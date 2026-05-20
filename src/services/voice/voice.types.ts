// ── Voice Note Types ──────────────────────────────────────────────────────────

// Waveform: ~100 float values 0-1 representing audio amplitude over time.
// Generated client-side for instant UX, optionally re-validated server-side.
export type Waveform = number[];

export interface VoiceUploadSessionData {
  sessionId:  string;
  userId:     string;
  chatId:     string;
  uploadUrl:  string;    // presigned PUT URL
  s3Key:      string;    // S3 object key in TEMP bucket
  mimeType:   string;
  maxBytes:   number;
  expiresAt:  number;    // Unix ms
}

export interface VoiceConfirmPayload {
  sessionId:    string;
  chatId:       string;
  clientTempId: string;
  durationMs:   number;   // client-reported
  waveform:     Waveform; // client-computed
  mimeType:     string;
}

export interface VoiceProcessJobData {
  voiceNoteId: string;
  messageId:   string;
  s3TempKey:   string;
  mimeType:    string;
  chatId:      string;
  senderId:    string;
}

export interface ProcessedAudio {
  s3FinalKey:   string;
  durationMs:   number;
  waveform:     Waveform;
  fileSizeBytes: number;
}
