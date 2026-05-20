// ── Subscription Lifecycle ────────────────────────────────────────────────────
//
// Manages the complete subscription state machine:
//   PENDING_ACTIVATION → ACTIVE → CANCELLED/PAST_DUE/EXPIRED
//
// Design:
//   - Single source of truth: DB Subscription row
//   - Entitlements derived from subscription; provisioned/revoked here
//   - All state transitions emit Socket.IO events for realtime entitlement refresh
//   - Idempotent: safe to call multiple times with same provider event
//
// Fulfillment hooks (called from payment.queue):
//   - activateSubscriptionFromPayment   — new purchase or renewal
//   - cancelSubscriptionForUser         — user-initiated cancel
//   - expireSubscription                — grace period elapsed
//   - pauseSubscription / resumeSubscription

import prisma from '../prisma.service';
import { PRODUCT_CATALOG } from '../payments/payment.types';
import { TIER_FEATURES, GRACE_PERIOD_DAYS, type SubscriptionTier } from './subscription.types';
import { provisionEntitlements, revokeEntitlements } from '../entitlements/entitlement.engine';
import { getPaymentProvider } from '../payments/providers/payment.provider.registry';
import { emitToUser } from '../socket.service';
import { logger } from '../../observability/logger';
import { captureException } from '../../observability/sentry';
import {
  subscriptionActivatedTotal,
  subscriptionCancelledTotal,
  subscriptionExpiredTotal,
  subscriptionPastDueTotal,
} from '../../observability/metrics';
import type { PaymentProvider } from '../payments/payment.types';

// ── Activate / renew from payment event ──────────────────────────────────────

export async function activateSubscriptionFromPayment(params: {
  providerSubId: string;
  eventType:     string;
  provider:      PaymentProvider;
  rawPayload:    Record<string, unknown>;
  userId?:       string;
}): Promise<void> {
  const { providerSubId, eventType, provider, rawPayload } = params;

  // Expired / cancelled events
  if (['EXPIRED', 'GRACE_PERIOD_EXPIRED', 'SUBSCRIPTION_CANCELED', 'SUBSCRIPTION_EXPIRED',
       'customer.subscription.deleted', 'DID_FAIL_TO_RENEW'].includes(eventType)) {
    await handleSubscriptionExpiry(providerSubId);
    return;
  }

  if (['SUBSCRIPTION_ON_HOLD', 'invoice.payment_failed'].includes(eventType)) {
    await markPastDue(providerSubId);
    return;
  }

  // Try to find existing subscription by providerSubId
  let sub = await prisma.subscription.findUnique({
    where:  { providerSubId },
    select: { id: true, userId: true, tier: true, status: true, currentPeriodEnd: true },
  });

  if (!sub) {
    // New subscription — we need userId from rawPayload or session lookup
    // For Stripe: rawPayload.metadata.userId; for Apple/Google: look up by user claim
    const userId = params.userId
      ?? extractUserId(rawPayload, provider)
      ?? await lookupUserByProvider(providerSubId, provider);

    if (!userId) {
      logger.warn({ providerSubId, provider }, 'Cannot find userId for new subscription — deferred');
      return;
    }

    const tierInfo = inferTierFromPayload(rawPayload, provider);
    if (!tierInfo) {
      logger.warn({ providerSubId, provider }, 'Cannot infer tier from webhook payload');
      return;
    }

    sub = await createSubscription({
      userId,
      providerSubId,
      tier:     tierInfo.tier,
      provider,
      periodStart: tierInfo.periodStart,
      periodEnd:   tierInfo.periodEnd,
      priceUsd:    tierInfo.priceUsd,
      currency:    tierInfo.currency,
      interval:    tierInfo.interval,
    });
  } else {
    // Renewal — extend period
    const periodEnd = extractPeriodEnd(rawPayload, provider) ?? new Date(sub.currentPeriodEnd.getTime() + 30 * 86400_000);
    await prisma.subscription.update({
      where: { id: sub.id },
      data: {
        status:             'ACTIVE',
        currentPeriodEnd:   periodEnd,
        gracePeriodEndsAt:  null,
        failedRenewals:     0,
        cancelAtPeriodEnd:  false,
      },
    });
  }

  // Provision entitlements
  await provisionEntitlements(sub.userId, sub.id, sub.tier as SubscriptionTier);

  // Realtime update
  emitToUser(sub.userId, 'subscription:updated', {
    tier:   sub.tier,
    status: 'ACTIVE',
  });

  subscriptionActivatedTotal.inc({ tier: sub.tier, provider });
  logger.info({ subId: sub.id, userId: sub.userId, tier: sub.tier }, 'subscription activated');
}

