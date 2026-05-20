import { Request, Response, NextFunction } from 'express';
import prisma from '../services/prisma.service';
import { submitAppeal, reviewAppeal } from '../services/moderation/enforcement/moderation.enforcement';
import { getHighRiskConversations } from '../services/moderation/conversation/conversation.analyzer';
import { getTrustScore } from '../services/trust/trust.score';
import { enforceOnModeration } from '../services/moderation/enforcement/moderation.enforcement';
import { moderationAppealTotal } from '../observability/metrics';

const qs = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

// ── User-facing appeal endpoints ──────────────────────────────────────────────

// POST /api/moderation/appeal
// Body: { eventId, reason }
export const createAppeal = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const { eventId, reason } = req.body;

    if (!eventId || !reason?.trim()) {
      res.status(400).json({ success: false, message: 'eventId and reason are required' });
      return;
    }

    const appealId = await submitAppeal(userId, eventId, reason.trim());
    res.status(201).json({ success: true, data: { appealId } });
  } catch (error: any) {
    if (error.statusCode) {
      res.status(error.statusCode).json({ success: false, message: error.message });
      return;
    }
    next(error);
  }
};

// GET /api/moderation/appeal — list user's own appeals
export const listMyAppeals = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user!.userId;

    const appeals = await prisma.moderationAppeal.findMany({
      where:   { userId },
      orderBy: { createdAt: 'desc' },
      take:    20,
      select: {
        id:          true,
        eventId:     true,
        status:      true,
        reason:      true,
        reviewNotes: true,
        reviewedAt:  true,
        createdAt:   true,
      },
    });

    res.status(200).json({ success: true, data: appeals });
  } catch (error) {
    next(error);
  }
};

// GET /api/moderation/status — user's own trust score + active enforcements
export const getModerationStatus = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user!.userId;

    const [trustSnapshot, activeEnforcements] = await Promise.all([
      getTrustScore(userId),
      prisma.fraudEnforcementAction.findMany({
        where: {
          userId,
          isActive: true,
          OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        },
        select: { actionType: true, reason: true, expiresAt: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    res.status(200).json({
      success: true,
      data: {
        trustScore:   trustSnapshot.score,
        enforcements: activeEnforcements,
      },
    });
  } catch (error) {
    next(error);
  }
};

// ── Admin moderation operations ───────────────────────────────────────────────

// GET /api/admin/moderation/events
// Query: ?decision=ESCALATED&triggerType=ASYNC_ML&limit=50&offset=0
export const listModerationEvents = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const decision    = qs(req.query.decision);
    const triggerType = qs(req.query.triggerType);
    const sourceType  = qs(req.query.sourceType);
    const limit       = Math.min(parseInt(qs(req.query.limit) ?? '50', 10), 100);
    const offset      = parseInt(qs(req.query.offset) ?? '0', 10);

    const events = await prisma.moderationEvent.findMany({
      where: {
        ...(decision    ? { decision: decision as any }    : {}),
        ...(triggerType ? { triggerType: triggerType as any } : {}),
        ...(sourceType  ? { sourceType: sourceType as any }  : {}),
      },
      orderBy: { createdAt: 'desc' },
      take:    limit,
      skip:    offset,
      select: {
        id:            true,
        sourceType:    true,
        sourceId:      true,
        userId:        true,
        triggerType:   true,
        triggerReason: true,
        riskScore:     true,
        decision:      true,
        createdAt:     true,
        moderatorId:   true,
        resolvedAt:    true,
        decisions:     { select: { provider: true, decision: true, enforcementType: true, createdAt: true } },
      },
    });

    const total = await prisma.moderationEvent.count({
      where: {
        ...(decision    ? { decision: decision as any }    : {}),
        ...(triggerType ? { triggerType: triggerType as any } : {}),
        ...(sourceType  ? { sourceType: sourceType as any }  : {}),
      },
    });

    res.status(200).json({ success: true, data: { events, total, limit, offset } });
  } catch (error) {
    next(error);
  }
};

// GET /api/admin/moderation/events/:eventId
export const getModerationEvent = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const eventId = req.params.eventId as string;

    const event = await prisma.moderationEvent.findUnique({
      where:   { id: eventId },
      include: {
        decisions: true,
        appeals:   { select: { id: true, status: true, reason: true, createdAt: true, reviewedAt: true, reviewNotes: true } },
      },
    });

    if (!event) {
      res.status(404).json({ success: false, message: 'Event not found' });
      return;
    }

    res.status(200).json({ success: true, data: event });
  } catch (error) {
    next(error);
  }
};

