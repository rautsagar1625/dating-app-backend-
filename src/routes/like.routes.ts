import { Router } from 'express';
import { sendLike, removeLike, getLikesSent, getLikesReceived } from '../controllers/like.controller';
import { requireAuth } from '../middleware/auth.middleware';

const router = Router();

router.use(requireAuth);

router.post('/', sendLike);
router.delete('/:receiverId', removeLike);
router.get('/sent', getLikesSent);
router.get('/received', getLikesReceived);

export default router;
