// ── Analytics Aggregation Cron ────────────────────────────────────────────────
//
// Runs once per day (UTC midnight) to compute pre-aggregated snapshots.
// Pre-aggregation means dashboard queries are O(1) instead of full-table scans.
//
// Aggregations computed:
//   DashboardMetricSnapshot (DAILY):
//     DAU, WAU, MAU, NEW_USERS, MESSAGES, MATCHES, REVENUE, CHATS_UNLOCKED
//
//   AnalyticsAggregation:
//     RETENTION_D1, RETENTION_D7, RETENTION_D30   (per cohort)
//     REVENUE_DAILY, FUNNEL_SIGNUP

import { Queue, Worker, Job } from 'bullmq';
import IORedis from 'ioredis';
import prisma from '../prisma.service';
import { queueLogger } from '../../observability/logger';
import { captureException } from '../../observability/sentry';

const connection = new IORedis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
  maxRetriesPerRequest: null,
});

interface AggregateJobData {
  date: string; // ISO date string YYYY-MM-DD for the day to aggregate
}

export const analyticsQueue = new Queue<AggregateJobData>('analytics-agg', {
  connection,
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: 'fixed', delay: 60_000 },
    removeOnComplete: { count: 30 },
    removeOnFail: { count: 7 },
  },
});

// ── Daily snapshot computation ────────────────────────────────────────────────

async function upsertSnapshot(
  metric: string,
  granularity: string,
  periodStart: Date,
  value: number,
  metadata: object = {},
) {
  await prisma.dashboardMetricSnapshot.upsert({
    where: { metric_granularity_periodStart: { metric, granularity, periodStart } },
    create: { metric, granularity, periodStart, value, metadata, computedAt: new Date() },
    update: { value, metadata, computedAt: new Date() },
  });
}

async function upsertAggregation(
  aggType: string,
  periodDate: Date,
  cohortDate: Date | null,
  value: number,
  sampleSize: number,
  metadata: object = {},
) {
  await prisma.analyticsAggregation.upsert({
    where: {
      aggType_periodDate_cohortDate: {
        aggType,
        periodDate,
        cohortDate: cohortDate ?? new Date(0),
      },
    },
    create: { aggType, periodDate, cohortDate, value, sampleSize, metadata, computedAt: new Date() },
    update: { value, sampleSize, metadata, computedAt: new Date() },
  });
}

export async function runDailyAggregations(dateStr: string): Promise<void> {
  const day = new Date(`${dateStr}T00:00:00Z`);
  const dayEnd = new Date(day.getTime() + 24 * 60 * 60 * 1000);
  const d7Start = new Date(day.getTime() - 6 * 24 * 60 * 60 * 1000);
  const d30Start = new Date(day.getTime() - 29 * 24 * 60 * 60 * 1000);

  // ── User volume snapshots ──────────────────────────────────────────────────
  const [dau, wau, mau, newUsers] = await Promise.all([
    prisma.user.count({ where: { lastSeen: { gte: day, lt: dayEnd } } }),
    prisma.user.count({ where: { lastSeen: { gte: d7Start, lt: dayEnd } } }),
    prisma.user.count({ where: { lastSeen: { gte: d30Start, lt: dayEnd } } }),
    prisma.user.count({ where: { createdAt: { gte: day, lt: dayEnd } } }),
  ]);

  // ── Engagement snapshots ───────────────────────────────────────────────────
  const [messages, likes, chatsUnlocked] = await Promise.all([
    prisma.message.count({ where: { createdAt: { gte: day, lt: dayEnd } } }),
    prisma.like.count({ where: { createdAt: { gte: day, lt: dayEnd } } }),
    prisma.chat.count({ where: { isUnlocked: true, createdAt: { gte: day, lt: dayEnd } } }),
  ]);

  // ── Revenue snapshot ───────────────────────────────────────────────────────
  const revAgg = await prisma.transaction.aggregate({
    where: { type: 'CREDIT', createdAt: { gte: day, lt: dayEnd } },
    _sum: { amount: true },
  });
  const revenue = revAgg._sum.amount ?? 0;

  // Persist all daily snapshots
  await Promise.all([
    upsertSnapshot('DAU',            'DAILY', day, dau),
    upsertSnapshot('WAU',            'DAILY', day, wau),
    upsertSnapshot('MAU',            'DAILY', day, mau),
    upsertSnapshot('NEW_USERS',      'DAILY', day, newUsers),
    upsertSnapshot('MESSAGES',       'DAILY', day, messages),
    upsertSnapshot('MATCHES',        'DAILY', day, likes),
    upsertSnapshot('CHATS_UNLOCKED', 'DAILY', day, chatsUnlocked),
    upsertSnapshot('REVENUE',        'DAILY', day, revenue),
  ]);

  // ── Retention cohorts ──────────────────────────────────────────────────────
  // For users who registered on each day in the past 30 days, check if they
  // were active on `day` (D1/D7/D30 from their registration).

  // D1 retention: users registered yesterday still active today
  const d1CohortDate = new Date(day.getTime() - 1 * 24 * 60 * 60 * 1000);
  await computeRetention('RETENTION_D1', day, d1CohortDate, 1);

  // D7 retention: users registered 7 days ago still active today
  const d7CohortDate = new Date(day.getTime() - 7 * 24 * 60 * 60 * 1000);
  await computeRetention('RETENTION_D7', day, d7CohortDate, 7);

  // D30 retention: users registered 30 days ago still active today
  const d30CohortDate = new Date(day.getTime() - 30 * 24 * 60 * 60 * 1000);
  await computeRetention('RETENTION_D30', day, d30CohortDate, 30);

  // ── Revenue daily aggregation ──────────────────────────────────────────────
  await upsertAggregation('REVENUE_DAILY', day, null, revenue, 0);

  // ── Signup funnel ──────────────────────────────────────────────────────────
  // registered → completed profile → sent first like → sent first message
  const [registered, withProfile, likedOnce, chattedOnce] = await Promise.all([
    prisma.user.count({ where: { createdAt: { gte: day, lt: dayEnd } } }),
    prisma.profile.count({ where: { user: { createdAt: { gte: day, lt: dayEnd } } } }),
    prisma.like.groupBy({
      by: ['senderId'],
      where: { createdAt: { gte: day, lt: dayEnd } },
      _count: true,
    }).then((r) => r.length),
    prisma.message.groupBy({
      by: ['senderId'],
      where: { createdAt: { gte: day, lt: dayEnd } },
      _count: true,
    }).then((r) => r.length),
  ]);

  if (registered > 0) {
    await Promise.all([
      upsertAggregation('FUNNEL_PROFILE_COMPLETE', day, null, withProfile / registered, registered),
      upsertAggregation('FUNNEL_FIRST_LIKE', day, null, likedOnce / registered, registered),
      upsertAggregation('FUNNEL_FIRST_MESSAGE', day, null, chattedOnce / registered, registered),
    ]);
  }
}

