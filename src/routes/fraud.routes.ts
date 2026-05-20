import { Router } from 'express';
import { requireAuth } from '../middleware/auth.middleware';
import { requireAdmin } from '../middleware/admin.middleware';
import {
  listCases, reviewCase,
  listDevices, getDevice,
  enforceAction, revokeAction,
  getUserFraudProfile, getStats,
} from '../controllers/fraud.controller';

const router = Router();

router.use(requireAuth, requireAdmin);

router.get('/stats',                   getStats);
router.get('/cases',                   listCases);
router.patch('/cases/:id',             reviewCase);
router.get('/devices',                 listDevices);
router.get('/devices/:id',             getDevice);
router.post('/enforce',                enforceAction);
router.delete('/enforce/:actionId',    revokeAction);
router.get('/user/:userId',            getUserFraudProfile);

export default router;
