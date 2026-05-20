import { Request, Response, NextFunction } from 'express';
import prisma from '../services/prisma.service';
import { recordRiskEvent } from '../services/risk.service';
import { trackEvent } from '../services/analytics.service';

// POST /api/reports/:userId
export const reportUser = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const reporterId = req.user!.userId;
    const reportedId = req.params.userId as string;
    const { reason } = req.body;

    if (reporterId === reportedId) {
      res.status(400).json({ success: false, message: 'Cannot report yourself' });
      return;
    }

    if (!reason || !reason.trim()) {
      res.status(400).json({ success: false, message: 'Reason is required' });
      return;
    }

    const target = await prisma.user.findUnique({ where: { id: reportedId }, select: { id: true } });
    if (!target) {
      res.status(404).json({ success: false, message: 'User not found' });
      return;
    }

    const report = await prisma.report.create({
      data: { reporterId, reportedId, reason: reason.trim() },
    });

    recordRiskEvent(reportedId, 'reported', reason.trim()).catch(() => {});
    trackEvent('report_filed', reporterId, { reportedId, reason: reason.trim() });

    res.status(201).json({ success: true, data: { id: report.id } });
  } catch (error) {
    next(error);
  }
};
