import IORedis from 'ioredis';
import type { FlagConfig } from './flag.types';
import { logger } from '../../observability/logger';

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const FLAGS_REDIS_KEY = 'velvet:flags:all';
const FLAGS_REDIS_TTL = 60; // seconds
const INVALIDATE_CHANNEL = 'velvet:flags:invalidated';
const LOCAL_TTL_MS = 10_000; // 10 s — avoids Redis round-trip on every request

// Separate connections: one for get/set/publish, one locked into subscribe mode
export const flagsRedis = new IORedis(REDIS_URL, {
  maxRetriesPerRequest: 2,
  enableReadyCheck: false,
  lazyConnect: true,
});

const flagsSub = new IORedis(REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  lazyConnect: true,
});

flagsRedis.connect().catch(() => {});
flagsSub.connect().catch(() => {});

// ── Local in-process cache (L1) ───────────────────────────────────────────────
let localCache: { data: FlagConfig[]; expiresAt: number } | null = null;

function getLocal(): FlagConfig[] | null {
  if (localCache && Date.now() < localCache.expiresAt) return localCache.data;
  localCache = null;
  return null;
}

function setLocal(data: FlagConfig[]): void {
  localCache = { data, expiresAt: Date.now() + LOCAL_TTL_MS };
}

function clearLocal(): void {
  localCache = null;
}

// ── Redis cache (L2) ──────────────────────────────────────────────────────────
export async function getCachedFlags(): Promise<FlagConfig[] | null> {
  const l1 = getLocal();
  if (l1) return l1;

  try {
    const raw = await flagsRedis.get(FLAGS_REDIS_KEY);
    if (!raw) return null;
    const flags = JSON.parse(raw) as FlagConfig[];
    setLocal(flags);
    return flags;
  } catch {
    return null; // Redis down — caller falls through to DB
  }
}

export async function setCachedFlags(flags: FlagConfig[]): Promise<void> {
  setLocal(flags);
  try {
    await flagsRedis.setex(FLAGS_REDIS_KEY, FLAGS_REDIS_TTL, JSON.stringify(flags));
  } catch {
    // Non-critical: next request will re-populate from DB
  }
}

// Called after any flag mutation: evicts both layers and notifies all server instances
export async function invalidateFlagsCache(): Promise<void> {
  clearLocal();
  try {
    await flagsRedis.del(FLAGS_REDIS_KEY);
    await flagsRedis.publish(INVALIDATE_CHANNEL, 'invalidated');
  } catch (err) {
    logger.warn({ err }, 'flags cache invalidation failed — local cache cleared, Redis stale');
  }
}

// All instances subscribe so their local caches are cleared on any mutation
flagsSub.subscribe(INVALIDATE_CHANNEL).catch(() => {});
flagsSub.on('message', () => {
  clearLocal();
});
