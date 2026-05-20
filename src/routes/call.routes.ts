import { Router } from 'express';
import { requireAuth } from '../middleware/auth.middleware';
import { requireAdmin, requirePermission } from '../middleware/admin.middleware';
import {
  getCallHistory,
  getCallDetails,
  reportCall,
  getCallQuality,
  adminListCallReports,
  adminResolveCallReport,
  adminEndCall,
} from '../controllers/call.controller';

const router = Router();

router.use(requireAuth);

// User routes
router.get('/history',              getCallHistory);
router.get('/:callId',              getCallDetails);
router.post('/:callId/report',      reportCall);
router.get('/:callId/quality',      getCallQuality);

// Admin routes
router.get('/admin/reports',         requireAdmin, requirePermission('read:moderation'),  adminListCallReports);
router.patch('/admin/reports/:reportId', requireAdmin, requirePermission('write:moderation'), adminResolveCallReport);
router.post('/admin/:callId/end',    requireAdmin, requirePermission('write:moderation'), adminEndCall);

export default router;
