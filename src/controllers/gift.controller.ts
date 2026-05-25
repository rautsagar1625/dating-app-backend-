import { Request, Response, NextFunction } from 'express';
import prisma from '../services/prisma.service';

const GIFT_COST_MAP: Record<string, number> = {}; // cached at runtime

// ── GET /api/gifts/catalog ────────────────────────────────────────────────────
export const getCatalog = async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const catalog = await prisma.giftCatalogItem.findMany({
      where:   { isActive: true },
      orderBy: { sortOrder: 'asc' },
      select:  { id: true, name: true, emoji: true, cost: true },
    });
    res.json({ success: true, data: catalog });
  } catch (error) {
    next(error);
  }
};

// ── POST /api/gifts/send ──────────────────────────────────────────────────────
export const sendGift = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const senderId = req.user!.userId;
    const { receiverId, giftId, message } = req.body;

    if (!receiverId || !giftId) {
      res.status(400).json({ success: false, message: 'receiverId and giftId are required' });
      return;
    }

    // Validate receiver exists
    const receiver = await prisma.user.findUnique({
      where:  { id: receiverId },
      select: { id: true },
    });
    if (!receiver) {
      res.status(404).json({ success: false, message: 'Receiver not found' });
      return;
    }

    // Get gift cost
    const giftItem = await prisma.giftCatalogItem.findUnique({
      where:  { id: giftId },
      select: { id: true, cost: true, name: true, emoji: true },
    });
    if (!giftItem || !giftItem) {
      res.status(404).json({ success: false, message: 'Gift not found' });
      return;
    }

    // Deduct credits atomically
    const result = await prisma.$transaction(async (tx) => {
      const wallet = await tx.wallet.findUnique({
        where:  { userId: senderId },
        select: { balance: true },
      });

      if (!wallet) throw new Error('WALLET_NOT_FOUND');
      if (wallet.balance < giftItem.cost) throw new Error('INSUFFICIENT_BALANCE');

      // Deduct sender credits
      await tx.wallet.update({
        where: { userId: senderId },
        data:  { balance: { decrement: giftItem.cost } },
      });

      await tx.transaction.create({
        data: {
          userId: senderId,
          amount: giftItem.cost,
          type:   'DEBIT',
          reason: `Gift: ${giftItem.emoji} ${giftItem.name} → ${receiverId}`,
        },
      });

      // Create gift transaction
      const gift = await tx.giftTransaction.create({
        data: {
          senderId,
          receiverId,
          giftId,
          message: message?.trim() || null,
        },
      });

      return gift;
    });

    // Notify receiver
    await prisma.notification.upsert({
      where:  { userId_type_referenceId: { userId: receiverId, type: 'GIFT', referenceId: senderId } },
      update: { isRead: false, createdAt: new Date() },
      create: { userId: receiverId, type: 'GIFT', referenceId: senderId },
    }).catch(() => {
      // Notification type not in enum check — fail silently, gift was sent
    });

    res.json({
      success: true,
      data:    { id: result.id, giftEmoji: giftItem.emoji, giftName: giftItem.name, createdAt: result.createdAt },
    });
  } catch (error: any) {
    if (error.message === 'INSUFFICIENT_BALANCE') {
      res.status(402).json({ success: false, message: 'Insufficient credits to send this gift' });
      return;
    }
    if (error.message === 'WALLET_NOT_FOUND') {
      res.status(402).json({ success: false, message: 'No wallet found — add credits first' });
      return;
    }
    next(error);
  }
};

// ── GET /api/gifts/received ───────────────────────────────────────────────────
export const getReceivedGifts = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const { page = '1', limit = '20' } = req.query;
    const pageNum  = Math.max(1, parseInt(page  as string, 10));
    const limitNum = Math.min(50, Math.max(1, parseInt(limit as string, 10)));

    const [gifts, total] = await prisma.$transaction([
      prisma.giftTransaction.findMany({
        where:   { receiverId: userId },
        orderBy: { createdAt: 'desc' },
        skip:    (pageNum - 1) * limitNum,
        take:    limitNum,
        include: {
          gift:   { select: { name: true, emoji: true, cost: true } },
          sender: {
            select: {
              id: true,
              profile: { select: { username: true } },
              photos:  { where: { isPrivate: false }, take: 1, select: { url: true } },
            },
          },
        },
      }),
      prisma.giftTransaction.count({ where: { receiverId: userId } }),
    ]);

    const formatted = gifts.map((g) => ({
      id:          g.id,
      giftEmoji:   g.gift.emoji,
      giftName:    g.gift.name,
      giftCost:    g.gift.cost,
      message:     g.message,
      createdAt:   g.createdAt,
      sender: {
        id:        g.sender.id,
        username:  g.sender.profile?.username ?? 'User',
        avatarUrl: g.sender.photos[0]?.url ?? null,
      },
    }));

    res.json({ success: true, data: formatted, meta: { page: pageNum, limit: limitNum, total } });
  } catch (error) {
    next(error);
  }
};

// ── POST /api/gifts/catalog  (admin seed) ─────────────────────────────────────
export const seedCatalog = async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const DEFAULT_GIFTS = [
      { name: 'Rose',        emoji: '🌹', cost: 10,  sortOrder: 1 },
      { name: 'Heart',       emoji: '❤️',  cost: 15,  sortOrder: 2 },
      { name: 'Kiss',        emoji: '💋',  cost: 20,  sortOrder: 3 },
      { name: 'Bouquet',     emoji: '💐',  cost: 30,  sortOrder: 4 },
      { name: 'Ring',        emoji: '💍',  cost: 50,  sortOrder: 5 },
      { name: 'Champagne',   emoji: '🍾',  cost: 40,  sortOrder: 6 },
      { name: 'Teddy Bear',  emoji: '🧸',  cost: 25,  sortOrder: 7 },
      { name: 'Star',        emoji: '⭐',  cost: 5,   sortOrder: 8 },
      { name: 'Fire',        emoji: '🔥',  cost: 35,  sortOrder: 9 },
      { name: 'Diamond',     emoji: '💎',  cost: 100, sortOrder: 10 },
    ];

    await prisma.$transaction(
      DEFAULT_GIFTS.map((g) =>
        prisma.giftCatalogItem.upsert({
          where:  { id: `seed-${g.name.toLowerCase().replace(' ', '-')}` },
          update: {},
          create: { id: `seed-${g.name.toLowerCase().replace(' ', '-')}`, ...g },
        })
      )
    );

    res.json({ success: true, message: 'Gift catalog seeded' });
  } catch (error) {
    next(error);
  }
};
