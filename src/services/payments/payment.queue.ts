// ── Payment Queue ─────────────────────────────────────────────────────────────
//
// Two queues:
//   payment-webhook  — processes incoming provider webhooks (idempotent)
//   payment-reconcile — nightly reconciliation: finds sessions stuck in PROCESSING
//
// Webhook queue design:
//   - Idempotency: providerEventId is the dedup key (DB unique constraint)
//   - Retry: 5 attempts, exponential backoff starting 10s
//   - Dead-letter: events failing all retries retained 7 days for manual review
//
// Reconciliation:
//   - Runs every 30 minutes via BullMQ repeatable job
//   - Queries provider for any PROCESSING sessions older than 5 minutes
//   - Updates status; triggers downstream entitlement/boost activation

import { Queue, Worker } from 'bullmq';
import { redisConnection } from '../notification.queue';
import prisma from '../prisma.service';
import { getPaymentProvider } from './providers/payment.provider.registry';
import { confirmPaymentSuccess, recordProviderEvent } from './payment.session';
import { activateSubscriptionFromPayment } from '../subscriptions/subscription.lifecycle';
import { activateBoostFromPayment } from '../boosts/boost.service';
import { creditPackFulfillment } from './payment.fulfillment';
import type { PaymentProvider, WebhookEvent } from './payment.types';
import { logger } from '../../observability/logger';
import { captureException } from '../../observability/sentry';
import { paymentWebhookTotal, paymentReconcileTotal } from '../../observability/metrics';

// ── Queues ────────────────────────────────────────────────────────────────────

export const paymentWebhookQueue = new Queue<{ event: WebhookEvent; rawBody: string }>(
  'payment-webhook',
  {
    connection: redisConnection,
    defaultJobOptions: {
      attempts:         5,
      backoff:          { type: 'exponential', delay: 10_000 },
      removeOnComplete: { count: 500 },
      removeOnFail:     { age: 7 * 86400 },  // keep failures 7 days
    },
  },
);

export const paymentReconcileQueue = new Queue<{ batchSize: number }>(
  'payment-reconcile',
  {
    connection: redisConnection,
    defaultJobOptions: {
      attempts:         3,
      removeOnComplete: { count: 50 },
      removeOnFail:     { count: 20 },
    },
  },
);

// ── Webhook dispatch ──────────────────────────────────────────────────────────

async function processWebhookEvent(event: WebhookEvent): Promise<void> {
  const eventId = await recordProviderEvent({
    provider:        event.provider,
    eventType:       event.eventType,
    providerEventId: event.providerEventId,
    paymentSessionId: undefined,
    userId:          event.userId,
    rawPayload:      event.rawPayload,
  });

  paymentWebhookTotal.inc({ provider: event.provider, eventType: event.eventType });

  switch (event.eventType) {
    // ── Stripe ──────────────────────────────────────────────────────────────
    case 'payment_intent.succeeded':
    case 'charge.succeeded': {
      const session = event.paymentIntentId
        ? await prisma.paymentSession.findFirst({
            where: { providerIntentId: event.paymentIntentId },
            select: { id: true, provider: true },
          })
        : null;
      if (session) {
        await confirmPaymentSuccess({
          sessionId: session.id,
          provider:  session.provider as PaymentProvider,
        }).catch(() => {});
        await dispatchPostPayment(session.id);
      }
      break;
    }

    case 'payment_intent.payment_failed':
    case 'charge.failed': {
      if (event.paymentIntentId) {
        await prisma.paymentSession.updateMany({
          where: { providerIntentId: event.paymentIntentId, status: 'PROCESSING' },
          data:  { status: 'FAILED', failureCode: 'PROVIDER_WEBHOOK_FAILED' },
        });
      }
      break;
    }

    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
    case 'invoice.payment_succeeded':
    case 'invoice.payment_failed': {
      if (event.subscriptionId) {
        await activateSubscriptionFromPayment({
          providerSubId: event.subscriptionId,
          eventType:     event.eventType,
          provider:      event.provider,
          rawPayload:    event.rawPayload,
        }).catch((err) => logger.warn({ err, eventId }, 'subscription webhook handler failed'));
      }
      break;
    }

    // ── Razorpay ─────────────────────────────────────────────────────────────
    case 'payment.captured':
    case 'order.paid': {
      if (event.paymentIntentId) {
        const session = await prisma.paymentSession.findFirst({
          where: { providerIntentId: event.paymentIntentId },
          select: { id: true, provider: true },
        });
        if (session) {
          await confirmPaymentSuccess({ sessionId: session.id, provider: session.provider as PaymentProvider });
          await dispatchPostPayment(session.id);
        }
      }
      break;
    }

    case 'payment.failed': {
      if (event.paymentIntentId) {
        await prisma.paymentSession.updateMany({
          where: { providerIntentId: event.paymentIntentId, status: 'PROCESSING' },
          data:  { status: 'FAILED', failureCode: 'RAZORPAY_FAILED' },
        });
      }
      break;
    }

    // ── Apple ──────────────────────────────────────────────────────────────
    case 'DID_RENEW':
    case 'SUBSCRIBED':
    case 'DID_RECOVER': {
      if (event.subscriptionId) {
        await activateSubscriptionFromPayment({
          providerSubId: event.subscriptionId,
          eventType:     event.eventType,
          provider:      'apple',
          rawPayload:    event.rawPayload,
        }).catch(() => {});
      }
      break;
    }

    case 'EXPIRED':
    case 'DID_FAIL_TO_RENEW':
    case 'GRACE_PERIOD_EXPIRED': {
      if (event.subscriptionId) {
        await activateSubscriptionFromPayment({
          providerSubId: event.subscriptionId,
          eventType:     event.eventType,
          provider:      'apple',
          rawPayload:    event.rawPayload,
        }).catch(() => {});
      }
      break;
    }

    // ── Google ────────────────────────────────────────────────────────────
    case 'SUBSCRIPTION_RENEWED':
    case 'SUBSCRIPTION_PURCHASED':
    case 'SUBSCRIPTION_RECOVERED': {
      if (event.subscriptionId) {
        await activateSubscriptionFromPayment({
          providerSubId: event.subscriptionId,
          eventType:     event.eventType,
          provider:      'google',
          rawPayload:    event.rawPayload,
        }).catch(() => {});
      }
      break;
    }

    case 'SUBSCRIPTION_CANCELED':
    case 'SUBSCRIPTION_EXPIRED': {
      if (event.subscriptionId) {
        await activateSubscriptionFromPayment({
          providerSubId: event.subscriptionId,
          eventType:     event.eventType,
          provider:      'google',
          rawPayload:    event.rawPayload,
        }).catch(() => {});
      }
      break;
    }

    default:
      logger.debug({ eventType: event.eventType, eventId }, 'unhandled webhook event type');
  }
}

