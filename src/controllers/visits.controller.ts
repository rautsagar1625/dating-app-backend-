import { Request, Response, NextFunction } from 'express';
import prisma from '../services/prisma.service';
import { createNotification } from '../services/notification.service';
import { isOnline } from '../services/online.service';

const VISIT_COOLDOWN_MS = 15 * 60 * 1000;

// POST /api/visits/:userId  — record a profile view
export const recordVisit = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const visitorId = req.user!.userId;
    const visitedId = req.params.userId as string;

    if (visitorId === visitedId) {
      // Viewing own profile — skip silently
      res.status(200).json({ success: true, data: null });
      return;
    }

    const existing = await prisma.profileVisit.findUnique({
      where: { visitorId_visitedId: { visitorId, visitedId } },
    });

    if (existing && Date.now() - existing.visitedAt.getTime() < VISIT_COOLDOWN_MS) {
      // Within cooldown — skip silently
      res.status(200).json({ success: true, data: null });
      return;
    }

    const visit = await prisma.profileVisit.upsert({
      where: { visitorId_visitedId: { visitorId, visitedId } },
      create: { visitorId, visitedId },
      update: { visitedAt: new Date() },
    });

    // Fire-and-forget — never block the response on notification creation
    createNotification(visitedId, 'VISIT', visitorId);

    res.status(200).json({ success: true, data: visit });
  } catch (error) {
    next(error);
  }
};

// GET /api/visits/visitors  — list users who visited my profile, most recent first
export const getVisitors = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const visitedId = req.user!.userId;
    const { limit = '50' } = req.query;
    const limitNum = Math.min(100, Math.max(1, parseInt(limit as string, 10)));

    const visits = await prisma.profileVisit.findMany({
      where: { visitedId },
      orderBy: { visitedAt: 'desc' },
      take: limitNum,
      select: {
        id: true,
        visitedAt: true,
        visitor: {
          select: {
            id: true,
            lastSeen: true,
            profile: {
              select: { username: true, age: true, gender: true, isPrivatePhoto: true },
            },
            photos: {
              where: { isPrivate: false },
              select: { url: true },
              take: 1,
            },
          },
        },
      },
    });

    const result = visits.map((v) => ({
      visitId: v.id,
      visitedAt: v.visitedAt,
      visitor: {
        userId: v.visitor.id,
        username: v.visitor.profile?.username ?? null,
        displayUsername: v.visitor.profile?.username ? `@${v.visitor.profile.username}` : null,
        age: v.visitor.profile?.age ?? null,
        gender: v.visitor.profile?.gender ?? null,
        isPrivatePhoto: v.visitor.profile?.isPrivatePhoto ?? false,
        isOnline: isOnline(v.visitor.lastSeen),
        avatarUrl: v.visitor.photos[0]?.url ?? null,
      },
    }));

    res.status(200).json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};
