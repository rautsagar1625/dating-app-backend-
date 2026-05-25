import { Router } from 'express';
import { getCatalog, sendGift, getReceivedGifts, seedCatalog } from '../controllers/gift.controller';
import { requireAuth } from '../middleware/auth.middleware';
import { requireAdmin } from '../middleware/admin.middleware';

const router = Router();

router.use(requireAuth);

router.get('/catalog',  getCatalog);
router.post('/send',    sendGift);
router.get('/received', getReceivedGifts);

// Admin: seed default gift catalog
router.post('/catalog/seed', requireAdmin, seedCatalog);

export default router;
