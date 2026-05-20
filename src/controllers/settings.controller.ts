import { Request, Response, NextFunction } from 'express';
import prisma from '../services/prisma.service';

const VALID_ALLOW_MESSAGES = ['all', 'liked', 'none'] as const;

// GET /api/settings/privacy
export const getPrivacySettings = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user!.userId;

    const profile = await prisma.profile.findUnique({
      where: { userId },
      select: { isHidden: true, allowMessagesFrom: true },
    });

    if (!profile) {
      res.status(404).json({ success: false, message: 'Profile not found. Complete your profile first.' });
      return;
    }

    res.status(200).json({
      success: true,
      data: { isHidden: profile.isHidden, allowMessagesFrom: profile.allowMessagesFrom },
    });
  } catch (error) {
    next(error);
  }
};

// PUT /api/settings/privacy
export const updatePrivacySettings = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const { isHidden, allowMessagesFrom } = req.body;

    if (
      allowMessagesFrom !== undefined &&
      !VALID_ALLOW_MESSAGES.includes(allowMessagesFrom)
    ) {
      res.status(400).json({
        success: false,
        message: `allowMessagesFrom must be one of: ${VALID_ALLOW_MESSAGES.join(', ')}`,
      });
      return;
    }

    const profile = await prisma.profile.update({
      where: { userId },
      data: {
        ...(isHidden !== undefined ? { isHidden: Boolean(isHidden) } : {}),
        ...(allowMessagesFrom !== undefined ? { allowMessagesFrom } : {}),
      },
      select: { isHidden: true, allowMessagesFrom: true },
    });

    res.status(200).json({
      success: true,
      data: { isHidden: profile.isHidden, allowMessagesFrom: profile.allowMessagesFrom },
    });
  } catch (error: any) {
    if (error.code === 'P2025') {
      res.status(404).json({ success: false, message: 'Profile not found. Complete your profile first.' });
      return;
    }
    next(error);
  }
};
