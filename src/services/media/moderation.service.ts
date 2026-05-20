// ── Moderation service ────────────────────────────────────────────────────────
//
// Provider-agnostic NSFW scanning and perceptual hash dedup.
//
// Pluggable design:
//   The NsfwProvider interface abstracts the scanning call. Wire in any
//   provider (AWS Rekognition, SightEngine, Google Vision) by implementing
//   the interface and setting NSFW_PROVIDER env var.
//
// Lifecycle:
//   UNREVIEWED  → (scan enqueued) → PENDING
//   PENDING     → scan passes     → APPROVED
//   PENDING     → scan fails      → REJECTED  (asset quarantined)
//   PENDING     → uncertain score → QUARANTINED (sent to human review queue)
//
// Perceptual hash dedup:
//   Known bad hashes are stored in a Redis Set velvet:media:phash:blocklist.
//   Near-duplicate detection (Hamming distance ≤ 10) checks the DB index.
//   PhotoDNA integration would hook in here for CSAM detection.

import IORedis from 'ioredis';
import prisma from '../prisma.service';
import { hammingDistance } from './image.processor';
import { logger } from '../../observability/logger';
import {
  mediaModerationTotal,
  mediaProcessingDuration,
} from '../../observability/metrics';

const redis = new IORedis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
  maxRetriesPerRequest: 3,
  lazyConnect: true,
});

const PHASH_BLOCKLIST_KEY = 'velvet:media:phash:blocklist';
const PHASH_HAMMING_THRESHOLD = 10; // ≤ this distance = near-duplicate

// ── Provider interface ────────────────────────────────────────────────────────

interface NsfwScanResult {
  isNsfw:    boolean;
  nsfwScore: number;         // 0.0 – 1.0
  labels:    string[];
  raw:       Record<string, unknown>;
}

interface NsfwProvider {
  scan(imageBuffer: Buffer): Promise<NsfwScanResult>;
}

// Default stub — always marks as not NSFW.
// Replace with a real provider class when ready.
const stubProvider: NsfwProvider = {
  async scan(_buf: Buffer): Promise<NsfwScanResult> {
    return { isNsfw: false, nsfwScore: 0, labels: [], raw: { provider: 'stub' } };
  },
};

// Wire in a real provider by setting NSFW_PROVIDER env var to 'rekognition' etc.
// For now, the stub is always used.
function getProvider(): NsfwProvider {
  return stubProvider;
}

// ── Perceptual hash blocklist ─────────────────────────────────────────────────

export async function isHashBlocked(phash: string): Promise<boolean> {
  return (await redis.sismember(PHASH_BLOCKLIST_KEY, phash)) === 1;
}

export async function addHashToBlocklist(phash: string): Promise<void> {
  await redis.sadd(PHASH_BLOCKLIST_KEY, phash);
}

// Check the DB for near-duplicate hashes (Hamming ≤ threshold).
// This is O(n) over assets with hashes — for production at scale,
// use a dedicated vector/hash similarity service or pg_trgm index.
async function findNearDuplicate(phash: string): Promise<string | null> {
  const assets = await prisma.mediaAsset.findMany({
    where:  { perceptualHash: { not: null } },
    select: { id: true, perceptualHash: true },
    take:   2000, // reasonable scan window
  });

  for (const a of assets) {
    if (a.perceptualHash && hammingDistance(phash, a.perceptualHash) <= PHASH_HAMMING_THRESHOLD) {
      return a.id;
    }
  }
  return null;
}

// ── Main moderation scan ──────────────────────────────────────────────────────

export interface ModerationResult {
  state:       'APPROVED' | 'REJECTED' | 'QUARANTINED';
  reason?:     string;
  isNsfw?:     boolean;
  nsfwScore?:  number;
  labels?:     string[];
  duplicateOf?: string;
}

export async function moderateAsset(params: {
  assetId:      string;
  imageBuffer:  Buffer;
  perceptualHash: string;
}): Promise<ModerationResult> {
  const start = Date.now();
  let result: ModerationResult = { state: 'APPROVED' };

  try {
    // 1. Exact blocklist match (O(1) Redis lookup)
    if (await isHashBlocked(params.perceptualHash)) {
      result = { state: 'REJECTED', reason: 'BLOCKLIST_EXACT_MATCH' };
      mediaModerationTotal.inc({ provider: 'phash', result: 'rejected' });
      return result;
    }

    // 2. Near-duplicate detection
    const dupId = await findNearDuplicate(params.perceptualHash);
    if (dupId) {
      result = { state: 'QUARANTINED', reason: 'NEAR_DUPLICATE', duplicateOf: dupId };
    }

    // 3. NSFW scan
    const provider   = getProvider();
    const scanResult = await provider.scan(params.imageBuffer);

    if (scanResult.isNsfw || scanResult.nsfwScore >= 0.85) {
      result = {
        state:     'REJECTED',
        isNsfw:    true,
        nsfwScore: scanResult.nsfwScore,
        labels:    scanResult.labels,
        reason:    'NSFW_AUTO',
      };
    } else if (scanResult.nsfwScore >= 0.60) {
      // Borderline — send to human review
      result = {
        state:     'QUARANTINED',
        isNsfw:    scanResult.isNsfw,
        nsfwScore: scanResult.nsfwScore,
        labels:    scanResult.labels,
        reason:    'NSFW_MANUAL_REVIEW',
      };
    } else {
      result = {
        state:     result.state === 'QUARANTINED' ? 'QUARANTINED' : 'APPROVED',
        isNsfw:    false,
        nsfwScore: scanResult.nsfwScore,
        labels:    scanResult.labels,
        duplicateOf: result.duplicateOf,
      };
    }

    // Persist moderation record
    await prisma.mediaModeration.create({
      data: {
        assetId:   params.assetId,
        provider:  'stub',
        result:    scanResult.raw as any,
        isNsfw:    scanResult.isNsfw,
        nsfwScore: scanResult.nsfwScore,
        labels:    scanResult.labels,
      },
    });

    mediaModerationTotal.inc({ provider: 'stub', result: result.state.toLowerCase() });
  } catch (err) {
    // Scan failure → QUARANTINED (fail safe — don't auto-approve on errors)
    result = { state: 'QUARANTINED', reason: 'SCAN_ERROR' };
    logger.error({ err, assetId: params.assetId }, 'moderation scan failed');
    mediaModerationTotal.inc({ provider: 'stub', result: 'error' });
  }

  mediaProcessingDuration.observe({ stage: 'moderation' }, (Date.now() - start) / 1000);
  return result;
}
