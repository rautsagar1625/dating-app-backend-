import { Router } from 'express';
import { browseUsers, getUserById } from '../controllers/users.controller';
import { requireAuth } from '../middleware/auth.middleware';

const router = Router();

router.use(requireAuth);

router.get('/', browseUsers);
router.get('/:userId', getUserById);

export default router;
