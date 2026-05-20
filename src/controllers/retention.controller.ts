import { Request, Response, NextFunction } from 'express';
import prisma from '../services/prisma.service';

// GET /api/retention/nudge  — returns time-sensitive activity the user should act on.
// Called on app foreground to drive re-engagement without push spam.
export const getNudge = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000); // last 7 days

    const [
      unreadNotifications,
      pendingPhotoRequests,
      newVisitors,
      mutualLikeCount,
    ] = await Promise.all([
      prisma.notification.count({ where: { userId, isRead: false } }),
      prisma.photoAccessRequest.count({ where: { ownerId: userId, status: 'PENDING' } }),
      prisma.profileVisit.count({ where: { visitedId: userId, visitedAt: { gte: since } } }),
      // Mutual likes = users who liked me AND I liked back — potential matches
      prisma.like.count({
        where: {
          receiverId: userId,
          sender: {
            likesReceived: { some: { senderId: userId } },
          },
        },
      }),
    ]);

    const nudges: { type: string; count: number; label: string }[] = [];

    if (unreadNotifications > 0)
      nudges.push({ type: 'unread_notifications', count: unreadNotifications, label: `${unreadNotifications} unread notification${unreadNotifications > 1 ? 's' : ''}` });

    if (pendingPhotoRequests > 0)
      nudges.push({ type: 'pending_photo_requests', count: pendingPhotoRequests, label: `${pendingPhotoRequests} photo access request${pendingPhotoRequests > 1 ? 's' : ''}` });

    if (newVisitors > 0)
      nudges.push({ type: 'new_visitors', count: newVisitors, label: `${newVisitors} profile view${newVisitors > 1 ? 's' : ''} this week` });

    if (mutualLikeCount > 0)
      nudges.push({ type: 'mutual_likes', count: mutualLikeCount, label: `${mutualLikeCount} mutual like${mutualLikeCount > 1 ? 's' : ''} — say hello!` });

    res.status(200).json({ success: true, data: { nudges, totalActionItems: nudges.reduce((sum, n) => sum + n.count, 0) } });
  } catch (error) {
    next(error);
  }
};