async function computeRetention(
  aggType: string,
  periodDate: Date,
  cohortDate: Date,
  daysOffset: number,
) {
  const cohortEnd = new Date(cohortDate.getTime() + 24 * 60 * 60 * 1000);
  const activeWindow = new Date(periodDate.getTime() + 24 * 60 * 60 * 1000);

  // Cohort: users who registered on cohortDate
  const cohortUsers = await prisma.user.findMany({
    where: { createdAt: { gte: cohortDate, lt: cohortEnd } },
    select: { id: true },
  });

  if (cohortUsers.length === 0) return;

  const cohortIds = cohortUsers.map((u) => u.id);

  // Active: had any analytics event on periodDate
  const activeEvents = await prisma.analyticsEvent.groupBy({
    by: ['userId'],
    where: {
      userId: { in: cohortIds },
      occurredAt: { gte: periodDate, lt: activeWindow },
    },
  });

  const retentionRate = activeEvents.length / cohortUsers.length;
  await upsertAggregation(aggType, periodDate, cohortDate, retentionRate, cohortUsers.length, {
    daysOffset,
    cohortSize: cohortUsers.length,
    activeCount: activeEvents.length,
  });
}

// ── Worker ─────────────────────────────────────────────────────────────────────

const analyticsWorker = new Worker<AggregateJobData>(
  'analytics-agg',
  async (job: Job<AggregateJobData>) => {
    const log = queueLogger('analytics-agg', job.id);
    log.info({ date: job.data.date }, 'running daily analytics aggregations');
    await runDailyAggregations(job.data.date);
    log.info({ date: job.data.date }, 'analytics aggregations complete');
  },
  { connection, concurrency: 1 },
);

analyticsWorker.on('failed', (job, err) => {
  const log = queueLogger('analytics-agg', job?.id);
  log.error({ err: err.message }, 'analytics aggregation job failed');
  captureException(err, { jobId: job?.id, date: job?.data?.date });
});

// ── Schedule ──────────────────────────────────────────────────────────────────

export async function scheduleAnalyticsAggregations(): Promise<void> {
  // Run at 00:05 UTC daily (5 min after midnight to avoid race with DB writes)
  await analyticsQueue.add(
    'daily-agg',
    { date: 'PLACEHOLDER' }, // data is overridden by the repeat handler below
    {
      repeat: { pattern: '5 0 * * *', tz: 'UTC' },
      jobId: 'analytics-daily-agg',
    },
  );
}

// Utility: trigger a backfill for a specific date (useful for re-computing stale data)
export async function triggerAggregationForDate(dateStr: string): Promise<void> {
  await analyticsQueue.add('daily-agg-manual', { date: dateStr }, {
    jobId: `analytics-manual-${dateStr}`,
  });
}
