import { Request, Response, NextFunction } from 'express';
import { isUploadRateLimited, createUploadSession, completeUploadSession } from '../services/media/upload.service';
import { getMediaUrl, getAssetMeta, listMyAssets, deleteAsset } from '../services/media/media.service';
import { enqueueImageProcessing } from '../services/media/media.queue';
import { type MediaType, type VariantType, type ImageFormat } from '../services/media/media.types';
import prisma from '../services/prisma.service';

// POST /api/media/upload-url
// Issues a presigned S3 PUT URL for the client to upload directly.
// The client then calls /complete after the PUT to trigger processing.
export const requestUploadUrl = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId    = req.user!.userId;
    const { mediaType, mimeType, fileSize } = req.body;

    const validTypes: MediaType[] = [
      'PROFILE_PHOTO', 'PRIVATE_PHOTO', 'CHAT_ATTACHMENT', 'VERIFICATION_SELFIE',
    ];
    if (!validTypes.includes(mediaType)) {
      res.status(400).json({ success: false, message: 'Invalid mediaType' });
      return;
    }
    if (!mimeType || typeof mimeType !== 'string') {
      res.status(400).json({ success: false, message: 'mimeType is required' });
      return;
    }
    if (!fileSize || typeof fileSize !== 'number' || fileSize <= 0) {
      res.status(400).json({ success: false, message: 'fileSize is required (bytes)' });
      return;
    }

    if (await isUploadRateLimited(userId)) {
      res.status(429).json({ success: false, message: 'Upload rate limit exceeded (20/hour)' });
      return;
    }

    const session = await createUploadSession({ userId, mediaType, mimeType, fileSize });

    res.status(200).json({
      success: true,
      data: {
        sessionId:  session.sessionId,
        assetId:    session.assetId,
        uploadUrl:  session.uploadUrl,
        expiresAt:  session.expiresAt.toISOString(),
        instructions: {
          method:  'PUT',
          headers: { 'Content-Type': mimeType },
          note:    'PUT the raw file bytes to uploadUrl with Content-Type header set. Then call /complete.',
        },
      },
    });
  } catch (err: any) {
    if (err.message === 'MIME_NOT_ALLOWED') {
      res.status(400).json({ success: false, message: 'MIME type not allowed for this upload type' });
      return;
    }
    if (err.message === 'FILE_TOO_LARGE') {
      res.status(400).json({ success: false, message: 'File size exceeds the limit for this upload type' });
      return;
    }
    next(err);
  }
};

// POST /api/media/upload-url/:sessionId/complete
// Client calls this after the S3 PUT succeeds. Validates the upload then enqueues processing.
export const completeUpload = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId    = req.user!.userId;
    const sessionId = req.params.sessionId as string;

    const assetId = await completeUploadSession(sessionId, userId);
    await enqueueImageProcessing(assetId);

    res.status(200).json({
      success: true,
      data: { assetId, status: 'PROCESSING' },
    });
  } catch (err: any) {
    if (err.message === 'SESSION_NOT_FOUND') {
      res.status(404).json({ success: false, message: 'Upload session not found' });
      return;
    }
    if (err.message === 'UNAUTHORIZED') {
      res.status(403).json({ success: false, message: 'Unauthorized' });
      return;
    }
    if (['UPLOAD_NOT_FOUND', 'MIME_MISMATCH', 'FILE_TOO_LARGE'].includes(err.message)) {
      res.status(422).json({ success: false, message: err.message });
      return;
    }
    next(err);
  }
};

