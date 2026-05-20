// ── Realtime Feedback Handler ─────────────────────────────────────────────────
//
// Processes user actions (likes, skips, blocks, reports, dwells) and propagates
// them into the recommendation system in two layers:
//
//   FAST PATH (synchronous, <5ms):
//     - Increment Redis signal counters
//     - Remove candidate from active pool on block/report
//     - Invalidate feed cache on high-signal actions
//
//   ASYNC PATH (BullMQ job):
//     - Recompute full signal profile
//     - Update DB RecommendationFeedback record
//     - Adjust candidate preScore weights
//     - Trigger trust score recompute on negative signals
//
// Never called on the hot message path — only on explicit user actions.

import IORedis from 'ioredis';
import prisma from '../../prisma.service';
import { invalidateFeedCache } from '../feed/feed.service';
import { invalidateCandidateCache } from '../candidates/candidate.generator';
import { invalidateSignalCache } from '../signals/signal.aggregator';
import { logger } from '../../../observability/logger';
import {
  recFeedbackTotal,
  recLikeConversionTotal,
} from '../../../observability/metrics';
import type { FeedbackSignal, FeedbackAction } from '../rec.types';

const REDIS_URL  = process.env.REDIS_URL ?? 'redis://localhost:6379';
const fbRedis    = new IORedis(REDIS_URL, {
  maxRetriesPerRequest: 1,
  lazyConnect: true,
  enableReadyCheck: false,
});
fbRedis.connect().catch(() => {});

// Redis counters (7-day sliding window)
const LIKE_RECV_KEY   = (uid: string) => `rec:fb:like_recv:${uid}`;
const SKIP_KEY        = (uid: string) => `rec:fb:skip:${uid}`;
const BLOCK_RECV_KEY  = (uid: string) => `rec:fb:block_recv:${uid}`;
const REPORT_RECV_KEY = (uid: string) => `rec:fb:report_recv:${uid}`;
const WINDOW_7D_S     = 7 * 86400;

// High-signal actions that require full cache bust
const CACHE_BUST_ACTIONS = new Set<FeedbackAction>(['LIKE', 'BLOCK', 'REPORT', 'MATCH', 'SUPERLIKE']);

// ── Fast path: Redis counter updates ─────────────────────────────────────────

async function updateRedisCounters(signal: FeedbackSignal): Promise<void> {
  const { userId, targetId, action } = signal;
  const pipeline = fbRedis.pipeline();

  try {
    switch (action) {
      case 'LIKE':
      case 'SUPERLIKE':
        pipeline.incr(LIKE_RECV_KEY(targetId));
        pipeline.expire(LIKE_RECV_KEY(targetId), WINDOW_7D_S);
        break;
      case 'SKIP':
        pipeline.incr(SKIP_KEY(userId));
        pipeline.expire(SKIP_KEY(userId), WINDOW_7D_S);
        break;
      case 'BLOCK':
        pipeline.incr(BLOCK_RECV_KEY(targetId));
        pipeline.expire(BLOCK_RECV_KEY(targetId), WINDOW_7D_S);
        break;
      case 'REPORT':
        pipeline.incr(REPORT_RECV_KEY(targetId));
        pipeline.expire(REPORT_RECV_KEY(targetId), WINDOW_7D_S);
        break;
    }

    await pipeline.exec();
  } catch { /* non-critical — counters are eventually-consistent supplements */ }
}

// ── Fast path: pool & cache invalidation ─────────────────────────────────────

async function handleCacheSideEffects(signal: FeedbackSignal): Promise<void> {
  const { userId, targetId, action } = signal;

  if (CACHE_BUST_ACTIONS.has(action)) {
    // Invalidate the viewer's feed so next load gets fresh ranking
    await invalidateFeedCache(userId);
  }

  if (action === 'BLOCK' || action === 'REPORT') {
    // Remove this target from the candidate pool immediately
    await invalidateCandidateCache(userId);
    // Also invalidate target's pool in case they had viewer as candidate
    await invalidateCandidateCache(targetId);
  }

  if (action === 'LIKE' || action === 'MATCH') {
    // Viewer's signal profile changed — signal cache should refresh
    await invalidateSignalCache(userId);
    await invalidateSignalCache(targetId);
  }
}

// ── Persist feedback to DB ────────────────────────────────────────────────────

async function persistFeedback(signal: FeedbackSignal): Promise<void> {
  await prisma.recommendationFeedback.create({
    data: {
      userId:      signal.userId,
      targetId:    signal.targetId,
      sessionId:   signal.sessionId,
      action:      signal.action,
      dwellMs:     signal.dwellMs,
      position:    signal.position,
      rankScore:   signal.rankScore,
      rankVersion: signal.rankVersion,
      signals:     signal.factors as object ?? undefined,
    },
  });
}

// ── Main handler ──────────────────────────────────────────────────────────────

export async function processFeedback(signal: FeedbackSignal): Promise<void> {
  try {
    // FAST PATH: counters + cache (both non-blocking on failure)
    await Promise.allSettled([
      updateRedisCounters(signal),
      handleCacheSideEffects(signal),
    ]);

    // ASYNC PATH: persist to DB (fire-and-forget)
    persistFeedback(signal).catch((err) => {
      logger.warn({ err, signal }, 'feedback persist failed');
    });

    // Track metrics
    recFeedbackTotal.inc({ action: signal.action });

    if (signal.action === 'MATCH') {
      recLikeConversionTotal.inc({ type: 'match' });
    }

    logger.debug({ userId: signal.userId, targetId: signal.targetId, action: signal.action }, 'feedback processed');
  } catch (err) {
    logger.error({ err, signal }, 'processFeedback failed');
  }
}

// ── Batch dwell recording (for client-reported dwell times) ──────────────────

export async function processDwellBatch(
  userId:   string,
  sessionId: string,
  dwells: Array<{ targetId: string; dwellMs: number; position: number }>,
): Promise<void> {
  // Only persist significant dwells (> 2 seconds = meaningful engagement)
  const significant = dwells.filter((d) => d.dwellMs > 2000);
  if (significant.length === 0) return;

  await Promise.allSettled(
    significant.map((d) =>
      processFeedback({
        userId,
        targetId:   d.targetId,
        sessionId,
        action:     'DWELL',
        dwellMs:    d.dwellMs,
        position:   d.position,
      }),
    ),
  );
}

// ── Session close ─────────────────────────────────────────────────────────────

export async function closeSession(
  userId:    string,
  sessionId: string,
  stats: { seenCount: number; likeCount: number; skipCount: number },
): Promise<void> {
  await prisma.feedSession.updateMany({
    where: { id: sessionId, userId },
    data:  {
      endedAt:   new Date(),
      seenCount: stats.seenCount,
      likeCount: stats.likeCount,
      skipCount: stats.skipCount,
    },
  }).catch(() => {});
}
