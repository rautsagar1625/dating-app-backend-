import { Router } from 'express';
import { getPrivacySettings, updatePrivacySettings } from '../controllers/settings.controller';
import { requireAuth } from '../middleware/auth.middleware';

const router = Router();

router.use(requireAuth);

router.get('/privacy', getPrivacySettings);
router.put('/privacy', updatePrivacySettings);

export default router;
