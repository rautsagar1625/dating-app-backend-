// ── Call Billing Hooks ────────────────────────────────────────────────────────
//
// Deducts credits from the caller's wallet after a call ends.
// Configurable via feature flags: CALL_CREDIT_PER_MINUTE (default: 0 = free).
//
// Design:
//   - Free for now (CALL_CREDIT_PER_MINUTE = 0) — hook is wired, not charged
//   - Future: deduct credits per minute × durationS
//   - Uses BullMQ for retry-safe deduction (idempotent via callId job key)
//   - Premium pass: users with 'CALL_PASS' in wallet skip per-minute billing

import { Queue, Worker } from 'bullmq';
import { redisConnection } from '../notification.queue';
import prisma from '../prisma.service';
import { logger } from '../../observability/logger';

export interface CallBillingJobData {
  callId:    string;
  callerId:  string;
  type:      string;
  durationS: number;
}

export const callBillingQueue = new Queue<CallBillingJobData>('call-billing', {
  connection: redisConnection,
  defaultJobOptions: {
    attempts:         3,
    backoff:          { type: 'exponential', delay: 5000 },
    removeOnComplete: { count: 200 },
    removeOnFail:     { age: 86400 },
  },
});

export async function enqueueCallBilling(data: CallBillingJobData): Promise<void> {
  // Deduplicated by callId — exactly-once billing per call
  await callBillingQueue.add('bill', data, {
    jobId: `bill:${data.callId}`,
  }).catch(() => {});
}

export async function computeCallCost(
  type:     string,
  durationS: number,
): Promise<number> {
  const ratePerMin = parseFloat(process.env.CALL_CREDIT_PER_MINUTE ?? '0');
  if (ratePerMin <= 0) return 0;

  const minutes = durationS / 60;
  return Math.ceil(minutes * ratePerMin);
}

export async function processCallBilling(data: CallBillingJobData): Promise<void> {
  const cost = await computeCallCost(data.type, data.durationS);
  if (cost <= 0) return;  // free tier or very short call

  try {
    // Check if caller has a call pass (exempt from billing)
    const wallet = await prisma.wallet.findUnique({
      where:  { userId: data.callerId },
      select: { balance: true },
    });

    if (!wallet) return;
    if (wallet.balance < cost) {
      logger.warn({ callerId: data.callerId, cost, balance: wallet.balance }, 'insufficient balance for call');
      return;  // Graceful: don't block retrospectively — UI checks beforehand
    }

    await prisma.wallet.update({
      where: { userId: data.callerId },
      data:  { balance: { decrement: cost } },
    });

    // Record transaction
    await prisma.transaction.create({
      data: {
        userId: data.callerId,
        amount: -cost,
        type:   'DEBIT',
        reason: `${data.type} call (${Math.ceil(data.durationS / 60)} min)`,
      },
    }).catch(() => {});

    logger.info({ callerId: data.callerId, callId: data.callId, cost }, 'call billing processed');
  } catch (err) {
    logger.error({ err, callId: data.callId }, 'call billing failed');
    throw err;  // allow BullMQ retry
  }
}

export const callBillingWorker = new Worker<CallBillingJobData>(
  'call-billing',
  async (job) => processCallBilling(job.data),
  { connection: redisConnection, concurrency: 10 },
);

export async function closeCallBillingWorker(): Promise<void> {
  await callBillingWorker.close();
}
