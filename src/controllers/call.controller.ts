import { Request, Response, NextFunction } from 'express';
import prisma from '../services/prisma.service';
import { submitCallReport } from '../services/calls/call.safety';
import { getCallState, endCall } from '../services/calls/call.state';
import { emitToUser } from '../services/socket.service';

// GET /api/calls/history
export const getCallHistory = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const limit  = Math.min(parseInt(req.query.limit as string ?? '20'), 50);
    const cursor = req.query.cursor as string | undefined;

    const calls = await prisma.callSession.findMany({
      where: {
        OR: [{ callerId: userId }, { calleeId: userId }],
        ...(cursor ? { createdAt: { lt: new Date(cursor) } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      select: {
        id:        true,
        callerId:  true,
        calleeId:  true,
        type:      true,
        status:    true,
        durationS: true,
        provider:  true,
        startedAt: true,
        endedAt:   true,
        endReason: true,
        createdAt: true,
      },
    });

    const hasMore = calls.length > limit;
    const items   = hasMore ? calls.slice(0, limit) : calls;

    res.status(200).json({
      success: true,
      data: {
        calls:      items,
        nextCursor: hasMore ? items[items.length - 1]?.createdAt.toISOString() : null,
      },
    });
  } catch (err) {
    next(err);
  }
};

// GET /api/calls/:callId
export const getCallDetails = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const callId = req.params.callId as string;

    const call = await prisma.callSession.findUnique({
      where: { id: callId },
      include: {
        participants: {
          select: { userId: true, role: true, deviceType: true, joinedAt: true, leftAt: true },
        },
      },
    });

    if (!call) {
      res.status(404).json({ success: false, message: 'Call not found' });
      return;
    }
    if (call.callerId !== userId && call.calleeId !== userId) {
      res.status(403).json({ success: false, message: 'Not a participant of this call' });
      return;
    }

    res.status(200).json({ success: true, data: call });
  } catch (err) {
    next(err);
  }
};

// POST /api/calls/:callId/report
export const reportCall = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const callId = req.params.callId as string;
    const { reportedId, reason, notes } = req.body;

    if (!reportedId || typeof reportedId !== 'string') {
      res.status(400).json({ success: false, message: 'reportedId is required' });
      return;
    }
    if (!reason || typeof reason !== 'string') {
      res.status(400).json({ success: false, message: 'reason is required' });
      return;
    }

    const reportId = await submitCallReport({ callId, reporterId: userId, reportedId, reason, notes });

    res.status(201).json({ success: true, data: { reportId } });
  } catch (err: any) {
    if (err.statusCode) {
      res.status(err.statusCode).json({ success: false, message: err.message });
      return;
    }
    next(err);
  }
};

// GET /api/calls/:callId/quality
export const getCallQuality = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const callId = req.params.callId as string;

    const call = await prisma.callSession.findUnique({
      where:  { id: callId },
      select: { callerId: true, calleeId: true },
    });

    if (!call) {
      res.status(404).json({ success: false, message: 'Call not found' });
      return;
    }
    if (call.callerId !== userId && call.calleeId !== userId) {
      res.status(403).json({ success: false, message: 'Not a participant of this call' });
      return;
    }

    const events = await prisma.callQualityEvent.findMany({
      where:   { callId },
      orderBy: { reportedAt: 'asc' },
      select: {
        userId:        true,
        packetLossPct: true,
        jitterMs:      true,
        rttMs:         true,
        bitrateKbps:   true,
        resolution:    true,
        frameRate:     true,
        networkType:   true,
        reportedAt:    true,
      },
    });

    res.status(200).json({ success: true, data: { events } });
  } catch (err) {
    next(err);
  }
};

// ── Admin endpoints ───────────────────────────────────────────────────────────

// GET /api/calls/admin/reports
export const adminListCallReports = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const status = (req.query.status as string) ?? 'PENDING';
    const limit  = Math.min(parseInt(req.query.limit as string ?? '50'), 100);
    const cursor = req.query.cursor as string | undefined;

    const reports = await prisma.callModerationEvent.findMany({
      where: {
        status,
        ...(cursor ? { createdAt: { lt: new Date(cursor) } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
    });

    const hasMore = reports.length > limit;
    const items   = hasMore ? reports.slice(0, limit) : reports;

    res.status(200).json({
      success: true,
      data: {
        reports:    items,
        nextCursor: hasMore ? items[items.length - 1]?.createdAt.toISOString() : null,
      },
    });
  } catch (err) {
    next(err);
  }
};

// PATCH /api/calls/admin/reports/:reportId
export const adminResolveCallReport = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const reportId = req.params.reportId as string;
    const { status } = req.body;

    const validStatuses = ['RESOLVED', 'DISMISSED', 'ESCALATED'];
    if (!validStatuses.includes(status)) {
      res.status(400).json({ success: false, message: `status must be one of: ${validStatuses.join(', ')}` });
      return;
    }

    const report = await prisma.callModerationEvent.update({
      where: { id: reportId },
      data:  { status },
    });

    res.status(200).json({ success: true, data: report });
  } catch (err) {
    next(err);
  }
};

// POST /api/calls/admin/:callId/end
export const adminEndCall = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const callId = req.params.callId as string;

    const state = await getCallState(callId);
    if (!state || !['RINGING', 'CONNECTING', 'ACTIVE'].includes(state.status)) {
      res.status(404).json({ success: false, message: 'No active call found with that ID' });
      return;
    }

    const { durationS } = await endCall(callId, 'admin', 'MODERATION');
    const endedPayload = { callId, durationS, endReason: 'MODERATION' as const };

    emitToUser(state.callerId, 'call:ended', endedPayload);
    emitToUser(state.calleeId, 'call:ended', endedPayload);

    res.status(200).json({ success: true, data: { callId, durationS } });
  } catch (err) {
    next(err);
  }
};
