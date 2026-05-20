// ── Feed Fatigue Controller ───────────────────────────────────────────────────
//
// Prevents repetitive feeds and manages cooldown windows.
//
// Layers:
//   1. Session dedup   — profiles seen in the current API session (in-memory)
//   2. Daily dedup     — profiles seen in the last 24h (Redis set, TTL 24h)
//   3. Soft cooldown   — profiles seen 2+ times get a score penalty
//   4. Hard cooldown   — profiles seen ≥ 4 times are suppressed for 48h
//   5. Freshness slot  — every Nth position reserved for a fresh (never-seen) profile
//
// The FeedImpression table (already in schema) is the durable record.
// Redis is the hot layer used at feed-generation time.

import IORedis from 'ioredis';
import prisma from '../../prisma.service';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
const fatigueRedis = new IORedis(REDIS_URL, {
  maxRetriesPerRequest: 1,
  lazyConnect: true,
  enableReadyCheck: false,
});
fatigueRedis.connect().catch(() => {});

const SEEN_24H_KEY     = (uid: string) => `rec:seen_24h:${uid}`;
const SEEN_COUNT_KEY   = (uid: string, tgt: string) => `rec:seen_count:${uid}:${tgt}`;
const SEEN_24H_TTL     = 24 * 3600;
const SEEN_COUNT_TTL   = 48 * 3600;

const SOFT_COOLDOWN_THRESHOLD = 2;    // seen ≥ 2 times → score penalty
const HARD_COOLDOWN_THRESHOLD = 4;    // seen ≥ 4 times → suppress for 48h
const SCORE_DECAY_PER_VIEW    = 0.15; // score multiplier reduction per re-view
const FRESHNESS_SLOT_INTERVAL = 5;    // every 5th position inject a fresh profile

// ── Impression recording ──────────────────────────────────────────────────────

export async function recordImpression(viewerId: string, profileId: string): Promise<void> {
  // 1. Update FeedImpression (durable dedup table)
  await prisma.feedImpression.upsert({
    where:  { viewerId_profileId: { viewerId, profileId } },
    create: { viewerId, profileId },
    update: { seenAt: new Date() },
  }).catch(() => {});

  // 2. Add to daily Redis set
  try {
    const key = SEEN_24H_KEY(viewerId);
    await fatigueRedis.sadd(key, profileId);
    await fatigueRedis.expire(key, SEEN_24H_TTL);
  } catch { /* non-critical */ }

  // 3. Increment per-target view counter
  try {
    const countKey = SEEN_COUNT_KEY(viewerId, profileId);
    await fatigueRedis.incr(countKey);
    await fatigueRedis.expire(countKey, SEEN_COUNT_TTL);
  } catch { /* non-critical */ }
}

export async function recordImpressionBatch(
  viewerId:   string,
  profileIds: string[],
): Promise<void> {
  await Promise.all(profileIds.map((id) => recordImpression(viewerId, id)));
}

// ── Seen-set queries ──────────────────────────────────────────────────────────

export async function getSeenIn24h(viewerId: string): Promise<Set<string>> {
  try {
    const members = await fatigueRedis.smembers(SEEN_24H_KEY(viewerId));
    return new Set(members);
  } catch {
    return new Set();
  }
}

export async function getViewCount(viewerId: string, profileId: string): Promise<number> {
  try {
    const val = await fatigueRedis.get(SEEN_COUNT_KEY(viewerId, profileId));
    return val ? parseInt(val, 10) : 0;
  } catch {
    return 0;
  }
}

// ── Fatigue scoring ───────────────────────────────────────────────────────────

// Returns a multiplier (0-1) to apply to final rank score.
// 1.0 = no fatigue, 0.0 = fully suppressed.
export async function fatigueMultiplier(
  viewerId:  string,
  profileId: string,
): Promise<number> {
  const count = await getViewCount(viewerId, profileId);

  if (count >= HARD_COOLDOWN_THRESHOLD) return 0;                              // suppress
  if (count >= SOFT_COOLDOWN_THRESHOLD) {
    return Math.max(1 - (count - SOFT_COOLDOWN_THRESHOLD + 1) * SCORE_DECAY_PER_VIEW, 0.1);
  }
  return 1.0;
}

// ── Freshness slot injection ──────────────────────────────────────────────────
// Given a sorted list of candidates, replaces every Nth slot with a profile
// the viewer has NEVER seen (ensuring feed freshness).

export function injectFreshnessSlots<T extends { userId: string }>(
  ranked:     T[],
  freshPool:  T[],
  seenSet:    Set<string>,
): T[] {
  if (freshPool.length === 0) return ranked;

  const result    = [...ranked];
  const freshCopy = freshPool.filter((c) => !seenSet.has(c.userId));
  let   freshIdx  = 0;

  for (let i = FRESHNESS_SLOT_INTERVAL - 1; i < result.length && freshIdx < freshCopy.length; i += FRESHNESS_SLOT_INTERVAL) {
    if (seenSet.has(result[i].userId)) {
      result[i] = freshCopy[freshIdx++];
    }
  }

  return result;
}

// ── Session-level dedup (in-memory, no persistence needed) ───────────────────

export class SessionDedup {
  private seen = new Set<string>();

  add(profileId: string): void {
    this.seen.add(profileId);
  }

  has(profileId: string): boolean {
    return this.seen.has(profileId);
  }

  filter<T extends { userId: string }>(candidates: T[]): T[] {
    return candidates.filter((c) => !this.seen.has(c.userId));
  }
}
