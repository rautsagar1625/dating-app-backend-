import { Router } from 'express';
import { getProfile, getUserProfile, upsertProfile } from '../controllers/profile.controller';
import { requireAuth } from '../middleware/auth.middleware';

const router = Router();

router.use(requireAuth);

router.get('/', getProfile);
router.post('/', upsertProfile);
router.put('/', upsertProfile);
router.get('/:userId', getUserProfile);

export default router;
