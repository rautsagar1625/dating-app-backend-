import { Router } from 'express';
import { requireAuth } from '../middleware/auth.middleware';
import { requireAdmin, requirePermission } from '../middleware/admin.middleware';
import {
  getMySubscription,
  validateMobileReceipt,
  cancelSubscription,
  confirmCancellation,
  adminSubscriptionStats,
  adminRetentionCohort,
} from '../controllers/subscription.controller';

const router = Router();

router.use(requireAuth);

// User routes
router.get('/me',                           getMySubscription);
router.post('/validate-receipt',            validateMobileReceipt);
router.post('/cancel',                      cancelSubscription);
router.post('/cancel/confirm',              confirmCancellation);

// Admin routes
router.get('/admin/stats',                  requireAdmin, requirePermission('read:dashboard'), adminSubscriptionStats);
router.get('/admin/retention-cohort',       requireAdmin, requirePermission('read:analytics'), adminRetentionCohort);

export default router;
