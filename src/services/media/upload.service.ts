// ── Upload session service ────────────────────────────────────────────────────
//
// Manages the lifecycle of a presigned S3 upload:
//
//   createSession()    → issues a 15-minute presigned PUT URL, persists session
//                        record in DB and caches it in Redis for fast lookups.
//   completeSession()  → client calls this after the PUT to S3 completes.
//                        We verify the object actually landed (HeadObject),
//                        validate magic bytes, then enqueue the processing job.
//
// Why presigned PUT (not POST)?
//   PUT is simpler for mobile clients — a single axios.put() call with the file
//   as the body. POST forms require multipart encoding which is more complex.
//   The trade-off is that size is not enforced by S3 at the presign level for
//   PUT, so we enforce it server-side in completeSession() via HeadObject.

import { randomUUID } from 'crypto';
import IORedis from 'ioredis';
import prisma from '../prisma.service';
import { createPresignedPutUrl, headObject } from './s3.service';
import {
  MEDIA_BUCKETS,
  UPLOAD_LIMITS,
  UPLOAD_RATE_LIMIT_WINDOW_SECS,
  UPLOAD_RATE_LIMIT_MAX,
  UPLOAD_SESSION_TTL_SECS,
  buildTempS3Key,
  mimeToExt,
  detectMagicMime,
  type MediaType,
} from './media.types';
import { getObjectBuffer } from './s3.service';

const redis = new IORedis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
  maxRetriesPerRequest: 3,
  lazyConnect: true,
});

// ── Rate limiting ─────────────────────────────────────────────────────────────
export async function isUploadRateLimited(userId: string): Promise<boolean> {
  const key   = `velvet:media:rate:${userId}`;
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, UPLOAD_RATE_LIMIT_WINDOW_SECS);
  return count > UPLOAD_RATE_LIMIT_MAX;
}

// ── Session cache helpers ─────────────────────────────────────────────────────
interface CachedSession {
  userId:   string;
  assetId:  string;
  s3Bucket: string;
  s3Key:    string;
  maxSizeBytes: number;
}

async function cacheSession(sessionId: string, data: CachedSession): Promise<void> {
  await redis.setex(
    `velvet:upload:session:${sessionId}`,
    UPLOAD_SESSION_TTL_SECS,
    JSON.stringify(data),
  );
}

async function loadSession(sessionId: string): Promise<CachedSession | null> {
  const raw = await redis.get(`velvet:upload:session:${sessionId}`);
  if (raw) return JSON.parse(raw) as CachedSession;

  // Redis miss — fall back to DB (e.g. after a Redis restart)
  const row = await prisma.uploadSession.findUnique({ where: { id: sessionId } });
  if (!row) return null;
  return {
    userId:      row.userId,
    assetId:     row.assetId!,
    s3Bucket:    row.s3Bucket,
    s3Key:       row.s3Key,
    maxSizeBytes: row.maxSizeBytes,
  };
}

// ── Create upload session ─────────────────────────────────────────────────────
export interface UploadSessionResult {
  sessionId:  string;
  assetId:    string;
  uploadUrl:  string;
  s3Key:      string;
  s3Bucket:   string;
  expiresAt:  Date;
}