// ── Post-payment fulfillment dispatch ─────────────────────────────────────────

async function dispatchPostPayment(sessionId: string): Promise<void> {
  const session = await prisma.paymentSession.findUnique({
    where:  { id: sessionId },
    select: { productType: true, productId: true, userId: true, subscriptionId: true },
  });
  if (!session) return;

  switch (session.productType) {
    case 'SUBSCRIPTION':
      // Subscription lifecycle handles entitlement provisioning
      break;
    case 'BOOST':
      await activateBoostFromPayment({ sessionId, userId: session.userId, productId: session.productId });
      break;
    case 'CREDIT_PACK':
    case 'SUPERLIKE':
    case 'UNLOCK':
      await creditPackFulfillment({ sessionId, userId: session.userId, productId: session.productId });
      break;
  }
}

// ── Reconciliation ────────────────────────────────────────────────────────────

async function runReconciliation(batchSize: number): Promise<void> {
  const stuckCutoff = new Date(Date.now() - 10 * 60 * 1000);  // stuck > 10 min

  const stuckSessions = await prisma.paymentSession.findMany({
    where: {
      status:    'PROCESSING',
      createdAt: { lt: stuckCutoff },
    },
    take: batchSize,
    select: { id: true, provider: true, providerIntentId: true, productId: true },
  });

  let resolved = 0;
  for (const session of stuckSessions) {
    try {
      const provider = getPaymentProvider(session.provider as PaymentProvider);
      const result   = await provider.capturePayment(session.providerIntentId ?? session.id);
      if (result.status === 'SUCCESS') {
        await confirmPaymentSuccess({ sessionId: session.id, provider: session.provider as PaymentProvider });
        await dispatchPostPayment(session.id);
        resolved++;
      } else {
        await prisma.paymentSession.update({
          where: { id: session.id },
          data:  { status: 'FAILED', failureCode: 'RECONCILE_FAILED' },
        });
      }
    } catch (err) {
      captureException(err as Error, { sessionId: session.id });
    }
  }

  paymentReconcileTotal.inc({ resolved: String(resolved), total: String(stuckSessions.length) });
  logger.info({ resolved, total: stuckSessions.length }, 'payment reconciliation complete');
}

// ── Workers ───────────────────────────────────────────────────────────────────

export const paymentWebhookWorker = new Worker<{ event: WebhookEvent; rawBody: string }>(
  'payment-webhook',
  async (job) => processWebhookEvent(job.data.event),
  { connection: redisConnection, concurrency: 20 },
);

export const paymentReconcileWorker = new Worker<{ batchSize: number }>(
  'payment-reconcile',
  async (job) => runReconciliation(job.data.batchSize ?? 100),
  { connection: redisConnection, concurrency: 1 },
);

export async function schedulePaymentReconcile(): Promise<void> {
  await paymentReconcileQueue.add(
    'reconcile',
    { batchSize: 100 },
    {
      jobId:  'payment-reconcile-cron',
      repeat: { pattern: '*/30 * * * *' },  // every 30 minutes
    },
  ).catch(() => {});
}

export async function closePaymentWorkers(): Promise<void> {
  await Promise.all([
    paymentWebhookWorker.close(),
    paymentReconcileWorker.close(),
  ]);
}
