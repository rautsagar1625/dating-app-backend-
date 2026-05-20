import { Request, Response, NextFunction } from 'express';
import { activateBoost, getActiveBoost, expireBoost } from '../services/boosts/boost.service';
import { hasEntitlement } from '../services/entitlements/entitlement.engine';
import prisma from '../services/prisma.service';

// POST /api/boosts/activate  — direct boost purchase (via credits/wallet)
export const activateBoostHandler = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const { type = 'BOOST', durationMinutes = 30, multiplier = 1.5 } = req.body;

    // Diamond subscribers get a free weekly boost — check entitlement
    const hasFreeBoost = await hasEntitlement(userId, 'PROFILE_BOOST_WEEKLY');

    if (!hasFreeBoost) {
      // Deduct credits from wallet
      const costCredits = getBoostCostCredits(type, durationMinutes);
      const wallet = await prisma.wallet.findUnique({
        where:  { userId },
        select: { balance: true },
      });
      if (!wallet || wallet.balance < costCredits) {
        res.status(402).json({ success: false, message: 'Insufficient credits', required: costCredits });
        return;
      }
      await prisma.wallet.update({
        where: { userId },
        data:  { balance: { decrement: costCredits } },
      });
      await prisma.transaction.create({
        data: { userId, amount: -costCredits, type: 'DEBIT', reason: `Boost: ${type} ${durationMinutes}min` },
      });
    }

    const result = await activateBoost({ userId, type, durationMinutes, multiplier });
    const boost  = await getActiveBoost(userId);

    res.status(200).json({
      success: true,
      data: {
        boostId:   result.boostId,
        type,
        expiresAt: boost?.expiresAt,
        free:      hasFreeBoost,
      },
    });
  } catch (err: any) {
    if (err.statusCode) {
      res.status(err.statusCode).json({ success: false, message: err.message, ttlSeconds: err.ttlSeconds });
      return;
    }
    next(err);
  }
};

// GET /api/boosts/status
export const getBoostStatus = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const boost  = await getActiveBoost(userId);
    res.status(200).json({ success: true, data: { activeBoost: boost } });
  } catch (err) {
    next(err);
  }
};

// DELETE /api/boosts/:boostId  — cancel an active boost
export const cancelBoost = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId  = req.user!.userId;
    const boostId = req.params.boostId as string;

    const boost = await prisma.boostCampaign.findUnique({
      where:  { id: boostId },
      select: { userId: true, status: true },
    });
    if (!boost) {
      res.status(404).json({ success: false, message: 'Boost not found' });
      return;
    }
    if (boost.userId !== userId) {
      res.status(403).json({ success: false, message: 'Not your boost' });
      return;
    }
    if (boost.status !== 'ACTIVE') {
      res.status(409).json({ success: false, message: 'Boost is not active' });
      return;
    }

    await expireBoost(boostId, userId);
    res.status(200).json({ success: true });
  } catch (err) {
    next(err);
  }
};

// GET /api/boosts/history
export const getBoostHistory = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const limit  = Math.min(parseInt(req.query.limit as string ?? '20'), 50);

    const boosts = await prisma.boostCampaign.findMany({
      where:   { userId },
      orderBy: { createdAt: 'desc' },
      take:    limit,
      select: {
        id: true, type: true, status: true,
        durationMinutes: true, multiplier: true,
        impressionsSent: true, impressionsCap: true,
        startedAt: true, expiresAt: true, createdAt: true,
      },
    });

    res.status(200).json({ success: true, data: { boosts } });
  } catch (err) {
    next(err);
  }
};

function getBoostCostCredits(type: string, durationMinutes: number): number {
  const rates: Record<string, number> = { BOOST: 50, SPOTLIGHT: 80, SUPERLIKE: 30 };
  const base = rates[type] ?? 50;
  return Math.round(base * (durationMinutes / 30));
}
