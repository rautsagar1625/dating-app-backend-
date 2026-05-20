import { Request, Response, NextFunction } from 'express';
import prisma from '../services/prisma.service';
import { createNotification } from '../services/notification.service';
import { emitToUser, isUserOnlineSocket } from '../services/socket.service';
import { isBlocked, getBlockedUserIds } from '../services/block.service';
import { isOnline } from '../services/online.service';
import { trackEvent } from '../services/analytics.service';
import { checkMessageSpam, isSoftBanned } from '../services/risk.service';
import { isShadowRestricted } from '../services/fraud/enforcement.service';
import { evaluateMessage } from '../services/moderation/message/rules.engine';
import { enqueueMessageModeration } from '../services/moderation/moderation.queue';
import { moderationRealtimeTotal } from '../observability/metrics';

const UNLOCK_CHAT_COST = 20; // credits

// POST /api/chat/start/:userId  — create chat (locked) if not exists; return chatId + state
export const startChat = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const targetUserId = req.params.userId as string;

    if (!targetUserId || userId === targetUserId) {
      res.status(400).json({ success: false, message: 'Invalid target user' });
      return;
    }

    if (await isBlocked(userId, targetUserId)) {
      res.status(403).json({ success: false, message: 'BLOCKED' });
      return;
    }

    const [user1Id, user2Id] = userId < targetUserId ? [userId, targetUserId] : [targetUserId, userId];

    const [chat, targetUser] = await Promise.all([
      prisma.chat.upsert({
        where: { user1Id_user2Id: { user1Id, user2Id } },
        update: {},
        create: { user1Id, user2Id, isUnlocked: false },
        select: { id: true, isUnlocked: true },
      }),
      prisma.user.findUnique({
        where: { id: targetUserId },
        select: { lastSeen: true },
      }),
    ]);

    res.status(200).json({
      success: true,
      data: {
        chatId: chat.id,
        isUnlocked: chat.isUnlocked,
        unlockCost: UNLOCK_CHAT_COST,
        otherUser: {
          isOnline: isOnline(targetUser?.lastSeen ?? null),
          lastSeenAt: targetUser?.lastSeen?.toISOString() ?? null,
        },
      },
    });
  } catch (error) {
    next(error);
  }
};

// POST /api/chat/unlock/:chatId  — primary unlock endpoint, bulletproof against double-deduction
export const unlockChatById = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const chatId = req.params.chatId as string;

    if (!chatId) {
      res.status(400).json({ success: false, message: 'chatId is required' });
      return;
    }

    const newBalance = await prisma.$transaction(async (tx) => {
      // Verify membership and read current state
      const chat = await tx.chat.findUnique({
        where:  { id: chatId },
        select: { user1Id: true, user2Id: true, isUnlocked: true },
      });

      if (!chat) throw new Error('CHAT_NOT_FOUND');
      if (chat.user1Id !== userId && chat.user2Id !== userId) throw new Error('FORBIDDEN');
      if (chat.isUnlocked) throw new Error('ALREADY_UNLOCKED');

      // Read wallet balance
      const wallet = await tx.wallet.findUnique({
        where:  { userId },
        select: { balance: true },
      });
      if (!wallet || wallet.balance < UNLOCK_CHAT_COST) throw new Error('INSUFFICIENT_BALANCE');

      // Atomic check-and-set: only one concurrent transaction can flip false→true.
      // updateMany returns count=0 if another request already flipped it, preventing
      // double deduction even under simultaneous requests (READ COMMITTED row-lock).
      const flipped = await tx.chat.updateMany({
        where: { id: chatId, isUnlocked: false },
        data:  { isUnlocked: true },
      });
      if (flipped.count === 0) throw new Error('ALREADY_UNLOCKED');

      // Only reaches here for the one request that won the flip
      await tx.wallet.update({
        where: { userId },
        data:  { balance: { decrement: UNLOCK_CHAT_COST } },
      });

      await tx.transaction.create({
        data: { userId, amount: UNLOCK_CHAT_COST, type: 'DEBIT', reason: 'Unlock chat' },
      });

      return wallet.balance - UNLOCK_CHAT_COST;
    });

    trackEvent('chat_unlocked', userId, { chatId });

    res.status(200).json({
      success: true,
      data: { chatId, isUnlocked: true, newBalance },
    });
  } catch (error: any) {
    if (error.message === 'ALREADY_UNLOCKED') {
      res.status(409).json({ success: false, message: 'Chat is already unlocked' });
      return;
    }
    if (error.message === 'INSUFFICIENT_BALANCE') {
      res.status(402).json({ success: false, message: 'Insufficient credits' });
      return;
    }
    if (error.message === 'CHAT_NOT_FOUND') {
      res.status(404).json({ success: false, message: 'Chat not found' });
      return;
    }
    if (error.message === 'FORBIDDEN') {
      res.status(403).json({ success: false, message: 'You are not part of this chat' });
      return;
    }
    next(error);
  }
};

