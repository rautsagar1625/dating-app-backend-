import { Router } from 'express';
import { blockUser, unblockUser, getBlocked } from '../controllers/blocks.controller';
import { requireAuth } from '../middleware/auth.middleware';

const router = Router();

router.use(requireAuth);

router.get('/',           getBlocked);
router.post('/:userId',   blockUser);
router.delete('/:userId', unblockUser);

export default router;
