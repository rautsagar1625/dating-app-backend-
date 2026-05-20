// ── Moderation Enforcement Engine ────────────────────────────────────────────
//
// Progressive enforcement ladder:
//
//   1. WARN           — in-app warning, no restriction
//   2. COOLDOWN       — message rate limited for 24h
//   3. SHADOW_RESTRICT — messages silently suppressed, sender unaware
//   4. SOFT_BAN       — account suspended, can appeal
//   5. HARD_BAN       — permanent ban, no appeal
//
// Each enforcement step requires a preceding step (escalation path).
// Manual moderator overrides can skip steps.
//
// Repeat violations within 30 days accelerate the ladder.

import prisma from '../../prisma.service';
import { applyEnforcement } from '../../fraud/enforcement.service';
import { recomputeTrustScore } from '../../trust/trust.score';
import { logger } from '../../../observability/logger';
import {
  moderationEnforcementTotal,
} from '../../../observability/metrics';

export type EnforcementLevel = 'WARN' | 'COOLDOWN' | 'SHADOW_RESTRICT' | 'SOFT_BAN' | 'HARD_BAN';

interface EnforcementSpec {
  type:       EnforcementLevel;
  ttlSeconds?: number;   // undefined = permanent
  reason:     string;
}

// Risk score → initial enforcement level mapping
function riskToEnforcement(
  riskScore: number,
  priorViolations: number,
): EnforcementSpec {
  // Accelerate enforcement for repeat offenders
  const escalationBoost = Math.min(priorViolations, 3);

  const effectiveScore = riskScore + escalationBoost * 10;

  if (effectiveScore >= 90) return { type: 'HARD_BAN',        reason: `Auto: score ${riskScore}, violations ${priorViolations}` };
  if (effectiveScore >= 75) return { type: 'SOFT_BAN',        reason: `Auto: score ${riskScore}`, ttlSeconds: 7 * 86400 };
  if (effectiveScore >= 60) return { type: 'SHADOW_RESTRICT', reason: `Auto: score ${riskScore}`, ttlSeconds: 3 * 86400 };
  if (effectiveScore >= 40) return { type: 'COOLDOWN',        reason: `Auto: score ${riskScore}`, ttlSeconds: 86400 };
  return                           { type: 'WARN',             reason: `Auto: score ${riskScore}` };
}

// ── Apply progressive enforcement ────────────────────────────────────────────

export async function enforceOnModeration(
  userId:      string,
  triggerReason: string,
  riskScore:   number,
  moderationEventId?: string,
): Promise<EnforcementSpec | null> {
  // Count prior violations in the last 30 days
  const priorCount = await prisma.moderationEvent.count({
    where: {
      userId,
      decision: { not: 'APPROVED' },
      createdAt: { gte: new Date(Date.now() - 30 * 86400_000) },
    },
  });

  const spec = riskToEnforcement(riskScore, priorCount);

  // Don't re-apply the same tier if already active
  const alreadyActive = await prisma.fraudEnforcementAction.findFirst({
    where: {
      userId,
      actionType: spec.type,
      isActive:   true,
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
    select: { id: true },
  });

  if (alreadyActive && spec.type !== 'HARD_BAN') {
    // Already at or above this tier — skip re-application
    return null;
  }

  // Apply the enforcement
  await applyEnforcement(
    userId, null, spec.type, spec.reason, spec.ttlSeconds,
    undefined, // automated
    { triggerReason, riskScore, moderationEventId },
  );

  // Record decision on the moderation event
  if (moderationEventId) {
    const action = await prisma.fraudEnforcementAction.findFirst({
      where: { userId, actionType: spec.type, isActive: true },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });

    await prisma.moderationDecision.create({
      data: {
        eventId:         moderationEventId,
        decision:        spec.type === 'WARN' ? 'WARNING_SENT' : 'SUPPRESSED',
        provider:        'rules',
        explanation:     spec.reason,
        signals:         [] as unknown as object,
        enforcementType: spec.type,
        enforcementId:   action?.id,
      },
    });
  }

  // Recompute trust score asynchronously
  recomputeTrustScore(userId, `moderation:${triggerReason}`).catch(() => {});

  moderationEnforcementTotal.inc({ type: spec.type });
  logger.info({ userId, enforcement: spec.type, riskScore, priorCount, triggerReason }, 'enforcement applied');

  return spec;
}

// ── Appeal processing ─────────────────────────────────────────────────────────

export async function submitAppeal(
  userId:   string,
  eventId:  string,
  reason:   string,
): Promise<string> {
  // Validate event belongs to user
  const event = await prisma.moderationEvent.findUnique({
    where: { id: eventId },
    select: { userId: true, decision: true },
  });

  if (!event || event.userId !== userId) {
    throw Object.assign(new Error('Event not found or not yours'), { statusCode: 404 });
  }

  if (event.decision === 'APPROVED') {
    throw Object.assign(new Error('Cannot appeal approved decisions'), { statusCode: 400 });
  }

  // One pending appeal per event
  const existing = await prisma.moderationAppeal.findFirst({
    where: { eventId, status: 'PENDING' },
    select: { id: true },
  });
  if (existing) {
    throw Object.assign(new Error('Appeal already pending'), { statusCode: 409 });
  }

  const appeal = await prisma.moderationAppeal.create({
    data: {
      eventId,
      userId,
      reason: reason.slice(0, 500),
    },
  });

  return appeal.id;
}

export async function reviewAppeal(
  appealId:    string,
  reviewerId:  string,
  approve:     boolean,
  reviewNotes: string,
): Promise<void> {
  const appeal = await prisma.moderationAppeal.findUnique({
    where: { id: appealId },
    select: { id: true, userId: true, eventId: true, status: true },
  });

  if (!appeal || appeal.status !== 'PENDING') {
    throw Object.assign(new Error('Appeal not found or already reviewed'), { statusCode: 404 });
  }

  await prisma.moderationAppeal.update({
    where: { id: appealId },
    data: {
      status:      approve ? 'APPROVED' : 'DENIED',
      reviewerId,
      reviewNotes,
      reviewedAt:  new Date(),
    },
  });

  if (approve) {
    // Revoke all active enforcements tied to this event
    const decisions = await prisma.moderationDecision.findMany({
      where: { eventId: appeal.eventId, enforcementId: { not: null } },
      select: { enforcementId: true },
    });

    await prisma.fraudEnforcementAction.updateMany({
      where: { id: { in: decisions.map((d) => d.enforcementId!).filter(Boolean) } },
      data:  { isActive: false, revokedAt: new Date(), revokedBy: reviewerId },
    });

    await prisma.moderationEvent.update({
      where: { id: appeal.eventId },
      data:  { decision: 'APPROVED', resolvedAt: new Date(), moderatorId: reviewerId },
    });

    recomputeTrustScore(appeal.userId, 'appeal_approved').catch(() => {});
    logger.info({ appealId, userId: appeal.userId, reviewerId }, 'appeal approved — enforcement revoked');
  }
}
