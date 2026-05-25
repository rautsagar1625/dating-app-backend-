import { Router } from 'express';
import { listNews, getNewsPost, createNewsPost, updateNewsPost, deleteNewsPost } from '../controllers/news.controller';
import { requireAuth } from '../middleware/auth.middleware';
import { requireAdmin } from '../middleware/admin.middleware';

const router = Router();

router.use(requireAuth);

router.get('/',     listNews);
router.get('/:id',  getNewsPost);

// Admin-only write operations
router.post('/',         requireAdmin, createNewsPost);
router.put('/:id',       requireAdmin, updateNewsPost);
router.delete('/:id',    requireAdmin, deleteNewsPost);

export default router;
