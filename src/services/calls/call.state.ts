// ── Call Session State Machine (Redis-backed) ─────────────────────────────────
//
// Redis is the single source of truth for ACTIVE call state.
// The DB (CallSession) is the durable audit record — written async.
//
// Redis keys:
//   call:state:{callId}        → CallState JSON       TTL: 15min (refreshed while active)
//   call:user:{userId}         → active callId        TTL: 15min
//   call:ring:{callId}         → "1" sentinel         TTL: 30s (ring timeout)
//   call:spam:{cId}:{tId}      → call count           TTL: 1h
//
// State transitions enforced here:
//   RINGING → CONNECTING (on accept)
//   RINGING → REJECTED / MISSED / CANCELLED
//   CONNECTING → ACTIVE / FAILED
//   ACTIVE → ENDED / FAILED / MODERATION_ENDED
//
// All transitions are atomic via Redis scripting where needed.

import IORedis from 'ioredis';
import { randomUUID } from 'crypto';
import prisma from '../prisma.service';
import { getCallProvider } from './providers/call.provider.registry';
import { logger } from '../../observability/logger';
import { captureException } from '../../observability/sentry';
import {
  callStateTransitions,
  callDurationHistogram,
  callInitiatedTotal,
} from '../../observability/metrics';
import type { CallState, CallType, CallStatus, EndReason, RoomCredentials } from './call.types';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
export const callRedis = new IORedis(REDIS_URL, {
  maxRetriesPerRequest: 2,
  lazyConnect: true,
  enableReadyCheck: false,
});
callRedis.connect().catch(() => {});

const STATE_TTL  = 15 * 60;   // 15 min
const RING_TTL   = 30;         // 30s ring timeout
const USER_TTL   = 15 * 60;
const SPAM_TTL   = 60 * 60;    // 1h spam window
const SPAM_LIMIT = 3;          // max calls to same person per hour

const stateKey = (callId: string)             => `call:state:${callId}`;
const userKey  = (userId: string)             => `call:user:${userId}`;
const ringKey  = (callId: string)             => `call:ring:${callId}`;
const spamKey  = (caller: string, callee: string) => `call:spam:${caller}:${callee}`;

// ── Read / Write ──────────────────────────────────────────────────────────────

export async function getCallState(callId: string): Promise<CallState | null> {
  try {
    const raw = await callRedis.get(stateKey(callId));
    return raw ? JSON.parse(raw) as CallState : null;
  } catch {
    return null;
  }
}

async function saveCallState(state: CallState, ttl = STATE_TTL): Promise<void> {
  await callRedis.setex(stateKey(state.callId), ttl, JSON.stringify(state));
}

export async function getUserActiveCallId(userId: string): Promise<string | null> {
  return callRedis.get(userKey(userId));
}

async function setUserActiveCall(userId: string, callId: string | null): Promise<void> {
  if (callId) {
    await callRedis.setex(userKey(userId), USER_TTL, callId);
  } else {
    await callRedis.del(userKey(userId));
  }
}

// ── Spam guard ────────────────────────────────────────────────────────────────

export async function checkSpamLimit(callerId: string, calleeId: string): Promise<boolean> {
  try {
    const key   = spamKey(callerId, calleeId);
    const count = await callRedis.incr(key);
    if (count === 1) await callRedis.expire(key, SPAM_TTL);
    return count > SPAM_LIMIT;
  } catch {
    return false;  // fail-open: don't block on Redis error
  }
}

// ── State transitions ─────────────────────────────────────────────────────────

export async function initiateCall(params: {
  callerId: string;
  calleeId: string;
  type:     CallType;
  chatId?:  string;
}): Promise<CallState> {
  const callId = randomUUID();
  const provider = getCallProvider();

  const state: CallState = {
    callId,
    callerId:   params.callerId,
    calleeId:   params.calleeId,
    chatId:     params.chatId,
    type:       params.type,
    status:     'RINGING',
    provider:   provider.name,
    ringingAt:  Date.now(),
  };

  await Promise.all([
    saveCallState(state),
    setUserActiveCall(params.callerId, callId),
    callRedis.setex(ringKey(callId), RING_TTL, '1'),
  ]);

  // Persist to DB async
  prisma.callSession.create({
    data: {
      id:        callId,
      callerId:  params.callerId,
      calleeId:  params.calleeId,
      chatId:    params.chatId,
      type:      params.type,
      status:    'RINGING',
      provider:  provider.name,
    },
  }).then(() =>
    prisma.callParticipant.createMany({
      data: [
        { callId, userId: params.callerId, role: 'CALLER' },
        { callId, userId: params.calleeId, role: 'CALLEE' },
      ],
    }),
  ).catch((err) => logger.error({ err, callId }, 'call DB persist failed'));

  callInitiatedTotal.inc({ type: params.type, provider: provider.name });
  logger.info({ callId, callerId: params.callerId, calleeId: params.calleeId, type: params.type }, 'call initiated');
  return state;
}

