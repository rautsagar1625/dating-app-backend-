// ── Unified Trust Score (0–100) ───────────────────────────────────────────────
//
// Higher = more trustworthy. The score drives progressive enforcement:
//   90-100  pristine account
//   70-89   good standing
//   50-69   under watch — extra moderation scrutiny
//   30-49   restricted — cooldown enforced
//   15-29   shadow restriction or soft ban
//    0-14   hard ban territory
//
// Component weights:
//   PENALTIES (max deduction)
//     fraudRisk        25 pts  (from UserRiskProfile.riskScore)
//     modViolations    20 pts  (ModerationEvent severity × count)
//     reportRate       15 pts  (reports received per 7 days)
//     toxicity         10 pts  (avg ConversationRiskProfile.riskScore)
//     spam              8 pts  (MessageModerationResult spam count)
//     blockRate         5 pts  (blocks received per 7 days)
//     mediaViolations  10 pts  (quarantined/rejected media)
//
//   BONUSES (max addition)
//     profileComplete  +5
//     accountAge30d    +3
//     accountAge90d    +5 (cumulative)
//     verified        +10

import prisma from '../prisma.service';
import { logger } from '../../observability/logger';
import { captureException } from '../../observability/sentry';
import {
  getCachedTrustScore,
  setCachedTrustScore,
  invalidateTrustCache,
} from './trust.cache';
import type { TrustScoreComponents, TrustScoreSnapshot } from './trust.types';

// ── Score computation ─────────────────────────────────────────────────────────

export async function computeTrustScore(userId: string): Promise<TrustScoreSnapshot> {
  const [user, riskProfile, recentModerationEvents, recentReports, conversationProfiles,
         recentSpam, recentBlocks, mediaViolations] = await Promise.all([
    prisma.user.findUnique({
      where:   { id: userId },
      select:  { createdAt: true, profile: { select: { username: true, bio: true, age: true } } },
    }),
    prisma.userRiskProfile.findUnique({ where: { userId } }),
    prisma.moderationEvent.findMany({
      where: { userId, createdAt: { gte: daysAgo(30) }, decision: { not: 'APPROVED' } },
      select: { triggerReason: true, decision: true, riskScore: true, createdAt: true },
    }),
    prisma.report.count({ where: { reportedId: userId, createdAt: { gte: daysAgo(7) } } }),
    prisma.conversationRiskProfile.findMany({
      where: {
        OR: [
          { chat: { user1Id: userId } },
          { chat: { user2Id: userId } },
        ],
        riskScore: { gt: 0 },
      },
      select: { riskScore: true },
      take: 20,
      orderBy: { updatedAt: 'desc' },
    }),
    prisma.messageModerationResult.count({
      where: { userId, decision: 'ESCALATED', processedAt: { gte: daysAgo(7) } },
    }),
    prisma.block.count({ where: { blockedId: userId, createdAt: { gte: daysAgo(7) } } }),
    prisma.mediaAsset.count({
      where: { userId, status: { in: ['QUARANTINED', 'FAILED'] }, createdAt: { gte: daysAgo(30) } },
    }),
  ]);

  // ── Penalty calculations ──────────────────────────────────────────────────────

  // 1. Fraud risk penalty (0-25)
  const fraudScore = riskProfile?.riskScore ?? 0;
  const fraudRiskPenalty = Math.round((fraudScore / 100) * 25);

  // 2. Moderation violations penalty (0-20)
  // Weight by severity: ESCALATED > REJECTED > SUPPRESSED
  const modWeight = recentModerationEvents.reduce((sum, e) => {
    const w = e.decision === 'REJECTED' ? 3 : e.decision === 'ESCALATED' ? 2 : 1;
    return sum + w;
  }, 0);
  const modViolationPenalty = Math.min(Math.round(modWeight * 2), 20);

  // 3. Report rate penalty (0-15): ≥3 reports/week = max penalty
  const reportRatePenalty = Math.min(Math.round(recentReports * 5), 15);

  // 4. Conversation toxicity penalty (0-10)
  const avgConvRisk = conversationProfiles.length > 0
    ? conversationProfiles.reduce((s, p) => s + p.riskScore, 0) / conversationProfiles.length
    : 0;
  const toxicityPenalty = Math.round((avgConvRisk / 100) * 10);

  // 5. Spam penalty (0-8)
  const spamPenalty = Math.min(recentSpam * 2, 8);

  // 6. Block rate penalty (0-5)
  const blockRatePenalty = Math.min(recentBlocks * 2, 5);

  // 7. Media violations penalty (0-10)
  const mediaViolPenalty = Math.min(mediaViolations * 3, 10);

  // ── Bonus calculations ────────────────────────────────────────────────────────

  // Profile completeness: username + bio + age = max bonus
  const profileBonus = user?.profile
    ? (user.profile.bio ? 2 : 0) + (user.profile.age ? 2 : 0) + 1
    : 0;

  // Account age bonuses
  const ageMs = user ? Date.now() - user.createdAt.getTime() : 0;
  const ageBonus = ageMs >= 90 * 86400_000 ? 5 : ageMs >= 30 * 86400_000 ? 3 : 0;

  // Verified bonus (no verification model yet — placeholder)
  const verifiedBonus = 0;

  // ── Final score ────────────────────────────────────────────────────────────────

  const totalPenalty =
    fraudRiskPenalty + modViolationPenalty + reportRatePenalty +
    toxicityPenalty + spamPenalty + blockRatePenalty + mediaViolPenalty;

  const totalBonus = profileBonus + ageBonus + verifiedBonus;
  const rawScore = 100 - totalPenalty + totalBonus;
  const totalScore = Math.max(0, Math.min(100, rawScore));

  const components: TrustScoreComponents = {
    fraudRiskPenalty, modViolationPenalty, reportRatePenalty,
    toxicityPenalty, spamPenalty, blockRatePenalty, mediaViolPenalty,
    profileBonus, ageBonus, verifiedBonus, totalScore,
  };

  return { userId, score: totalScore, components, computedAt: new Date().toISOString() };
}

