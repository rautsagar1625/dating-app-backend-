import { Router } from 'express';
import { addFavorite, removeFavorite, checkFavorite, getFavorites } from '../controllers/favorites.controller';
import { requireAuth } from '../middleware/auth.middleware';

const router = Router();

router.use(requireAuth);

router.get('/',              getFavorites);
router.get('/check/:userId', checkFavorite);
router.post('/:userId',      addFavorite);
router.delete('/:userId',    removeFavorite);

export default router;
