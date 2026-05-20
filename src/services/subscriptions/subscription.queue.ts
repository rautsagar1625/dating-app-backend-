// ── Subscription Queue ────────────────────────────────────────────────────────
// Handles:
//   - Grace period expiry worker (fires 7d after PAST_DUE)
//   - Subscription expiry sweeper (daily — finds ACTIVE past their end date)
//   - Renewal reminder notifications (48h before expiry)

import { Queue, Worker } from 'bullmq';
import { redisConnection } from '../notification.queue';
import prisma from '../prisma.service';
import { handleSubscriptionExpiry } from './subscription.lifecycle';
import { emitToUser } from '../socket.service';
import { logger } from '../../observability/logger';

export const subscriptionQueue = new Queue<{
  type: 'expire_grace' | 'expire_subscription' | 'renewal_reminder';
  subscriptionId?: string;
  providerSubId?:  string;
  userId?:         string;
}>(
  'subscription-lifecycle',
  {
    connection: redisConnection,
    defaultJobOptions: {
      attempts:         3,
      backoff:          { type: 'exponential', delay: 30_000 },
      removeOnComplete: { count: 200 },
      removeOnFail:     { age: 7 * 86400 },
    },
  },
);

async function runExpirySweep(): Promise<void> {
  const now = new Date();

  // 1. Expire ACTIVE subscriptions past their period end
  const expired = await prisma.subscription.findMany({
    where: {
      status: 'ACTIVE',
      currentPeriodEnd: { lt: now },
      cancelAtPeriodEnd: true,
    },
    select: { id: true, userId: true, providerSubId: true },
    take: 200,
  });

  for (const sub of expired) {
    if (sub.providerSubId) {
      await handleSubscriptionExpiry(sub.providerSubId).catch(() => {});
    }
  }

  // 2. Expire PAST_DUE subscriptions past grace period
  const pastDueExpired = await prisma.subscription.findMany({
    where: {
      status: 'PAST_DUE',
      gracePeriodEndsAt: { lt: now },
    },
    select: { id: true, userId: true, providerSubId: true },
    take: 200,
  });

  for (const sub of pastDueExpired) {
    if (sub.providerSubId) {
      await handleSubscriptionExpiry(sub.providerSubId).catch(() => {});
    }
  }

  // 3. Send renewal reminders for subscriptions expiring in 48h (non-autorenew or at-risk)
  const reminderCutoff = new Date(now.getTime() + 48 * 3600_000);
  const upcoming = await prisma.subscription.findMany({
    where: {
      status: 'ACTIVE',
      currentPeriodEnd: { gte: now, lte: reminderCutoff },
      cancelAtPeriodEnd: true,
    },
    select: { id: true, userId: true, tier: true, currentPeriodEnd: true },
    take: 500,
  });

  for (const sub of upcoming) {
    emitToUser(sub.userId, 'subscription:expiring_soon', {
      subscriptionId:  sub.id,
      tier:            sub.tier,
      expiresAt:       sub.currentPeriodEnd.toISOString(),
    });
  }

  logger.info({ expired: expired.length + pastDueExpired.length, reminders: upcoming.length }, 'subscription sweep done');
}

export const subscriptionWorker = new Worker<{
  type: string;
  subscriptionId?: string;
  providerSubId?:  string;
  userId?:         string;
}>(
  'subscription-lifecycle',
  async (job) => {
    if (job.data.type === 'expire_grace' && job.data.providerSubId) {
      await handleSubscriptionExpiry(job.data.providerSubId);
    }
  },
  { connection: redisConnection, concurrency: 20 },
);

export async function scheduleSubscriptionCrons(): Promise<void> {
  // Expiry sweep every 15 minutes
  await subscriptionQueue.add(
    'expiry-sweep',
    { type: 'expire_subscription' },
    { jobId: 'sub-expiry-sweep', repeat: { pattern: '*/15 * * * *' } },
  ).catch(() => {});
}

export async function closeSubscriptionWorker(): Promise<void> {
  await subscriptionWorker.close();
}