// ── Public API ─────────────────────────────────────────────────────────────────

export async function getTrustScore(userId: string): Promise<TrustScoreSnapshot> {
  const cached = await getCachedTrustScore(userId);
  if (cached) return cached;

  const snapshot = await computeTrustScore(userId);
  await setCachedTrustScore(snapshot);
  return snapshot;
}

// Called after any event that affects trust (moderation action, report, ban, etc.)
export async function recomputeTrustScore(userId: string, reason: string): Promise<void> {
  try {
    await invalidateTrustCache(userId);

    const [prev, next] = await Promise.all([
      prisma.trustScoreHistory.findFirst({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        select: { score: true },
      }),
      computeTrustScore(userId),
    ]);

    const prevScore = prev?.score ?? 100;
    const delta     = next.score - prevScore;

    await prisma.trustScoreHistory.create({
      data: {
        userId,
        score:      next.score,
        delta,
        reason,
        components: next.components as object,
      },
    });

    await setCachedTrustScore(next);
    logger.debug({ userId, score: next.score, delta, reason }, 'trust score updated');
  } catch (err) {
    logger.error({ err, userId, reason }, 'trust score recomputation failed');
    captureException(err as Error, { userId, reason });
  }
}

// Decay / recovery cron: runs daily to nudge scores toward neutral
export async function runTrustScoreDecay(): Promise<void> {
  // Users with score > 80: no decay needed
  // Users with score 50-80: +1 passive recovery per day (good behavior rewarded)
  // Users with score < 50: +0.5 per day if no new violations in past 7 days

  const recentViolators = await prisma.moderationEvent.groupBy({
    by: ['userId'],
    where: { createdAt: { gte: daysAgo(7) }, decision: { not: 'APPROVED' } },
  });
  const violatorSet = new Set(recentViolators.map((v) => v.userId));

  const lowTrustUsers = await prisma.trustScoreHistory.groupBy({
    by: ['userId'],
    _max: { createdAt: true },
    having: { userId: { _count: { gt: 0 } } },
  });

  for (const u of lowTrustUsers) {
    if (!violatorSet.has(u.userId)) {
      await recomputeTrustScore(u.userId, 'daily_decay_recovery').catch(() => {});
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}
