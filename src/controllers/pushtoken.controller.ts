import { Request, Response, NextFunction } from 'express';
import prisma from '../services/prisma.service';

// POST /api/push-tokens  — register or refresh a device push token
export const registerPushToken = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const { token } = req.body;

    if (!token || typeof token !== 'string' || !token.startsWith('ExponentPushToken[')) {
      res.status(400).json({ success: false, message: 'Invalid push token format' });
      return;
    }

    // Upsert by token value: if the token already exists for another user
    // (device re-used), re-assign it; if it's new, create it.
    await prisma.pushToken.upsert({
      where:  { token },
      update: { userId },
      create: { userId, token },
    });

    res.status(200).json({ success: true, data: null });
  } catch (error) {
    next(error);
  }
};

// DELETE /api/push-tokens  — deregister on logout (optional, best-effort)
export const deregisterPushToken = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const { token } = req.body;

    if (token) {
      await prisma.pushToken.deleteMany({ where: { userId, token } });
    } else {
      // No token supplied — remove all tokens for this user (full logout)
      await prisma.pushToken.deleteMany({ where: { userId } });
    }

    res.status(200).json({ success: true, data: null });
  } catch (error) {
    next(error);
  }
};
