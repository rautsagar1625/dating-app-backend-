import { Router } from 'express';
import {
  startChat,
  unlockChatById,
  unlockChat,
  sendMessage,
  getChats,
  getChatMessages,
  getChatStatus,
  markSeen,
} from '../controllers/chat.controller';
import { requireAuth } from '../middleware/auth.middleware';

const router = Router();

router.use(requireAuth);

router.get('/', getChats);
router.post('/start/:userId', startChat);
router.post('/unlock/:chatId', unlockChatById);
router.post('/unlock', unlockChat);
router.post('/message', sendMessage);
router.get('/status/:targetUserId', getChatStatus);
router.get('/:chatId/messages', getChatMessages);
router.post('/:chatId/seen', markSeen);

export default router;
