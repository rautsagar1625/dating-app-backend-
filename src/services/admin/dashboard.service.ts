// ── Admin Dashboard Service ────────────────────────────────────────────────────
// All dashboard reads go through a 60-second Redis cache so the dashboard
// endpoint is cheap to poll from the frontend without hammering the DB.

import IORedis from 'ioredis';
import prisma from '../prisma.service';
import {
  mediaProcessQueue,
  mediaModerateQueue,
  mediaCleanupQueue,
} from '../media/media.queue';
import { fraudQueue } from '../fraud/fraud.queue';

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const redis = new IORedis(REDIS_URL, { maxRetriesPerRequest: 2, lazyConnect: true });
redis.connect().catch(() => {});

const CACHE_TTL = 60; // seconds

async function cachedQuery<T>(key: string, fn: () => Promise<T>): Promise<T> {
  try {
    const cached = await redis.get(key);
    if (cached) return JSON.parse(cached) as T;
  } catch {
    // Redis miss — fall through to DB
  }
  const result = await fn();
  try {
    await redis.setex(key, CACHE_TTL, JSON.stringify(result));
  } catch {
    // Non-critical
  }
  return result;
}

// ── User metrics ───────────────────────────────────────────────────────────────

async function computeUserMetrics() {
  const now = new Date();
  const d1  = new Date(now.getTime() - 1  * 24 * 60 * 60 * 1000);
  const d7  = new Date(now.getTime() - 7  * 24 * 60 * 60 * 1000);
  const d30 = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const [total, active24h, active7d, active30d, newToday, bannedCount] = await Promise.all([
    prisma.user.count(),
    prisma.user.count({ where: { lastSeen: { gte: d1 } } }),
    prisma.user.count({ where: { lastSeen: { gte: d7 } } }),
    prisma.user.count({ where: { lastSeen: { gte: d30 } } }),
    prisma.user.count({ where: { createdAt: { gte: startOfDay(now) } } }),
    prisma.user.count({ where: { isBanned: true } }),
  ]);

  return { total, dau: active24h, wau: active7d, mau: active30d, newToday, bannedCount };
}

// ── Engagement metrics ─────────────────────────────────────────────────────────

async function computeEngagementMetrics() {
  const now = new Date();
  const lastHour = new Date(now.getTime() - 60 * 60 * 1000);

  const [messagesToday, messagesLastHour, likesToday, chatsUnlockedToday, reportsOpen] =
    await Promise.all([
      prisma.message.count({ where: { createdAt: { gte: startOfDay(now) } } }),
      prisma.message.count({ where: { createdAt: { gte: lastHour } } }),
      prisma.like.count({ where: { createdAt: { gte: startOfDay(now) } } }),
      prisma.chat.count({ where: { isUnlocked: true, createdAt: { gte: startOfDay(now) } } }),
      prisma.report.count({ where: { isResolved: false } }),
    ]);

  return {
    messagesToday,
    messagesPerHour: messagesLastHour,
    likesToday,
    chatsUnlockedToday,
    openReports: reportsOpen,
  };
}

// ── Revenue metrics ────────────────────────────────────────────────────────────

async function computeRevenueMetrics() {
  const now = new Date();
  const d30 = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const [todayTx, monthTx, totalCreditsIssued] = await Promise.all([
    prisma.transaction.aggregate({
      where: { type: 'CREDIT', createdAt: { gte: startOfDay(now) } },
      _sum: { amount: true },
      _count: true,
    }),
    prisma.transaction.aggregate({
      where: { type: 'CREDIT', createdAt: { gte: d30 } },
      _sum: { amount: true },
      _count: true,
    }),
    prisma.transaction.aggregate({
      where: { type: 'CREDIT' },
      _sum: { amount: true },
    }),
  ]);

  return {
    creditsIssuedToday: todayTx._sum.amount ?? 0,
    transactionsToday: todayTx._count,
    creditsIssuedLast30d: monthTx._sum.amount ?? 0,
    transactionsLast30d: monthTx._count,
    totalCreditsIssued: totalCreditsIssued._sum.amount ?? 0,
  };
}

