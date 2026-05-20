import { Request, Response, NextFunction } from 'express';
import prisma from '../services/prisma.service';
import { createNotification } from '../services/notification.service';
import { isOnline as isUserOnline } from '../services/online.service';
import { trackEvent } from '../services/analytics.service';
import { processFeedback } from '../services/recommendation/feedback/feedback.handler';
import { enqueueSignalAgg } from '../services/recommendation/recommendation.queue';

// POST /api/likes  — send a like
export const sendLike = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const senderId = req.user!.userId;
    const { receiverId } = req.body;

    if (!receiverId) {
      res.status(400).json({ success: false, message: 'receiverId is required' });
      return;
    }

    if (senderId === receiverId) {
      res.status(400).json({ success: false, message: 'You cannot like yourself' });
      return;
    }

    const like = await prisma.like.create({ data: { senderId, receiverId } });

    const reverseLike = await prisma.like.findUnique({
      where: { senderId_receiverId: { senderId: receiverId, receiverId: senderId } },
    });

    trackEvent('like_sent', senderId, { receiverId, isMutual: !!reverseLike });
    createNotification(receiverId, 'LIKE', senderId);

    // Feed feedback loop — fire-and-forget
    processFeedback({ userId: senderId, targetId: receiverId, action: reverseLike ? 'MATCH' : 'LIKE' }).catch(() => {});
    enqueueSignalAgg(senderId,   'like_sent').catch(() => {});
    enqueueSignalAgg(receiverId, 'like_received').catch(() => {});

    res.status(201).json({ success: true, data: { like, isMutual: !!reverseLike } });
  } catch (error: any) {
    if (error.code === 'P2002') {
      res.status(409).json({ success: false, message: 'Already liked this user' });
      return;
    }
    next(error);
  }
};

// DELETE /api/likes/:receiverId  — remove a like
export const removeLike = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const senderId = req.user!.userId;
    const receiverId = req.params.receiverId as string;

    const like = await prisma.like.findUnique({
      where: { senderId_receiverId: { senderId, receiverId } },
    });

    if (!like) {
      res.status(404).json({ success: false, message: 'Like not found' });
      return;
    }

    await prisma.like.delete({ where: { id: like.id } });

    res.status(200).json({ success: true, message: 'Like removed' });
  } catch (error) {
    next(error);
  }
};

// GET /api/likes/received  — likes the current user received
export const getLikesReceived = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const myId = req.user!.userId;

    const [received, sent] = await Promise.all([
      prisma.like.findMany({
        where: { receiverId: myId },
        select: {
          id: true,
          createdAt: true,
          sender: {
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
        orderBy: { createdAt: 'desc' },
      }),
      prisma.like.findMany({
        where: { senderId: myId },
        select: { receiverId: true },
      }),
    ]);

    const myLikedIds = new Set(sent.map((l) => l.receiverId));

    const data = received.map((l) => ({
      likeId: l.id,
      createdAt: l.createdAt,
      isMutual: myLikedIds.has(l.sender.id),
      user: {
        userId: l.sender.id,
        username: l.sender.profile?.username ?? null,
        displayUsername: l.sender.profile?.username ? `@${l.sender.profile.username}` : null,
        age: l.sender.profile?.age ?? null,
        gender: l.sender.profile?.gender ?? null,
        isPrivatePhoto: l.sender.profile?.isPrivatePhoto ?? false,
        isOnline: isUserOnline(l.sender.lastSeen),
        avatarUrl: l.sender.photos[0]?.url ?? null,
      },
    }));

    res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

// GET /api/likes/sent  — likes the current user sent
export const getLikesSent = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const myId = req.user!.userId;

    const [sent, received] = await Promise.all([
      prisma.like.findMany({
        where: { senderId: myId },
        select: {
          id: true,
          createdAt: true,
          receiver: {
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
        orderBy: { createdAt: 'desc' },
      }),
      prisma.like.findMany({
        where: { receiverId: myId },
        select: { senderId: true },
      }),
    ]);

    const likedMeIds = new Set(received.map((l) => l.senderId));

    const data = sent.map((l) => ({
      likeId: l.id,
      createdAt: l.createdAt,
      isMutual: likedMeIds.has(l.receiver.id),
      user: {
        userId: l.receiver.id,
        username: l.receiver.profile?.username ?? null,
        displayUsername: l.receiver.profile?.username ? `@${l.receiver.profile.username}` : null,
        age: l.receiver.profile?.age ?? null,
        gender: l.receiver.profile?.gender ?? null,
        isPrivatePhoto: l.receiver.profile?.isPrivatePhoto ?? false,
        isOnline: isUserOnline(l.receiver.lastSeen),
        avatarUrl: l.receiver.photos[0]?.url ?? null,
      },
    }));

    res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};
