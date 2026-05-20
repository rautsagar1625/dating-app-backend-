import { Router } from 'express';
import { ping } from '../controllers/status.controller';
import { requireAuth } from '../middleware/auth.middleware';

const router = Router();

router.post('/ping', requireAuth, ping);

export default router;
