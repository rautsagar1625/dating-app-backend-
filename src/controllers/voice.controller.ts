import { Request, Response, NextFunction } from 'express';
import {
  createVoiceUploadSession,
  confirmVoiceUpload,
  getVoicePlaybackUrl,
} from '../services/voice/voice.upload';
import prisma from '../services/prisma.service';

// POST /api/voice/upload-url
export const requestVoiceUploadUrl = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const { chatId, mimeType, fileSize, durationMs } = req.body;

    if (!chatId || typeof chatId !== 'string') {
      res.status(400).json({ success: false, message: 'chatId is required' });
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
    if (!durationMs || typeof durationMs !== 'number' || durationMs <= 0 || durationMs > 120_000) {
      res.status(400).json({ success: false, message: 'durationMs is required (1–120000)' });
      return;
    }

    const session = await createVoiceUploadSession(userId, chatId, mimeType, fileSize);

    res.status(200).json({
      success: true,
      data: {
        sessionId:  session.sessionId,
        uploadUrl:  session.uploadUrl,
        expiresAt:  session.expiresAt,
        instructions: {
          method:  'PUT',
          headers: { 'Content-Type': mimeType },
          note:    'PUT raw audio bytes to uploadUrl, then call /confirm with sessionId and waveform.',
        },
      },
    });
  } catch (err: any) {
    if (err.statusCode) {
      res.status(err.statusCode).json({ success: false, message: err.message });
      return;
    }
    next(err);
  }
};

// POST /api/voice/confirm
export const confirmVoiceUploadHandler = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const { sessionId, chatId, clientTempId, durationMs, waveform, mimeType } = req.body;

    if (!sessionId || typeof sessionId !== 'string') {
      res.status(400).json({ success: false, message: 'sessionId is required' });
      return;
    }
    if (!chatId || typeof chatId !== 'string') {
      res.status(400).json({ success: false, message: 'chatId is required' });
      return;
    }
    if (!clientTempId || typeof clientTempId !== 'string') {
      res.status(400).json({ success: false, message: 'clientTempId is required' });
      return;
    }
    if (!durationMs || typeof durationMs !== 'number' || durationMs <= 0) {
      res.status(400).json({ success: false, message: 'durationMs is required' });
      return;
    }
    if (!Array.isArray(waveform) || waveform.length < 10 || waveform.length > 200) {
      res.status(400).json({ success: false, message: 'waveform must be an array of 10–200 numbers' });
      return;
    }

    const result = await confirmVoiceUpload(userId, {
      sessionId,
      chatId,
      clientTempId,
      durationMs,
      waveform,
      mimeType: mimeType ?? 'audio/aac',
    });

    res.status(201).json({ success: true, data: result });
  } catch (err: any) {
    if (err.statusCode) {
      res.status(err.statusCode).json({ success: false, message: err.message });
      return;
    }
    next(err);
  }
};

// GET /api/voice/:voiceNoteId/url
export const getVoicePlaybackUrlHandler = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId     = req.user!.userId;
    const voiceNoteId = req.params.voiceNoteId as string;

    const { url, expiresAt } = await getVoicePlaybackUrl(voiceNoteId, userId);

    res.status(200).json({ success: true, data: { url, expiresAt } });
  } catch (err: any) {
    if (err.statusCode) {
      res.status(err.statusCode).json({ success: false, message: err.message });
      return;
    }
    next(err);
  }
};

// DELETE /api/voice/:voiceNoteId
export const deleteVoiceNote = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId     = req.user!.userId;
    const voiceNoteId = req.params.voiceNoteId as string;

    const voiceNote = await prisma.voiceMessage.findUnique({
      where:  { id: voiceNoteId },
      select: { senderId: true },
    });

    if (!voiceNote) {
      res.status(404).json({ success: false, message: 'Voice note not found' });
      return;
    }
    if (voiceNote.senderId !== userId) {
      res.status(403).json({ success: false, message: 'Not your voice note' });
      return;
    }

    await prisma.voiceMessage.update({
      where: { id: voiceNoteId },
      data:  { deletedAt: new Date() },
    });

    res.status(200).json({ success: true });
  } catch (err) {
    next(err);
  }
};
