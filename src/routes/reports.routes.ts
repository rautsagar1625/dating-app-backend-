import { Router } from 'express';
import { reportUser } from '../controllers/reports.controller';
import { requireAuth } from '../middleware/auth.middleware';

const router = Router();

router.use(requireAuth);
router.post('/:userId', reportUser);

export default router;