// GET /api/media/:assetId/url?variant=MEDIUM&format=WEBP
// Returns a (possibly signed) CDN URL for the requested variant.
export const getAssetUrl = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId    = req.user!.userId;
    const assetId   = req.params.assetId as string;
    const variant   = (req.query.variant as VariantType) ?? 'MEDIUM';
    const format    = (req.query.format  as ImageFormat)  ?? 'WEBP';

    const result = await getMediaUrl({
      assetId,
      requesterId: userId,
      variantType: variant,
      format,
      ipHash:     req.device?.ipHash ?? '',
      userAgent:  req.headers['user-agent'],
    });

    res.status(200).json({ success: true, data: result });
  } catch (err: any) {
    if (err.message === 'ASSET_NOT_FOUND') {
      res.status(404).json({ success: false, message: 'Asset not found' });
      return;
    }
    if (err.message === 'ACCESS_DENIED') {
      res.status(403).json({ success: false, message: 'Access denied' });
      return;
    }
    if (err.message === 'VARIANT_NOT_READY') {
      res.status(202).json({ success: false, message: 'Asset is still processing', status: 'PROCESSING' });
      return;
    }
    next(err);
  }
};

// GET /api/media/:assetId
// Returns asset metadata including all available variant descriptors + blurhash.
export const getAsset = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId  = req.user!.userId;
    const assetId = req.params.assetId as string;
    const meta    = await getAssetMeta(assetId, userId);
    res.status(200).json({ success: true, data: meta });
  } catch (err: any) {
    if (err.message === 'ASSET_NOT_FOUND') { res.status(404).json({ success: false, message: 'Asset not found' }); return; }
    if (err.message === 'ACCESS_DENIED')   { res.status(403).json({ success: false, message: 'Access denied' });   return; }
    next(err);
  }
};

// GET /api/media/me?mediaType=PROFILE_PHOTO
export const listAssets = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId    = req.user!.userId;
    const mediaType = req.query.mediaType as string | undefined;
    const assets    = await listMyAssets(userId, mediaType);
    res.status(200).json({ success: true, data: assets });
  } catch (err) {
    next(err);
  }
};

// DELETE /api/media/:assetId
export const removeAsset = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    await deleteAsset(req.params.assetId as string, req.user!.userId);
    res.status(200).json({ success: true });
  } catch (err: any) {
    if (err.message === 'ASSET_NOT_FOUND') { res.status(404).json({ success: false, message: 'Asset not found' }); return; }
    if (err.message === 'UNAUTHORIZED')    { res.status(403).json({ success: false, message: 'Unauthorized' });    return; }
    next(err);
  }
};

// ── Admin endpoints ───────────────────────────────────────────────────────────

// GET /api/media/admin/moderation-queue?state=QUARANTINED&limit=20
export const getModerationQueue = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { state = 'QUARANTINED', limit = '20' } = req.query;
    const take = Math.min(50, parseInt(limit as string, 10));

    const assets = await prisma.mediaAsset.findMany({
      where:   { moderationState: state as string },
      include: { moderations: { orderBy: { createdAt: 'desc' }, take: 1 } },
      orderBy: { createdAt: 'asc' },
      take,
    });

    res.status(200).json({ success: true, data: assets, meta: { count: assets.length } });
  } catch (err) { next(err); }
};

// PATCH /api/media/admin/:assetId/moderate
// Admin manual override of moderation state.
export const adminModerateAsset = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const assetId  = req.params.assetId as string;
    const { state, notes } = req.body;
    const reviewerId = req.user!.userId;

    const valid = ['APPROVED', 'REJECTED', 'QUARANTINED'];
    if (!valid.includes(state)) {
      res.status(400).json({ success: false, message: 'Invalid moderation state' });
      return;
    }

    const newStatus =
      state === 'REJECTED'   ? 'QUARANTINED' :
      state === 'QUARANTINED' ? 'QUARANTINED' :
                                'READY';

    await prisma.$transaction([
      prisma.mediaAsset.update({
        where: { id: assetId },
        data:  { moderationState: state, status: newStatus },
      }),
      prisma.mediaModeration.create({
        data: {
          assetId,
          provider:   'manual',
          result:     { adminOverride: true },
          labels:     [],
          reviewerId,
          reviewNotes: notes ?? null,
          reviewedAt:  new Date(),
        },
      }),
    ]);

    res.status(200).json({ success: true });
  } catch (err) { next(err); }
};
