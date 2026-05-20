// ── User Signal Aggregator ────────────────────────────────────────────────────
//
// Computes a UserSignals snapshot from raw DB tables.
// Results are cached in Redis (5-min TTL) to serve the hot ranking path.
//
// Signal sources:
//   Like              → likeOutRate, likeInRate
//   Message / Chat    → replyRate, avgConvDepth, convStartRate
//   Block             → blockRecvRate (negative signal)
//   Report            → reportRecvRate (negative signal)
//   Profile + Photo   → profileQuality, photoCount
//   TrustScoreHistory → trustScore
//   UserRiskProfile   → fraudScore
//   User.lastSeen     → isOnline, lastActiveAt

import IORedis from 'ioredis';
import prisma from '../../prisma.service';
import { getTrustScore } from '../../trust/trust.score';
import { isOnline } from '../../online.service';
import { logger } from '../../../observability/logger';
import type { UserSignals } from '../rec.types';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
const signalRedis = new IORedis(REDIS_URL, {
  maxRetriesPerRequest: 2,
  lazyConnect: true,
  enableReadyCheck: false,
});
signalRedis.connect().catch(() => {});

const SIGNAL_TTL   = 5 * 60;           // 5 minutes hot cache
const KEY_PREFIX   = 'rec:signals:';
const WINDOW_14D   = 14 * 86400_000;
const WINDOW_7D    = 7  * 86400_000;
const WINDOW_30D   = 30 * 86400_000;

export function signalKey(userId: string): string {
  return `${KEY_PREFIX}${userId}`;
}

// ── Main computation ──────────────────────────────────────────────────────────

export async function computeUserSignals(userId: string): Promise<UserSignals> {
  const now = Date.now();
  const since14d = new Date(now - WINDOW_14D);
  const since7d  = new Date(now - WINDOW_7D);
  const since30d = new Date(now - WINDOW_30D);

  const [
    user,
    profile,
    photoCount,
    likesSent,
    likesRecv,
    feedImpressionCount,
    visitorCount,
    blocksRecv,
    reportsRecv,
    riskProfile,
    trustSnapshot,
    chatsReceived,
    chatReplied,
    recentMessages,
  ] = await Promise.all([
    prisma.user.findUnique({
      where:  { id: userId },
      select: { lastSeen: true },
    }),
    prisma.profile.findUnique({
      where:  { userId },
      select: { bio: true, age: true, gender: true, location: true },
    }),
    prisma.photo.count({ where: { userId } }),
    prisma.like.count({ where: { senderId: userId, createdAt: { gte: since14d } } }),
    prisma.like.count({ where: { receiverId: userId, createdAt: { gte: since14d } } }),
    // denominator for likeOutRate: distinct profiles shown in feed
    prisma.feedImpression.count({ where: { viewerId: userId, seenAt: { gte: since14d } } }),
    // denominator for likeInRate: distinct visitors
    prisma.profileVisit.count({ where: { visitedId: userId, visitedAt: { gte: since14d } } }),
    prisma.block.count({ where: { blockedId: userId, createdAt: { gte: since7d } } }),
    prisma.report.count({ where: { reportedId: userId, createdAt: { gte: since7d } } }),
    prisma.userRiskProfile.findUnique({ where: { userId }, select: { riskScore: true } }),
    getTrustScore(userId),
    // chats where this user was the receiver and a message was sent to them
    prisma.chat.count({
      where: {
        OR: [{ user2Id: userId }, { user1Id: userId }],
        createdAt: { gte: since30d },
        messages: { some: { senderId: { not: userId } } },
      },
    }),
    // chats where they received a message and then replied
    prisma.chat.count({
      where: {
        OR: [{ user2Id: userId }, { user1Id: userId }],
        createdAt: { gte: since30d },
        messages: {
          some: { senderId: { not: userId } },
          every: {},
        },
        AND: [{ messages: { some: { senderId: userId } } }],
      },
    }),
    // message counts per chat for convDepth calculation
    prisma.message.groupBy({
      by:     ['chatId'],
      where:  { senderId: userId, createdAt: { gte: since30d } },
      _count: { id: true },
    }),
  ]);

  // ── Rate calculations ─────────────────────────────────────────────────────

  const likeOutRate = feedImpressionCount > 0
    ? Math.min(likesSent / feedImpressionCount, 1)
    : 0;

  const likeInRate = visitorCount > 0
    ? Math.min(likesRecv / visitorCount, 1)
    : 0;

  const replyRate = chatsReceived > 0
    ? Math.min(chatReplied / chatsReceived, 1)
    : 0;

  const avgConvDepth = recentMessages.length > 0
    ? recentMessages.reduce((s, r) => s + r._count.id, 0) / recentMessages.length
    : 0;

  // convStartRate: fraction of matched chats where user sent ≥1 message
  const convStartRate = chatsReceived > 0
    ? Math.min(recentMessages.length / chatsReceived, 1)
    : 0;

  const visitorsPer100 = Math.max(visitorCount, 1) / 100;
  const blockRecvRate  = Math.min(blocksRecv  / visitorsPer100, 1);
  const reportRecvRate = Math.min(reportsRecv / visitorsPer100, 1);

  // ── Profile quality (0-1) ─────────────────────────────────────────────────

  let profileQuality = 0;
  if (profile) {
    if (profile.bio)      profileQuality += 0.25;
    if (profile.age)      profileQuality += 0.20;
    if (profile.gender)   profileQuality += 0.15;
    if (profile.location) profileQuality += 0.10;
  }
  profileQuality += Math.min(photoCount, 4) * 0.075;  // up to +0.30 for 4 photos
  profileQuality = Math.min(profileQuality, 1);

  const signals: UserSignals = {
    userId,
    likeOutRate,
    likeInRate,
    replyRate,
    avgConvDepth,
    convStartRate,
    blockRecvRate,
    reportRecvRate,
    profileQuality,
    photoCount,
    trustScore:  trustSnapshot.score,
    fraudScore:  riskProfile?.riskScore ?? 0,
    lastActiveAt: user?.lastSeen ?? null,
    isOnline:    isOnline(user?.lastSeen ?? null),
    computedAt:  new Date(),
  };

  return signals;
}