// ── Fraud metrics ──────────────────────────────────────────────────────────────

async function computeFraudMetrics() {
  const [pendingCases, activeEnforcements, emulators, highRiskDevices] = await Promise.all([
    prisma.fraudCase.count({ where: { status: 'PENDING' } }),
    prisma.fraudEnforcementAction.count({ where: { isActive: true } }),
    prisma.deviceFingerprint.count({ where: { isEmulator: true } }),
    prisma.deviceFingerprint.count({ where: { riskLevel: { in: ['HIGH', 'CRITICAL', 'EXTREME'] } } }),
  ]);
  return { pendingCases, activeEnforcements, emulators, highRiskDevices };
}

// ── Media metrics ──────────────────────────────────────────────────────────────

async function computeMediaMetrics() {
  const now = new Date();
  const [pending, processing, failed, quarantined, uploadedToday] = await Promise.all([
    prisma.mediaAsset.count({ where: { status: 'PENDING' } }),
    prisma.mediaAsset.count({ where: { status: 'PROCESSING' } }),
    prisma.mediaAsset.count({ where: { status: 'FAILED' } }),
    prisma.mediaAsset.count({ where: { status: 'QUARANTINED' } }),
    prisma.mediaAsset.count({ where: { createdAt: { gte: startOfDay(now) } } }),
  ]);
  return { pending, processing, failed, quarantined, uploadedToday };
}

// ── Queue health ───────────────────────────────────────────────────────────────

export interface QueueStats {
  name:      string;
  waiting:   number;
  active:    number;
  completed: number;
  failed:    number;
  delayed:   number;
  paused:    boolean;
}

export async function getQueueStats(): Promise<QueueStats[]> {
  const queues = [
    { name: 'media-process',  queue: mediaProcessQueue  },
    { name: 'media-moderate', queue: mediaModerateQueue },
    { name: 'media-cleanup',  queue: mediaCleanupQueue  },
    { name: 'fraud',          queue: fraudQueue          },
  ];

  return Promise.all(
    queues.map(async ({ name, queue }) => {
      const [waiting, active, completed, failed, delayed, isPaused] = await Promise.all([
        queue.getWaitingCount(),
        queue.getActiveCount(),
        queue.getCompletedCount(),
        queue.getFailedCount(),
        queue.getDelayedCount(),
        queue.isPaused(),
      ]);
      return { name, waiting, active, completed, failed, delayed, paused: isPaused };
    }),
  );
}

// ── Full dashboard snapshot ────────────────────────────────────────────────────

export async function getLiveDashboard() {
  const [users, engagement, revenue, fraud, media] = await Promise.all([
    cachedQuery('admin:dash:users', computeUserMetrics),
    cachedQuery('admin:dash:engagement', computeEngagementMetrics),
    cachedQuery('admin:dash:revenue', computeRevenueMetrics),
    cachedQuery('admin:dash:fraud', computeFraudMetrics),
    cachedQuery('admin:dash:media', computeMediaMetrics),
  ]);

  // Queue stats are cheap in-memory calls — no cache needed
  const queues = await getQueueStats().catch(() => []);

  return { users, engagement, revenue, fraud, media, queues, generatedAt: new Date().toISOString() };
}

// ── Time-series data (last N days) ────────────────────────────────────────────

export async function getMetricTimeSeries(
  metric: string,
  days: number,
): Promise<Array<{ date: string; value: number }>> {
  const rows = await prisma.dashboardMetricSnapshot.findMany({
    where: {
      metric,
      granularity: 'DAILY',
      periodStart: { gte: new Date(Date.now() - days * 24 * 60 * 60 * 1000) },
    },
    orderBy: { periodStart: 'asc' },
    select: { periodStart: true, value: true },
  });
  return rows.map((r) => ({ date: r.periodStart.toISOString().slice(0, 10), value: r.value }));
}

// ── User investigation profile ─────────────────────────────────────────────────