// POST /api/chat/unlock  — legacy endpoint kept for backward compat
export const unlockChat = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const { targetUserId } = req.body;

    if (!targetUserId) {
      res.status(400).json({ success: false, message: 'targetUserId is required' });
      return;
    }
    if (userId === targetUserId) {
      res.status(400).json({ success: false, message: 'Invalid target user' });
      return;
    }

    const [user1Id, user2Id] = userId < targetUserId ? [userId, targetUserId] : [targetUserId, userId];

    const newBalance = await prisma.$transaction(async (tx) => {
      const wallet = await tx.wallet.findUnique({ where: { userId }, select: { balance: true } });
      if (!wallet || wallet.balance < UNLOCK_CHAT_COST) throw new Error('INSUFFICIENT_BALANCE');

      const flipped = await tx.chat.updateMany({
        where: { user1Id, user2Id, isUnlocked: false },
        data:  { isUnlocked: true },
      });
      if (flipped.count === 0) throw new Error('ALREADY_UNLOCKED');

      await tx.wallet.update({
        where: { userId },
        data:  { balance: { decrement: UNLOCK_CHAT_COST } },
      });
      await tx.transaction.create({
        data: { userId, amount: UNLOCK_CHAT_COST, type: 'DEBIT', reason: 'Unlock chat' },
      });
      return wallet.balance - UNLOCK_CHAT_COST;
    });

    res.status(200).json({ success: true, data: { isUnlocked: true, newBalance } });
  } catch (error: any) {
    if (error.message === 'ALREADY_UNLOCKED') {
      res.status(409).json({ success: false, message: 'Chat is already unlocked' });
      return;
    }
    if (error.message === 'INSUFFICIENT_BALANCE') {
      res.status(402).json({ success: false, message: 'Insufficient credits' });
      return;
    }
    next(error);
  }
};