// ── Create new subscription record ───────────────────────────────────────────

async function createSubscription(params: {
  userId:       string;
  providerSubId: string;
  tier:         SubscriptionTier;
  provider:     string;
  periodStart:  Date;
  periodEnd:    Date;
  priceUsd:     number;
  currency:     string;
  interval:     string;
}): Promise<{ id: string; userId: string; tier: string; status: string; currentPeriodEnd: Date }> {
  // Cancel any existing active subscription first
  await prisma.subscription.updateMany({
    where: { userId: params.userId, status: 'ACTIVE' },
    data:  { status: 'CANCELLED', cancelledAt: new Date() },
  });

  const sub = await prisma.subscription.create({
    data: {
      userId:            params.userId,
      tier:              params.tier,
      status:            'ACTIVE',
      provider:          params.provider,
      providerSubId:     params.providerSubId,
      currentPeriodStart: params.periodStart,
      currentPeriodEnd:   params.periodEnd,
      priceUsd:           params.priceUsd,
      currency:           params.currency,
      billingInterval:    params.interval,
    },
    select: { id: true, userId: true, tier: true, status: true, currentPeriodEnd: true },
  });

  return sub;
}

// ── User-initiated cancellation ───────────────────────────────────────────────

export async function cancelSubscriptionForUser(userId: string, immediately = false): Promise<void> {
  const sub = await prisma.subscription.findFirst({
    where:  { userId, status: 'ACTIVE' },
    select: { id: true, provider: true, providerSubId: true },
  });
  if (!sub) throw Object.assign(new Error('No active subscription'), { statusCode: 404 });

  // Cancel at provider
  if (sub.providerSubId) {
    try {
      const provider = getPaymentProvider(sub.provider as PaymentProvider);
      await provider.cancelSubscription?.(sub.providerSubId, immediately);
    } catch (err) {
      captureException(err as Error, { subId: sub.id, note: 'provider cancel failed — proceeding with local cancel' });
    }
  }

  if (immediately) {
    await prisma.subscription.update({
      where: { id: sub.id },
      data:  { status: 'CANCELLED', cancelledAt: new Date(), cancelAtPeriodEnd: false },
    });
    await revokeEntitlements(userId, sub.id);
    emitToUser(userId, 'subscription:updated', { status: 'CANCELLED' });
  } else {
    await prisma.subscription.update({
      where: { id: sub.id },
      data:  { cancelAtPeriodEnd: true },
    });
    emitToUser(userId, 'subscription:updated', { cancelAtPeriodEnd: true });
  }

  subscriptionCancelledTotal.inc({ immediately: String(immediately) });
  logger.info({ subId: sub.id, userId, immediately }, 'subscription cancelled');
}

// ── Expiry and grace period ───────────────────────────────────────────────────

export async function markPastDue(providerSubId: string): Promise<void> {
  const sub = await prisma.subscription.findUnique({
    where:  { providerSubId },
    select: { id: true, userId: true, failedRenewals: true },
  });
  if (!sub) return;

  const gracePeriodEndsAt = new Date(Date.now() + GRACE_PERIOD_DAYS * 86400_000);
  await prisma.subscription.update({
    where: { id: sub.id },
    data:  {
      status:             'PAST_DUE',
      gracePeriodEndsAt,
      failedRenewals:     { increment: 1 },
    },
  });

  // Entitlements remain active during grace period
  emitToUser(sub.userId, 'subscription:updated', { status: 'PAST_DUE', gracePeriodEndsAt });
  subscriptionPastDueTotal.inc();
}

export async function handleSubscriptionExpiry(providerSubId: string): Promise<void> {
  const sub = await prisma.subscription.findUnique({
    where:  { providerSubId },
    select: { id: true, userId: true, status: true },
  });
  if (!sub || sub.status === 'EXPIRED') return;

  await prisma.subscription.update({
    where: { id: sub.id },
    data:  { status: 'EXPIRED' },
  });

  await revokeEntitlements(sub.userId, sub.id);
  emitToUser(sub.userId, 'subscription:updated', { status: 'EXPIRED' });
  subscriptionExpiredTotal.inc();
  logger.info({ subId: sub.id, userId: sub.userId }, 'subscription expired');
}

// ── Get active subscription ───────────────────────────────────────────────────

export async function getActiveSubscription(userId: string) {
  return prisma.subscription.findFirst({
    where: { userId, status: { in: ['ACTIVE', 'PAST_DUE'] } },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true, tier: true, status: true,
      currentPeriodEnd: true, cancelAtPeriodEnd: true,
      gracePeriodEndsAt: true, billingInterval: true,
      priceUsd: true, provider: true,
    },
  });
}