export async function getUserInvestigationProfile(userId: string) {
  const [user, riskProfile, cases, enforcements, signals, mediaAssets, events] =
    await Promise.all([
      prisma.user.findUnique({
        where: { id: userId },
        include: { profile: true, wallet: true, pushTokens: { select: { token: true } } },
      }),
      prisma.userRiskProfile.findUnique({ where: { userId } }),
      prisma.fraudCase.findMany({
        where: { userId }, orderBy: { createdAt: 'desc' }, take: 10,
      }),
      prisma.fraudEnforcementAction.findMany({
        where: { userId }, orderBy: { createdAt: 'desc' }, take: 10,
      }),
      prisma.fraudSignal.findMany({
        where: { userId }, orderBy: { createdAt: 'desc' }, take: 20,
      }),
      prisma.mediaAsset.count({ where: { userId } }),
      prisma.analyticsEvent.findMany({
        where: { userId }, orderBy: { occurredAt: 'desc' }, take: 50,
      }),
    ]);

  if (!user) return null;

  return { user, riskProfile, cases, enforcements, signals, mediaAssets, recentEvents: events };
}

// ── Retention analytics ────────────────────────────────────────────────────────

export async function getRetentionData(days: number) {
  const rows = await prisma.analyticsAggregation.findMany({
    where: {
      aggType: { in: ['RETENTION_D1', 'RETENTION_D7', 'RETENTION_D30'] },
      periodDate: { gte: new Date(Date.now() - days * 24 * 60 * 60 * 1000) },
    },
    orderBy: { periodDate: 'asc' },
    select: { aggType: true, periodDate: true, value: true, sampleSize: true },
  });

  const byType: Record<string, Array<{ date: string; value: number; n: number }>> = {};
  for (const r of rows) {
    if (!byType[r.aggType]) byType[r.aggType] = [];
    byType[r.aggType].push({
      date: r.periodDate.toISOString().slice(0, 10),
      value: r.value,
      n: r.sampleSize,
    });
  }
  return byType;
}

// ── Revenue analytics ──────────────────────────────────────────────────────────

export async function getRevenueTimeSeries(days: number) {
  return getMetricTimeSeries('REVENUE', days);
}

export async function getTopSpenders(limit = 20) {
  const rows = await prisma.transaction.groupBy({
    by: ['userId'],
    where: { type: 'CREDIT' },
    _sum: { amount: true },
    orderBy: { _sum: { amount: 'desc' } },
    take: limit,
  });

  const userIds = rows.map((r) => r.userId);
  const users = await prisma.user.findMany({
    where: { id: { in: userIds } },
    select: { id: true, email: true, profile: { select: { username: true } } },
  });
  const userMap = Object.fromEntries(users.map((u) => [u.id, u]));

  return rows.map((r) => ({
    userId: r.userId,
    email: userMap[r.userId]?.email,
    username: userMap[r.userId]?.profile?.username,
    totalCredits: r._sum.amount ?? 0,
  }));
}

// ── Incident debugging ────────────────────────────────────────────────────────

export async function searchByRequestId(requestId: string) {
  const events = await prisma.analyticsEvent.findMany({
    where: { properties: { path: ['requestId'], equals: requestId } },
    orderBy: { occurredAt: 'desc' },
    take: 50,
  });
  return events;
}

export async function getUserActivityTimeline(userId: string, hours = 24) {
  const since = new Date(Date.now() - hours * 60 * 60 * 1000);
  const [events, messages, mediaUploads] = await Promise.all([
    prisma.analyticsEvent.findMany({
      where: { userId, occurredAt: { gte: since } },
      orderBy: { occurredAt: 'desc' },
    }),
    prisma.message.count({ where: { senderId: userId, createdAt: { gte: since } } }),
    prisma.mediaAsset.findMany({
      where: { userId, createdAt: { gte: since } },
      select: { id: true, mediaType: true, status: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    }),
  ]);
  return { events, messageSentCount: messages, mediaUploads };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function startOfDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

export async function invalidateDashboardCache(): Promise<void> {
  const keys = [
    'admin:dash:users',
    'admin:dash:engagement',
    'admin:dash:revenue',
    'admin:dash:fraud',
    'admin:dash:media',
  ];
  await Promise.all(keys.map((k) => redis.del(k).catch(() => {})));
}
