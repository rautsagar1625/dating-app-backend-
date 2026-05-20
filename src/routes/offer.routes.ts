import { Router } from 'express';
import { requireAuth } from '../middleware/auth.middleware';
import { requireAdmin, requirePermission } from '../middleware/admin.middleware';
import {
  triggerOffer,
  convertOffer,
  dismissOffer,
  getMySegment,
  adminCreateExperiment,
  adminActivateExperiment,
  adminStopExperiment,
  adminExperimentResults,
  adminOfferFunnel,
} from '../controllers/offer.controller';

const router = Router();

router.use(requireAuth);

// User routes
router.post('/trigger',                                  triggerOffer);
router.post('/:exposureId/convert',                      convertOffer);
router.post('/:exposureId/dismiss',                      dismissOffer);
router.get('/segment',                                   getMySegment);

// Admin routes
router.post('/admin/experiments',                        requireAdmin, requirePermission('write:monetization'), adminCreateExperiment);
router.patch('/admin/experiments/:experimentId/activate', requireAdmin, requirePermission('write:monetization'), adminActivateExperiment);
router.patch('/admin/experiments/:experimentId/stop',    requireAdmin, requirePermission('write:monetization'), adminStopExperiment);
router.get('/admin/experiments/:experimentId/results',   requireAdmin, requirePermission('read:revenue'),    adminExperimentResults);
router.get('/admin/funnel',                              requireAdmin, requirePermission('read:revenue'),    adminOfferFunnel);

export default router;
