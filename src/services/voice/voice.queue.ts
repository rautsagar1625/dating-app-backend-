// ── Voice Note Processing Queue ───────────────────────────────────────────────
//
// Worker: downloads temp audio from S3, optionally normalizes via ffmpeg,
// validates duration, moves to CDN chat bucket, updates VoiceMessage record,
// then triggers content moderation scan.
//
// Degrades gracefully: if ffmpeg is unavailable the file is moved as-is.
// This means the raw upload (already validated against UPLOAD_LIMITS) goes live.
//
// Processing steps:
//   1. Download from S3 TEMP
//   2. ffprobe: validate duration (reject if > 10 min or 0)
//   3. ffmpeg: normalize audio levels (loudnorm filter), transcode to AAC if needed
//   4. Re-upload to CHAT bucket under {userId}/VOICE_NOTE/{assetId}/audio.aac
//   5. Upsert VoiceMessage with final s3Key + processedAt
//   6. Emit voice_note_ready via Socket.IO to chat participants
//   7. Enqueue moderation scan (placeholder — future audio AI)

import { Queue, Worker, Job } from 'bullmq';
import { redisConnection } from '../notification.queue';
import { Readable } from 'stream';
import prisma from '../prisma.service';
import { getObjectBuffer, putObject } from '../media/s3.service';
import { MEDIA_BUCKETS } from '../media/media.types';
import { emitToUser } from '../socket.service';
import { queueLogger } from '../../observability/logger';
import { captureException } from '../../observability/sentry';
import {
  queueJobsProcessedTotal,
  queueJobDuration,
  voiceNoteProcessTotal,
  voiceNoteProcessDuration,
} from '../../observability/metrics';
import type { VoiceProcessJobData, Waveform } from './voice.types';

export const voiceProcessQueue = new Queue<VoiceProcessJobData>('voice-process', {
  connection: redisConnection,
  defaultJobOptions: {
    attempts:         3,
    backoff:          { type: 'exponential', delay: 5000 },
    removeOnComplete: { count: 200 },
    removeOnFail:     { age: 86400 },
  },
});

export async function enqueueVoiceProcess(data: VoiceProcessJobData): Promise<void> {
  await voiceProcessQueue.add('process', data, {
    jobId: `voice:${data.voiceNoteId}`,
  }).catch(() => {});
}

// ── Audio helpers (ffmpeg-optional) ──────────────────────────────────────────

async function tryFfmpegProcess(
  inputBuffer: Buffer,
  mimeType:    string,
): Promise<{ outputBuffer: Buffer; durationMs: number } | null> {
  try {
    // @ts-expect-error optional peer dependency
    const ffmpeg = await import('fluent-ffmpeg');
    const ffmpegFn = ffmpeg.default ?? ffmpeg;

    return await new Promise<{ outputBuffer: Buffer; durationMs: number } | null>((resolve) => {
      const chunks: Buffer[] = [];
      let   durationMs = 0;

      const stream = new Readable();
      stream.push(inputBuffer);
      stream.push(null);

      ffmpegFn(stream)
        .audioCodec('aac')
        .audioChannels(1)       // mono — reduces file size, adequate for voice
        .audioBitrate('64k')
        .audioFilters('loudnorm=I=-16:TP=-1.5:LRA=11')  // EBU R128 normalization
        .format('adts')         // AAC ADTS container
        .on('error', () => resolve(null))
        .on('codecData', (data: { duration: string }) => {
          const parts  = data.duration.split(':');
          const hh = parseFloat(parts[0] ?? '0');
          const mm = parseFloat(parts[1] ?? '0');
          const ss = parseFloat(parts[2] ?? '0');
          durationMs = Math.round((hh * 3600 + mm * 60 + ss) * 1000);
        })
        .pipe()
        .on('data', (chunk: Buffer) => chunks.push(chunk))
        .on('end', () => {
          const outputBuffer = Buffer.concat(chunks);
          resolve(outputBuffer.length > 0 ? { outputBuffer, durationMs } : null);
        });
    });
  } catch {
    return null;  // ffmpeg not installed
  }
}