// POST /api/chat/message
export const sendMessage = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const senderId = req.user!.userId;
    const { chatId, message, clientTempId } = req.body;

    if (!chatId || !message?.trim()) {
      res.status(400).json({ success: false, message: 'chatId and message are required' });
      return;
    }

    if (message.trim().length > 1000) {
      res.status(400).json({ success: false, message: 'Message too long (max 1000 characters)' });
      return;
    }

    // Abuse guards: soft ban check + spam rate limiting
    if (await isSoftBanned(senderId)) {
      res.status(403).json({ success: false, message: 'Your account has been temporarily restricted' });
      return;
    }
    const shadowRestricted = await isShadowRestricted(senderId);
    if (await checkMessageSpam(senderId)) {
      res.status(429).json({ success: false, message: 'Sending too fast — slow down' });
      return;
    }

    // Realtime moderation: lightweight rules engine (<10ms, fail-safe)
    const modResult = await evaluateMessage(message.trim(), senderId, chatId).catch(() => null);
    if (modResult) {
      moderationRealtimeTotal.inc({ action: modResult.action });
      if (modResult.action === 'SUPPRESS') {
        res.status(403).json({ success: false, message: 'Message blocked by content policy' });
        return;
      }
    }

    // Idempotency: if clientTempId already exists, return the existing message
    if (clientTempId) {
      const existing = await prisma.message.findUnique({
        where: { clientTempId },
        select: { id: true, clientTempId: true, chatId: true, senderId: true, message: true, status: true, deliveredAt: true, seenAt: true, createdAt: true },
      });
      if (existing) {
        res.status(200).json({ success: true, data: existing });
        return;
      }
    }

    const chat = await prisma.chat.findUnique({ where: { id: chatId } });

    if (!chat) {
      res.status(404).json({ success: false, message: 'Chat not found' });
      return;
    }

    if (!chat.isUnlocked) {
      res.status(403).json({ success: false, message: 'Chat is locked' });
      return;
    }

    if (chat.user1Id !== senderId && chat.user2Id !== senderId) {
      res.status(403).json({ success: false, message: 'You are not part of this chat' });
      return;
    }

    const otherUserId = chat.user1Id === senderId ? chat.user2Id : chat.user1Id;
    if (await isBlocked(senderId, otherUserId)) {
      res.status(403).json({ success: false, message: 'BLOCKED' });
      return;
    }

    // Enforce recipient's allowMessagesFrom setting
    const recipientProfile = await prisma.profile.findUnique({
      where: { userId: otherUserId },
      select: { allowMessagesFrom: true },
    });
    if (recipientProfile?.allowMessagesFrom === 'none') {
      res.status(403).json({ success: false, message: 'MESSAGES_DISABLED' });
      return;
    }
    if (recipientProfile?.allowMessagesFrom === 'liked') {
      const hasLike = await prisma.like.findFirst({
        where: {
          OR: [
            { senderId, receiverId: otherUserId },
            { senderId: otherUserId, receiverId: senderId },
          ],
        },
        select: { id: true },
      });
      if (!hasLike) {
        res.status(403).json({ success: false, message: 'MESSAGES_RESTRICTED' });
        return;
      }
    }

    // Shadow-restricted senders: store the message but don't deliver it to the recipient.
    // From the sender's perspective the message was accepted — bot operators stay unaware.
    const recipientOnline = shadowRestricted ? false : isUserOnlineSocket(otherUserId);
    const now = new Date();

    const newMessage = await prisma.message.create({
      data: {
        chatId,
        senderId,
        message: message.trim(),
        clientTempId: clientTempId ?? null,
        status: recipientOnline ? 'DELIVERED' : 'SENT',
        deliveredAt: recipientOnline ? now : null,
      },
      select: { id: true, clientTempId: true, chatId: true, senderId: true, message: true, status: true, deliveredAt: true, seenAt: true, createdAt: true },
    });

    // Enqueue async deep moderation (non-blocking — SHADOW action also stored for audit)
    if (modResult && modResult.action !== 'SUPPRESS') {
      enqueueMessageModeration({ messageId: newMessage.id, chatId, userId: senderId, text: message.trim() }).catch(() => {});
    }

    trackEvent('message_sent', senderId, { chatId, recipientId: otherUserId });

    if (!shadowRestricted) {
      createNotification(otherUserId, 'MESSAGE', senderId);

      // Deliver to recipient
      emitToUser(otherUserId, 'new_message', {
        id: newMessage.id,
        chatId: newMessage.chatId,
        senderId: newMessage.senderId,
        message: newMessage.message,
        status: newMessage.status,
        createdAt: newMessage.createdAt.toISOString(),
      });

      // If delivered immediately, notify sender of the delivery receipt
      if (recipientOnline) {
        emitToUser(senderId, 'messages_delivered', {
          messageIds: [newMessage.id],
          deliveredAt: now.toISOString(),
        });
      }
    }

    res.status(201).json({ success: true, data: newMessage });
  } catch (error) {
    next(error);
  }
};

// POST /api/chat/:chatId/seen  — mark all received messages in chat as SEEN
export const markSeen = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const chatId = req.params.chatId as string;

    const chat = await prisma.chat.findUnique({ where: { id: chatId }, select: { user1Id: true, user2Id: true } });
    if (!chat) {
      res.status(404).json({ success: false, message: 'Chat not found' });
      return;
    }
    if (chat.user1Id !== userId && chat.user2Id !== userId) {
      res.status(403).json({ success: false, message: 'Forbidden' });
      return;
    }

    const senderId = chat.user1Id === userId ? chat.user2Id : chat.user1Id;
    const now = new Date();

    // Mark all SENT or DELIVERED messages from the other user as SEEN
    const updated = await prisma.message.updateMany({
      where: {
        chatId,
        senderId,
        status: { in: ['SENT', 'DELIVERED'] },
      },
      data: { status: 'SEEN', seenAt: now },
    });

    if (updated.count > 0) {
      // Notify the sender that their messages were seen
      emitToUser(senderId, 'messages_seen', {
        chatId,
        seenAt: now.toISOString(),
      });
    }

    res.status(200).json({ success: true, data: { markedCount: updated.count } });
  } catch (error) {
    next(error);
  }
};

