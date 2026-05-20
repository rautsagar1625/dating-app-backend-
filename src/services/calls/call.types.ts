// ── Call System — Shared Types ────────────────────────────────────────────────

export type CallType   = 'AUDIO' | 'VIDEO';
export type CallStatus =
  | 'RINGING'
  | 'CONNECTING'
  | 'ACTIVE'
  | 'ENDED'
  | 'MISSED'
  | 'REJECTED'
  | 'CANCELLED'
  | 'FAILED'
  | 'MODERATION_ENDED';

export type EndReason =
  | 'NORMAL'
  | 'MISSED'
  | 'REJECTED'
  | 'CANCELLED'
  | 'FAILED'
  | 'MODERATION'
  | 'TIMEOUT'
  | 'BILLING_FAILED';

// ── Redis ephemeral call state ────────────────────────────────────────────────
// Stored in Redis; source of truth for active call signaling.
// DB CallSession is the durable audit record (written async).

export interface CallState {
  callId:        string;
  callerId:      string;
  calleeId:      string;
  chatId?:       string;
  type:          CallType;
  status:        CallStatus;
  provider:      string;
  providerRoomId?: string;
  callerToken?:  string;
  calleeToken?:  string;
  ringingAt:     number;   // Unix ms
  connectedAt?:  number;
  activatedAt?:  number;
  endedAt?:      number;
  endReason?:    EndReason;
}

// ── Provider interface ────────────────────────────────────────────────────────

export interface CreateRoomParams {
  callId:          string;
  callType:        CallType;
  maxParticipants: number;
}

export interface RoomCredentials {
  roomId:      string;   // provider room ID
  appId?:      string;   // Agora needs this on the client
  callerToken: string;
  calleeToken: string;
}

export interface GenerateTokenParams {
  userId:      string;
  roomId:      string;
  callId:      string;
  role:        'CALLER' | 'CALLEE';
  ttlSeconds?: number;
}

export interface RoomStats {
  activeUsers: number;
  durationS:   number;
}

export interface CallProvider {
  readonly name: string;
  createRoom(params: CreateRoomParams): Promise<RoomCredentials>;
  endRoom(roomId: string): Promise<void>;
  getRoomStats(roomId: string): Promise<RoomStats | null>;
}

// ── QoS report (client-sent) ─────────────────────────────────────────────────

export interface QosReport {
  callId:        string;
  packetLossPct?: number;
  jitterMs?:     number;
  rttMs?:        number;
  bitrateKbps?:  number;
  resolution?:   string;
  frameRate?:    number;
  networkType?:  string;
}

// ── Socket signaling payloads ─────────────────────────────────────────────────

export interface CallInvitePayload {
  calleeId: string;
  type:     CallType;
  chatId?:  string;
}

export interface CallAcceptPayload { callId: string; deviceType?: string }
export interface CallRejectPayload { callId: string; reason?: string }
export interface CallEndPayload    { callId: string }

export interface CallIncomingEvent {
  callId:    string;
  callerId:  string;
  type:      CallType;
  provider:  string;
}

export interface CallConnectedEvent {
  callId:  string;
  roomId:  string;
  token:   string;
  appId?:  string;
  type:    CallType;
}

export interface CallEndedEvent {
  callId:    string;
  durationS: number;
  endReason: EndReason;
}