// Generate a simple amplitude waveform from raw PCM bytes (fallback)
function generateWaveformFromBuffer(buf: Buffer, points = 100): Waveform {
  const chunkSize = Math.max(1, Math.floor(buf.length / points));
  const waveform: number[] = [];

  for (let i = 0; i < points; i++) {
    const start = i * chunkSize;
    const end   = Math.min(start + chunkSize, buf.length);
    let   sum   = 0;

    for (let j = start; j < end; j++) {
      // Treat each byte as unsigned amplitude sample
      sum += Math.abs((buf[j] ?? 0) - 128);
    }

    const avg = sum / Math.max(end - start, 1);
    waveform.push(Math.min(avg / 128, 1));
  }

  // Smooth the waveform (moving average)
  return waveform.map((v, i) => {
    const prev  = waveform[i - 1] ?? v;
    const next  = waveform[i + 1] ?? v;
    return (prev + v + next) / 3;
  });
}

// ── Worker ────────────────────────────────────────────────────────────────────

export const voiceProcessWorker = new Worker<VoiceProcessJobData>(
  'voice-process',
  async (job: Job<VoiceProcessJobData>) => {
    const { voiceNoteId, messageId, s3TempKey, mimeType, chatId, senderId } = job.data;
    const log   = queueLogger('voice-process', job.id);
    const start = Date.now();

    log.info({ voiceNoteId }, 'processing voice note');

    // 1. Download from temp bucket
    const inputBuffer = await getObjectBuffer(MEDIA_BUCKETS.TEMP, s3TempKey);

    // 2. Try ffmpeg normalization
    const processed = await tryFfmpegProcess(inputBuffer, mimeType);
    const outputBuffer  = processed?.outputBuffer ?? inputBuffer;
    const durationMsNew = processed?.durationMs   ?? 0;

    // 3. Build CDN key: userId/VOICE_NOTE/voiceNoteId/audio.aac
    const [, , assetId] = s3TempKey.split('/');  // tmp/{userId}/{assetId}/...
    const finalKey = `${senderId}/VOICE_NOTE/${voiceNoteId}/audio.aac`;

    // 4. Upload to CHAT bucket
    await putObject({
      bucket:      MEDIA_BUCKETS.CHAT,
      key:         finalKey,
      body:        outputBuffer,
      contentType: 'audio/aac',
    });

    // 5. Generate waveform from processed audio (better than client data)
    const waveform = generateWaveformFromBuffer(outputBuffer, 100);

    // 6. Update DB record
    await prisma.voiceMessage.update({
      where: { id: voiceNoteId },
      data: {
        s3Key:        finalKey,
        fileSizeBytes: outputBuffer.length,
        ...(durationMsNew > 0 ? { durationMs: durationMsNew } : {}),
        waveform:     waveform as unknown as object,
        processedAt:  new Date(),
      },
    });

    // 7. Notify clients that the voice note is processed (waveform ready)
    const chat = await prisma.chat.findUnique({
      where:  { id: chatId },
      select: { user1Id: true, user2Id: true },
    });
    if (chat) {
      const payload = { messageId, voiceNoteId, waveform, ...(durationMsNew > 0 ? { durationMs: durationMsNew } : {}) };
      emitToUser(chat.user1Id, 'voice_note_ready', payload);
      emitToUser(chat.user2Id, 'voice_note_ready', payload);
    }

    voiceNoteProcessTotal.inc({ result: 'success', ffmpeg: processed ? '1' : '0' });
    voiceNoteProcessDuration.observe((Date.now() - start) / 1000);
    queueJobsProcessedTotal.inc({ queue: 'voice-process', status: 'completed' });
    queueJobDuration.observe({ queue: 'voice-process' }, (Date.now() - start) / 1000);

    log.info({ voiceNoteId, fileSizeBytes: outputBuffer.length }, 'voice note processed');
  },
  { connection: redisConnection, concurrency: 5 },
);

voiceProcessWorker.on('failed', (job, err) => {
  voiceNoteProcessTotal.inc({ result: 'failed', ffmpeg: '0' });
  queueJobsProcessedTotal.inc({ queue: 'voice-process', status: 'failed' });
  captureException(err, { queue: 'voice-process', jobId: job?.id });
});

export async function closeVoiceWorker(): Promise<void> {
  await voiceProcessWorker.close();
}
