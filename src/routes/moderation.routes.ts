import { Router } from 'express';
import { requireAuth } from '../middleware/auth.middleware';
import { requireAdmin, requirePermission } from '../middleware/admin.middleware';
import {
  createAppeal,
  listMyAppeals,
  getModerationStatus,
  listModerationEvents,
  getModerationEvent,
  resolveModerationEvent,
  manualEnforce,
  listAdminAppeals,
  reviewAppealHandler,
  getHighRiskConversationsHandler,
  getUserTrustProfile,
  getModerationStats,
} from '../controllers/moderation.controller';

const router = Router();

// ── User-facing (authenticated users) ────────────────────────────────────────

router.use(requireAuth);

router.get('/status',        getModerationStatus);
router.post('/appeal',       createAppeal);
router.get('/appeal',        listMyAppeals);

// ── Admin operations ──────────────────────────────────────────────────────────

router.get('/admin/stats',                        requireAdmin, requirePermission('read:moderation'), getModerationStats);
router.get('/admin/events',                       requireAdmin, requirePermission('read:moderation'), listModerationEvents);
router.get('/admin/events/:eventId',              requireAdmin, requirePermission('read:moderation'), getModerationEvent);
router.post('/admin/events/:eventId/resolve',     requireAdmin, requirePermission('write:moderation'), resolveModerationEvent);
router.post('/admin/enforce',                     requireAdmin, requirePermission('write:moderation'), manualEnforce);
router.get('/admin/appeals',                      requireAdmin, requirePermission('read:moderation'), listAdminAppeals);
router.post('/admin/appeals/:appealId/review',    requireAdmin, requirePermission('write:moderation'), reviewAppealHandler);
router.get('/admin/conversations/high-risk',      requireAdmin, requirePermission('read:moderation'), getHighRiskConversationsHandler);
router.get('/admin/users/:userId/trust',          requireAdmin, requirePermission('read:users'),       getUserTrustProfile);

export default router;
