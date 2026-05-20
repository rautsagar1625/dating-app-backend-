import { Request, Response, NextFunction } from 'express';
import prisma from '../services/prisma.service';
import { getBlockedUserIds, isBlocked } from '../services/block.service';
import { isOnline, ONLINE_THRESHOLD_MS } from '../services/online.service';
import { signUrl } from '../services/signedUrl.service';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

function computeScore(
  p: { age: number | null; gender: string | null; location: string | null; bio: string | null; user: { lastSeen: Date | null; photos: { id: string; url: string }[]; _count: { likesReceived: number } } },
  currentLocation: string | null,
): number {
  const lastSeenMs = p.user.lastSeen ? Date.now() - new Date(p.user.lastSeen).getTime() : Infinity;

  let lastActiveScore = 0;
  if (lastSeenMs < ONLINE_THRESHOLD_MS) lastActiveScore = 40;
  else if (lastSeenMs < HOUR_MS) lastActiveScore = 30;
  else if (lastSeenMs < DAY_MS) lastActiveScore = 20;
  else if (lastSeenMs < WEEK_MS) lastActiveScore = 10;

  const proximityScore =
    currentLocation && p.location && p.location.toLowerCase().includes(currentLocation) ? 20 : 0;

  const likesScore = Math.min(p.user._count.likesReceived, 20);

  const completenessScore =
    (p.bio ? 4 : 0) + (p.age ? 4 : 0) + (p.gender ? 4 : 0) + (p.location ? 4 : 0) + (p.user.photos.length > 0 ? 4 : 0);

  return lastActiveScore + proximityScore + likesScore + completenessScore;
}

// GET /api/users  (browse with filters)
export const browseUsers = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const currentUserId = req.user!.userId;
    const { gender, online, page = '1', limit = '20', age_min, age_max, location } = req.query;

    const pageNum = Math.max(1, parseInt(page as string, 10));
    const limitNum = Math.min(50, Math.max(1, parseInt(limit as string, 10)));
    const skip = (pageNum - 1) * limitNum;

    const ageMin = age_min ? parseInt(age_min as string, 10) : undefined;
    const ageMax = age_max ? parseInt(age_max as string, 10) : undefined;

    // Anti-repetition: exclude profiles seen in the last 24h (unless it's page 1 refresh)
    const freshFeed = pageNum === 1;
    const seenCutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const [blockedIds, currentProfile, seenProfileIds] = await Promise.all([
      getBlockedUserIds(currentUserId),
      prisma.profile.findUnique({ where: { userId: currentUserId }, select: { location: true } }),
      freshFeed
        ? Promise.resolve([] as string[])
        : prisma.feedImpression.findMany({
            where: { viewerId: currentUserId, seenAt: { gte: seenCutoff } },
            select: { profileId: true },
          }).then((rows) => rows.map((r) => r.profileId)),
    ]);

    const excludeIds = [...blockedIds, ...seenProfileIds];
    const currentLocation = currentProfile?.location?.toLowerCase() ?? null;

    const profiles = await prisma.profile.findMany({
      where: {
        userId: {
          not: currentUserId,
          ...(excludeIds.length > 0 ? { notIn: excludeIds } : {}),
        },
        isAnonymous: false,
        isHidden: false,
        user: { isBanned: false },
        ...(gender ? { gender: gender as string } : {}),
        ...(ageMin !== undefined || ageMax !== undefined
          ? { age: { ...(ageMin !== undefined ? { gte: ageMin } : {}), ...(ageMax !== undefined ? { lte: ageMax } : {}) } }
          : {}),
        ...(location ? { location: { contains: location as string, mode: 'insensitive' } } : {}),
      },
      include: {
        user: {
          select: {
            lastSeen: true,
            photos: {
              where: { isPrivate: false },
              select: { id: true, url: true },
              take: 1,
            },
            _count: { select: { likesReceived: true } },
          },
        },
      },
      take: 200,
    });

    let results = profiles.map((p) => ({
      userId: p.userId,
      username: p.username,
      displayUsername: `@${p.username}`,
      age: p.age ?? null,
      gender: p.gender ?? null,
      location: p.location ?? null,
      bio: p.bio ?? null,
      isPrivatePhoto: p.isPrivatePhoto,
      isAnonymous: p.isAnonymous,
      isOnline: isOnline(p.user.lastSeen),
      lastSeenAt: p.user.lastSeen?.toISOString() ?? null,
      photos: p.user.photos,
      score: computeScore(p, currentLocation),
    }));

    results.sort((a, b) => b.score - a.score);

    if (online === 'true') {
      results = results.filter((u) => u.isOnline);
    }

    const paginated = results.slice(skip, skip + limitNum);

    res.status(200).json({
      success: true,
      data: paginated,
      meta: { page: pageNum, limit: limitNum, count: paginated.length },
    });

    // Record feed impressions after response — never delays the client
    if (paginated.length > 0) {
      const now = new Date();
      prisma.$transaction(
        paginated.map((u) =>
          prisma.feedImpression.upsert({
            where: { viewerId_profileId: { viewerId: currentUserId, profileId: u.userId } },
            create: { viewerId: currentUserId, profileId: u.userId, seenAt: now },
            update: { seenAt: now },
          })
        )
      ).catch(() => {});
    }
  } catch (error) {
    next(error);
  }
};

// GET /api/users/:userId  (single public profile)
export const getUserById = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const currentUserId = req.user!.userId;
    const userId = req.params.userId as string;

    const profile = await prisma.profile.findUnique({
      where: { userId },
      include: {
        user: {
          select: {
            lastSeen: true,
            photos: {
              where: { isPrivate: false },
              select: { id: true, url: true },
            },
          },
        },
      },
    });

    if (!profile) {
      res.status(404).json({ success: false, message: 'User not found' });
      return;
    }

    if (currentUserId !== userId) {
      if (await isBlocked(currentUserId, userId)) {
        res.status(404).json({ success: false, message: 'User not found' });
        return;
      }
      if (profile.isHidden) {
        res.status(404).json({ success: false, message: 'User not found' });
        return;
      }
    }

    let photos = profile.user.photos;
    let privateAccessGranted = !profile.isPrivatePhoto || currentUserId === userId;

    if (profile.isPrivatePhoto && currentUserId !== userId) {
      const accessRequest = await prisma.photoAccessRequest.findUnique({
        where: { requesterId_ownerId: { requesterId: currentUserId, ownerId: userId } },
      });
      if (!accessRequest || accessRequest.status !== 'GRANTED') {
        photos = [];
      } else {
        privateAccessGranted = true;
      }
    }

    // Sign private photo URLs so they can't be hotlinked after expiry
    const signedPhotos = privateAccessGranted
      ? photos.map((p) => {
          try {
            const parsed = new URL(p.url);
            return { ...p, url: `${parsed.origin}${signUrl(parsed.pathname)}` };
          } catch {
            return { ...p, url: signUrl(p.url) };
          }
        })
      : photos;

    res.status(200).json({
      success: true,
      data: {
        userId: profile.userId,
        username: profile.username,
        displayUsername: `@${profile.username}`,
        age: profile.age ?? null,
        gender: profile.gender ?? null,
        location: profile.location ?? null,
        bio: profile.bio ?? null,
        isPrivatePhoto: profile.isPrivatePhoto,
        isAnonymous: profile.isAnonymous,
        isOnline: isOnline(profile.user.lastSeen),
        lastSeenAt: profile.user.lastSeen?.toISOString() ?? null,
        photos: signedPhotos,
      },
    });
  } catch (error) {
    next(error);
  }
};
