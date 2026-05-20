import { Request, Response, NextFunction } from 'express';
import prisma from '../services/prisma.service';

// Shapes a profile row into the public-safe object
const formatProfile = (profile: any, isOwner: boolean) => ({
  userId: profile.userId,
  username: isOwner ? profile.username : `@${profile.username}`,
  age: profile.age ?? null,
  gender: profile.gender ?? null,
  location: profile.location ?? null,
  bio: profile.bio ?? null,
  isPrivatePhoto: profile.isPrivatePhoto ?? false,
  isAnonymous: profile.isAnonymous ?? false,
});

// GET /api/profile  (own profile, protected)
export const getProfile = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user!.userId;

    const profile = await prisma.profile.findUnique({ where: { userId } });

    if (!profile) {
      res.status(404).json({ success: false, message: 'Profile not found' });
      return;
    }

    res.status(200).json({ success: true, data: formatProfile(profile, true) });
  } catch (error) {
    next(error);
  }
};

// GET /api/profile/:userId  (public profile view, protected)
export const getUserProfile = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const currentUserId = req.user!.userId;
    const userId = req.params.userId as string;

    const profile = await prisma.profile.findUnique({ where: { userId } });

    if (!profile) {
      res.status(404).json({ success: false, message: 'Profile not found' });
      return;
    }

    const isOwner = currentUserId === userId;
    res.status(200).json({ success: true, data: formatProfile(profile, isOwner) });
  } catch (error) {
    next(error);
  }
};

// POST/PUT /api/profile  (upsert own profile, protected)
export const upsertProfile = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const { username, age, gender, location, bio, isAnonymous, isPrivatePhoto } = req.body;

    if (!username || username.length > 30) {
      res.status(400).json({ success: false, message: 'Username is required and must be 30 characters or fewer' });
      return;
    }
    if (bio && bio.length > 500) {
      res.status(400).json({ success: false, message: 'Bio must be 500 characters or fewer' });
      return;
    }
    if (age !== undefined && (Number(age) < 18 || Number(age) > 120)) {
      res.status(400).json({ success: false, message: 'Age must be between 18 and 120' });
      return;
    }

    const profile = await prisma.profile.upsert({
      where: { userId },
      update: {
        username,
        age: age ? Number(age) : undefined,
        gender,
        location,
        bio,
        isAnonymous: isAnonymous ?? undefined,
        isPrivatePhoto: isPrivatePhoto ?? undefined,
      },
      create: {
        userId,
        username,
        age: age ? Number(age) : undefined,
        gender,
        location,
        bio,
        isAnonymous: isAnonymous ?? false,
        isPrivatePhoto: isPrivatePhoto ?? false,
      },
    });

    res.status(200).json({ success: true, data: formatProfile(profile, true) });
  } catch (error: any) {
    if (error.code === 'P2002') {
      res.status(409).json({ success: false, message: 'Username already taken' });
      return;
    }
    next(error);
  }
};
