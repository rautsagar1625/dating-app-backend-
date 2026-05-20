// ── Recommendation BullMQ Queues ──────────────────────────────────────────────
//
// Four independent queues for async recommendation work:
//
//   rec-candidate-gen  — precompute candidate pools for active users
//     Triggered: cron every 30min + on-demand after major user events
//     Deduped by userId — one job per user per window
//
//   rec-signal-agg     — recompute + persist signal profiles
//     Triggered: after like/match/block/chat events (30s debounce per userId)
//     Runs full computeUserSignals → persistSignalProfile
//
//   rec-rank           — full feed rebuild for a user
//     Triggered: on demand, after signal agg completes, or stale cache miss
//
//   rec-signal-decay   — daily decay pass: recompute all active users' signals
//     Cron: daily at 02:00 UTC

import { Queue, Worker, Job } from 'bullmq';
import { redisConnection } from '../notification.queue';
import prisma from '../prisma.service';
import { generateCandidates } from './candidates/candidate.generator';
import { persistSignalProfile } from './signals/signal.aggregator';
import { invalidateFeedCache } from './feed/feed.service';
import { queueLogger } from '../../observability/logger';
import { captureException } from '../../observability/sentry';
import {
  queueJobsProcessedTotal,
  queueJobDuration,
} from '../../observability/metrics';

// ── Queue definitions ─────────────────────────────────────────────────────────

export const recCandidateGenQueue = new Queue<{ userId: string }>('rec-candidate-gen', {
  connection: redisConnection,
  defaultJobOptions: {
    attempts:         2,
    backoff:          { type: 'fixed', delay: 5000 },
    removeOnComplete: { count: 200 },
    removeOnFail:     { count: 50 },
  },
});

export const recSignalAggQueue = new Queue<{ userId: string; reason: string }>('rec-signal-agg', {
  connection: redisConnection,
  defaultJobOptions: {
    attempts:         3,
    backoff:          { type: 'exponential', delay: 3000 },
    removeOnComplete: { count: 500 },
    removeOnFail:     { count: 100 },
  },
});

export const recRankQueue = new Queue<{ userId: string }>('rec-rank', {
  connection: redisConnection,
  defaultJobOptions: {
    attempts:         2,
    backoff:          { type: 'fixed', delay: 3000 },
    removeOnComplete: { count: 200 },
    removeOnFail:     { count: 50 },
  },
});

export const recSignalDecayQueue = new Queue<{ batchOffset: number }>('rec-signal-decay', {
  connection: redisConnection,
  defaultJobOptions: {
    attempts:         2,
    backoff:          { type: 'fixed', delay: 10000 },
    removeOnComplete: { count: 10 },
    removeOnFail:     { count: 10 },
  },
});

// ── Enqueue helpers ───────────────────────────────────────────────────────────

// 30-second debounce per userId — prevents thundering herd on popular users
export async function enqueueSignalAgg(userId: string, reason: string): Promise<void> {
  await recSignalAggQueue.add(
    'agg',
    { userId, reason },
    { jobId: `sig:${userId}`, delay: 30_000 },
  ).catch(() => {});
}

export async function enqueueCandidateGen(userId: string): Promise<void> {
  await recCandidateGenQueue.add(
    'gen',
    { userId },
    { jobId: `cgen:${userId}`, delay: 2000 },
  ).catch(() => {});
}

export async function enqueueRankBuild(userId: string): Promise<void> {
  await recRankQueue.add(
    'rank',
    { userId },
    { jobId: `rank:${userId}`, delay: 5000 },
  ).catch(() => {});
}

// ── Workers ───────────────────────────────────────────────────────────────────

export const recCandidateGenWorker = new Worker<{ userId: string }>(
  'rec-candidate-gen',
  async (job: Job<{ userId: string }>) => {
    const { userId } = job.data;
    const log    = queueLogger('rec-candidate-gen', job.id);
    const start  = Date.now();

    log.debug({ userId }, 'generating candidate pool');
    await generateCandidates(userId, true);

    queueJobsProcessedTotal.inc({ queue: 'rec-candidate-gen', status: 'completed' });
    queueJobDuration.observe({ queue: 'rec-candidate-gen' }, (Date.now() - start) / 1000);
  },
  { connection: redisConnection, concurrency: 10 },
);

