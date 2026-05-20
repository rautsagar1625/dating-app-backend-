// ── Revenue Analytics Engine ──────────────────────────────────────────────────
//
// Pre-aggregates revenue metrics into RevenueSnapshot for dashboard queries.
// Direct PaymentSession scans at query time don't scale — these snapshots do.
//
// Aggregation schedule:
//   HOUR  — every hour via BullMQ cron
//   DAY   — at 00:05 UTC
//   WEEK  — Monday 00:10 UTC
//   MONTH — 1st of month 00:15 UTC
//
// Metrics computed:
//   - totalRevenue, subscriptionRev, boostRev, creditPackRev
//   - newSubscribers, churned
//   - ARPU (totalRevenue / activeUsers)
//   - activeSubCount

import { Queue, Worker } from 'bullmq';
import { redisConnection } from '../notification.queue';
import prisma from '../prisma.service';
import { logger } from '../../observability/logger';
import { revenueSnapshotCreatedTotal } from '../../observability/metrics';

type Granularity = 'HOUR' | 'DAY' | 'WEEK' | 'MONTH';

export const revenueAnalyticsQueue = new Queue<{ granularity: Granularity; periodStart: string }>(
  'revenue-analytics',
  {
    connection: redisConnection,
    defaultJobOptions: {
      attempts:         3,
      backoff:          { type: 'exponential', delay: 30_000 },
      removeOnComplete: { count: 100 },
      removeOnFail:     { count: 50 },
    },
  },
);

// ── Snapshot computation ──────────────────────────────────────────────────────

export async function computeRevenueSnapshot(
  granularity: Granularity,
  periodStart: Date,
): Promise<void> {
  const periodEnd = getPeriodEnd(granularity, periodStart);
  const currency  = 'USD';

  // Revenue by product type
  const payments = await prisma.paymentSession.findMany({
    where: {
      status:    'SUCCESS',
      createdAt: { gte: periodStart, lt: periodEnd },
    },
    select: { amountUsd: true, productType: true },
  });

  const totalRevenue    = payments.reduce((s, p) => s + Number(p.amountUsd), 0);
  const subscriptionRev = payments.filter((p) => p.productType === 'SUBSCRIPTION').reduce((s, p) => s + Number(p.amountUsd), 0);
  const boostRev        = payments.filter((p) => p.productType === 'BOOST' || p.productType === 'SUPERLIKE').reduce((s, p) => s + Number(p.amountUsd), 0);
  const creditPackRev   = payments.filter((p) => p.productType === 'CREDIT_PACK').reduce((s, p) => s + Number(p.amountUsd), 0);

  // Subscriber metrics
  const [newSubscribers, churned, activeSubCount] = await Promise.all([
    prisma.subscription.count({ where: { createdAt: { gte: periodStart, lt: periodEnd } } }),
    prisma.subscription.count({ where: { cancelledAt: { gte: periodStart, lt: periodEnd } } }),
    prisma.subscription.count({ where: { status: { in: ['ACTIVE', 'PAST_DUE'] } } }),
  ]);

  // ARPU: total revenue / active users in period
  const activeUsers = await prisma.user.count({
    where: { lastSeen: { gte: periodStart } },
  });
  const arpu = activeUsers > 0 ? totalRevenue / activeUsers : 0;

  // Upsert snapshot (idempotent re-runs)
  await prisma.revenueSnapshot.upsert({
    where:  { granularity_periodStart_currency: { granularity, periodStart, currency } },
    create: { granularity, periodStart, periodEnd, totalRevenue, subscriptionRev, boostRev, creditPackRev, newSubscribers, churned, arpu, activeSubCount, currency },
    update: { periodEnd, totalRevenue, subscriptionRev, boostRev, creditPackRev, newSubscribers, churned, arpu, activeSubCount },
  });

  revenueSnapshotCreatedTotal.inc({ granularity });
  logger.info({ granularity, periodStart, totalRevenue, activeSubCount }, 'revenue snapshot computed');
}

// ── LTV calculation ───────────────────────────────────────────────────────────

export async function computeUserLtv(userId: string): Promise<number> {
  const result = await prisma.paymentSession.aggregate({
    where: { userId, status: 'SUCCESS' },
    _sum: { amountUsd: true },
  });
  const refunds = await prisma.paymentSession.aggregate({
    where: { userId, status: 'REFUNDED' },
    _sum: { refundAmountUsd: true },
  });
  const gross = Number(result._sum.amountUsd ?? 0);
  const refunded = Number(refunds._sum.refundAmountUsd ?? 0);
  return Math.max(0, gross - refunded);
}

// ── Cohort retention analysis ─────────────────────────────────────────────────

