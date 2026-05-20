import { Router } from 'express';
import { getBalance, addCredits, deductCredits, getHistory } from '../controllers/wallet.controller';
import { requireAuth } from '../middleware/auth.middleware';
import { requireAdmin } from '../middleware/admin.middleware';

const router = Router();

router.use(requireAuth);

router.get('/',         getBalance);
router.post('/add',     requireAdmin, addCredits);  // admin-only: prevents self-awarding credits
router.post('/deduct',  deductCredits);
router.get('/history',  getHistory);

export default router;
