import { Router } from 'express';
import { Request, Response, NextFunction } from 'express';
import { requireAuth } from '../middleware/auth.middleware';
import { requireAdmin } from '../middleware/admin.middleware';
import { getBackupStatus } from '../services/backup-monitor';

const router = Router();

// GET /api/backup/status — returns current backup health for all types
// Admin-only: reveals infrastructure timing details
router.get(
  '/status',
  requireAuth,
  requireAdmin,
  async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const summary = await getBackupStatus();
      res.status(summary.healthy ? 200 : 503).json({ success: true, data: summary });
    } catch (error) {
      next(error);
    }
  },
);

export default router;
