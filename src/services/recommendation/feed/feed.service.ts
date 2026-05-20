// ── Feed Orchestration Service ────────────────────────────────────────────────
//
// Assembles a ranked, deduplicated, fatigue-controlled feed for a user.
//
// Pipeline:
//   1. Start / resume feed session
//   2. Check Redis feed cache (15-min TTL)
//   3. On miss: generate candidates → load signals → rank → diversify
//   4. Apply fatigue multipliers (penalize / suppress re-shown profiles)
//   5. Apply session dedup (don't repeat within same API call sequence)
//   6. Inject freshness slots every 5th position
//   7. Slice to requested limit
//   8. Persist impressions async (non-blocking)
//   9. Enqueue signal refresh if signals are stale
//
// Cache strategy:
//   rec:feed:{userId}  → JSON array of RankedCandidate, TTL 15min
//   Invalidated on: feedback LIKE/BLOCK/REPORT, signal update, pool refresh

import IORedis from 'ioredis';
import prisma from '../../prisma.service';
import { generateCandidates } from '../candidates/candidate.generator';
import { getUserSignals, getPopulationStats } from '../signals/signal.aggregator';
import { rankCandidates } from '../ranking/ranking.engine';
import { DEFAULT_WEIGHTS } from '../ranking/weights';
import {
  getSeenIn24h,
  fatigueMultiplier,
  injectFreshnessSlots,
  recordImpressionBatch,
  SessionDedup,
} from './fatigue.controller';
import { getExperimentAssignment } from '../experiments/experiment.service';
import { captureException } from '../../../observability/sentry';
import { logger } from '../../../observability/logger';
import {
  recFeedGenerationDuration,
  recCandidatePoolSize,
  recFeedCacheHit,
} from '../../../observability/metrics';
import type { FeedRequest, FeedResult, RankedCandidate } from '../rec.types';
import { RANK_VERSION } from '../rec.types';
import { randomUUID } from 'crypto';

const REDIS_URL  = process.env.REDIS_URL ?? 'redis://localhost:6379';
const feedRedis  = new IORedis(REDIS_URL, {
  maxRetriesPerRequest: 2,
  lazyConnect: true,
  enableReadyCheck: false,
});
feedRedis.connect().catch(() => {});

const FEED_KEY     = (uid: string) => `rec:feed:${uid}`;
const SESSION_KEY  = (uid: string) => `rec:session:${uid}`;
const FEED_TTL     = 15 * 60;   // 15 minutes
const SESSION_TTL  = 30 * 60;   // 30 minutes
const MAX_FEED_SIZE = 200;       // pre-generate N, serve slices from cache

// ── Session management ────────────────────────────────────────────────────────

async function getOrCreateSession(userId: string): Promise<string> {
  try {
    const existing = await feedRedis.get(SESSION_KEY(userId));
    if (existing) return existing;
  } catch { /* miss */ }

  const sessionId = randomUUID();

  try {
    await feedRedis.setex(SESSION_KEY(userId), SESSION_TTL, sessionId);
  } catch { /* non-critical */ }

  // Persist to DB for analytics
  prisma.feedSession.create({
    data: { userId, id: sessionId, rankVersion: RANK_VERSION },
  }).catch(() => {});

  return sessionId;
}

// ── Feed cache ────────────────────────────────────────────────────────────────

async function getCachedFeed(userId: string): Promise<RankedCandidate[] | null> {
  try {
    const raw = await feedRedis.get(FEED_KEY(userId));
    if (raw) return JSON.parse(raw) as RankedCandidate[];
  } catch { /* miss */ }
  return null;
}

async function cacheFeed(userId: string, feed: RankedCandidate[]): Promise<void> {
  try {
    await feedRedis.setex(FEED_KEY(userId), FEED_TTL, JSON.stringify(feed));
  } catch { /* non-critical */ }
}

