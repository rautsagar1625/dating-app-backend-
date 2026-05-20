// ── Payment Session Layer ─────────────────────────────────────────────────────
//
// Owns the idempotency guarantee and state machine for every charge attempt.
// Design invariants:
//   - One PaymentSession per idempotency key — never create a second
//   - State transitions are append-only; never delete sessions
//   - Redis caches session state for fast idempotency checks (24h TTL)
//   - All DB writes are async-safe; failures don't lose the session record
//
// State machine:
//   PENDING → PROCESSING → SUCCESS | FAILED | REFUNDED | DISPUTED
//
// Redis keys:
//   pay:idem:{key}    → sessionId           TTL 24h  (idempotency dedup)
//   pay:session:{id}  → JSON session state  TTL 30min (fast read)

import IORedis from 'ioredis';
import { randomUUID } from 'crypto';
import prisma from '../prisma.service';
import { getPaymentProvider } from './providers/payment.provider.registry';
import { PRODUCT_CATALOG, type ProductType, type PaymentProvider } from './payment.types';
import { logger } from '../../observability/logger';
import { captureException } from '../../observability/sentry';
import {
  paymentIntentTotal,
  paymentSuccessTotal,
  paymentFailureTotal,
  paymentLatency,
} from '../../observability/metrics';

const REDIS_URL  = process.env.REDIS_URL ?? 'redis://localhost:6379';
export const payRedis = new IORedis(REDIS_URL, {
  maxRetriesPerRequest: 2,
  lazyConnect: true,
  enableReadyCheck: false,
});
payRedis.connect().catch(() => {});

const IDEM_TTL    = 86400;  // 24h idempotency window
const SESSION_TTL = 1800;   // 30min session cache

const idemKey    = (k: string)  => `pay:idem:${k}`;
const sessionKey = (id: string) => `pay:session:${id}`;

// ── Create payment session ────────────────────────────────────────────────────

export async function createPaymentSession(params: {
  userId:          string;
  idempotencyKey:  string;
  productId:       string;
  provider:        PaymentProvider;
  currency?:       string;
  metadata?:       Record<string, string>;
  subscriptionId?: string;
}): Promise<{ sessionId: string; clientSecret?: string; checkoutUrl?: string; alreadyCompleted: boolean }> {
  const { userId, idempotencyKey, productId, provider, currency = 'USD', metadata, subscriptionId } = params;

  // Fast idempotency check via Redis
  const existing = await payRedis.get(idemKey(idempotencyKey));
  if (existing) {
    const cached = await payRedis.get(sessionKey(existing));
    if (cached) {
      const session = JSON.parse(cached) as { status: string; clientSecret?: string; checkoutUrl?: string };
      return {
        sessionId:        existing,
        clientSecret:     session.clientSecret,
        checkoutUrl:      session.checkoutUrl,
        alreadyCompleted: session.status === 'SUCCESS',
      };
    }
    // Redis evicted session cache but idempotency key still valid — fetch from DB
    const dbSession = await prisma.paymentSession.findUnique({
      where:  { id: existing },
      select: { status: true, id: true },
    });
    if (dbSession && ['SUCCESS', 'REFUNDED'].includes(dbSession.status)) {
      return { sessionId: dbSession.id, alreadyCompleted: true };
    }
  }

  const sku = PRODUCT_CATALOG[productId];
  if (!sku) throw Object.assign(new Error(`Unknown product: ${productId}`), { statusCode: 400 });

  // Check for existing pending session for same user+product (duplicate charge prevention)
  const recentPending = await prisma.paymentSession.findFirst({
    where: {
      userId,
      productId,
      status:    'PROCESSING',
      createdAt: { gte: new Date(Date.now() - 5 * 60 * 1000) },  // 5-min window
    },
    select: { id: true },
  });
  if (recentPending) {
    throw Object.assign(
      new Error('A payment for this product is already processing. Please wait.'),
      { statusCode: 409, sessionId: recentPending.id },
    );
  }

  const sessionId = randomUUID();
  const payProvider = getPaymentProvider(provider);
  const timer = paymentLatency.startTimer({ provider, productType: sku.type });

  // Create DB record first — ensures auditability even if provider call fails
  await prisma.paymentSession.create({
    data: {
      id:             sessionId,
      userId,
      idempotencyKey,
      provider,
      productType:    sku.type as ProductType,
      productId,
      amountUsd:      sku.amountUsd,
      currency,
      status:         'PENDING',
      subscriptionId: subscriptionId ?? null,
      metadata:       metadata ?? {},
    },
  });

  paymentIntentTotal.inc({ provider, productType: sku.type });

  let providerIntentId: string | undefined;
  let clientSecret: string | undefined;
  let checkoutUrl: string | undefined;

  try {
    const result = await payProvider.createPaymentIntent({
      userId,
      idempotencyKey,
      productId,
      amountUsd: sku.amountUsd,
      currency,
      metadata,
      subscriptionId,
    });

    providerIntentId = result.providerIntentId;
    clientSecret     = result.clientSecret;
    checkoutUrl      = result.checkoutUrl;

    await prisma.paymentSession.update({
      where: { id: sessionId },
      data:  { status: 'PROCESSING', providerIntentId },
    });

    // Cache idempotency key + session
    const cachePayload = JSON.stringify({ status: 'PROCESSING', clientSecret, checkoutUrl });
    await Promise.all([
      payRedis.setex(idemKey(idempotencyKey), IDEM_TTL, sessionId),
      payRedis.setex(sessionKey(sessionId), SESSION_TTL, cachePayload),
    ]);

    logger.info({ sessionId, userId, productId, provider }, 'payment session created');
    return { sessionId, clientSecret, checkoutUrl, alreadyCompleted: false };
  } catch (err) {
    timer();
    await prisma.paymentSession.update({
      where: { id: sessionId },
      data: {
        status:         'FAILED',
        failureMessage: (err as Error).message,
        failureCode:    'PROVIDER_ERROR',
      },
    }).catch(() => {});
    paymentFailureTotal.inc({ provider, productType: sku.type, reason: 'PROVIDER_ERROR' });
    captureException(err as Error, { userId, sessionId, productId });
    throw err;
  } finally {
    timer();
  }
}

