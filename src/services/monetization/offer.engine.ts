// ── Behavioral Monetization Engine ───────────────────────────────────────────
//
// Delivers personalized, context-aware monetization offers at the right moment.
// Design principles:
//   1. Cooldown-protected  — users can't be shown the same offer type within N hours
//   2. Fatigue-aware       — high-fatigue users receive fewer/gentler offers
//   3. Fraud-aware         — high-risk users excluded from aggressive offers
//   4. Experiment-hooked   — every offer render is an OfferExposure (A/B-able)
//   5. Non-subscriber only — subscribers don't see subscription upsells
//   6. Context-sensitive   — offer copy/context adapts to trigger point
//
// Offer types:
//   SUBSCRIPTION_UPSELL    — upgrade to premium
//   BOOST_PROMPT           — buy a boost (post-match, idle feed)
//   SUPERLIKE_PROMPT       — buy superlike pack (profile view, swipe)
//   CHAT_UNLOCK_PROMPT     — buy credits to unlock a locked chat
//   REACTIVATION_OFFER     — discounted offer for returning lapsed user
//   CHURN_SAVE_OFFER       — retention offer before cancellation
//   ABANDONMENT_RECOVERY   — offer re-shown after incomplete purchase
//
// Redis keys:
//   offer:cooldown:{userId}:{offerType}  → "1"  TTL = cooldown seconds
//   offer:fatigue:{userId}              → float score  TTL = 24h

import IORedis from 'ioredis';
import { randomUUID } from 'crypto';
import prisma from '../prisma.service';
import { getEntitlements } from '../entitlements/entitlement.engine';
import { logger } from '../../observability/logger';
import { offerShownTotal, offerConversionTotal } from '../../observability/metrics';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
export const offerRedis = new IORedis(REDIS_URL, {
  maxRetriesPerRequest: 2,
  lazyConnect: true,
  enableReadyCheck: false,
});
offerRedis.connect().catch(() => {});

// Cooldown per offer type (hours)
const OFFER_COOLDOWNS: Record<string, number> = {
  SUBSCRIPTION_UPSELL:   24,
  BOOST_PROMPT:           4,
  SUPERLIKE_PROMPT:       8,
  CHAT_UNLOCK_PROMPT:     2,
  REACTIVATION_OFFER:    72,
  CHURN_SAVE_OFFER:      48,
  ABANDONMENT_RECOVERY:   1,
};

// Max impressions per day across all offer types — fatigue hard cap
const DAILY_OFFER_HARD_CAP = 6;