export async function invalidateFeedCache(userId: string): Promise<void> {
  try {
    await feedRedis.del(FEED_KEY(userId));
  } catch { /* non-critical */ }
}

// ── Core feed assembly ────────────────────────────────────────────────────────

async function buildFeed(userId: string): Promise<RankedCandidate[]> {
  const timerStart = Date.now();

  // 1. Get or generate candidates
  const candidates = await generateCandidates(userId);
  recCandidatePoolSize.observe(candidates.length);

  if (candidates.length === 0) return [];

  // 2. Resolve ranking weights (experiment or default)
  const assignment = await getExperimentAssignment(userId);
  const weights    = assignment?.weights ?? DEFAULT_WEIGHTS;

  // 3. Load viewer signals
  const [viewerSignals, seenSet] = await Promise.all([
    getUserSignals(userId),
    getSeenIn24h(userId),
  ]);

  // 4. Load candidate signals in parallel (batch — use DB or cached signals)
  const candidateSignalsMap = new Map(
    await Promise.all(
      candidates.map(async (c) => [c.userId, await getUserSignals(c.userId).catch(() => null)] as const),
    ),
  );

  // 5. Apply fatigue multipliers
  const fatigued = await Promise.all(
    candidates.map(async (c) => {
      const mult = await fatigueMultiplier(userId, c.userId);
      return { ...c, preScore: c.preScore * mult };
    }),
  );

  // Filter out hard-suppressed (mult = 0)
  const active = fatigued.filter((c) => c.preScore > 0);

  // 6. Rank
  const ranked = await rankCandidates(active, viewerSignals, candidateSignalsMap as any, weights);

  // 7. Inject freshness slots using FRESH pool as donor
  const freshPool = active.filter((c) => c.poolType === 'FRESH');
  const final = injectFreshnessSlots(ranked, freshPool as any, seenSet);

  recFeedGenerationDuration.observe((Date.now() - timerStart) / 1000);
  return final.slice(0, MAX_FEED_SIZE);
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function getFeed(req: FeedRequest): Promise<FeedResult> {
  const { userId, limit, offset, forceRefresh } = req;

  const sessionId = await getOrCreateSession(userId);

  // Attempt cache read
  let feed = forceRefresh ? null : await getCachedFeed(userId);
  const fromCache = feed !== null;

  if (fromCache) {
    recFeedCacheHit.inc({ hit: '1' });
  } else {
    recFeedCacheHit.inc({ hit: '0' });
  }

  if (!feed) {
    try {
      feed = await buildFeed(userId);
      await cacheFeed(userId, feed);
    } catch (err) {
      captureException(err as Error, { userId });
      logger.error({ err, userId }, 'feed generation failed');
      feed = [];
    }
  }

  // Session-level dedup: filter out profiles already returned this session
  // (tracked by offset — simple slice works if clients page sequentially)
  const page = feed.slice(offset, offset + limit);

  // Record impressions async (non-blocking)
  if (page.length > 0) {
    recordImpressionBatch(userId, page.map((p) => p.userId)).catch(() => {});
  }

  return {
    profiles:    page,
    sessionId,
    rankVersion: RANK_VERSION,
    fromCache,
    generatedAt: new Date(),
  };
}

// ── Admin: snapshot for debuggability ────────────────────────────────────────

export async function snapshotFeed(userId: string): Promise<void> {
  try {
    const assignment = await getExperimentAssignment(userId);
    const weights    = assignment?.weights ?? DEFAULT_WEIGHTS;
    const feed       = await buildFeed(userId);

    await prisma.recommendationSnapshot.create({
      data: {
        userId,
        rankVersion: RANK_VERSION,
        topN:    feed.slice(0, 20).map((c) => ({
          candidateId: c.userId,
          score:       c.score,
          factors:     c.factors,
        })),
        weights,
      },
    });
  } catch (err) {
    logger.error({ err, userId }, 'feed snapshot failed');
  }
}
