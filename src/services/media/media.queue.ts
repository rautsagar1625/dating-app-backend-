// ── Media processing queue ────────────────────────────────────────────────────
//
// Two BullMQ queues with dedicated workers:
//
//   media-process  — image processing (sharp variants, hashes, S3 move)
//     └─ process-image job
//
//   media-moderate — NSFW + pHash scan (runs *after* processing completes)
//     └─ moderate-image job
//
//   media-cleanup  — maintenance cron: expire sessions, delete temp orphans
//     └─ expire-sessions job
//     └─ cleanup-temp    job
//
// Queue separation matters for scaling:
//   Processing workers are CPU-bound (sharp). Run them on dedicated nodes with
//   more vCPUs. Moderation workers are I/O-bound (network calls to NSFW APIs).
//   The cleanup queue is low-priority and needs very few replicas.
//
// Retry policy:
//   process-image:  3 attempts, exponential backoff starting at 5s
//   moderate-image: 2 attempts, flat 10s delay (idempotent API calls)
//   Dead-letter: jobs exhausting retries land in failed state with full stack.
//   A Prometheus alert fires when velvet_media_failed_jobs_total > 5 in 5m.

import { Queue, Worker, Job } from 'bullmq';
import IORedis from 'ioredis';
import prisma from '../prisma.service';
import { getObjectBuffer, putObject, deleteObject } from './s3.service';
import { processImage } from './image.processor';
import { moderateAsset } from './moderation.service';
import {
  buildS3Key,
  getFinalBucket,
  getCdnDomain,
  IMAGE_OUTPUT_FORMATS,
  IMAGE_VARIANT_DEFS,
  type MediaType,
  type VariantType,
  type ImageFormat,
} from './media.types';
import { queueLogger } from '../../observability/logger';
import { captureException } from '../../observability/sentry';
import {
  mediaUploadTotal,
  mediaProcessingDuration,
  mediaModerationTotal,
  mediaQueueDepth,
} from '../../observability/metrics';

// ── Redis connection (separate from BullMQ's internal connection) ─────────────
const connection = new IORedis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
  maxRetriesPerRequest: null, // required by BullMQ
});

// ── Job type definitions ──────────────────────────────────────────────────────

export interface ProcessImageJobData {
  assetId: string;
}

export interface ModerateImageJobData {
  assetId: string;
}

export interface CleanupJobData {
  type: 'expire-sessions' | 'cleanup-temp';
}

// ── Queues ────────────────────────────────────────────────────────────────────

export const mediaProcessQueue = new Queue<ProcessImageJobData>('media-process', {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff:  { type: 'exponential', delay: 5000 },
    removeOnComplete: { count: 500 },
    removeOnFail:     { count: 200 },
  },
});

export const mediaModerateQueue = new Queue<ModerateImageJobData>('media-moderate', {
  connection,
  defaultJobOptions: {
    attempts: 2,
    backoff:  { type: 'fixed', delay: 10_000 },
    removeOnComplete: { count: 500 },
    removeOnFail:     { count: 200 },
  },
});

export const mediaCleanupQueue = new Queue<CleanupJobData>('media-cleanup', {
  connection,
  defaultJobOptions: {
    attempts: 1,
    removeOnComplete: { count: 10 },
    removeOnFail:     { count: 10 },
  },
});

export async function enqueueImageProcessing(assetId: string): Promise<void> {
  await mediaProcessQueue.add('process-image', { assetId }, {
    jobId: `process:${assetId}`, // deduplication — one job per asset
  });
}

export async function enqueueModeration(assetId: string): Promise<void> {
  await mediaModerateQueue.add('moderate-image', { assetId }, {
    jobId: `moderate:${assetId}`,
  });
}

// ── Image processing worker ───────────────────────────────────────────────────
//
// Concurrency 4: each worker uses ~200 MB RAM peak during sharp processing.
// Scale horizontally by increasing replica count in K8s, not concurrency,
// to avoid OOM kills on constrained nodes.

