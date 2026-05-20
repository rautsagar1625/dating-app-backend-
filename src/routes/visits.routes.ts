import { Router } from 'express';
import { recordVisit, getVisitors } from '../controllers/visits.controller';
import { requireAuth } from '../middleware/auth.middleware';

const router = Router();

router.use(requireAuth);

router.get('/visitors', getVisitors);
router.post('/:userId', recordVisit);

export default router;
