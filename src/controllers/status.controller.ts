import { Request, Response, NextFunction } from 'express';
import { touchLastSeen } from '../services/online.service';

// POST /api/status/ping — heartbeat; DB write is debounced to once per 60s
export const ping = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const now = await touchLastSeen(userId);
    res.status(200).json({ success: true, data: { lastSeen: now.toISOString() } });
  } catch (error) {
    next(error);
  }
};