export const mediaProcessWorker = new Worker<ProcessImageJobData>(
  'media-process',
  async (job: Job<ProcessImageJobData>) => {
    const { assetId } = job.data;
    const log = queueLogger('media-process', job.id);
    const start = Date.now();

    log.info({ assetId }, 'processing image');

    const asset = await prisma.mediaAsset.findUnique({ where: { id: assetId } });
    if (!asset || !asset.tempS3Key) {
      log.warn({ assetId }, 'asset not found or no tempS3Key, skipping');
      return;
    }

    // Mark as PROCESSING before we do any work
    await prisma.mediaAsset.update({
      where: { id: assetId },
      data:  { status: 'PROCESSING' },
    });

    try {
      // Download original from temp bucket
      const original = await getObjectBuffer(asset.s3Bucket, asset.tempS3Key);
      log.debug({ assetId, bytes: original.length }, 'downloaded original');

      // Process — generate all variants + compute hashes
      const result = await processImage(original);
      log.debug({ assetId, variantCount: result.variants.length }, 'image processed');

      const mediaType  = asset.mediaType as MediaType;
      const destBucket = getFinalBucket(mediaType);
      const cdnDomain  = getCdnDomain(mediaType);

      // Upload variants to final bucket in parallel (max 5 concurrent)
      const variantRecords: Array<{
        assetId:       string;
        variantType:   string;
        format:        string;
        s3Key:         string;
        fileSizeBytes: number;
        width:         number;
        height:        number;
      }> = [];

      const uploads = result.variants.map(async (v) => {
        const s3Key      = buildS3Key(asset.userId, mediaType, assetId, v.variantType, v.format);
        const mimeType   = `image/${v.format.toLowerCase() === 'jpeg' ? 'jpeg' : v.format.toLowerCase()}`;
        // Immutable processed variants get long cache TTL — content-addressed by assetId
        const cacheCtrl  = mediaType === 'PROFILE_PHOTO'
          ? 'public, max-age=31536000, immutable'
          : 'private, no-store';

        await putObject({ bucket: destBucket, key: s3Key, body: v.buffer, contentType: mimeType, cacheControl: cacheCtrl });

        variantRecords.push({
          assetId,
          variantType:   v.variantType,
          format:        v.format,
          s3Key,
          fileSizeBytes: v.fileSizeBytes,
          width:         v.width,
          height:        v.height,
        });
      });

      // Upload 5 at a time to avoid S3 request throttle
      for (let i = 0; i < uploads.length; i += 5) {
        await Promise.all(uploads.slice(i, i + 5));
      }

      // The canonical s3Key for the asset is the ORIGINAL JPEG variant
      const originalVariant = variantRecords.find((v) => v.variantType === 'ORIGINAL' && v.format === 'JPEG')!;

      // Persist all variant records + update asset in one transaction
      await prisma.$transaction([
        prisma.mediaVariant.createMany({ data: variantRecords, skipDuplicates: true }),
        prisma.mediaAsset.update({
          where: { id: assetId },
          data: {
            status:         'READY',
            s3Bucket:       destBucket,
            s3Key:          originalVariant.s3Key,
            cdnDomain:      cdnDomain,
            width:          result.originalWidth,
            height:         result.originalHeight,
            perceptualHash: result.perceptualHash,
            sha256Hash:     result.sha256Hash,
            blurhash:       result.blurhash,
            fileSizeBytes:  original.length,
          },
        }),
      ]);

      // Delete from temp bucket — no longer needed
      await deleteObject(asset.s3Bucket, asset.tempS3Key);

      const durationSec = (Date.now() - start) / 1000;
      mediaProcessingDuration.observe({ stage: 'process' }, durationSec);
      mediaUploadTotal.inc({ mediaType, result: 'processed' });
      log.info({ assetId, durationSec, variantCount: variantRecords.length }, 'image processing complete');

      // Enqueue moderation scan
      await enqueueModeration(assetId);

    } catch (err) {
      await prisma.mediaAsset.update({
        where: { id: assetId },
        data:  { status: 'FAILED' },
      }).catch(() => {});
      throw err; // re-throw so BullMQ retries
    }
  },
  { connection, concurrency: 4 },
);

// ── Moderation worker ─────────────────────────────────────────────────────────

