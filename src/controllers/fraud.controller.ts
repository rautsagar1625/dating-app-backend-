import { Request, Response, NextFunction } from 'express';
import prisma from '../services/prisma.service';
import { applyEnforcement, revokeEnforcement } from '../services/fraud/enforcement.service';
import { EnforcementType, ENFORCEMENT_TYPES } from '../services/fraud/fraud.types';

// ── Review queue ──────────────────────────────────────────────────────────────

// GET /api/fraud/cases?status=PENDING&priority=HIGH&limit=20
export const listCases = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { status = 'PENDING', priority, limit = '20', cursor } = req.query;
    const take = Math.min(50, parseInt(limit as string, 10));

    const cases = await prisma.fraudCase.findMany({
      where: {
        ...(status !== 'ALL' ? { status: status as string } : {}),
        ...(priority ? { priority: priority as string } : {}),
        ...(cursor ? { id: { lt: cursor as string } } : {}),
      },
      orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }],
      take,
      include: {
        deviceFp: {
          select: { riskScore: true, riskLevel: true, isEmulator: true, brand: true, model: true, linkedUserIds: true },
        },
      },
    });

    res.status(200).json({
      success: true,
      data: cases,
      meta: { count: cases.length, nextCursor: cases.length === take ? cases[take - 1]?.id : null },
    });
  } catch (error) {
    next(error);
  }
};

// PATCH /api/fraud/cases/:id — reviewer updates case
export const reviewCase = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const id = req.params.id as string;
    const { status, reviewNotes, actionTaken } = req.body;

    if (!['IN_REVIEW', 'RESOLVED', 'DISMISSED'].includes(status)) {
      res.status(400).json({ success: false, message: 'Invalid status' });
      return;
    }

    const updated = await prisma.fraudCase.update({
      where: { id },
      data: {
        status,
        reviewerId: req.user!.userId,
        reviewNotes,
        actionTaken,
        updatedAt: new Date(),
        ...(status === 'RESOLVED' || status === 'DISMISSED' ? { resolvedAt: new Date() } : {}),
      },
    });

    res.status(200).json({ success: true, data: updated });
  } catch (error) {
    next(error);
  }
};

// ── Device fingerprints ───────────────────────────────────────────────────────

// GET /api/fraud/devices?riskLevel=HIGH&limit=20
export const listDevices = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { riskLevel, limit = '20' } = req.query;
    const take = Math.min(100, parseInt(limit as string, 10));

    const devices = await prisma.deviceFingerprint.findMany({
      where: riskLevel ? { riskLevel: riskLevel as string } : {},
      orderBy: { riskScore: 'desc' },
      take,
      include: {
        _count: { select: { signals: true, cases: true } },
      },
    });

    res.status(200).json({ success: true, data: devices });
  } catch (error) {
    next(error);
  }
};

// GET /api/fraud/devices/:id
export const getDevice = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const id = req.params.id as string;
    const device = await prisma.deviceFingerprint.findUnique({
      where: { id },
      include: {
        signals:      { orderBy: { createdAt: 'desc' }, take: 20 },
        cases:        { orderBy: { createdAt: 'desc' }, take: 5  },
        enforcements: { where: { isActive: true }, orderBy: { createdAt: 'desc' } },
      },
    });

    if (!device) {
      res.status(404).json({ success: false, message: 'Device not found' });
      return;
    }

    res.status(200).json({ success: true, data: device });
  } catch (error) {
    next(error);
  }
};

// ── Manual enforcement ────────────────────────────────────────────────────────

// POST /api/fraud/enforce
export const enforceAction = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { userId, deviceFpId, actionType, reason, ttlSeconds } = req.body;

    if (!ENFORCEMENT_TYPES.includes(actionType)) {
      res.status(400).json({ success: false, message: 'Invalid actionType' });
      return;
    }
    if (!userId && !deviceFpId) {
      res.status(400).json({ success: false, message: 'userId or deviceFpId required' });
      return;
    }
    if (!reason) {
      res.status(400).json({ success: false, message: 'reason required' });
      return;
    }

    await applyEnforcement(
      userId ?? null,
      deviceFpId ?? null,
      actionType as EnforcementType,
      reason,
      ttlSeconds,
      req.user!.userId,
    );

    res.status(200).json({ success: true });
  } catch (error) {
    next(error);
  }
};

// DELETE /api/fraud/enforce/:actionId — revoke an active enforcement
export const revokeAction = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    await revokeEnforcement(req.params.actionId as string, req.user!.userId);
    res.status(200).json({ success: true });
  } catch (error) {
    next(error);
  }
};

// GET /api/fraud/user/:userId — full fraud profile for a user
export const getUserFraudProfile = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.params.userId as string;

    const [riskProfile, cases, enforcements, signals] = await Promise.all([
      prisma.userRiskProfile.findUnique({ where: { userId } }),
      prisma.fraudCase.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: 10 }),
      prisma.fraudEnforcementAction.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: 10,
      }),
      prisma.fraudSignal.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: 20,
      }),
    ]);

    res.status(200).json({ success: true, data: { riskProfile, cases, enforcements, signals } });
  } catch (error) {
    next(error);
  }
};

// GET /api/fraud/stats — dashboard summary
export const getStats = async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const [pending, highPriority, emulators, activeEnforcements] = await Promise.all([
      prisma.fraudCase.count({ where: { status: 'PENDING' } }),
      prisma.fraudCase.count({ where: { status: 'PENDING', priority: 'HIGH' } }),
      prisma.deviceFingerprint.count({ where: { isEmulator: true } }),
      prisma.fraudEnforcementAction.count({ where: { isActive: true } }),
    ]);

    res.status(200).json({
      success: true,
      data: { pendingCases: pending, highPriorityCases: highPriority, emulatorDevices: emulators, activeEnforcements },
    });
  } catch (error) {
    next(error);
  }
};
