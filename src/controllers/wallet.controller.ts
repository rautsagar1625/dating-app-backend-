import { Request, Response, NextFunction } from 'express';
import prisma from '../services/prisma.service';

const PACKAGES: Record<string, { amount: number; label: string }> = {
  starter:  { amount: 50,   label: 'Starter Pack — 50 credits'    },
  popular:  { amount: 200,  label: 'Popular Pack — 200 credits'    },
  premium:  { amount: 500,  label: 'Premium Pack — 500 credits'    },
  ultimate: { amount: 1000, label: 'Ultimate Pack — 1000 credits'  },
};

// GET /api/wallet
export const getBalance = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user!.userId;

    const wallet = await prisma.wallet.upsert({
      where:  { userId },
      update: {},
      create: { userId, balance: 0 },
      select: { balance: true },
    });

    res.status(200).json({ success: true, data: { balance: wallet.balance } });
  } catch (error) {
    next(error);
  }
};

// POST /api/wallet/add
export const addCredits = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const { packageId, amount: rawAmount } = req.body;

    let amount: number;
    let reason: string;

    if (packageId) {
      const pkg = PACKAGES[packageId as string];
      if (!pkg) {
        res.status(400).json({ success: false, message: 'Invalid packageId' });
        return;
      }
      amount = pkg.amount;
      reason = pkg.label;
    } else if (rawAmount) {
      amount = Number(rawAmount);
      if (!amount || amount <= 0 || !Number.isInteger(amount)) {
        res.status(400).json({ success: false, message: 'amount must be a positive integer' });
        return;
      }
      reason = `Added ${amount} credits`;
    } else {
      res.status(400).json({ success: false, message: 'packageId or amount is required' });
      return;
    }

    const result = await prisma.$transaction(async (tx) => {
      const wallet = await tx.wallet.upsert({
        where:  { userId },
        update: { balance: { increment: amount } },
        create: { userId, balance: amount },
      });

      await tx.transaction.create({
        data: { userId, amount, type: 'CREDIT', reason },
      });

      return wallet;
    });

    res.status(200).json({ success: true, data: { balance: result.balance } });
  } catch (error) {
    next(error);
  }
};

// POST /api/wallet/deduct
export const deductCredits = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const { amount, reason } = req.body;

    if (!amount || !Number.isInteger(Number(amount)) || Number(amount) <= 0) {
      res.status(400).json({ success: false, message: 'amount must be a positive integer' });
      return;
    }
    if (!reason?.trim()) {
      res.status(400).json({ success: false, message: 'reason is required' });
      return;
    }

    const cost = Number(amount);

    const result = await prisma.$transaction(async (tx) => {
      const wallet = await tx.wallet.findUnique({
        where:  { userId },
        select: { balance: true },
      });

      if (!wallet) throw new Error('WALLET_NOT_FOUND');
      if (wallet.balance < cost) throw new Error('INSUFFICIENT_BALANCE');

      const updated = await tx.wallet.update({
        where: { userId },
        data:  { balance: { decrement: cost } },
      });

      await tx.transaction.create({
        data: { userId, amount: cost, type: 'DEBIT', reason: reason.trim() },
      });

      return updated;
    });

    res.status(200).json({ success: true, data: { balance: result.balance } });
  } catch (error: any) {
    if (error.message === 'INSUFFICIENT_BALANCE') {
      res.status(402).json({ success: false, message: 'Insufficient credits' });
      return;
    }
    if (error.message === 'WALLET_NOT_FOUND') {
      res.status(404).json({ success: false, message: 'Wallet not found' });
      return;
    }
    next(error);
  }
};

// GET /api/wallet/history
export const getHistory = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const { page = '1', limit = '20' } = req.query;

    const pageNum  = Math.max(1, parseInt(page  as string, 10));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit as string, 10)));

    const [transactions, total] = await prisma.$transaction([
      prisma.transaction.findMany({
        where:   { userId },
        orderBy: { createdAt: 'desc' },
        skip:    (pageNum - 1) * limitNum,
        take:    limitNum,
        select:  { id: true, amount: true, type: true, reason: true, createdAt: true },
      }),
      prisma.transaction.count({ where: { userId } }),
    ]);

    res.status(200).json({
      success: true,
      data:    transactions,
      meta:    { page: pageNum, limit: limitNum, total },
    });
  } catch (error) {
    next(error);
  }
};
