import { Router } from 'express';
import { requireAuth } from '../middleware/auth.middleware';
import {
  requestVoiceUploadUrl,
  confirmVoiceUploadHandler,
  getVoicePlaybackUrlHandler,
  deleteVoiceNote,
} from '../controllers/voice.controller';

const router = Router();

router.use(requireAuth);

router.post('/upload-url',       requestVoiceUploadUrl);
router.post('/confirm',          confirmVoiceUploadHandler);
router.get('/:voiceNoteId/url',  getVoicePlaybackUrlHandler);
router.delete('/:voiceNoteId',   deleteVoiceNote);

export default router;