// ── Mobile receipt validation + subscription creation ─────────────────────────

export async function validateAndActivateMobileSubscription(params: {
  userId:        string;
  platform:      'apple' | 'google';
  receiptToken:  string;
  productId:     string;
}): Promise<{ subscriptionId: string }> {
  const { userId, platform, receiptToken, productId } = params;

  // Dedup: same receipt token already processed?
  const existing = await prisma.purchaseReceipt.findUnique({
    where:  { transactionId: receiptToken.slice(0, 200) },
    select: { id: true, subscriptionId: true },
  });
  if (existing?.subscriptionId) return { subscriptionId: existing.subscriptionId };

  const provider = getPaymentProvider(platform);
  const validation = await provider.validateReceipt!(receiptToken, productId);

  if (!validation.valid || validation.purchaseState !== 'PURCHASED') {
    throw Object.assign(new Error('Receipt validation failed'), { statusCode: 402 });
  }

  // Infer tier from productId
  const sku = Object.values(PRODUCT_CATALOG).find(
    (s) => s.appleProductId === productId || s.googleProductId === productId,
  );
  if (!sku?.tier) throw Object.assign(new Error('Unknown product'), { statusCode: 400 });

  const periodStart = new Date();
  const periodEnd   = validation.expiresAt ?? new Date(Date.now() + 30 * 86400_000);

  const sub = await createSubscription({
    userId,
    providerSubId: validation.originalTransactionId ?? validation.transactionId,
    tier:          sku.tier,
    provider:      platform,
    periodStart,
    periodEnd,
    priceUsd:      sku.amountUsd,
    currency:      'USD',
    interval:      sku.interval ?? 'MONTH',
  });

  // Record receipt for dedup
  await prisma.purchaseReceipt.create({
    data: {
      userId,
      platform,
      productId,
      transactionId:         validation.transactionId.slice(0, 200),
      originalTransactionId: validation.originalTransactionId ?? null,
      receiptToken:          receiptToken.slice(0, 4000),
      purchaseState:         'PURCHASED',
      expiresAt:             validation.expiresAt,
      validationResponse:    validation.rawResponse as any,
      subscriptionId:        sub.id,
    },
  }).catch(() => {});  // non-fatal

  await provisionEntitlements(userId, sub.id, sku.tier);
  subscriptionActivatedTotal.inc({ tier: sku.tier, provider: platform });

  return { subscriptionId: sub.id };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function extractUserId(payload: Record<string, unknown>, provider: PaymentProvider): string | undefined {
  if (provider === 'stripe') {
    const obj = ((payload.data as Record<string, unknown> | undefined)?.['object'] as Record<string, unknown>) ?? {};
    return (obj.metadata as any)?.userId as string | undefined;
  }
  if (provider === 'razorpay') {
    return (payload.payload as any)?.payment?.entity?.notes?.userId as string | undefined;
  }
  return undefined;
}

async function lookupUserByProvider(providerSubId: string, _provider: PaymentProvider): Promise<string | undefined> {
  const sub = await prisma.subscription.findFirst({
    where:  { providerSubId },
    select: { userId: true },
  });
  return sub?.userId;
}

function extractPeriodEnd(payload: Record<string, unknown>, provider: PaymentProvider): Date | undefined {
  if (provider === 'stripe') {
    const periodEnd = ((payload.data as any)?.[`object`] as any)?.current_period_end as number | undefined;
    return periodEnd ? new Date(periodEnd * 1000) : undefined;
  }
  return undefined;
}

function inferTierFromPayload(payload: Record<string, unknown>, provider: PaymentProvider) {
  if (provider === 'stripe') {
    const obj = ((payload.data as any)?.['object'] ?? payload) as Record<string, unknown>;
    const productId = (obj.plan as any)?.product ?? (obj.items as any)?.data?.[0]?.plan?.product;
    const sku = Object.values(PRODUCT_CATALOG).find((s) => s.stripeProductId === productId);
    if (!sku?.tier) return null;
    const periodEnd   = (obj.current_period_end as number) * 1000;
    const periodStart = (obj.current_period_start as number) * 1000;
    return {
      tier:        sku.tier,
      periodStart: new Date(periodStart),
      periodEnd:   new Date(periodEnd),
      priceUsd:    sku.amountUsd,
      currency:    sku.currency,
      interval:    sku.interval ?? 'MONTH',
    };
  }
  return null;
}