// ── Confirm payment success ───────────────────────────────────────────────────

export async function confirmPaymentSuccess(params: {
  sessionId:     string;
  provider:      PaymentProvider;
  receiptData?:  string;
  signature?:    string;
  rawPayload?:   string;
}): Promise<void> {
  const { sessionId, provider, receiptData, signature, rawPayload } = params;

  const session = await prisma.paymentSession.findUnique({
    where:  { id: sessionId },
    select: { status: true, userId: true, providerIntentId: true, productId: true, productType: true, amountUsd: true },
  });
  if (!session) throw new Error('Payment session not found');
  if (session.status === 'SUCCESS') return;  // idempotent
  if (session.status === 'REFUNDED' || session.status === 'DISPUTED') {
    throw Object.assign(new Error('Cannot confirm an already-refunded payment'), { statusCode: 409 });
  }

  // Verify with provider (never trust client-reported success)
  const payProvider = getPaymentProvider(provider);
  const captureResult = await payProvider.capturePayment(
    session.providerIntentId ?? sessionId,
    signature,
    rawPayload,
  );

  if (captureResult.status !== 'SUCCESS') {
    await prisma.paymentSession.update({
      where: { id: sessionId },
      data:  { status: 'FAILED', failureCode: 'CAPTURE_FAILED' },
    });
    paymentFailureTotal.inc({ provider, productType: session.productType, reason: 'CAPTURE_FAILED' });
    throw Object.assign(new Error('Payment capture failed at provider'), { statusCode: 402 });
  }

  await prisma.paymentSession.update({
    where: { id: sessionId },
    data:  { status: 'SUCCESS', receiptData: receiptData ?? captureResult.receiptData },
  });

  // Invalidate session cache
  await payRedis.del(sessionKey(sessionId)).catch(() => {});

  paymentSuccessTotal.inc({ provider, productType: session.productType });
  logger.info({ sessionId, userId: session.userId, productId: session.productId }, 'payment confirmed');
}

// ── Record provider webhook event ─────────────────────────────────────────────

export async function recordProviderEvent(params: {
  provider:        PaymentProvider;
  eventType:       string;
  providerEventId: string;
  paymentSessionId?: string;
  userId?:         string;
  rawPayload:      Record<string, unknown>;
}): Promise<string> {
  // Idempotency: skip duplicate webhook events
  const existing = await prisma.paymentProviderEvent.findUnique({
    where:  { providerEventId: params.providerEventId },
    select: { id: true },
  });
  if (existing) return existing.id;

  const event = await prisma.paymentProviderEvent.create({
    data: {
      provider:         params.provider,
      eventType:        params.eventType,
      providerEventId:  params.providerEventId,
      paymentSessionId: params.paymentSessionId,
      userId:           params.userId,
      rawPayload:       params.rawPayload,
    },
    select: { id: true },
  });

  return event.id;
}

// ── Refund ────────────────────────────────────────────────────────────────────

export async function initiateRefund(params: {
  sessionId:  string;
  reason:     string;
  amountUsd?: number;
  requestedBy: string;  // userId or 'admin'
}): Promise<{ refundId: string }> {
  const { sessionId, amountUsd, reason, requestedBy } = params;

  const session = await prisma.paymentSession.findUnique({
    where:  { id: sessionId },
    select: { status: true, provider: true, providerIntentId: true, userId: true, amountUsd: true },
  });
  if (!session) throw Object.assign(new Error('Session not found'), { statusCode: 404 });
  if (session.status !== 'SUCCESS') {
    throw Object.assign(new Error('Can only refund successful payments'), { statusCode: 409 });
  }
  if (requestedBy !== 'admin' && session.userId !== requestedBy) {
    throw Object.assign(new Error('Not authorized to refund this payment'), { statusCode: 403 });
  }

  const payProvider = getPaymentProvider(session.provider as PaymentProvider);
  const result = await payProvider.refundPayment(
    session.providerIntentId ?? sessionId,
    amountUsd,
  );

  await prisma.paymentSession.update({
    where: { id: sessionId },
    data: {
      status:          'REFUNDED',
      refundedAt:      new Date(),
      refundAmountUsd: amountUsd ?? Number(session.amountUsd),
      metadata:        { refundReason: reason, refundId: result.refundId, requestedBy } as any,
    },
  });

  logger.info({ sessionId, refundId: result.refundId, reason }, 'payment refunded');
  return { refundId: result.refundId };
}