// GET /api/chat  — list all chats for the current user
export const getChats = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user!.userId;

    const blockedIds = await getBlockedUserIds(userId);
    const blockedSet = new Set(blockedIds);

    const chats = await prisma.chat.findMany({
      where: {
        OR: [{ user1Id: userId }, { user2Id: userId }],
      },
      select: {
        id: true,
        isUnlocked: true,
        createdAt: true,
        user1: {
          select: {
            id: true,
            profile: { select: { username: true, isPrivatePhoto: true } },
            photos: { where: { isPrivate: false }, select: { url: true }, take: 1 },
          },
        },
        user2: {
          select: {
            id: true,
            profile: { select: { username: true, isPrivatePhoto: true } },
            photos: { where: { isPrivate: false }, select: { url: true }, take: 1 },
          },
        },
        messages: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { message: true, createdAt: true, senderId: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    // Shape: expose the "other" user, filtering out blocked users
    const result = chats
      .filter((chat) => {
        const otherId = chat.user1.id === userId ? chat.user2.id : chat.user1.id;
        return !blockedSet.has(otherId);
      })
      .map((chat) => {
      const other = chat.user1.id === userId ? chat.user2 : chat.user1;
      return {
        id: chat.id,
        isUnlocked: chat.isUnlocked,
        createdAt: chat.createdAt,
        otherUser: {
          userId: other.id,
          username: other.profile?.username ?? null,
          avatarUrl: other.photos[0]?.url ?? null,
        },
        lastMessage: chat.messages[0] ?? null,
      };
    });

    res.status(200).json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};

// GET /api/chat/:chatId/messages
export const getChatMessages = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const chatId = req.params.chatId as string;
    const { page = '1', limit = '50' } = req.query;

    const pageNum = Math.max(1, parseInt(page as string, 10));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit as string, 10)));

    const chat = await prisma.chat.findUnique({ where: { id: chatId } });

    if (!chat) {
      res.status(404).json({ success: false, message: 'Chat not found' });
      return;
    }

    if (chat.user1Id !== userId && chat.user2Id !== userId) {
      res.status(403).json({ success: false, message: 'You are not part of this chat' });
      return;
    }

    if (!chat.isUnlocked) {
      res.status(403).json({ success: false, message: 'Chat is locked' });
      return;
    }

    const messages = await prisma.message.findMany({
      where: { chatId },
      orderBy: { createdAt: 'desc' },
      skip: (pageNum - 1) * limitNum,
      take: limitNum,
      select: { id: true, clientTempId: true, senderId: true, message: true, status: true, deliveredAt: true, seenAt: true, createdAt: true },
    });

    res.status(200).json({
      success: true,
      data: messages.reverse(),
      meta: { page: pageNum, limit: limitNum },
    });
  } catch (error) {
    next(error);
  }
};

// GET /api/chat/status/:targetUserId  — check chat state between current user and target
export const getChatStatus = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const targetUserId = req.params.targetUserId as string;

    const [user1Id, user2Id] = userId < targetUserId ? [userId, targetUserId] : [targetUserId, userId];

    const chat = await prisma.chat.findUnique({
      where: { user1Id_user2Id: { user1Id, user2Id } },
      select: { id: true, isUnlocked: true },
    });

    res.status(200).json({
      success: true,
      data: {
        exists: !!chat,
        chatId: chat?.id ?? null,
        isUnlocked: chat?.isUnlocked ?? false,
        unlockCost: UNLOCK_CHAT_COST,
      },
    });
  } catch (error) {
    next(error);
  }
};