// ── Cache layer ───────────────────────────────────────────────────────────────

export async function getUserSignals(userId: string): Promise<UserSignals> {
  try {
    const cached = await signalRedis.get(signalKey(userId));
    if (cached) return JSON.parse(cached) as UserSignals;
  } catch { /* Redis miss — compute */ }

  const signals = await computeUserSignals(userId);
  await cacheSignals(signals);
  return signals;
}

export async function cacheSignals(signals: UserSignals): Promise<void> {
  try {
    await signalRedis.setex(signalKey(signals.userId), SIGNAL_TTL, JSON.stringify(signals));
  } catch { /* non-critical */ }
}

export async function invalidateSignalCache(userId: string): Promise<void> {
  try {
    await signalRedis.del(signalKey(userId));
  } catch { /* non-critical */ }
}

// ── Persist to DB for analytics / admin ──────────────────────────────────────

export async function persistSignalProfile(userId: string): Promise<void> {
  try {
    const s = await computeUserSignals(userId);

    await prisma.userSignalProfile.upsert({
      where:  { userId },
      create: {
        userId,
        likeOutRate:    s.likeOutRate,
        likeInRate:     s.likeInRate,
        replyRate:      s.replyRate,
        avgConvDepth:   s.avgConvDepth,
        convStartRate:  s.convStartRate,
        blockRecvRate:  s.blockRecvRate,
        reportRecvRate: s.reportRecvRate,
        profileQuality: s.profileQuality,
        photoCount:     s.photoCount,
        trustScore:     s.trustScore,
        fraudScore:     s.fraudScore,
      },
      update: {
        likeOutRate:    s.likeOutRate,
        likeInRate:     s.likeInRate,
        replyRate:      s.replyRate,
        avgConvDepth:   s.avgConvDepth,
        convStartRate:  s.convStartRate,
        blockRecvRate:  s.blockRecvRate,
        reportRecvRate: s.reportRecvRate,
        profileQuality: s.profileQuality,
        photoCount:     s.photoCount,
        trustScore:     s.trustScore,
        fraudScore:     s.fraudScore,
        computedAt:     new Date(),
      },
    });

    await cacheSignals(s);
  } catch (err) {
    logger.error({ err, userId }, 'persistSignalProfile failed');
  }
}

// ── Population stats (cold-start priors) ─────────────────────────────────────
// Returns average signals across active users — used when a user has no history.

let _populationCache: { likeOutRate: number; replyRate: number; expiresAt: number } | null = null;

export async function getPopulationStats(): Promise<{ likeOutRate: number; replyRate: number }> {
  if (_populationCache && _populationCache.expiresAt > Date.now()) {
    return _populationCache;
  }

  try {
    const stats = await prisma.userSignalProfile.aggregate({
      _avg: { likeOutRate: true, replyRate: true },
      where: { computedAt: { gte: new Date(Date.now() - 7 * 86400_000) } },
    });

    const result = {
      likeOutRate: stats._avg.likeOutRate ?? 0.08,
      replyRate:   stats._avg.replyRate   ?? 0.25,
    };

    _populationCache = { ...result, expiresAt: Date.now() + 30 * 60_000 };
    return result;
  } catch {
    return { likeOutRate: 0.08, replyRate: 0.25 };
  }
}