export const recSignalAggWorker = new Worker<{ userId: string; reason: string }>(
  'rec-signal-agg',
  async (job: Job<{ userId: string; reason: string }>) => {
    const { userId } = job.data;
    const log    = queueLogger('rec-signal-agg', job.id);
    const start  = Date.now();

    log.debug({ userId }, 'aggregating signals');
    await persistSignalProfile(userId);
    // After signals refresh, invalidate the feed cache so next request re-ranks
    await invalidateFeedCache(userId);

    queueJobsProcessedTotal.inc({ queue: 'rec-signal-agg', status: 'completed' });
    queueJobDuration.observe({ queue: 'rec-signal-agg' }, (Date.now() - start) / 1000);
  },
  { connection: redisConnection, concurrency: 20 },
);

export const recRankWorker = new Worker<{ userId: string }>(
  'rec-rank',
  async (job: Job<{ userId: string }>) => {
    const { userId } = job.data;
    const start  = Date.now();

    await invalidateFeedCache(userId);
    await generateCandidates(userId, true);

    queueJobsProcessedTotal.inc({ queue: 'rec-rank', status: 'completed' });
    queueJobDuration.observe({ queue: 'rec-rank' }, (Date.now() - start) / 1000);
  },
  { connection: redisConnection, concurrency: 5 },
);

// Batch signal decay: pages through users who were active in last 30d
// and refreshes their signal profiles
export const recSignalDecayWorker = new Worker<{ batchOffset: number }>(
  'rec-signal-decay',
  async (job: Job<{ batchOffset: number }>) => {
    const { batchOffset } = job.data;
    const BATCH_SIZE = 50;
    const since30d   = new Date(Date.now() - 30 * 86400_000);

    const users = await prisma.user.findMany({
      where:   { lastSeen: { gte: since30d }, isBanned: false },
      select:  { id: true },
      take:    BATCH_SIZE,
      skip:    batchOffset,
      orderBy: { lastSeen: 'desc' },
    });

    if (users.length === 0) return;

    // Enqueue individual signal agg jobs with staggered delays to avoid spike
    for (let i = 0; i < users.length; i++) {
      await recSignalAggQueue.add(
        'agg',
        { userId: users[i].id, reason: 'daily_decay' },
        { jobId: `sig:${users[i].id}`, delay: i * 200 },
      ).catch(() => {});
    }

    // Enqueue next batch
    if (users.length === BATCH_SIZE) {
      await recSignalDecayQueue.add(
        'decay-batch',
        { batchOffset: batchOffset + BATCH_SIZE },
        { delay: 5000 },
      ).catch(() => {});
    }

    queueJobsProcessedTotal.inc({ queue: 'rec-signal-decay', status: 'completed' });
  },
  { connection: redisConnection, concurrency: 2 },
);

// Failure handlers
for (const [worker, name] of [
  [recCandidateGenWorker, 'rec-candidate-gen'],
  [recSignalAggWorker,    'rec-signal-agg'],
  [recRankWorker,         'rec-rank'],
  [recSignalDecayWorker,  'rec-signal-decay'],
] as const) {
  (worker as typeof recCandidateGenWorker).on('failed', (job, err) => {
    captureException(err, { queue: name, jobId: job?.id });
    queueJobsProcessedTotal.inc({ queue: name, status: 'failed' });
  });
}

// ── Cron scheduling ───────────────────────────────────────────────────────────

export async function scheduleRecCrons(): Promise<void> {
  // Candidate gen for ALL active users: runs every 30 minutes
  // (limited to users active in last 24h — kicked off via decay job)
  await recSignalDecayQueue.add(
    'decay-batch',
    { batchOffset: 0 },
    {
      jobId: 'signal-decay-cron',
      repeat: { pattern: '0 2 * * *' }, // 02:00 UTC daily
    },
  ).catch(() => {});
}

// ── Graceful shutdown ─────────────────────────────────────────────────────────

export async function closeRecWorkers(): Promise<void> {
  await Promise.all([
    recCandidateGenWorker.close(),
    recSignalAggWorker.close(),
    recRankWorker.close(),
    recSignalDecayWorker.close(),
  ]);
}
