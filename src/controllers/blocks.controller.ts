import { Request, Response, NextFunction } from 'express';
import prisma from '../services/prisma.service';
import { recordRiskEvent } from '../services/risk.service';

// POST /api/blocks/:userId — block a user
export const blockUser = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const blockerId = req.user!.userId;
    const blockedId = req.params.userId as string;

    if (!blockedId || blockerId === blockedId) {
      res.status(400).json({ success: false, message: 'Invalid target user' });
      return;
    }

    const block = await prisma.block.create({ data: { blockerId, blockedId } });

    recordRiskEvent(blockedId, 'blocked').catch(() => {});

    res.status(201).json({ success: true, data: { id: block.id } });
  } catch (error: any) {
    if (error.code === 'P2002') {
      res.status(409).json({ success: false, message: 'Already blocked' });
      return;
    }
    next(error);
  }
};

// DELETE /api/blocks/:userId — unblock a user
export const unblockUser = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const blockerId = req.user!.userId;
    const blockedId = req.params.userId as string;

    const deleted = await prisma.block.deleteMany({ where: { blockerId, blockedId } });

    if (deleted.count === 0) {
      res.status(404).json({ success: false, message: 'Block not found' });
      return;
    }

    res.status(200).json({ success: true, data: null });
  } catch (error) {
    next(error);
  }
};

// GET /api/blocks — list users I have blocked (not who blocked me)
export const getBlocked = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const blockerId = req.user!.userId;

    const blocks = await prisma.block.findMany({
      where: { blockerId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        createdAt: true,
        blocked: {
          select: {
            id: true,
            profile: { select: { username: true } },
            photos: { where: { isPrivate: false }, select: { url: true }, take: 1 },
          },
        },
      },
    });

    const data = blocks.map((b) => ({
      blockId: b.id,
      blockedAt: b.createdAt,
      user: {
        userId: b.blocked.id,
        username: b.blocked.profile?.username ?? null,
        avatarUrl: b.blocked.photos[0]?.url ?? null,
      },
    }));

    res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};