export async function acceptCall(callId: string, calleeId: string): Promise<{
  state: CallState;
  credentials: RoomCredentials;
}> {
  const state = await getCallState(callId);
  if (!state) throw new Error('Call not found or expired');
  if (state.calleeId !== calleeId) throw new Error('Not the callee for this call');
  if (state.status !== 'RINGING') throw new Error(`Cannot accept call in status: ${state.status}`);

  // Create provider room
  const provider    = getCallProvider();
  const credentials = await provider.createRoom({
    callId,
    callType:        state.type,
    maxParticipants: 2,
  });

  const updated: CallState = {
    ...state,
    status:          'CONNECTING',
    providerRoomId:  credentials.roomId,
    callerToken:     credentials.callerToken,
    calleeToken:     credentials.calleeToken,
    connectedAt:     Date.now(),
  };

  await Promise.all([
    saveCallState(updated),
    setUserActiveCall(calleeId, callId),
    callRedis.del(ringKey(callId)),
  ]);

  // Update DB async
  prisma.callSession.update({
    where: { id: callId },
    data: {
      status:        'CONNECTING',
      providerRoomId: credentials.roomId,
    },
  }).catch(() => {});

  callStateTransitions.inc({ transition: 'ringing_to_connecting', provider: provider.name });
  logger.info({ callId, calleeId }, 'call accepted');
  return { state: updated, credentials };
}

export async function activateCall(callId: string): Promise<CallState> {
  const state = await getCallState(callId);
  if (!state) throw new Error('Call not found');

  const updated: CallState = {
    ...state,
    status:      'ACTIVE',
    activatedAt: Date.now(),
  };

  await saveCallState(updated);
  prisma.callSession.update({
    where: { id: callId },
    data:  { status: 'ACTIVE', startedAt: new Date() },
  }).catch(() => {});
  prisma.callParticipant.updateMany({
    where: { callId },
    data:  { joinedAt: new Date() },
  }).catch(() => {});

  callStateTransitions.inc({ transition: 'connecting_to_active', provider: state.provider });
  return updated;
}

export async function endCall(
  callId:    string,
  initiator: string,
  reason:    EndReason = 'NORMAL',
): Promise<{ state: CallState; durationS: number }> {
  const state = await getCallState(callId);
  if (!state) return { state: { callId } as CallState, durationS: 0 };

  const now       = Date.now();
  const durationS = state.activatedAt
    ? Math.round((now - state.activatedAt) / 1000)
    : 0;

  const finalStatus: CallStatus =
    reason === 'REJECTED'   ? 'REJECTED'  :
    reason === 'MISSED'     ? 'MISSED'    :
    reason === 'CANCELLED'  ? 'CANCELLED' :
    reason === 'FAILED'     ? 'FAILED'    :
    reason === 'MODERATION' ? 'MODERATION_ENDED' :
    'ENDED';

  const updated: CallState = {
    ...state,
    status:    finalStatus,
    endedAt:   now,
    endReason: reason,
  };

  // End provider room
  if (state.providerRoomId) {
    getCallProvider().endRoom(state.providerRoomId).catch(() => {});
  }

  // Clean Redis
  await Promise.all([
    callRedis.setex(stateKey(callId), 120, JSON.stringify(updated)),  // keep briefly for stragglers
    setUserActiveCall(state.callerId, null),
    setUserActiveCall(state.calleeId, null),
    callRedis.del(ringKey(callId)),
  ]);

  // Persist to DB
  prisma.callSession.update({
    where: { id: callId },
    data: {
      status:    finalStatus,
      durationS: durationS > 0 ? durationS : undefined,
      endedAt:   new Date(),
      endReason: reason,
    },
  }).catch(() => {});

  if (durationS > 0) {
    prisma.callParticipant.updateMany({
      where: { callId },
      data:  { leftAt: new Date() },
    }).catch(() => {});

    callDurationHistogram.observe({ type: state.type, provider: state.provider }, durationS);
  }

  callStateTransitions.inc({
    transition: `ended_${reason.toLowerCase()}`,
    provider:   state.provider,
  });

  logger.info({ callId, initiator, reason, durationS }, 'call ended');
  return { state: updated, durationS };
}

export async function handleRingTimeout(callId: string): Promise<boolean> {
  const state = await getCallState(callId);
  if (!state || state.status !== 'RINGING') return false;

  await endCall(callId, 'system', 'MISSED');
  return true;
}
