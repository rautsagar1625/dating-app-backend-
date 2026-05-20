import { Router } from 'express';
import { requireAuth } from '../middleware/auth.middleware';
import { requireAdmin } from '../middleware/admin.middleware';
import {
  evaluate,
  getFlags,
  createFlagHandler,
  updateFlagHandler,
  deleteFlagHandler,
  getAuditLog,
  setOverrideHandler,
  removeOverrideHandler,
} from '../controllers/flags.controller';

const router = Router();

// ── Authenticated user endpoint ───────────────────────────────────────────────
// GET /api/flags/evaluate — returns full flag map for the calling user
router.get('/evaluate', requireAuth, evaluate);

// ── Admin endpoints ───────────────────────────────────────────────────────────
router.get('/',                                        requireAuth, requireAdmin, getFlags);
router.post('/',                                       requireAuth, requireAdmin, createFlagHandler);
router.patch('/:key',                                  requireAuth, requireAdmin, updateFlagHandler);
router.delete('/:key',                                 requireAuth, requireAdmin, deleteFlagHandler);
router.get('/:key/audit',                              requireAuth, requireAdmin, getAuditLog);
router.put('/:key/overrides/:userId',                  requireAuth, requireAdmin, setOverrideHandler);
router.delete('/:key/overrides/:userId',               requireAuth, requireAdmin, removeOverrideHandler);

export default router;
