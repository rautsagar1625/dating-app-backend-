// ── Bucket identifiers ────────────────────────────────────────────────────────
//
// Separate buckets enforce IAM boundary isolation:
//   PUBLIC    — CloudFront distribution with no signed-URL requirement
//   PRIVATE   — CloudFront distribution that *requires* signed URLs
//   CHAT      — same signed-URL requirement, shorter default TTL
//   TEMP      — upload landing zone; S3 lifecycle rule deletes objects after 24h
//   QUARANTINE— no CDN distribution; direct S3 access is IAM-restricted to admins
//
export const MEDIA_BUCKETS = {
  PUBLIC:     process.env.S3_BUCKET_PUBLIC     ?? 'velvet-media-public',
  PRIVATE:    process.env.S3_BUCKET_PRIVATE    ?? 'velvet-media-private',
  CHAT:       process.env.S3_BUCKET_CHAT       ?? 'velvet-media-chat',
  TEMP:       process.env.S3_BUCKET_TEMP       ?? 'velvet-media-temp',
  QUARANTINE: process.env.S3_BUCKET_QUARANTINE ?? 'velvet-media-quarantine',
} as const;

// ── CDN domains ───────────────────────────────────────────────────────────────
export const CDN_DOMAINS = {
  PUBLIC:  process.env.CDN_PUBLIC_DOMAIN  ?? 'cdn-public.velvet.app',
  PRIVATE: process.env.CDN_PRIVATE_DOMAIN ?? 'cdn-private.velvet.app',
  CHAT:    process.env.CDN_CHAT_DOMAIN    ?? 'cdn-chat.velvet.app',
} as const;

// ── Upload limits per media type ──────────────────────────────────────────────
export type MediaType =
  | 'PROFILE_PHOTO'
  | 'PRIVATE_PHOTO'
  | 'CHAT_ATTACHMENT'
  | 'VERIFICATION_SELFIE'
  | 'VIDEO'
  | 'VOICE_NOTE';