// POST /api/admin/moderation/events/:eventId/resolve
// Body: { action: 'APPROVE' | 'REJECT', notes }
export const resolveModerationEvent = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const reviewerId = req.user!.userId;
    const eventId    = req.params.eventId as string;
    const { action, notes } = req.body;

    if (!['APPROVE', 'REJECT'].includes(action)) {
      res.status(400).json({ success: false, message: 'action must be APPROVE or REJECT' });
      return;
    }

    const event = await prisma.moderationEvent.findUnique({
      where:  { id: eventId },
      select: { id: true, decision: true, userId: true },
    });
    if (!event) {
      res.status(404).json({ success: false, message: 'Event not found' });
      return;
    }
    if (event.decision === 'APPROVED') {
      res.status(409).json({ success: false, message: 'Event already resolved' });
      return;
    }

    await prisma.moderationEvent.update({
      where: { id: eventId },
      data: {
        decision:    action === 'APPROVE' ? 'APPROVED' : 'REJECTED',
        moderatorId: reviewerId,
        resolvedAt:  new Date(),
      },
    });

    res.status(200).json({ success: true });
  } catch (error) {
    next(error);
  }
};

// POST /api/admin/moderation/enforce
// Body: { userId, riskScore, reason, eventId? }
// Allows admin to manually trigger enforcement
export const manualEnforce = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { userId, riskScore, reason, eventId } = req.body;

    if (!userId || riskScore == null || !reason) {
      res.status(400).json({ success: false, message: 'userId, riskScore, and reason are required' });
      return;
    }

    const spec = await enforceOnModeration(userId, reason, Number(riskScore), eventId);
    res.status(200).json({ success: true, data: spec ?? { message: 'No new enforcement — already at this tier' } });
  } catch (error) {
    next(error);
  }
};

// GET /api/admin/moderation/appeals
// Query: ?status=PENDING&limit=50&offset=0
export const listAdminAppeals = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const status = qs(req.query.status) ?? 'PENDING';
    const limit  = Math.min(parseInt(qs(req.query.limit) ?? '50', 10), 100);
    const offset = parseInt(qs(req.query.offset) ?? '0', 10);

    const appeals = await prisma.moderationAppeal.findMany({
      where:   { status: status as any },
      orderBy: { createdAt: 'asc' },
      take:    limit,
      skip:    offset,
      include: {
        event: { select: { sourceType: true, triggerReason: true, riskScore: true, decision: true } },
      },
    });

    const total = await prisma.moderationAppeal.count({ where: { status: status as any } });
    res.status(200).json({ success: true, data: { appeals, total, limit, offset } });
  } catch (error) {
    next(error);
  }
};

// POST /api/admin/moderation/appeals/:appealId/review
// Body: { approve: boolean, notes: string }
export const reviewAppealHandler = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const reviewerId = req.user!.userId;
    const appealId   = req.params.appealId as string;
    const { approve, notes } = req.body;

    if (typeof approve !== 'boolean' || !notes?.trim()) {
      res.status(400).json({ success: false, message: 'approve (boolean) and notes are required' });
      return;
    }

    await reviewAppeal(appealId, reviewerId, approve, notes.trim());
    moderationAppealTotal.inc({ outcome: approve ? 'approved' : 'denied' });

    res.status(200).json({ success: true });
  } catch (error: any) {
    if (error.statusCode) {
      res.status(error.statusCode).json({ success: false, message: error.message });
      return;
    }
    next(error);
  }
};

// GET /api/admin/moderation/conversations/high-risk
export const getHighRiskConversationsHandler = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const limit = Math.min(parseInt(qs(req.query.limit) ?? '50', 10), 100);
    const data  = await getHighRiskConversations(limit);
    res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

// GET /api/admin/moderation/users/:userId/trust
export const getUserTrustProfile = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.params.userId as string;

    const [trustSnapshot, history, activeEnforcements] = await Promise.all([
      getTrustScore(userId),
      prisma.trustScoreHistory.findMany({
        where:   { userId },
        orderBy: { createdAt: 'desc' },
        take:    30,
        select:  { score: true, delta: true, reason: true, createdAt: true },
      }),
      prisma.fraudEnforcementAction.findMany({
        where: {
          userId,
          isActive: true,
          OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        },
        select: { actionType: true, reason: true, expiresAt: true, createdAt: true },
      }),
    ]);

    res.status(200).json({
      success: true,
      data: {
        current:      trustSnapshot,
        history,
        enforcements: activeEnforcements,
      },
    });
  } catch (error) {
    next(error);
  }
};

// GET /api/admin/moderation/stats
export const getModerationStats = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const since = new Date(Date.now() - 7 * 86400_000);

    const [
      eventsByDecision,
      appealsByStatus,
      enforcementsByType,
      highRiskConvCount,
    ] = await Promise.all([
      prisma.moderationEvent.groupBy({
        by:    ['decision'],
        where: { createdAt: { gte: since } },
        _count: true,
      }),
      prisma.moderationAppeal.groupBy({
        by:    ['status'],
        _count: true,
      }),
      prisma.fraudEnforcementAction.groupBy({
        by:    ['actionType'],
        where: { createdAt: { gte: since } },
        _count: true,
      }),
      prisma.conversationRiskProfile.count({
        where: { riskLevel: { in: ['HIGH', 'CRITICAL'] } },
      }),
    ]);

    res.status(200).json({
      success: true,
      data: {
        period:          '7d',
        eventsByDecision,
        appealsByStatus,
        enforcementsByType,
        highRiskConvCount,
      },
    });
  } catch (error) {
    next(error);
  }
};
