// ── Whale Intelligence System ─────────────────────────────────────────────────
//
// Behavioral spender segmentation with VIP treatment and fraud-aware monetization.
//
// Segments (tiered by LTV):
//   FREE     — no purchases
//   CASUAL   — < $10 LTV
//   REGULAR  — $10–$49 LTV
//   WHALE    — $50–$199 LTV
//   VIP      — $200+ LTV
//
// Fatigue scoring (0-1):
//   Updated per offer impression/dismissal in offer.engine.ts
//   High fatigue → fewer offers, gentler targeting
//
// Spending risk scoring (0-1):
//   High score → chargeback/refund pattern detected
//   High-risk users excluded from aggressive discounting
//
// Worker runs:
//   - On every successful payment (immediate update)
//   - Daily sweep for decay + recompute
//
// Redis key: whale:segment:{userId}  TTL 1h (fast read for offer engine)

import IORedis from 'ioredis';
import prisma from '../prisma.service';
import { logger } from '../../observability/logger';
import { whaleSegmentUpdatedTotal } from '../../observability/metrics';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
const whaleRedis = new IORedis(REDIS_URL, {
  maxRetriesPerRequest: 2,
  lazyConnect: true,
  enableReadyCheck: false,
});
whaleRedis.connect().catch(() => {});

const WHALE_CACHE_TTL = 3600;  // 1h
const whaleKey = (userId: string) => `whale:segment:${userId}`;

type SpenderSegmentLabel = 'FREE' | 'CASUAL' | 'REGULAR' | 'WHALE' | 'VIP';

interface SegmentData {
  segment:          SpenderSegmentLabel;
  ltv:              number;
  fatigueScore:     number;
  spendingRiskScore: number;
}

// ── Get segment (cached) ──────────────────────────────────────────────────────

export async function getUserSegment(userId: string): Promise<SegmentData> {
  const cached = await whaleRedis.get(whaleKey(userId)).catch(() => null);
  if (cached) return JSON.parse(cached) as SegmentData;

  return recomputeSegment(userId);
}

// ── Recompute segment ─────────────────────────────────────────────────────────

export async function recomputeSegment(userId: string): Promise<SegmentData> {
  // Aggregate payment history
  const payments = await prisma.paymentSession.findMany({
    where:  { userId, status: 'SUCCESS' },
    select: { amountUsd: true, createdAt: true, productType: true },
  });

  const refunds = await prisma.paymentSession.findMany({
    where:  { userId, status: 'REFUNDED' },
    select: { refundAmountUsd: true, createdAt: true },
  });

  const totalSpend   = payments.reduce((s, p) => s + Number(p.amountUsd), 0);
  const totalRefunds = refunds.reduce((s, r) => s + Number(r.refundAmountUsd ?? 0), 0);
  const ltv          = Math.max(0, totalSpend - totalRefunds);
  const purchaseCount = payments.length;

  const lastPurchase  = payments.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0]?.createdAt;

  const segment = classifySegment(ltv);

  // Spending risk: refund rate > 20% or > 3 refunds = elevated risk
  const refundRate      = purchaseCount > 0 ? refunds.length / purchaseCount : 0;
  const spendingRiskScore = Math.min(1, refundRate * 2 + (refunds.length >= 3 ? 0.3 : 0));

  // Fatigue: read from offer engine Redis (set there)
  const fatigueRaw  = await whaleRedis.get(`offer:fatigue:${userId}`).catch(() => null);
  const fatigueScore = fatigueRaw ? parseFloat(fatigueRaw) : 0;

  const data: SegmentData = { segment, ltv, fatigueScore, spendingRiskScore };

  // Upsert DB record
  await prisma.spenderSegment.upsert({
    where:  { userId },
    create: { userId, segment, ltv, totalSpend, purchaseCount, lastPurchaseAt: lastPurchase, fatigueScore, spendingRiskScore },
    update: { segment, ltv, totalSpend, purchaseCount, lastPurchaseAt: lastPurchase, fatigueScore, spendingRiskScore, segmentUpdatedAt: new Date() },
  }).catch((err) => logger.warn({ err, userId }, 'spender segment upsert failed'));

  // Cache
  await whaleRedis.setex(whaleKey(userId), WHALE_CACHE_TTL, JSON.stringify(data)).catch(() => {});

  whaleSegmentUpdatedTotal.inc({ segment });
  return data;
}

// ── VIP treatment hooks ───────────────────────────────────────────────────────

export function getVipTreatment(segment: SpenderSegmentLabel): {
  boostMultiplierBonus: number;  // extra recommendation boost
  offerDiscount:        number;  // 0-1 discount on upsell offers
  supportPriority:      string;
  adFree:               boolean;
} {
  const treatments: Record<SpenderSegmentLabel, ReturnType<typeof getVipTreatment>> = {
    FREE:    { boostMultiplierBonus: 0,    offerDiscount: 0,    supportPriority: 'normal',  adFree: false },
    CASUAL:  { boostMultiplierBonus: 0,    offerDiscount: 0.05, supportPriority: 'normal',  adFree: false },
    REGULAR: { boostMultiplierBonus: 0.05, offerDiscount: 0.10, supportPriority: 'normal',  adFree: false },
    WHALE:   { boostMultiplierBonus: 0.10, offerDiscount: 0.15, supportPriority: 'priority', adFree: true },
    VIP:     { boostMultiplierBonus: 0.15, offerDiscount: 0.20, supportPriority: 'vip',      adFree: true },
  };
  return treatments[segment];
}

// ── Monetization fairness gate ────────────────────────────────────────────────
// Prevents aggressive monetization of high-risk users.

export async function isMonetizationSafe(userId: string): Promise<{ safe: boolean; reason?: string }> {
  const segment = await getUserSegment(userId);

  if (segment.spendingRiskScore > 0.6) {
    return { safe: false, reason: 'high_refund_risk' };
  }
  if (segment.fatigueScore > 0.9) {
    return { safe: false, reason: 'severely_fatigued' };
  }
  return { safe: true };
}

// ── Churn risk detection ──────────────────────────────────────────────────────

export async function detectChurnRisk(userId: string): Promise<{ atRisk: boolean; score: number }> {
  const sub = await prisma.subscription.findFirst({
    where:  { userId, status: 'ACTIVE' },
    select: { currentPeriodEnd: true, cancelAtPeriodEnd: true, failedRenewals: true },
  });
  if (!sub) return { atRisk: false, score: 0 };

  let score = 0;
  const daysLeft = (sub.currentPeriodEnd.getTime() - Date.now()) / 86400_000;
  if (daysLeft < 7)              score += 0.3;
  if (sub.cancelAtPeriodEnd)     score += 0.5;
  if (sub.failedRenewals > 0)    score += 0.3 * sub.failedRenewals;

  const segment = await getUserSegment(userId);
  if (segment.fatigueScore > 0.6) score += 0.2;

  return { atRisk: score >= 0.5, score: Math.min(1, score) };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function classifySegment(ltv: number): SpenderSegmentLabel {
  if (ltv === 0)  return 'FREE';
  if (ltv < 10)   return 'CASUAL';
  if (ltv < 50)   return 'REGULAR';
  if (ltv < 200)  return 'WHALE';
  return 'VIP';
}
