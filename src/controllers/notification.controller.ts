import { Request, Response, NextFunction } from 'express';
import prisma from '../services/prisma.service';

// GET /api/notifications
export const getNotifications = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId  = req.user!.userId;
    const { page = '1', limit = '30' } = req.query;

    const pageNum  = Math.max(1, parseInt(page  as string, 10));
    const limitNum = Math.min(50, Math.max(1, parseInt(limit as string, 10)));

    const [notifications, total, unreadCount] = await prisma.$transaction([
      prisma.notification.findMany({
        where:   { userId },
        orderBy: { createdAt: 'desc' },
        skip:    (pageNum - 1) * limitNum,
        take:    limitNum,
        select:  { id: true, type: true, referenceId: true, isRead: true, createdAt: true },
      }),
      prisma.notification.count({ where: { userId } }),
      prisma.notification.count({ where: { userId, isRead: false } }),
    ]);

    const data = notifications.map((n) => ({
      notificationId: n.id,
      type:           n.type,
      referenceId:    n.referenceId,
      isRead:         n.isRead,
      createdAt:      n.createdAt,
    }));

    res.status(200).json({
      success: true,
      data,
      meta: { page: pageNum, limit: limitNum, total, unreadCount },
    });
  } catch (error) {
    next(error);
  }
};

// POST /api/notifications/read
// Body: { ids: string[] }  — mark specific notifications as read
//       { all: true }      — mark all as read
export const markRead = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId      = req.user!.userId;
    const { ids, all } = req.body;

    if (all === true) {
      await prisma.notification.updateMany({
        where: { userId, isRead: false },
        data:  { isRead: true },
      });
    } else if (Array.isArray(ids) && ids.length > 0) {
      await prisma.notification.updateMany({
        where: { userId, id: { in: ids as string[] }, isRead: false },
        data:  { isRead: true },
      });
    } else {
      res.status(400).json({ success: false, message: 'ids array or all:true is required' });
      return;
    }

    const unreadCount = await prisma.notification.count({ where: { userId, isRead: false } });

    res.status(200).json({ success: true, data: { unreadCount } });
  } catch (error) {
    next(error);
  }
};
