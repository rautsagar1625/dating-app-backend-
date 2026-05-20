import { Router } from 'express';
import { getNotifications, markRead } from '../controllers/notification.controller';
import { requireAuth } from '../middleware/auth.middleware';

const router = Router();

router.use(requireAuth);

router.get('/',     getNotifications);
router.post('/read', markRead);

export default router;
