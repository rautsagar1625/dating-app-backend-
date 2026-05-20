import { Router } from 'express';
import { requireAuth } from '../middleware/auth.middleware';
import { registerPushToken, deregisterPushToken } from '../controllers/pushtoken.controller';

const router = Router();

router.post('/',    requireAuth, registerPushToken);
router.delete('/',  requireAuth, deregisterPushToken);

export default router;
