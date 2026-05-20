// ── Voice Note Upload Service ─────────────────────────────────────────────────
//
// Flow:
//   1. POST /api/voice/upload-url   → presigned S3 PUT URL (15-min TTL)
//   2. Client PUT → S3 TEMP bucket (direct, no server bandwidth)
//   3. POST /api/voice/confirm      → create Message(type=VOICE) + VoiceMessage
//                                     + enqueue voice-process job
//   4. GET  /api/voice/:id/url      → signed CDN URL (1h TTL, rotates)
//
// Waveform and duration are client-provided at confirm time for instant UX.
// The processing worker re-validates them if ffprobe is available.

import IORedis from 'ioredis';
import { randomUUID } from 'crypto';
import prisma from '../prisma.service';
import { MEDIA_BUCKETS, UPLOAD_LIMITS, buildTempS3Key } from '../media/media.types';
import { createPresignedPutUrl, headObject } from '../media/s3.service';
import { getSignedCdnUrl } from '../media/cdn.service';
import { enqueueVoiceProcess } from './voice.queue';
import { emitToUser, isUserOnlineSocket } from '../socket.service';
import { createNotification } from '../notification.service';
import { isBlocked } from '../block.service';
import { logger } from '../../observability/logger';
import type { VoiceUploadSessionData, VoiceConfirmPayload } from './voice.types';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
const voiceRedis = new IORedis(REDIS_URL, {
  maxRetriesPerRequest: 2,
  lazyConnect: true,
  enableReadyCheck: false,
});
voiceRedis.connect().catch(() => {});

const SESSION_TTL  = 900;  // 15 minutes
const SESSION_KEY  = (id: string) => `voice:session:${id}`;
const CDN_CHAT_URL = (key: string) =>
  `https://${process.env.CDN_CHAT_DOMAIN ?? 'cdn-chat.velvet.app'}/${key}`;

// ── Upload session ────────────────────────────────────────────────────────────

export async function createVoiceUploadSession(
  userId:   string,
  chatId:   string,
  mimeType: string,
  fileSize: number,
): Promise<VoiceUploadSessionData> {
  const limits = UPLOAD_LIMITS['VOICE_NOTE'];

  if (!limits.mimes.includes(mimeType)) {
    throw Object.assign(new Error(`Unsupported voice format: ${mimeType}`), { statusCode: 400 });
  }
  if (fileSize > limits.maxBytes) {
    throw Object.assign(new Error('Voice note too large (max 10 MB)'), { statusCode: 400 });
  }

  // Validate that the chat exists and this user is a participant
  const chat = await prisma.chat.findUnique({
    where:  { id: chatId },
    select: { user1Id: true, user2Id: true, isUnlocked: true },
  });
  if (!chat || (chat.user1Id !== userId && chat.user2Id !== userId)) {
    throw Object.assign(new Error('Chat not found or access denied'), { statusCode: 403 });
  }
  if (!chat.isUnlocked) {
    throw Object.assign(new Error('Chat is locked — unlock first'), { statusCode: 403 });
  }

  const ext       = mimeType.split('/')[1] ?? 'aac';
  const assetId   = randomUUID();
  const s3Key     = buildTempS3Key(userId, assetId, `.${ext}`);
  const sessionId = randomUUID();

  const uploadUrl = await createPresignedPutUrl({
    bucket:     MEDIA_BUCKETS.TEMP,
    key:        s3Key,
    mimeType,
    expiresIn:  SESSION_TTL,
  });

  const session: VoiceUploadSessionData = {
    sessionId,
    userId,
    chatId,
    uploadUrl,
    s3Key,
    mimeType,
    maxBytes: fileSize,
    expiresAt: Date.now() + SESSION_TTL * 1000,
  };

  await voiceRedis.setex(SESSION_KEY(sessionId), SESSION_TTL, JSON.stringify(session));
  return session;
}

// ── Confirm upload ────────────────────────────────────────────────────────────

