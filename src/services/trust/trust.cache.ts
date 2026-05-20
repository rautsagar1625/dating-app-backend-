// ── Trust score Redis hot cache ───────────────────────────────────────────────
//
// Trust scores are expensive to compute (multiple DB aggregates).
// Cache in Redis with a 5-minute TTL. On cache miss, compute and store.
// On any trust-affecting event, invalidate the cache immediately.

import IORedis from 'ioredis';
import type { TrustScoreSnapshot } from './trust.types';

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
export const trustRedis = new IORedis(REDIS_URL, {
  maxRetriesPerRequest: 2,
  lazyConnect: true,
  enableReadyCheck: false,
});
trustRedis.connect().catch(() => {});

const CACHE_TTL   = 5 * 60;   // 5 minutes
const KEY_PREFIX  = 'velvet:trust:score:';

export function trustKey(userId: string): string {
  return `${KEY_PREFIX}${userId}`;
}

export async function getCachedTrustScore(userId: string): Promise<TrustScoreSnapshot | null> {
  try {
    const raw = await trustRedis.get(trustKey(userId));
    if (raw) return JSON.parse(raw) as TrustScoreSnapshot;
  } catch {
    // Redis unavailable — fall through to DB compute
  }
  return null;
}

export async function setCachedTrustScore(snapshot: TrustScoreSnapshot): Promise<void> {
  try {
    await trustRedis.setex(trustKey(snapshot.userId), CACHE_TTL, JSON.stringify(snapshot));
  } catch {
    // Non-critical — DB is source of truth
  }
}

export async function invalidateTrustCache(userId: string): Promise<void> {
  try {
    await trustRedis.del(trustKey(userId));
  } catch {
    // Best-effort
  }
}
