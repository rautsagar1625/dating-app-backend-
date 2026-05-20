import { Request, Response, NextFunction } from 'express';
import { getFeed, snapshotFeed } from '../services/recommendation/feed/feed.service';
import { processFeedback, processDwellBatch, closeSession } from '../services/recommendation/feedback/feedback.handler';
import { enqueueSignalAgg, enqueueCandidateGen } from '../services/recommendation/recommendation.queue';
import { setBoost, clearBoost } from '../services/recommendation/ranking/ranking.engine';
import {
  createExperiment,
  activateExperiment,
  stopExperiment,
} from '../services/recommendation/experiments/experiment.service';
import prisma from '../services/prisma.service';
import type { FeedbackAction } from '../services/recommendation/rec.types';

const qs = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

// ── Feed delivery ─────────────────────────────────────────────────────────────

// GET /api/feed
// Query: ?limit=20&offset=0&sessionId=...&refresh=true
export const getRecommendedFeed = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId      = req.user!.userId;
    const limit       = Math.min(parseInt(qs(req.query.limit)  ?? '20', 10), 50);
    const offset      = parseInt(qs(req.query.offset) ?? '0', 10);
    const sessionId   = qs(req.query.sessionId);
    const forceRefresh = req.query.refresh === 'true';

    const result = await getFeed({ userId, limit, offset, sessionId, forceRefresh });

    res.status(200).json({
      success: true,
      data: {
        profiles:    result.profiles,
        sessionId:   result.sessionId,
        rankVersion: result.rankVersion,
        fromCache:   result.fromCache,
        generatedAt: result.generatedAt,
        hasMore:     result.profiles.length === limit,
      },
    });
  } catch (error) {
    next(error);
  }
};

// ── Feedback recording ────────────────────────────────────────────────────────

// POST /api/feed/feedback
// Body: { targetId, action, sessionId?, dwellMs?, position?, rankScore?, rankVersion? }
export const recordFeedback = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const { targetId, action, sessionId, dwellMs, position, rankScore, rankVersion } = req.body;

    const validActions: FeedbackAction[] = ['LIKE', 'SKIP', 'SUPERLIKE', 'BLOCK', 'REPORT', 'VIEW', 'DWELL', 'MATCH'];
    if (!targetId || !validActions.includes(action)) {
      res.status(400).json({ success: false, message: 'targetId and valid action are required' });
      return;
    }

    await processFeedback({
      userId,
      targetId,
      action,
      sessionId,
      dwellMs:    typeof dwellMs  === 'number' ? dwellMs  : undefined,
      position:   typeof position === 'number' ? position : undefined,
      rankScore:  typeof rankScore === 'number' ? rankScore : undefined,
      rankVersion: rankVersion ?? undefined,
    });

    // Trigger async signal refresh on high-signal actions
    if (['LIKE', 'SUPERLIKE', 'BLOCK', 'REPORT', 'MATCH'].includes(action)) {
      enqueueSignalAgg(userId,   action.toLowerCase()).catch(() => {});
      enqueueSignalAgg(targetId, action.toLowerCase()).catch(() => {});
    }

    res.status(200).json({ success: true });
  } catch (error) {
    next(error);
  }
};

// POST /api/feed/dwell — batch dwell time reporting from client
// Body: { sessionId, dwells: [{ targetId, dwellMs, position }] }
export const recordDwellBatch = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId    = req.user!.userId;
    const { sessionId, dwells } = req.body;

    if (!sessionId || !Array.isArray(dwells)) {
      res.status(400).json({ success: false, message: 'sessionId and dwells[] required' });
      return;
    }

    await processDwellBatch(userId, sessionId, dwells.slice(0, 100));
    res.status(200).json({ success: true });
  } catch (error) {
    next(error);
  }
};