export const UPLOAD_LIMITS: Record<MediaType, { maxBytes: number; mimes: readonly string[] }> = {
  PROFILE_PHOTO:      { maxBytes: 15 * 1024 * 1024,  mimes: ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'] },
  PRIVATE_PHOTO:      { maxBytes: 15 * 1024 * 1024,  mimes: ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'] },
  CHAT_ATTACHMENT:    { maxBytes: 25 * 1024 * 1024,  mimes: ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'video/mp4'] },
  VERIFICATION_SELFIE:{ maxBytes: 10 * 1024 * 1024,  mimes: ['image/jpeg', 'image/png', 'image/webp'] },
  VIDEO:              { maxBytes: 200 * 1024 * 1024, mimes: ['video/mp4', 'video/quicktime', 'video/webm'] },
  VOICE_NOTE:         { maxBytes: 10 * 1024 * 1024,  mimes: ['audio/aac', 'audio/mp4', 'audio/mpeg', 'audio/ogg', 'audio/webm', 'audio/wav'] },
};

// ── Signed CDN URL TTLs (seconds) ─────────────────────────────────────────────
export const SIGNED_URL_TTL: Record<MediaType, number> = {
  PROFILE_PHOTO:       24 * 60 * 60,  // 24h
  PRIVATE_PHOTO:            60 * 60,  // 1h
  CHAT_ATTACHMENT:    24 * 60 * 60,   // 24h
  VERIFICATION_SELFIE:     15 * 60,   // 15min
  VIDEO:                    60 * 60,  // 1h
  VOICE_NOTE:               60 * 60,  // 1h — rotates to prevent hotlinking
};

// ── Image variant definitions ─────────────────────────────────────────────────
//
// Each image is processed into 4 × 2 = 8 size/format combinations (WebP + AVIF)
// plus one ORIGINAL JPEG for maximum client compatibility.
//
export type VariantType = 'THUMB' | 'SMALL' | 'MEDIUM' | 'LARGE' | 'ORIGINAL';
export type ImageFormat  = 'WEBP' | 'AVIF' | 'JPEG';

export interface VariantDef {
  type: VariantType;
  width: number;
  height: number;
  fit: 'cover' | 'inside';
}

export const IMAGE_VARIANT_DEFS: VariantDef[] = [
  { type: 'THUMB',  width: 160,  height: 160,  fit: 'cover'  },
  { type: 'SMALL',  width: 320,  height: 320,  fit: 'inside' },
  { type: 'MEDIUM', width: 640,  height: 640,  fit: 'inside' },
  { type: 'LARGE',  width: 1200, height: 1200, fit: 'inside' },
];

export const IMAGE_OUTPUT_FORMATS: ImageFormat[] = ['WEBP', 'AVIF'];

// ── S3 key construction ───────────────────────────────────────────────────────
//
// Naming convention: {userId}/{mediaType}/{assetId}/{variantType}_{format}.{ext}
// This gives us path-prefix policies and efficient listing by user/type.
//
export function buildS3Key(
  userId: string,
  mediaType: MediaType,
  assetId: string,
  variantType: VariantType,
  format: ImageFormat,
): string {
  const ext = format === 'JPEG' ? 'jpg' : format.toLowerCase();
  return `${userId}/${mediaType}/${assetId}/${variantType}_${format}.${ext}`;
}

export function buildTempS3Key(userId: string, assetId: string, ext: string): string {
  return `tmp/${userId}/${assetId}/original${ext}`;
}

// ── Bucket + CDN routing by media type ───────────────────────────────────────
export function getFinalBucket(mediaType: MediaType): string {
  if (mediaType === 'PROFILE_PHOTO') return MEDIA_BUCKETS.PUBLIC;
  if (mediaType === 'CHAT_ATTACHMENT') return MEDIA_BUCKETS.CHAT;
  return MEDIA_BUCKETS.PRIVATE;
}

export function getCdnDomain(mediaType: MediaType): string {
  if (mediaType === 'PROFILE_PHOTO') return CDN_DOMAINS.PUBLIC;
  if (mediaType === 'CHAT_ATTACHMENT') return CDN_DOMAINS.CHAT;
  return CDN_DOMAINS.PRIVATE;
}

export function isPublicMedia(mediaType: MediaType): boolean {
  return mediaType === 'PROFILE_PHOTO';
}

// ── MIME to file extension ────────────────────────────────────────────────────
export function mimeToExt(mime: string): string {
  const map: Record<string, string> = {
    'image/jpeg':       '.jpg',
    'image/png':        '.png',
    'image/webp':       '.webp',
    'image/heic':       '.heic',
    'image/heif':       '.heif',
    'image/gif':        '.gif',
    'image/avif':       '.avif',
    'video/mp4':        '.mp4',
    'video/quicktime':  '.mov',
    'video/webm':       '.webm',
  };
  return map[mime] ?? '.bin';
}

// ── Magic-byte MIME detection (avoids trusting client Content-Type) ───────────
export function detectMagicMime(buf: Buffer): string | null {
  if (buf.length < 12) return null;
  const hex = buf.subarray(0, 12).toString('hex');
  if (hex.startsWith('ffd8ff')) return 'image/jpeg';
  if (hex.startsWith('89504e47')) return 'image/png';
  if (hex.startsWith('47494638')) return 'image/gif';
  if (hex.startsWith('52494646') && buf.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  // MP4/MOV: ftyp box at offset 4
  const ftyp = buf.subarray(4, 8).toString('ascii');
  if (ftyp === 'ftyp') {
    const brand = buf.subarray(8, 12).toString('ascii');
    if (brand.startsWith('qt')) return 'video/quicktime';
    return 'video/mp4';
  }
  // HEIC/HEIF
  const possibleFtyp = buf.subarray(4, 12).toString('ascii');
  if (possibleFtyp.startsWith('ftypheic') || possibleFtyp.startsWith('ftyphei') || possibleFtyp.startsWith('ftypmif1')) return 'image/heic';
  return null;
}

// ── Upload rate limiting constants ────────────────────────────────────────────
export const UPLOAD_RATE_LIMIT_WINDOW_SECS = 3600;  // 1 hour
export const UPLOAD_RATE_LIMIT_MAX = 20;             // per user per hour
export const UPLOAD_SESSION_TTL_SECS = 900;          // 15 minutes
