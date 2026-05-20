// ── Entitlement Engine ────────────────────────────────────────────────────────
//
// Single source of truth for "what can this user do right now?"
// Architecture:
//   - Redis is the hot cache (5-min TTL, refreshed on any subscription event)
//   - DB SubscriptionEntitlement is the durable record
//   - checkEntitlement() is the performance-critical path — Redis only
//   - Feature gates integrate here: premium features call hasEntitlement()
//
// Redis key: ent:{userId} → JSON { features: string[], expiresAt: number }
// TTL: 300s (5 min). On subscription change, key is deleted to force refresh.
//
// Feature strings (from TIER_FEATURES in subscription.types.ts):
//   UNLIMITED_LIKES, SEE_WHO_LIKED_YOU, ADVANCED_FILTERS, READ_RECEIPTS,
//   PRIORITY_RANKING, AD_FREE, FREE_CHAT_UNLOCKS, INVISIBLE_BROWSE,
//   SUPER_LIKES_5_MONTHLY, SUPER_LIKES_10_MONTHLY, PROFILE_BADGE,
//   CONCIERGE_SUPPORT, PROFILE_BOOST_WEEKLY

import IORedis from 'ioredis';
import prisma from '../prisma.service';
import { TIER_FEATURES, type SubscriptionTier } from '../subscriptions/subscription.types';
import { emitToUser } from '../socket.service';
import { logger } from '../../observability/logger';
import { entitlementCacheHit, entitlementCacheMiss, entitlementCheckTotal } from '../../observability/metrics';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
export const entRedis = new IORedis(REDIS_URL, {
  maxRetriesPerRequest: 2,
  lazyConnect: true,
  enableReadyCheck: false,
});
entRedis.connect().catch(() => {});

const ENT_TTL = 300;  // 5 minutes
const entKey  = (userId: string) => `ent:${userId}`;

interface EntitlementCache {
  features:  string[];
  tier?:     string;
  expiresAt: number;  // Unix ms — subscription period end
}

// ── Read path (hot) ───────────────────────────────────────────────────────────

export async function hasEntitlement(userId: string, feature: string): Promise<boolean> {
  entitlementCheckTotal.inc({ feature });
  const features = await getEntitlements(userId);
  return features.includes(feature);
}

export async function getEntitlements(userId: string): Promise<string[]> {
  // Fast path: Redis cache
  try {
    const cached = await entRedis.get(entKey(userId));
    if (cached) {
      entitlementCacheHit.inc();
      const data = JSON.parse(cached) as EntitlementCache;
      if (data.expiresAt > Date.now()) return data.features;
      // Subscription expired — evict and return empty
      await entRedis.del(entKey(userId));
    }
  } catch { /* Redis unavailable — fall through to DB */ }

  entitlementCacheMiss.inc();
  return refreshEntitlementCache(userId);
}

export async function getEntitlementBundle(userId: string): Promise<EntitlementCache> {
  const cached = await entRedis.get(entKey(userId));
  if (cached) {
    return JSON.parse(cached) as EntitlementCache;
  }
  const features = await refreshEntitlementCache(userId);
  return { features, expiresAt: Date.now() + 86400_000 };
}

async function refreshEntitlementCache(userId: string): Promise<string[]> {
  const now = new Date();
  const entitlements = await prisma.subscriptionEntitlement.findMany({
    where: { userId, expiresAt: { gt: now } },
    select: { feature: true, expiresAt: true },
  });

  if (entitlements.length === 0) {
    // Cache the empty state so we don't hammer DB
    await entRedis.setex(entKey(userId), ENT_TTL, JSON.stringify({ features: [], expiresAt: now.getTime() })).catch(() => {});
    return [];
  }

  const features   = entitlements.map((e) => e.feature);
  const expiresAt  = Math.min(...entitlements.map((e) => e.expiresAt.getTime()));
  const cacheData: EntitlementCache = { features, expiresAt };

  // Infer tier from features for convenience
  for (const [tier, tierFeatures] of Object.entries(TIER_FEATURES)) {
    if (tierFeatures.every((f) => features.includes(f))) {
      cacheData.tier = tier;
      break;
    }
  }

  await entRedis.setex(entKey(userId), ENT_TTL, JSON.stringify(cacheData)).catch(() => {});
  return features;
}

// ── Write path ────────────────────────────────────────────────────────────────

export async function provisionEntitlements(
  userId:         string,
  subscriptionId: string,
  tier:           SubscriptionTier,
): Promise<void> {
  const features  = TIER_FEATURES[tier];
  const expiresAt = await getSubscriptionExpiry(subscriptionId);

  // Upsert all features for this subscription tier
  await prisma.$transaction(
    features.map((feature) =>
      prisma.subscriptionEntitlement.upsert({
        where:  { userId_feature: { userId, feature } },
        create: { userId, subscriptionId, feature, expiresAt },
        update: { subscriptionId, expiresAt },
      }),
    ),
  );

  // Remove entitlements for features NOT in this tier (downgrade scenario)
  await prisma.subscriptionEntitlement.deleteMany({
    where: {
      userId,
      feature: { notIn: features },
    },
  });

  // Invalidate cache — next read will rebuild
  await entRedis.del(entKey(userId)).catch(() => {});

  // Push realtime entitlement update to all user devices
  emitToUser(userId, 'entitlements:refreshed', { tier, features });

  logger.info({ userId, tier, featureCount: features.length }, 'entitlements provisioned');
}

export async function revokeEntitlements(userId: string, subscriptionId: string): Promise<void> {
  await prisma.subscriptionEntitlement.deleteMany({
    where: { userId, subscriptionId },
  });

  await entRedis.del(entKey(userId)).catch(() => {});
  emitToUser(userId, 'entitlements:refreshed', { tier: null, features: [] });
  logger.info({ userId, subscriptionId }, 'entitlements revoked');
}

// Extend entitlements when subscription renews
export async function extendEntitlements(userId: string, subscriptionId: string, newExpiresAt: Date): Promise<void> {
  await prisma.subscriptionEntitlement.updateMany({
    where: { userId, subscriptionId },
    data:  { expiresAt: newExpiresAt },
  });
  await entRedis.del(entKey(userId)).catch(() => {});
}

// ── Middleware helper — use in route guards ────────────────────────────────────

export async function requireEntitlement(userId: string, feature: string): Promise<void> {
  const has = await hasEntitlement(userId, feature);
  if (!has) {
    throw Object.assign(
      new Error(`Premium feature required: ${feature}`),
      { statusCode: 402, code: 'ENTITLEMENT_REQUIRED', feature },
    );
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function getSubscriptionExpiry(subscriptionId: string): Promise<Date> {
  const sub = await prisma.subscription.findUnique({
    where:  { id: subscriptionId },
    select: { currentPeriodEnd: true },
  });
  return sub?.currentPeriodEnd ?? new Date(Date.now() + 30 * 86400_000);
}
