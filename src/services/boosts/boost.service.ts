// ── Boost & Visibility Economy ────────────────────────────────────────────────
//
// Manages profile boosts, spotlights, and super likes.
// Integrated with the recommendation engine via setBoost() in ranking.engine.ts.
//
// Fairness design:
//   - Boost score bonuses are capped by MONETIZATION_CAPS in weights.ts
//   - Maximum 1 active boost per user at a time
//   - Boost impressions capped to prevent feed monopolization
//   - Cooldown: 30 minutes between consecutive boosts
//   - Daily cap: 5 boosts per user per day (anti-spam)
//
// Redis keys:
//   boost:active:{userId}     → boostId + multiplier + expiresAt  TTL=boostDuration
//   boost:cooldown:{userId}   → "1"                               TTL=30min
//   boost:daily:{userId}      → count                             TTL=midnight

import IORedis from 'ioredis';
import prisma from '../prisma.service';
import { setBoost, clearBoost } from '../recommendation/ranking/ranking.engine';
import { PRODUCT_CATALOG } from '../payments/payment.types';
import { logger } from '../../observability/logger';
import { boostActivatedTotal, boostExpiredTotal, boostImpressionTotal } from '../../observability/metrics';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
export const boostRedis = new IORedis(REDIS_URL, {
  maxRetriesPerRequest: 2,
  lazyConnect: true,
  enableReadyCheck: false,
});
boostRedis.connect().catch(() => {});

const DAILY_BOOST_CAP = 5;
const COOLDOWN_SECS   = 30 * 60;  // 30 minutes

