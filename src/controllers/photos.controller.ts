import { Request, Response, NextFunction } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import prisma from '../services/prisma.service';
import { signUrl } from '../services/signedUrl.service';
import { env } from '../config/env';

const PHOTO_ACCESS_COST = 10;
const PHOTO_UNLOCK_COST = 10;

// Extract the /uploads/filename path from a full URL and sign it.
// Public photos (no signing needed) pass through unchanged.
function maybeSign(url: string, isPrivate: boolean): string {
  if (!isPrivate) return url;
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${signUrl(parsed.pathname)}`;
  } catch {
    return signUrl(url); // already a path
  }
}

// ---------------------------------------------------------------------------
// Multer — disk storage for uploaded photos
// ---------------------------------------------------------------------------

const UPLOADS_DIR = path.join(__dirname, '..', '..', 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, _file, cb) => cb(null, `${req.user!.userId}-${Date.now()}.jpg`),
});

export const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only image files are allowed'));
  },
});

// POST /api/photos/upload — upload one photo for the authenticated user
export const uploadPhoto = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    if (!req.file) {
      res.status(400).json({ success: false, message: 'No file uploaded' });
      return;
    }

    const userId = req.user!.userId;
    const url = `${env.APP_URL}/uploads/${req.file.filename}`;

    const photo = await prisma.photo.create({
      data: { userId, url, isPrivate: false },
    });

    res.status(201).json({ success: true, data: photo });
  } catch (error) {
    next(error);
  }
};

// GET /api/photos/:userId  — list a user's viewable photos
export const getUserPhotos = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const currentUserId = req.user!.userId;
    const userId = req.params.userId as string;

    const profile = await prisma.profile.findUnique({
      where: { userId },
      select: { isPrivatePhoto: true },
    });

    if (!profile) {
      res.status(404).json({ success: false, message: 'User not found' });
      return;
    }

    if (currentUserId === userId) {
      const photos = await prisma.photo.findMany({
        where: { userId },
        orderBy: { createdAt: 'asc' },
      });
      const signed = photos.map((p) => ({ ...p, url: maybeSign(p.url, p.isPrivate) }));
      res.status(200).json({ success: true, data: signed, accessGranted: true });
      return;
    }

    let accessGranted = !profile.isPrivatePhoto;

    if (profile.isPrivatePhoto) {
      const request = await prisma.photoAccessRequest.findUnique({
        where: { requesterId_ownerId: { requesterId: currentUserId, ownerId: userId } },
      });
      accessGranted = request?.status === 'GRANTED';
    }

    const photos = await prisma.photo.findMany({
      where: { userId, ...(accessGranted ? {} : { isPrivate: false }) },
      orderBy: { createdAt: 'asc' },
    });

    // Sign private photo URLs so they can't be hotlinked or scraped
    const signed = photos.map((p) => ({ ...p, url: maybeSign(p.url, p.isPrivate && accessGranted) }));
    res.status(200).json({ success: true, data: signed, accessGranted });
  } catch (error) {
    next(error);
  }
};

// POST /api/photos/:userId/request-access
export const requestPhotoAccess = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const requesterId = req.user!.userId;
    const ownerId = req.params.userId as string;

    if (requesterId === ownerId) {
      res.status(400).json({ success: false, message: 'Invalid request' });
      return;
    }

    const profile = await prisma.profile.findUnique({
      where: { userId: ownerId },
      select: { isPrivatePhoto: true },
    });

    if (!profile) {
      res.status(404).json({ success: false, message: 'User not found' });
      return;
    }

    if (!profile.isPrivatePhoto) {
      res.status(400).json({ success: false, message: 'Photos are already public' });
      return;
    }

    const result = await prisma.$transaction(async (tx) => {
      // Re-check inside transaction to handle concurrent duplicate requests
      const existing = await tx.photoAccessRequest.findUnique({
        where: { requesterId_ownerId: { requesterId, ownerId } },
      });
      if (existing) return { existing };

      // Atomic check-and-deduct: count=0 means insufficient balance
      const deducted = await tx.wallet.updateMany({
        where: { userId: requesterId, balance: { gte: PHOTO_ACCESS_COST } },
        data:  { balance: { decrement: PHOTO_ACCESS_COST } },
      });
      if (deducted.count === 0) throw new Error('INSUFFICIENT_BALANCE');

      await tx.transaction.create({
        data: { userId: requesterId, amount: PHOTO_ACCESS_COST, type: 'DEBIT', reason: 'Photo access request' },
      });

      const created = await tx.photoAccessRequest.create({ data: { requesterId, ownerId } });
      return { created };
    });

    if ('existing' in result) {
      res.status(200).json({ success: true, data: result.existing });
      return;
    }
    res.status(201).json({ success: true, data: result.created });
  } catch (error: any) {
    if (error.message === 'INSUFFICIENT_BALANCE') {
      res.status(402).json({ success: false, message: 'Insufficient credits' });
      return;
    }
    next(error);
  }
};

// PATCH /api/photos/access/:requestId  — owner responds
export const respondToAccessRequest = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const ownerId = req.user!.userId;
    const requestId = req.params.requestId as string;
    const { status } = req.body;

    if (!['GRANTED', 'DENIED'].includes(status)) {
      res.status(400).json({ success: false, message: 'status must be GRANTED or DENIED' });
      return;
    }

    const request = await prisma.photoAccessRequest.findUnique({ where: { id: requestId } });

    if (!request) {
      res.status(404).json({ success: false, message: 'Request not found' });
      return;
    }

    if (request.ownerId !== ownerId) {
      res.status(403).json({ success: false, message: 'Not authorised' });
      return;
    }

    if (request.status !== 'PENDING') {
      res.status(409).json({ success: false, message: 'Request already resolved' });
      return;
    }

    const updated = await prisma.photoAccessRequest.update({
      where: { id: requestId },
      data: { status },
    });

    res.status(200).json({ success: true, data: updated });
  } catch (error) {
    next(error);
  }
};

// POST /api/photos/unlock/:userId  — pay credits, immediately grant own access
export const unlockPhotos = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const requesterId = req.user!.userId;
    const ownerId = req.params.userId as string;

    if (requesterId === ownerId) {
      res.status(400).json({ success: false, message: 'Cannot unlock your own photos' });
      return;
    }

    const profile = await prisma.profile.findUnique({
      where: { userId: ownerId },
      select: { isPrivatePhoto: true },
    });

    if (!profile) {
      res.status(404).json({ success: false, message: 'User not found' });
      return;
    }

    if (!profile.isPrivatePhoto) {
      const wallet = await prisma.wallet.findUnique({ where: { userId: requesterId } });
      res.status(200).json({ success: true, data: { accessGranted: true, newBalance: wallet?.balance ?? 0 } });
      return;
    }

    // All GRANTED checks and the balance deduction happen inside a single transaction
    // to prevent the TOCTOU race where two concurrent requests both pass the pre-check
    // then both deduct credits.
    const result = await prisma.$transaction(async (tx) => {
      // Re-check inside transaction — wins over any concurrent request
      const existing = await tx.photoAccessRequest.findUnique({
        where: { requesterId_ownerId: { requesterId, ownerId } },
        select: { status: true },
      });
      if (existing?.status === 'GRANTED') throw new Error('ALREADY_GRANTED');

      // Atomic balance check + deduction: only succeeds when balance >= cost.
      // updateMany returns count=0 if balance was insufficient, preventing double-deduction
      // even under simultaneous requests (same READ COMMITTED row-lock trick as chat unlock).
      const deducted = await tx.wallet.updateMany({
        where: { userId: requesterId, balance: { gte: PHOTO_UNLOCK_COST } },
        data:  { balance: { decrement: PHOTO_UNLOCK_COST } },
      });
      if (deducted.count === 0) throw new Error('INSUFFICIENT_BALANCE');

      const updatedWallet = await tx.wallet.findUnique({
        where: { userId: requesterId },
        select: { balance: true },
      });

      await tx.transaction.create({
        data: { userId: requesterId, amount: PHOTO_UNLOCK_COST, type: 'DEBIT', reason: 'Private photo unlock' },
      });

      await tx.photoAccessRequest.upsert({
        where: { requesterId_ownerId: { requesterId, ownerId } },
        create: { requesterId, ownerId, status: 'GRANTED' },
        update: { status: 'GRANTED' },
      });

      return { newBalance: updatedWallet!.balance };
    });

    res.status(200).json({ success: true, data: { accessGranted: true, newBalance: result.newBalance } });
  } catch (error: any) {
    if (error.message === 'ALREADY_GRANTED') {
      // Concurrent request already unlocked — treat as success
      const wallet = await prisma.wallet.findUnique({ where: { userId: req.user!.userId } });
      res.status(200).json({ success: true, data: { accessGranted: true, newBalance: wallet?.balance ?? 0 } });
      return;
    }
    if (error.message === 'INSUFFICIENT_BALANCE') {
      res.status(402).json({ success: false, message: 'Insufficient credits' });
      return;
    }
    next(error);
  }
};

// GET /api/photos/access/pending  — owner's pending requests
export const getPendingAccessRequests = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const ownerId = req.user!.userId;

    const requests = await prisma.photoAccessRequest.findMany({
      where: { ownerId, status: 'PENDING' },
      include: {
        requester: {
          select: {
            id: true,
            profile: { select: { username: true } },
            photos: { where: { isPrivate: false }, select: { url: true }, take: 1 },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    res.status(200).json({ success: true, data: requests });
  } catch (error) {
    next(error);
  }
};