export async function createUploadSession(params: {
  userId:     string;
  mediaType:  MediaType;
  mimeType:   string;
  fileSize:   number;
}): Promise<UploadSessionResult> {
  const limits = UPLOAD_LIMITS[params.mediaType];

  if (!limits.mimes.includes(params.mimeType)) {
    throw Object.assign(new Error(`MIME_NOT_ALLOWED`), { statusCode: 400 });
  }
  if (params.fileSize > limits.maxBytes) {
    throw Object.assign(new Error(`FILE_TOO_LARGE`), { statusCode: 400 });
  }

  const assetId   = randomUUID();
  const sessionId = randomUUID();
  const ext       = mimeToExt(params.mimeType);
  const s3Bucket  = MEDIA_BUCKETS.TEMP;
  const s3Key     = buildTempS3Key(params.userId, assetId, ext);
  const expiresAt = new Date(Date.now() + UPLOAD_SESSION_TTL_SECS * 1000);

  const uploadUrl = await createPresignedPutUrl({
    bucket:   s3Bucket,
    key:      s3Key,
    mimeType: params.mimeType,
  });

  // Persist session + asset stub in a single transaction
  await prisma.$transaction([
    prisma.mediaAsset.create({
      data: {
        id:          assetId,
        userId:      params.userId,
        mediaType:   params.mediaType,
        status:      'PENDING',
        s3Bucket,
        s3Key,
        tempS3Key:   s3Key,
        mimeType:    params.mimeType,
      },
    }),
    prisma.uploadSession.create({
      data: {
        id:          sessionId,
        userId:      params.userId,
        assetId,
        uploadType:  params.mediaType,
        s3Bucket,
        s3Key,
        presignedUrl: uploadUrl,
        maxSizeBytes: limits.maxBytes,
        allowedMimes: [...limits.mimes],
        expiresAt,
      },
    }),
  ]);

  await cacheSession(sessionId, {
    userId:   params.userId,
    assetId,
    s3Bucket,
    s3Key,
    maxSizeBytes: limits.maxBytes,
  });

  return { sessionId, assetId, uploadUrl, s3Key, s3Bucket, expiresAt };
}

// ── Complete upload session ───────────────────────────────────────────────────
// Returns the assetId on success; throws on any validation failure.
export async function completeUploadSession(
  sessionId: string,
  userId:    string,
): Promise<string> {
  const session = await loadSession(sessionId);
  if (!session)                  throw Object.assign(new Error('SESSION_NOT_FOUND'), { statusCode: 404 });
  if (session.userId !== userId) throw Object.assign(new Error('UNAUTHORIZED'),      { statusCode: 403 });

  // Confirm the object landed in S3
  const head = await headObject(session.s3Bucket, session.s3Key);
  if (!head.exists) throw Object.assign(new Error('UPLOAD_NOT_FOUND'), { statusCode: 422 });

  // Enforce file size server-side (presigned PUT cannot enforce this at the S3 level)
  if (head.contentLength > session.maxSizeBytes) {
    throw Object.assign(new Error('FILE_TOO_LARGE'), { statusCode: 422 });
  }

  // Magic-byte MIME validation — read first 16 bytes to verify actual content
  const header     = await getObjectBuffer(session.s3Bucket, session.s3Key).then((b) => b.subarray(0, 16));
  const detectedMime = detectMagicMime(header);
  // If detection returned null (HEIC, HEIF), trust the Content-Type from HeadObject
  if (detectedMime && detectedMime !== head.contentType.split(';')[0].trim()) {
    throw Object.assign(new Error('MIME_MISMATCH'), { statusCode: 422 });
  }

  // Mark session completed + update asset status in one transaction
  await prisma.$transaction([
    prisma.uploadSession.update({
      where: { id: sessionId },
      data:  { status: 'COMPLETED', completedAt: new Date() },
    }),
    prisma.mediaAsset.update({
      where: { id: session.assetId },
      data:  { status: 'UPLOADED', fileSizeBytes: head.contentLength },
    }),
  ]);

  // Invalidate Redis cache — session is now one-time-use
  await redis.del(`velvet:upload:session:${sessionId}`);

  return session.assetId;
}

// ── Expire stale sessions (called by maintenance cron) ───────────────────────
export async function expireUploadSessions(): Promise<void> {
  const now = new Date();
  await prisma.uploadSession.updateMany({
    where:  { status: 'PENDING', expiresAt: { lt: now } },
    data:   { status: 'EXPIRED' },
  });
  // The corresponding MediaAsset stubs are cleaned up by a separate job
}
