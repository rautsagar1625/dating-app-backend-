// ── Media service ─────────────────────────────────────────────────────────────
//
// Orchestration layer: URL generation, access control, asset lifecycle.
// All business logic around "can this user see this asset" lives here.
//
// Access model for private media:
//   1. Owner always has access.
//   2. Other users gain access via a granted record (PhotoAccessRequest.GRANTED).
//   3. Access grants are cached in Redis (velvet:media:access:{userId}:{assetId})
//      with a TTL equal to the signed URL TTL, so cache invalidation and URL
//      expiry are naturally synchronized.
//
// Revoking access:
//   Delete the PhotoAccessRequest record + call revokeMediaAccess() which
//   removes the Redis cache entry. Previously issued signed URLs remain valid
//   until their CloudFront expiry — this is an acceptable ~1h window.
//   For instant revocation, use a CloudFront invalidation in addition.

import IORedis from 'ioredis';
import prisma from '../prisma.service';
import { buildCdnUrl } from './cdn.service';
import {
  SIGNED_URL_TTL,
  buildS3Key,
  isPublicMedia,
  type MediaType,
  type VariantType,
  type ImageFormat,
} from './media.types';

const redis = new IORedis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
  maxRetriesPerRequest: 3,
  lazyConnect: true,
});

// ── Access grant cache ────────────────────────────────────────────────────────

async function hasAccessGrant(userId: string, assetId: string): Promise<boolean> {
  const cacheKey = `velvet:media:access:${userId}:${assetId}`;
  const cached   = await redis.get(cacheKey);
  if (cached !== null) return cached === '1';

  // DB fallback
  const asset = await prisma.mediaAsset.findUnique({
    where:  { id: assetId },
    select: { userId: true, mediaType: true },
  });
  if (!asset) return false;

  // Owner always has access
  if (asset.userId === userId) {
    await redis.setex(cacheKey, 3600, '1');
    return true;
  }

  // Check granted photo access
  const grant = await prisma.photoAccessRequest.findFirst({
    where:  { requesterId: userId, ownerId: asset.userId, status: 'GRANTED' },
    select: { id: true },
  });

  const granted = !!grant;
  const ttl     = granted ? SIGNED_URL_TTL[asset.mediaType as MediaType] : 60;
  await redis.setex(cacheKey, ttl, granted ? '1' : '0');
  return granted;
}

export async function revokeMediaAccess(userId: string, assetId: string): Promise<void> {
  await redis.del(`velvet:media:access:${userId}:${assetId}`);
}

// ── Signed URL cache ──────────────────────────────────────────────────────────
// Cache the generated CDN URL for (TTL - 60s) so we don't re-sign on every
// API call while the URL is still valid.

async function getCachedSignedUrl(userId: string, assetId: string, variant: string): Promise<string | null> {
  return redis.get(`velvet:media:url:${userId}:${assetId}:${variant}`);
}

async function setCachedSignedUrl(
  userId:    string,
  assetId:   string,
  variant:   string,
  url:       string,
  ttlSecs:   number,
): Promise<void> {
  // Cache for TTL minus 60s buffer so we don't serve an already-expired URL
  const cacheTtl = Math.max(ttlSecs - 60, 30);
  await redis.setex(`velvet:media:url:${userId}:${assetId}:${variant}`, cacheTtl, url);
}

// ── Get media URL ─────────────────────────────────────────────────────────────

export interface MediaUrlResult {
  url:          string;
  variantType:  string;
  format:       string;
  width:        number;
  height:       number;
  blurhash:     string | null;
  expiresAt:    Date | null;
}

