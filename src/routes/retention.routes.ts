import { Router } from 'express';
import { getNudge } from '../controllers/retention.controller';
import { requireAuth } from '../middleware/auth.middleware';

const router = Router();
router.use(requireAuth);
router.get('/nudge', getNudge);

export default router;
