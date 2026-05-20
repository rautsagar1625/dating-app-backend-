import { Router } from 'express';
import { requireAuth } from '../middleware/auth.middleware';
import { requireAdmin, requirePermission } from '../middleware/admin.middleware';
import {
  getRecommendedFeed,
  recordFeedback,
  recordDwellBatch,
  endFeedSession,
  activateBoost,
  deactivateBoost,
  listExperiments,
  createRankingExperiment,
  activateRankingExperiment,
  stopRankingExperiment,
  captureFeedSnapshot,
  getFeedSnapshot,
  getUserSignalProfile,
  triggerSignalRefresh,
} from '../controllers/feed.controller';

const router = Router();

// ── User-facing feed ──────────────────────────────────────────────────────────
router.use(requireAuth);

router.get('/',                  getRecommendedFeed);
router.post('/feedback',         recordFeedback);
router.post('/dwell',            recordDwellBatch);
router.post('/session/close',    endFeedSession);

// Boost activation (internal, called from wallet service — still requires auth)
router.post('/boost/:userId',    activateBoost);
router.delete('/boost/:userId',  deactivateBoost);

// ── Admin: experiments ────────────────────────────────────────────────────────
router.get('/admin/experiments',                    requireAdmin, requirePermission('read:analytics'),  listExperiments);
router.post('/admin/experiments',                   requireAdmin, requirePermission('write:flags'),     createRankingExperiment);
router.post('/admin/experiments/:id/activate',      requireAdmin, requirePermission('write:flags'),     activateRankingExperiment);
router.post('/admin/experiments/:id/stop',          requireAdmin, requirePermission('write:flags'),     stopRankingExperiment);

// ── Admin: debug ──────────────────────────────────────────────────────────────
router.post('/admin/snapshot/:userId',              requireAdmin, requirePermission('read:users'),  captureFeedSnapshot);
router.get('/admin/snapshot/:userId',               requireAdmin, requirePermission('read:users'),  getFeedSnapshot);
router.get('/admin/signals/:userId',                requireAdmin, requirePermission('read:users'),  getUserSignalProfile);
router.post('/admin/signal-refresh/:userId',        requireAdmin, requirePermission('write:users'), triggerSignalRefresh);

export default router;
