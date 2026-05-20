import { Request, Response, NextFunction } from 'express';
import prisma from '../services/prisma.service';
import { isOnline } from '../services/online.service';

// POST /api/favorites/:userId  — add favorite (409 if already exists)
export const addFavorite = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const targetId = req.params.userId as string;

    if (!targetId || userId === targetId) {
      res.status(400).json({ success: false, message: 'Invalid target user' });
      return;
    }

    const favorite = await prisma.favorite.create({ data: { userId, targetId } });

    res.status(201).json({ success: true, data: { id: favorite.id, isFavorited: true } });
  } catch (error: any) {
    if (error.code === 'P2002') {
      res.status(409).json({ success: false, message: 'Already favorited' });
      return;
    }
    next(error);
  }
};

// DELETE /api/favorites/:userId  — remove favorite
export const removeFavorite = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const targetId = req.params.userId as string;

    const deleted = await prisma.favorite.deleteMany({ where: { userId, targetId } });

    if (deleted.count === 0) {
      res.status(404).json({ success: false, message: 'Favorite not found' });
      return;
    }

    res.status(200).json({ success: true, data: { isFavorited: false } });
  } catch (error) {
    next(error);
  }
};

// GET /api/favorites/check/:userId  — check if a specific user is favorited
export const checkFavorite = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const targetId = req.params.userId as string;

    const fav = await prisma.favorite.findUnique({
      where: { userId_targetId: { userId, targetId } },
      select: { id: true },
    });

    res.status(200).json({ success: true, data: { isFavorited: !!fav } });
  } catch (error) {
    next(error);
  }
};

// GET /api/favorites  — list all favorited profiles
export const getFavorites = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const { limit = '100' } = req.query;
    const limitNum = Math.min(200, Math.max(1, parseInt(limit as string, 10)));

    const favorites = await prisma.favorite.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: limitNum,
      select: {
        id: true,
        createdAt: true,
        target: {
          select: {
            id: true,
            lastSeen: true,
            profile: {
              select: { username: true, age: true, gender: true, location: true, isPrivatePhoto: true },
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

    const data = favorites.map((f) => ({
      favoriteId: f.id,
      savedAt: f.createdAt,
      user: {
        userId: f.target.id,
        username: f.target.profile?.username ?? null,
        age: f.target.profile?.age ?? null,
        gender: f.target.profile?.gender ?? null,
        location: f.target.profile?.location ?? null,
        isPrivatePhoto: f.target.profile?.isPrivatePhoto ?? false,
        isOnline: isOnline(f.target.lastSeen),
        avatarUrl: f.target.photos[0]?.url ?? null,
      },
    }));

    res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};