export async function confirmVoiceUpload(
  userId:  string,
  payload: VoiceConfirmPayload,
): Promise<{ messageId: string; voiceNoteId: string }> {
  const { sessionId, chatId, clientTempId, durationMs, waveform, mimeType } = payload;

  // Validate session
  const raw = await voiceRedis.get(SESSION_KEY(sessionId));
  if (!raw) throw Object.assign(new Error('Upload session expired or not found'), { statusCode: 404 });

  const session = JSON.parse(raw) as VoiceUploadSessionData;
  if (session.userId !== userId) throw Object.assign(new Error('Session belongs to another user'), { statusCode: 403 });
  if (session.chatId !== chatId) throw Object.assign(new Error('chatId mismatch'), { statusCode: 400 });

  // Validate waveform (array of 10-200 floats 0-1)
  if (!Array.isArray(waveform) || waveform.length < 10 || waveform.length > 200) {
    throw Object.assign(new Error('Invalid waveform — must be 10-200 values'), { statusCode: 400 });
  }

  // Verify object exists in S3 (client actually uploaded it)
  const meta = await headObject(MEDIA_BUCKETS.TEMP, session.s3Key).catch(() => null);
  if (!meta) throw Object.assign(new Error('Upload not found in storage — upload the file first'), { statusCode: 422 });

  const fileSizeBytes = meta.contentLength ?? 0;

  // Idempotency: return existing if already confirmed
  const existing = await prisma.message.findUnique({
    where:  { clientTempId },
    select: { id: true, voiceNoteId: true },
  });
  if (existing && existing.voiceNoteId) {
    return { messageId: existing.id, voiceNoteId: existing.voiceNoteId };
  }

  const chat = await prisma.chat.findUnique({
    where:  { id: chatId },
    select: { user1Id: true, user2Id: true },
  });
  if (!chat) throw Object.assign(new Error('Chat not found'), { statusCode: 404 });

  const otherUserId = chat.user1Id === userId ? chat.user2Id : chat.user1Id;
  if (await isBlocked(userId, otherUserId)) {
    throw Object.assign(new Error('BLOCKED'), { statusCode: 403 });
  }

  // Create VoiceMessage + Message in a transaction
  const voiceNoteId = randomUUID();
  const messageId   = randomUUID();

  await prisma.$transaction([
    prisma.voiceMessage.create({
      data: {
        id:           voiceNoteId,
        messageId,
        chatId,
        senderId:     userId,
        s3Key:        session.s3Key,  // will be updated by worker to CDN path
        mimeType:     mimeType ?? session.mimeType,
        fileSizeBytes,
        durationMs:   Math.max(1, Math.min(durationMs, 600_000)), // cap at 10 min
        waveform:     waveform as unknown as object,
      },
    }),
    prisma.message.create({
      data: {
        id:          messageId,
        clientTempId,
        chatId,
        senderId:    userId,
        message:     '',   // empty for voice — client renders from VoiceMessage
        type:        'VOICE',
        voiceNoteId,
        status:      isUserOnlineSocket(otherUserId) ? 'DELIVERED' : 'SENT',
        deliveredAt: isUserOnlineSocket(otherUserId) ? new Date() : null,
      },
    }),
  ]);

  // Realtime delivery
  emitToUser(otherUserId, 'new_message', {
    id:         messageId,
    chatId,
    senderId:   userId,
    type:       'VOICE',
    voiceNote:  { id: voiceNoteId, durationMs, waveform },
    status:     'DELIVERED',
    createdAt:  new Date().toISOString(),
  });

  createNotification(otherUserId, 'MESSAGE', userId);

  // Enqueue processing (normalization, moderation scan, CDN move)
  await enqueueVoiceProcess({
    voiceNoteId,
    messageId,
    s3TempKey:  session.s3Key,
    mimeType:   session.mimeType,
    chatId,
    senderId:   userId,
  });

  // Consume session
  await voiceRedis.del(SESSION_KEY(sessionId));

  logger.info({ userId, chatId, voiceNoteId, durationMs }, 'voice note confirmed');
  return { messageId, voiceNoteId };
}

// ── Playback URL ──────────────────────────────────────────────────────────────

export async function getVoicePlaybackUrl(
  voiceNoteId: string,
  userId:      string,
): Promise<{ url: string; expiresAt: number }> {
  const note = await prisma.voiceMessage.findUnique({
    where:  { id: voiceNoteId },
    select: { s3Key: true, chatId: true, senderId: true, processedAt: true },
  });
  if (!note) throw Object.assign(new Error('Voice note not found'), { statusCode: 404 });

  const chat = await prisma.chat.findUnique({
    where:  { id: note.chatId },
    select: { user1Id: true, user2Id: true },
  });
  if (!chat || (chat.user1Id !== userId && chat.user2Id !== userId)) {
    throw Object.assign(new Error('Access denied'), { statusCode: 403 });
  }

  const TTL = 3600;
  const mediaType = note.processedAt ? 'VOICE_NOTE' as any : 'VOICE_NOTE' as any;
  const url = getSignedCdnUrl({ mediaType, s3Key: note.s3Key, ttlSeconds: TTL });
  return { url, expiresAt: Date.now() + TTL * 1000 };
}
