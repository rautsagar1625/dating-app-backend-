import { Router } from 'express';
import { requireAuth } from '../middleware/auth.middleware';
import {
  activateBoostHandler,
  getBoostStatus,
  cancelBoost,
  getBoostHistory,
} from '../controllers/boost.controller';

const router = Router();

router.use(requireAuth);

router.post('/activate',      activateBoostHandler);
router.get('/status',         getBoostStatus);
router.delete('/:boostId',    cancelBoost);
router.get('/history',        getBoostHistory);

export default router;