export async function getMediaUrl(params: {
  assetId:     string;
  requesterId: string;
  variantType: VariantType;
  format:      ImageFormat;
  ipHash:      string;
  userAgent?:  string;
}): Promise<MediaUrlResult> {
  const asset = await prisma.mediaAsset.findUnique({
    where:   { id: params.assetId },
    include: {
      variants: {
        where: { variantType: params.variantType, format: params.format },
        take:  1,
      },
    },
  });

  if (!asset || asset.status === 'DELETED' || asset.status === 'QUARANTINED') {
    throw Object.assign(new Error('ASSET_NOT_FOUND'), { statusCode: 404 });
  }
  if (asset.moderationState === 'REJECTED') {
    throw Object.assign(new Error('ASSET_NOT_FOUND'), { statusCode: 404 });
  }

  const mediaType = asset.mediaType as MediaType;

  // Access control (skip for public assets — profile photos are world-readable)
  if (!isPublicMedia(mediaType)) {
    const allowed = await hasAccessGrant(params.requesterId, params.assetId);
    if (!allowed) throw Object.assign(new Error('ACCESS_DENIED'), { statusCode: 403 });
  }

  const variant = asset.variants[0];
  if (!variant) throw Object.assign(new Error('VARIANT_NOT_READY'), { statusCode: 404 });

  const ttl       = SIGNED_URL_TTL[mediaType];
  const cacheKey  = `${params.variantType}:${params.format}`;
  const cacheHit  = !isPublicMedia(mediaType) && params.requesterId !== asset.userId
    ? await getCachedSignedUrl(params.requesterId, params.assetId, cacheKey)
    : null;

  let url: string;
  if (cacheHit) {
    url = cacheHit;
  } else {
    url = buildCdnUrl({ mediaType, s3Key: variant.s3Key, ttlSeconds: ttl });
    if (!isPublicMedia(mediaType)) {
      await setCachedSignedUrl(params.requesterId, params.assetId, cacheKey, url, ttl);
    }
  }

  // Audit log for private asset accesses
  if (!isPublicMedia(mediaType)) {
    prisma.mediaAccessLog.create({
      data: {
        assetId:    params.assetId,
        userId:     params.requesterId,
        accessType: 'presigned_url_issued',
        ipHash:     params.ipHash,
        userAgent:  params.userAgent,
      },
    }).catch(() => {});
  }

  return {
    url,
    variantType:  variant.variantType,
    format:       variant.format,
    width:        variant.width,
    height:       variant.height,
    blurhash:     asset.blurhash,
    expiresAt:    isPublicMedia(mediaType) ? null : new Date(Date.now() + ttl * 1000),
  };
}

// ── Get asset metadata (no URL) ───────────────────────────────────────────────

export async function getAssetMeta(assetId: string, requesterId: string) {
  const asset = await prisma.mediaAsset.findUnique({
    where:   { id: assetId },
    include: { variants: { select: { variantType: true, format: true, width: true, height: true, fileSizeBytes: true } } },
  });

  if (!asset || asset.status === 'DELETED') {
    throw Object.assign(new Error('ASSET_NOT_FOUND'), { statusCode: 404 });
  }

  const mediaType = asset.mediaType as MediaType;
  if (!isPublicMedia(mediaType) && !(await hasAccessGrant(requesterId, asset.id))) {
    throw Object.assign(new Error('ACCESS_DENIED'), { statusCode: 403 });
  }

  return {
    id:             asset.id,
    mediaType:      asset.mediaType,
    status:         asset.status,
    moderationState: asset.moderationState,
    width:          asset.width,
    height:         asset.height,
    fileSizeBytes:  asset.fileSizeBytes,
    blurhash:       asset.blurhash,
    variants:       asset.variants.map((v) => ({ variantType: v.variantType, format: v.format, width: v.width, height: v.height, fileSizeBytes: v.fileSizeBytes })),
    createdAt:      asset.createdAt,
  };
}

// ── List user's own assets ────────────────────────────────────────────────────

export async function listMyAssets(userId: string, mediaType?: string) {
  return prisma.mediaAsset.findMany({
    where: {
      userId,
      ...(mediaType ? { mediaType } : {}),
      status: { notIn: ['DELETED', 'QUARANTINED'] },
    },
    select: {
      id:             true,
      mediaType:      true,
      status:         true,
      moderationState: true,
      width:          true,
      height:         true,
      fileSizeBytes:  true,
      blurhash:       true,
      createdAt:      true,
    },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });
}

// ── Soft delete ───────────────────────────────────────────────────────────────

export async function deleteAsset(assetId: string, userId: string): Promise<void> {
  const asset = await prisma.mediaAsset.findUnique({ where: { id: assetId }, select: { userId: true } });
  if (!asset)                  throw Object.assign(new Error('ASSET_NOT_FOUND'), { statusCode: 404 });
  if (asset.userId !== userId) throw Object.assign(new Error('UNAUTHORIZED'),    { statusCode: 403 });

  await prisma.mediaAsset.update({
    where: { id: assetId },
    data:  { status: 'DELETED', deletedAt: new Date() },
  });
}