// POST /api/feed/session/close
// Body: { sessionId, seenCount, likeCount, skipCount }
export const endFeedSession = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const { sessionId, seenCount, likeCount, skipCount } = req.body;

    if (!sessionId) {
      res.status(400).json({ success: false, message: 'sessionId required' });
      return;
    }

    await closeSession(userId, sessionId, {
      seenCount:  seenCount  ?? 0,
      likeCount:  likeCount  ?? 0,
      skipCount:  skipCount  ?? 0,
    });

    res.status(200).json({ success: true });
  } catch (error) {
    next(error);
  }
};

// ── Boost management ──────────────────────────────────────────────────────────

// POST /api/feed/boost/:userId — activate a paid boost (called from wallet service)
export const activateBoost = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const targetUserId = req.params.userId as string;
    const { boostScore = 0.12, ttlSeconds = 1800 } = req.body; // 30-min boost default

    await setBoost(targetUserId, boostScore, ttlSeconds);
    res.status(200).json({ success: true });
  } catch (error) {
    next(error);
  }
};

// DELETE /api/feed/boost/:userId
export const deactivateBoost = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    await clearBoost(req.params.userId as string);
    res.status(200).json({ success: true });
  } catch (error) {
    next(error);
  }
};

// ── Admin: experiments ────────────────────────────────────────────────────────

// GET /api/admin/rec/experiments
export const listExperiments = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const experiments = await prisma.rankingExperiment.findMany({
      orderBy: { createdAt: 'desc' },
      take:    50,
    });
    res.status(200).json({ success: true, data: experiments });
  } catch (error) {
    next(error);
  }
};

// POST /api/admin/rec/experiments
export const createRankingExperiment = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { name, description, trafficPct, control, treatment } = req.body;

    if (!name || !control || !treatment) {
      res.status(400).json({ success: false, message: 'name, control, treatment required' });
      return;
    }

    const id = await createExperiment({ name, description, trafficPct: trafficPct ?? 0.1, control, treatment });
    res.status(201).json({ success: true, data: { id } });
  } catch (error) {
    next(error);
  }
};

// POST /api/admin/rec/experiments/:id/activate
export const activateRankingExperiment = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    await activateExperiment(req.params.id as string);
    res.status(200).json({ success: true });
  } catch (error) {
    next(error);
  }
};

// POST /api/admin/rec/experiments/:id/stop
export const stopRankingExperiment = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    await stopExperiment(req.params.id as string);
    res.status(200).json({ success: true });
  } catch (error) {
    next(error);
  }
};

// ── Admin: debug / observability ──────────────────────────────────────────────

// POST /api/admin/rec/snapshot/:userId — capture feed snapshot for debugging
export const captureFeedSnapshot = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.params.userId as string;
    await snapshotFeed(userId);
    const snapshot = await prisma.recommendationSnapshot.findFirst({
      where:   { userId },
      orderBy: { snapshotAt: 'desc' },
    });
    res.status(200).json({ success: true, data: snapshot });
  } catch (error) {
    next(error);
  }
};

// GET /api/admin/rec/snapshot/:userId
export const getFeedSnapshot = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId    = req.params.userId as string;
    const snapshots = await prisma.recommendationSnapshot.findMany({
      where:   { userId },
      orderBy: { snapshotAt: 'desc' },
      take:    5,
    });
    res.status(200).json({ success: true, data: snapshots });
  } catch (error) {
    next(error);
  }
};

// GET /api/admin/rec/signals/:userId
export const getUserSignalProfile = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.params.userId as string;
    const [profile, history] = await Promise.all([
      prisma.userSignalProfile.findUnique({ where: { userId } }),
      prisma.recommendationFeedback.groupBy({
        by:    ['action'],
        where: { userId },
        _count: true,
        orderBy: { _count: { action: 'desc' } },
      }),
    ]);
    res.status(200).json({ success: true, data: { profile, feedbackBreakdown: history } });
  } catch (error) {
    next(error);
  }
};

// POST /api/admin/rec/signal-refresh/:userId — manual signal recompute
export const triggerSignalRefresh = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.params.userId as string;
    await enqueueSignalAgg(userId, 'admin_manual');
    await enqueueCandidateGen(userId);
    res.status(200).json({ success: true, message: 'Signal refresh + candidate regen queued' });
  } catch (error) {
    next(error);
  }
};
