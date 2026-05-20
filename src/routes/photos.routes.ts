import { Router } from 'express';
import {
  getUserPhotos,
  requestPhotoAccess,
  respondToAccessRequest,
  getPendingAccessRequests,
  unlockPhotos,
  uploadPhoto,
  upload,
} from '../controllers/photos.controller';
import { requireAuth } from '../middleware/auth.middleware';

const router = Router();

router.use(requireAuth);

router.post('/upload', upload.single('photo'), uploadPhoto);
router.get('/access/pending', getPendingAccessRequests);
router.patch('/access/:requestId', respondToAccessRequest);
router.get('/:userId', getUserPhotos);
router.post('/:userId/unlock', unlockPhotos);
router.post('/:userId/request-access', requestPhotoAccess);

export default router;
