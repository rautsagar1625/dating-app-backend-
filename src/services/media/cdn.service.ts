// ── CDN / CloudFront service ──────────────────────────────────────────────────
//
// Architecture:
//   PUBLIC distribution:  cache-control "public, max-age=31536000, immutable"
//                          No signed URLs needed — profile photos are world-readable.
//   PRIVATE distribution: CloudFront signed URLs via RSA key pair.
//                          All requests without a valid signature are rejected
//                          by CloudFront before they hit the origin (S3).
//   CHAT distribution:    Same signed-URL mechanism, different CDN domain.
//
// Key rotation: rotate CF_KEY_PAIR_ID + CF_PRIVATE_KEY without downtime by
// keeping the old key pair active during the TTL window of existing issued URLs.
//
// Local dev fallback: if CF_KEY_PAIR_ID is unset, returns a direct S3-style URL
// so the system stays functional without AWS credentials.

import { getSignedUrl as cfGetSignedUrl } from '@aws-sdk/cloudfront-signer';
import { isPublicMedia, getCdnDomain, type MediaType } from './media.types';

const CF_KEY_PAIR_ID = process.env.CF_KEY_PAIR_ID ?? '';
// PEM private key stored as a single env var with literal \n characters
const CF_PRIVATE_KEY = (process.env.CF_PRIVATE_KEY ?? '').replace(/\\n/g, '\n');

const cdnEnabled = !!CF_KEY_PAIR_ID && !!CF_PRIVATE_KEY;

// ── Public (unsigned) CDN URL ─────────────────────────────────────────────────
// Used only for profile photos — the CloudFront distribution for the PUBLIC
// bucket does NOT require signed URLs.
export function getPublicCdnUrl(mediaType: MediaType, s3Key: string): string {
  const domain = getCdnDomain(mediaType);
  return `https://${domain}/${s3Key}`;
}

// ── Signed CDN URL ────────────────────────────────────────────────────────────
// Generates a CloudFront signed URL with a hard expiry. After expiry the
// signature is invalid and CloudFront returns 403.
//
// Cache-Control on the S3 origin is set to "private, no-store" so CloudFront
// does NOT cache private content at the edge — every request goes to origin
// and is gated by the signature. This trades some latency for correctness;
// for high-traffic private assets consider edge-side token validation instead.
export function getSignedCdnUrl(params: {
  mediaType:  MediaType;
  s3Key:      string;
  ttlSeconds: number;
}): string {
  const domain = getCdnDomain(params.mediaType);
  const url = `https://${domain}/${params.s3Key}`;
  const expiresAt = new Date(Date.now() + params.ttlSeconds * 1000).toISOString();

  if (!cdnEnabled) {
    // Dev fallback — append a fake sig parameter so downstream code doesn't break
    return `${url}?sig=devmode&exp=${Math.floor(Date.now() / 1000) + params.ttlSeconds}`;
  }

  return cfGetSignedUrl({
    url,
    keyPairId:    CF_KEY_PAIR_ID,
    privateKey:   CF_PRIVATE_KEY,
    dateLessThan: expiresAt,
  });
}

// ── Route to correct URL builder ─────────────────────────────────────────────
export function buildCdnUrl(params: {
  mediaType:  MediaType;
  s3Key:      string;
  ttlSeconds: number;
}): string {
  if (isPublicMedia(params.mediaType)) {
    return getPublicCdnUrl(params.mediaType, params.s3Key);
  }
  return getSignedCdnUrl(params);
}