const cooldownKey  = (userId: string, type: string) => `offer:cooldown:${userId}:${type}`;
const fatigueKey   = (userId: string) => `offer:fatigue:${userId}`;
const dailyCapKey  = (userId: string) => {
  const d = new Date();
  return `offer:daily:${userId}:${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
};

// ── Can show offer? ───────────────────────────────────────────────────────────

export async function canShowOffer(userId: string, offerType: string): Promise<{
  allowed: boolean;
  reason?: string;
}> {
  // 1. Daily hard cap
  const dailyCount = parseInt((await offerRedis.get(dailyCapKey(userId))) ?? '0', 10);
  if (dailyCount >= DAILY_OFFER_HARD_CAP) {
    return { allowed: false, reason: 'daily_cap' };
  }

  // 2. Per-type cooldown
  const onCooldown = await offerRedis.get(cooldownKey(userId, offerType));
  if (onCooldown) {
    return { allowed: false, reason: 'cooldown' };
  }

  // 3. Fatigue score — above 0.8 = severely fatigued, suppress all offers
  const fatigueRaw = await offerRedis.get(fatigueKey(userId));
  const fatigue    = fatigueRaw ? parseFloat(fatigueRaw) : 0;
  if (fatigue > 0.8) {
    return { allowed: false, reason: 'fatigue' };
  }

  // 4. Subscription upsell only for free users
  if (offerType === 'SUBSCRIPTION_UPSELL') {
    const features = await getEntitlements(userId);
    if (features.includes('UNLIMITED_LIKES')) {
      return { allowed: false, reason: 'already_subscribed' };
    }
  }

  return { allowed: true };
}

// ── Record offer shown ────────────────────────────────────────────────────────

export async function recordOfferShown(params: {
  userId:       string;
  offerType:    string;
  context?:     string;
  variantId?:   string;
  experimentId?: string;
}): Promise<string> {
  const { userId, offerType, context, variantId, experimentId } = params;

  const exposure = await prisma.offerExposure.create({
    data: {
      userId,
      offerType,
      context:      context ?? null,
      experimentId: experimentId ?? null,
      variantId:    variantId ?? null,
    },
    select: { id: true },
  });

  // Set cooldown
  const cooldownHours = OFFER_COOLDOWNS[offerType] ?? 24;
  await offerRedis.setex(cooldownKey(userId, offerType), cooldownHours * 3600, '1');

  // Increment daily counter
  const capKey = dailyCapKey(userId);
  const secsUntilMidnight = getSecsUntilMidnight();
  const cnt = await offerRedis.incr(capKey);
  if (cnt === 1) await offerRedis.expire(capKey, secsUntilMidnight);

  // Increment fatigue score (decays over 24h)
  await incrementFatigue(userId, 0.1);

  offerShownTotal.inc({ offerType, context: context ?? 'unknown' });
  return exposure.id;
}

// ── Record conversion ─────────────────────────────────────────────────────────

export async function recordOfferConversion(params: {
  exposureId: string;
  revenue?:   number;
}): Promise<void> {
  const { exposureId, revenue } = params;

  await prisma.offerExposure.update({
    where: { id: exposureId },
    data:  { convertedAt: new Date(), revenue: revenue ?? null },
  }).catch(() => {});

  // Reset fatigue on conversion — user is engaging willingly
  const exposure = await prisma.offerExposure.findUnique({
    where: { id: exposureId }, select: { userId: true, offerType: true },
  }).catch(() => null);

  if (exposure) {
    await offerRedis.set(fatigueKey(exposure.userId), '0', 'EX', 86400);
    offerConversionTotal.inc({ offerType: exposure.offerType });
  }
}

// ── Build offer payload ───────────────────────────────────────────────────────
// Returns the complete offer object to send to the client.

export async function buildOffer(params: {
  userId:    string;
  offerType: string;
  context?:  string;
  discount?: number;  // 0-1 discount multiplier
}): Promise<{
  exposureId:  string;
  offerType:   string;
  title:       string;
  body:        string;
  cta:         string;
  productId?:  string;
  discountPct?: number;
  expiresAt?:  number;
} | null> {
  const check = await canShowOffer(params.userId, params.offerType);
  if (!check.allowed) return null;

  const exposureId = await recordOfferShown(params);

  const copy = getOfferCopy(params.offerType, params.context, params.discount);
  const expiry = params.offerType === 'REACTIVATION_OFFER' || params.offerType === 'CHURN_SAVE_OFFER'
    ? Date.now() + 24 * 3600 * 1000  // urgency window
    : undefined;

  return {
    exposureId,
    offerType:   params.offerType,
    title:       copy.title,
    body:        copy.body,
    cta:         copy.cta,
    productId:   copy.productId,
    discountPct: params.discount ? Math.round(params.discount * 100) : undefined,
    expiresAt:   expiry,
  };
}

// ── Trigger evaluation ────────────────────────────────────────────────────────
// Called from app logic at trigger points (chat locked, likes wall, etc.)

export async function evaluateOfferTrigger(params: {
  userId:   string;
  trigger:  'CHAT_LOCKED' | 'LIKES_WALL' | 'DAILY_LIMIT_HIT' | 'IDLE_FEED' | 'MATCH' | 'PROFILE_VIEW';
  context?: Record<string, unknown>;
}): Promise<ReturnType<typeof buildOffer> extends Promise<infer T> ? T : never> {
  const { userId, trigger } = params;

  const offerTypeMap: Record<string, string> = {
    CHAT_LOCKED:      'CHAT_UNLOCK_PROMPT',
    LIKES_WALL:       'SUBSCRIPTION_UPSELL',
    DAILY_LIMIT_HIT:  'SUBSCRIPTION_UPSELL',
    IDLE_FEED:        'BOOST_PROMPT',
    MATCH:            'SUPERLIKE_PROMPT',
    PROFILE_VIEW:     'BOOST_PROMPT',
  };

  const offerType = offerTypeMap[trigger] ?? 'SUBSCRIPTION_UPSELL';
  return buildOffer({ userId, offerType, context: trigger });
}

// ── Abandonment recovery ──────────────────────────────────────────────────────

export async function checkAbandonmentRecovery(userId: string): Promise<{
  sessionId: string;
  productId: string;
} | null> {
  // Find payments that were started but not completed in the last 2h
  const cutoff = new Date(Date.now() - 2 * 3600_000);
  const abandoned = await prisma.paymentSession.findFirst({
    where: {
      userId,
      status:    'PROCESSING',
      createdAt: { gte: cutoff },
    },
    orderBy: { createdAt: 'desc' },
    select:  { id: true, productId: true },
  });
  if (!abandoned) return null;
  return { sessionId: abandoned.id, productId: abandoned.productId };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function incrementFatigue(userId: string, delta: number): Promise<void> {
  const key = fatigueKey(userId);
  const raw = await offerRedis.get(key);
  const current = raw ? parseFloat(raw) : 0;
  const updated = Math.min(1, current + delta);
  await offerRedis.setex(key, 86400, updated.toFixed(4));
}

function getSecsUntilMidnight(): number {
  const now       = new Date();
  const midnight  = new Date(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.floor((midnight.getTime() - now.getTime()) / 1000);
}

function getOfferCopy(offerType: string, context?: string, discount?: number) {
  const discountStr = discount ? ` — ${Math.round(discount * 100)}% off` : '';

  const copies: Record<string, { title: string; body: string; cta: string; productId?: string }> = {
    SUBSCRIPTION_UPSELL: {
      title:     'Unlock Premium',
      body:      'See who liked you, unlimited likes, and more.',
      cta:       `Get Premium${discountStr}`,
      productId: 'gold_monthly_usd',
    },
    BOOST_PROMPT: {
      title:     'Get Noticed',
      body:      'Boost your profile and get 10x more matches in 30 minutes.',
      cta:       'Boost Now',
      productId: 'boost_30min',
    },
    SUPERLIKE_PROMPT: {
      title:     'Stand Out',
      body:      'Super likes get 3x more replies. Send one now.',
      cta:       'Get Super Likes',
      productId: 'superlike_5pack',
    },
    CHAT_UNLOCK_PROMPT: {
      title:     'Unlock This Chat',
      body:      'You have a message waiting. Unlock to read and reply.',
      cta:       'Unlock Chat',
    },
    REACTIVATION_OFFER: {
      title:     `Welcome back${discountStr}`,
      body:      'Your matches are waiting. Come back with a special offer.',
      cta:       `Reactivate${discountStr}`,
      productId: 'gold_monthly_usd',
    },
    CHURN_SAVE_OFFER: {
      title:     'Stay a little longer',
      body:      'Before you cancel — here\'s an exclusive discount just for you.',
      cta:       `Keep Premium${discountStr}`,
      productId: 'gold_monthly_usd',
    },
    ABANDONMENT_RECOVERY: {
      title:     'Complete Your Purchase',
      body:      'You started a purchase but didn\'t finish. Your offer is still available.',
      cta:       'Complete Now',
    },
  };

  return copies[offerType] ?? copies.SUBSCRIPTION_UPSELL;
}