const boostActiveKey   = (userId: string) => `boost:active:${userId}`;
const boostCooldownKey = (userId: string) => `boost:cooldown:${userId}`;
const boostDailyKey    = (userId: string) => {
  const d = new Date();
  return `boost:daily:${userId}:${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
};

// ── Activate boost from payment ───────────────────────────────────────────────

export async function activateBoostFromPayment(params: {
  sessionId: string;
  userId:    string;
  productId: string;
}): Promise<void> {
  const { sessionId, userId, productId } = params;

  // Idempotency
  const session = await prisma.paymentSession.findUnique({
    where:  { id: sessionId },
    select: { metadata: true, status: true },
  });
  if (!session || session.status !== 'SUCCESS') return;
  if ((session.metadata as any)?.boostActivated) return;

  const sku = PRODUCT_CATALOG[productId];
  if (!sku || sku.type !== 'BOOST') return;

  const boostConfig = getBoostConfig(productId);
  await activateBoost({ userId, type: boostConfig.type, durationMinutes: boostConfig.durationMinutes, multiplier: boostConfig.multiplier, sessionId });

  // Mark session fulfilled
  await prisma.paymentSession.update({
    where: { id: sessionId },
    data:  { metadata: { ...(session.metadata as any), boostActivated: true } as any },
  }).catch(() => {});
}

// ── Activate boost directly (also used for subscription perks) ────────────────

export async function activateBoost(params: {
  userId:          string;
  type:            string;
  durationMinutes: number;
  multiplier:      number;
  sessionId?:      string;
  impressionsCap?: number;
}): Promise<{ boostId: string }> {
  const { userId, type, durationMinutes, multiplier, sessionId, impressionsCap } = params;

  // Cooldown check
  const onCooldown = await boostRedis.get(boostCooldownKey(userId));
  if (onCooldown) {
    const ttl = await boostRedis.ttl(boostCooldownKey(userId));
    throw Object.assign(new Error(`Boost cooldown active — ${ttl}s remaining`), { statusCode: 429, ttlSeconds: ttl });
  }

  // Daily cap check
  const dailyKey   = boostDailyKey(userId);
  const dailyCount = parseInt((await boostRedis.get(dailyKey)) ?? '0', 10);
  if (dailyCount >= DAILY_BOOST_CAP) {
    throw Object.assign(new Error('Daily boost limit reached'), { statusCode: 429 });
  }

  // Cancel any existing active boost
  const existingBoostId = await boostRedis.get(boostActiveKey(userId));
  if (existingBoostId) {
    await expireBoost(existingBoostId, userId);
  }

  const now       = new Date();
  const expiresAt = new Date(now.getTime() + durationMinutes * 60_000);

  const boost = await prisma.boostCampaign.create({
    data: {
      userId,
      type,
      status:          'ACTIVE',
      paymentSessionId: sessionId,
      multiplier,
      durationMinutes,
      impressionsCap:  impressionsCap ?? null,
      startedAt:       now,
      expiresAt,
    },
    select: { id: true },
  });

  const ttlSecs = durationMinutes * 60;

  // Cache active boost state in Redis
  await boostRedis.setex(
    boostActiveKey(userId),
    ttlSecs,
    JSON.stringify({ boostId: boost.id, multiplier, expiresAt: expiresAt.getTime() }),
  );

  // Set cooldown for next boost (starts after this one expires)
  await boostRedis.setex(boostCooldownKey(userId), ttlSecs + COOLDOWN_SECS, '1');

  // Increment daily counter (TTL = end of UTC day)
  const secsUntilMidnight = Math.floor((new Date(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1).getTime() - now.getTime()) / 1000);
  const newCount = await boostRedis.incr(dailyKey);
  if (newCount === 1) await boostRedis.expire(dailyKey, secsUntilMidnight);

  // Inject into recommendation engine
  await setBoost(userId, multiplier, ttlSecs);

  boostActivatedTotal.inc({ type });
  logger.info({ boostId: boost.id, userId, type, durationMinutes, multiplier }, 'boost activated');
  return { boostId: boost.id };
}

// ── Expire boost ──────────────────────────────────────────────────────────────

export async function expireBoost(boostId: string, userId: string): Promise<void> {
  await prisma.boostCampaign.update({
    where: { id: boostId },
    data:  { status: 'EXHAUSTED' },
  }).catch(() => {});

  await boostRedis.del(boostActiveKey(userId));
  await clearBoost(userId);

  boostExpiredTotal.inc();
  logger.debug({ boostId, userId }, 'boost expired');
}

// ── Record impression ─────────────────────────────────────────────────────────

export async function recordBoostImpression(userId: string): Promise<void> {
  const raw = await boostRedis.get(boostActiveKey(userId));
  if (!raw) return;

  const { boostId } = JSON.parse(raw) as { boostId: string; multiplier: number; expiresAt: number };

  const boost = await prisma.boostCampaign.update({
    where: { id: boostId, status: 'ACTIVE' },
    data:  { impressionsSent: { increment: 1 } },
    select: { impressionsSent: true, impressionsCap: true },
  }).catch(() => null);

  if (!boost) return;

  boostImpressionTotal.inc({ type: 'boost' });

  // Exhaust if impression cap hit
  if (boost.impressionsCap && boost.impressionsSent >= boost.impressionsCap) {
    await expireBoost(boostId, userId);
  }
}

// ── Get active boost state ────────────────────────────────────────────────────

export async function getActiveBoost(userId: string): Promise<{
  boostId: string;
  multiplier: number;
  expiresAt: Date;
} | null> {
  const raw = await boostRedis.get(boostActiveKey(userId));
  if (!raw) return null;
  const data = JSON.parse(raw) as { boostId: string; multiplier: number; expiresAt: number };
  return { ...data, expiresAt: new Date(data.expiresAt) };
}

// ── Config helpers ────────────────────────────────────────────────────────────

function getBoostConfig(productId: string): { type: string; durationMinutes: number; multiplier: number } {
  const configs: Record<string, { type: string; durationMinutes: number; multiplier: number }> = {
    boost_30min:    { type: 'BOOST',      durationMinutes: 30,   multiplier: 1.5 },
    spotlight_24h:  { type: 'SPOTLIGHT',  durationMinutes: 1440, multiplier: 1.3 },
    superlike_5pack:{ type: 'SUPERLIKE',  durationMinutes: 0,    multiplier: 2.0 },
  };
  return configs[productId] ?? { type: 'BOOST', durationMinutes: 30, multiplier: 1.5 };
}