export const mediaModerateWorker = new Worker<ModerateImageJobData>(
  'media-moderate',
  async (job: Job<ModerateImageJobData>) => {
    const { assetId } = job.data;
    const log = queueLogger('media-moderate', job.id);

    const asset = await prisma.mediaAsset.findUnique({
      where:   { id: assetId },
      include: {
        variants: { where: { variantType: 'MEDIUM', format: 'WEBP' }, take: 1 },
      },
    });

    if (!asset || asset.status !== 'READY') {
      log.warn({ assetId }, 'asset not ready for moderation, skipping');
      return;
    }

    await prisma.mediaAsset.update({
      where: { id: assetId },
      data:  { moderationState: 'PENDING' },
    });

    // Download the MEDIUM WebP for scanning (smaller = faster, still enough detail)
    const variant = asset.variants[0];
    if (!variant) {
      log.warn({ assetId }, 'no MEDIUM variant for moderation');
      return;
    }

    const imageBuffer = await getObjectBuffer(asset.s3Bucket, variant.s3Key);

    const modResult = await moderateAsset({
      assetId,
      imageBuffer,
      perceptualHash: asset.perceptualHash ?? '',
    });

    const dbState =
      modResult.state === 'APPROVED'    ? 'APPROVED' :
      modResult.state === 'REJECTED'    ? 'REJECTED'  :
                                          'QUARANTINED';

    const statusUpdate =
      modResult.state === 'REJECTED' || modResult.state === 'QUARANTINED'
        ? { moderationState: dbState, status: 'QUARANTINED' }
        : { moderationState: 'APPROVED' };

    await prisma.mediaAsset.update({ where: { id: assetId }, data: statusUpdate });

    log.info({ assetId, state: modResult.state, reason: modResult.reason }, 'moderation complete');
  },
  { connection, concurrency: 8 }, // I/O-bound — can run higher concurrency
);

// ── Maintenance workers ───────────────────────────────────────────────────────

export const mediaCleanupWorker = new Worker<CleanupJobData>(
  'media-cleanup',
  async (job: Job<CleanupJobData>) => {
    const log = queueLogger('media-cleanup', job.id);

    if (job.data.type === 'expire-sessions') {
      const { expireUploadSessions } = await import('./upload.service');
      await expireUploadSessions();
      log.info('upload sessions expired');
    }

    if (job.data.type === 'cleanup-temp') {
      // Find FAILED or old PENDING assets with a tempS3Key and delete from temp bucket
      const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const stale = await prisma.mediaAsset.findMany({
        where: {
          OR: [
            { status: 'FAILED', tempS3Key: { not: null } },
            { status: 'PENDING', createdAt: { lt: cutoff }, tempS3Key: { not: null } },
          ],
        },
        select: { id: true, s3Bucket: true, tempS3Key: true },
        take: 100,
      });

      for (const a of stale) {
        if (a.tempS3Key) {
          await deleteObject(a.s3Bucket, a.tempS3Key).catch(() => {});
          await prisma.mediaAsset.update({ where: { id: a.id }, data: { tempS3Key: null } }).catch(() => {});
        }
      }
      log.info({ count: stale.length }, 'temp objects cleaned up');
    }
  },
  { connection, concurrency: 1 },
);

// ── Maintenance schedule ──────────────────────────────────────────────────────

export async function scheduleMediaMaintenance(): Promise<void> {
  await mediaCleanupQueue.add('expire-sessions', { type: 'expire-sessions' }, {
    repeat: { pattern: '0 * * * *' },  // every hour
    jobId:  'media-expire-sessions',
  });
  await mediaCleanupQueue.add('cleanup-temp', { type: 'cleanup-temp' }, {
    repeat: { pattern: '0 */6 * * *' }, // every 6 hours
    jobId:  'media-cleanup-temp',
  });
}

// ── Error handlers ────────────────────────────────────────────────────────────

for (const worker of [mediaProcessWorker, mediaModerateWorker, mediaCleanupWorker]) {
  worker.on('failed', (job, err) => {
    const log = queueLogger(worker.name, job?.id);
    log.error({ err: err.message }, 'media worker job failed');
    captureException(err, { jobId: job?.id, jobName: job?.name, queue: worker.name });
  });
}

// ── Queue depth polling (Prometheus) ─────────────────────────────────────────

setInterval(async () => {
  const [pWaiting, mWaiting] = await Promise.all([
    mediaProcessQueue.getWaitingCount(),
    mediaModerateQueue.getWaitingCount(),
  ]).catch(() => [0, 0]);
  mediaQueueDepth.set({ queue: 'media-process' }, pWaiting);
  mediaQueueDepth.set({ queue: 'media-moderate' }, mWaiting);
}, 30_000);
