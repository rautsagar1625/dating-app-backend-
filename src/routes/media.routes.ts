import { Router } from 'express';
import { requireAuth } from '../middleware/auth.middleware';
import { requireAdmin } from '../middleware/admin.middleware';
import {
  requestUploadUrl,
  completeUpload,
  getAssetUrl,
  getAsset,
  listAssets,
  removeAsset,
  getModerationQueue,
  adminModerateAsset,
} from '../controllers/media.controller';

const router = Router();

// ── Authenticated user routes ─────────────────────────────────────────────────
router.use(requireAuth);

// Upload lifecycle
router.post('/upload-url',                       requestUploadUrl);
router.post('/upload-url/:sessionId/complete',   completeUpload);

// Asset access
router.get('/me',                listAssets);
router.get('/:assetId',          getAsset);
router.get('/:assetId/url',      getAssetUrl);
router.delete('/:assetId',       removeAsset);

// ── Admin-only routes ─────────────────────────────────────────────────────────
router.get('/admin/moderation-queue',       requireAdmin, getModerationQueue);
router.patch('/admin/:assetId/moderate',    requireAdmin, adminModerateAsset);

export default router;