export async function getSubscriberRetentionCohort(params: {
  cohortMonth: Date;  // first day of cohort month
  intervals:   number[];  // months to check (e.g. [1, 3, 6, 12])
}): Promise<Array<{ interval: number; retained: number; cohortSize: number; retentionRate: number }>> {
  const { cohortMonth, intervals } = params;
  const cohortEnd = new Date(cohortMonth);
  cohortEnd.setMonth(cohortEnd.getMonth() + 1);

  // Users who subscribed in the cohort month
  const cohortSubs = await prisma.subscription.findMany({
    where: { createdAt: { gte: cohortMonth, lt: cohortEnd } },
    select: { userId: true, createdAt: true },
  });
  const cohortSize = cohortSubs.length;
  if (cohortSize === 0) return intervals.map((i) => ({ interval: i, retained: 0, cohortSize: 0, retentionRate: 0 }));

  const userIds = cohortSubs.map((s) => s.userId);

  const results = await Promise.all(
    intervals.map(async (months) => {
      const checkDate = new Date(cohortMonth);
      checkDate.setMonth(checkDate.getMonth() + months);

      const retained = await prisma.subscription.count({
        where: {
          userId:    { in: userIds },
          status:    { in: ['ACTIVE', 'PAST_DUE'] },
          createdAt: { lte: checkDate },
          currentPeriodEnd: { gte: checkDate },
        },
      });

      return {
        interval:      months,
        retained,
        cohortSize,
        retentionRate: retained / cohortSize,
      };
    }),
  );

  return results;
}

// ── Paywall conversion funnel ─────────────────────────────────────────────────

export async function getPaywallConversionFunnel(days = 30): Promise<{
  totalExposures: number;
  converted:      number;
  dismissed:      number;
  conversionRate: number;
  byOfferType:    Array<{ offerType: string; shown: number; converted: number; rate: number }>;
}> {
  const since = new Date(Date.now() - days * 86400_000);

  const exposures = await prisma.offerExposure.groupBy({
    by:    ['offerType'],
    where: { shownAt: { gte: since } },
    _count: { _all: true },
  });

  const converted = await prisma.offerExposure.groupBy({
    by:    ['offerType'],
    where: { shownAt: { gte: since }, convertedAt: { not: null } },
    _count: { _all: true },
  });

  const totalExposures = exposures.reduce((s, e) => s + e._count._all, 0);
  const totalConverted = converted.reduce((s, c) => s + c._count._all, 0);
  const dismissed      = await prisma.offerExposure.count({ where: { shownAt: { gte: since }, dismissedAt: { not: null } } });

  const convertedMap = new Map(converted.map((c) => [c.offerType, c._count._all]));

  const byOfferType = exposures.map((e) => ({
    offerType: e.offerType,
    shown:     e._count._all,
    converted: convertedMap.get(e.offerType) ?? 0,
    rate:      e._count._all > 0 ? (convertedMap.get(e.offerType) ?? 0) / e._count._all : 0,
  }));

  return {
    totalExposures,
    converted: totalConverted,
    dismissed,
    conversionRate: totalExposures > 0 ? totalConverted / totalExposures : 0,
    byOfferType,
  };
}

// ── Queue workers ─────────────────────────────────────────────────────────────

export const revenueAnalyticsWorker = new Worker<{ granularity: Granularity; periodStart: string }>(
  'revenue-analytics',
  async (job) => {
    const { granularity, periodStart } = job.data;
    await computeRevenueSnapshot(granularity, new Date(periodStart));
  },
  { connection: redisConnection, concurrency: 2 },
);

export async function scheduleRevenueAnalyticsCrons(): Promise<void> {
  const crons = [
    { name: 'hourly',  cron: '5 * * * *',     granularity: 'HOUR'  },
    { name: 'daily',   cron: '5 0 * * *',      granularity: 'DAY'   },
    { name: 'weekly',  cron: '10 0 * * 1',     granularity: 'WEEK'  },
    { name: 'monthly', cron: '15 0 1 * *',     granularity: 'MONTH' },
  ] as const;

  for (const c of crons) {
    const now         = new Date();
    const periodStart = getPeriodStart(c.granularity, now);
    await revenueAnalyticsQueue.add(
      c.name,
      { granularity: c.granularity, periodStart: periodStart.toISOString() },
      { jobId: `rev-${c.name}`, repeat: { pattern: c.cron } },
    ).catch(() => {});
  }
}

export async function closeRevenueAnalyticsWorker(): Promise<void> {
  await revenueAnalyticsWorker.close();
}

// ── Time helpers ──────────────────────────────────────────────────────────────

function getPeriodStart(granularity: Granularity, ref: Date): Date {
  const d = new Date(ref);
  d.setMilliseconds(0); d.setSeconds(0);
  if (granularity === 'HOUR') { d.setMinutes(0); return d; }
  d.setMinutes(0); d.setHours(0);
  if (granularity === 'DAY') return d;
  if (granularity === 'WEEK') { d.setDate(d.getDate() - d.getDay()); return d; }
  d.setDate(1);
  return d;
}

function getPeriodEnd(granularity: Granularity, start: Date): Date {
  const d = new Date(start);
  if (granularity === 'HOUR')  { d.setHours(d.getHours() + 1);   return d; }
  if (granularity === 'DAY')   { d.setDate(d.getDate() + 1);      return d; }
  if (granularity === 'WEEK')  { d.setDate(d.getDate() + 7);      return d; }
  d.setMonth(d.getMonth() + 1);
  return d;
}
