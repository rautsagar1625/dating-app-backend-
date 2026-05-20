// ── Call Signaling — Socket.IO Event Handlers ─────────────────────────────────
//
// Registered per-socket in server.ts connection handler:
//   registerCallHandlers(socket, userId, io)
//
// ── Client → Server events ────────────────────────────────────────────────────
//
//   call:invite         { calleeId, type, chatId? }
//   call:accept         { callId, deviceType? }
//   call:reject         { callId }
//   call:cancel         { callId }
//   call:end            { callId }
//   call:ice-candidate  { callId, candidate, targetId }
//   call:quality-report { callId, packetLossPct?, jitterMs?, rttMs?, bitrateKbps?,
//                         resolution?, frameRate?, networkType? }
//   call:keepalive      { callId }
//
// ── Server → Client events ────────────────────────────────────────────────────
//
//   call:incoming       { callId, callerId, type, provider }
//   call:connecting     { callId, roomId, token, appId?, type }  → to caller only
//   call:connected      { callId, roomId, token, appId?, type }  → to callee only
//   call:rejected       { callId }
//   call:cancelled      { callId }
//   call:ended          { callId, durationS, endReason }
//   call:missed         { callId }
//   call:busy           { callId }
//   call:error          { callId, message, code }
//   call:ice-candidate  { callId, candidate, senderId }  (relay)
//   call:quality-alert  { callId, message }  (server-side QoS alert)

import type { Socket, Server } from 'socket.io';
import { Queue } from 'bullmq';
import { redisConnection } from '../services/notification.queue';
import {
  initiateCall,
  acceptCall,
  activateCall,
  endCall,
  getCallState,
  getUserActiveCallId,
  handleRingTimeout,
} from '../services/calls/call.state';
import { checkCallSafety } from '../services/calls/call.safety';
import { enqueueCallBilling } from '../services/calls/call.billing';
import { emitToUser } from '../services/socket.service';
import prisma from '../services/prisma.service';
import { logger } from '../observability/logger';
import { captureException } from '../observability/sentry';
import {
  callQosPacketLoss,
  callQosJitter,
  callQosRtt,
  wsMessagesTotal,
} from '../observability/metrics';
import type {
  CallInvitePayload,
  CallAcceptPayload,
  CallRejectPayload,
  CallEndPayload,
  QosReport,
} from '../services/calls/call.types';

// Ring timeout queue — jobs fire after 30s for each pending call
const ringTimeoutQueue = new Queue<{ callId: string; callerId: string; calleeId: string }>(
  'call-ring-timeout',
  {
    connection: redisConnection,
    defaultJobOptions: {
      attempts:         1,
      removeOnComplete: { count: 100 },
      removeOnFail:     { count: 50 },
    },
  },
);

export function registerCallHandlers(socket: Socket, userId: string, io: Server): void {
  // ── call:invite ─────────────────────────────────────────────────────────────

  socket.on('call:invite', async (payload: CallInvitePayload) => {
    wsMessagesTotal.inc({ event: 'call:invite' });
    const { calleeId, type, chatId } = payload;

    if (!calleeId || !['AUDIO', 'VIDEO'].includes(type)) {
      socket.emit('call:error', { message: 'Invalid call parameters', code: 'INVALID_PARAMS' });
      return;
    }

    try {
      const safety = await checkCallSafety(userId, calleeId);
      if (!safety.allowed) {
        // SHADOW_BLOCK: pretend it worked, caller doesn't know they're blocked
        if ((safety as any).silent) {
          setTimeout(() => socket.emit('call:ended', { callId: 'shadow', durationS: 0, endReason: 'MISSED' }), 30_000);
          return;
        }
        socket.emit('call:error', { message: safety.reason, code: safety.code });
        return;
      }

      const state = await initiateCall({ callerId: userId, calleeId, type, chatId });

      // Notify callee
      emitToUser(calleeId, 'call:incoming', {
        callId:   state.callId,
        callerId: userId,
        type,
        provider: state.provider,
      });

      // Confirm to caller
      socket.emit('call:ringing', { callId: state.callId, calleeId });

      // Schedule ring timeout (30s)
      await ringTimeoutQueue.add(
        'ring-timeout',
        { callId: state.callId, callerId: userId, calleeId },
        { jobId: `ring:${state.callId}`, delay: 30_000 },
      ).catch(() => {});

      logger.info({ callId: state.callId, callerId: userId, calleeId, type }, 'call:invite processed');
    } catch (err) {
      captureException(err as Error, { userId, calleeId });
      socket.emit('call:error', { message: 'Failed to initiate call', code: 'SERVER_ERROR' });
    }
  });

  // ── call:accept ─────────────────────────────────────────────────────────────

  socket.on('call:accept', async (payload: CallAcceptPayload) => {
    wsMessagesTotal.inc({ event: 'call:accept' });
    const { callId, deviceType } = payload;

    try {
      const { state, credentials } = await acceptCall(callId, userId);

      // Update participant device type
      if (deviceType) {
        prisma.callParticipant.updateMany({
          where: { callId, userId },
          data:  { deviceType, joinedAt: new Date() },
        }).catch(() => {});
      }

      // Give caller their token (CONNECTING state)
      emitToUser(state.callerId, 'call:connecting', {
        callId,
        roomId: credentials.roomId,
        token:  credentials.callerToken,
        appId:  credentials.appId,
        type:   state.type,
      });

      // Give callee their token
      socket.emit('call:connected', {
        callId,
        roomId: credentials.roomId,
        token:  credentials.calleeToken,
        appId:  credentials.appId,
        type:   state.type,
      });

      // Transition to ACTIVE (both parties have credentials)
      await activateCall(callId);

      logger.info({ callId, calleeId: userId }, 'call:accept processed');
    } catch (err: any) {
      logger.warn({ err, callId, userId }, 'call:accept failed');
      socket.emit('call:error', { callId, message: err.message ?? 'Accept failed', code: 'ACCEPT_FAILED' });
    }
  });

  // ── call:reject ─────────────────────────────────────────────────────────────

  socket.on('call:reject', async (payload: CallRejectPayload) => {
    wsMessagesTotal.inc({ event: 'call:reject' });
    const { callId } = payload;

    try {
      const state = await getCallState(callId);
      if (!state || state.calleeId !== userId) return;

      await endCall(callId, userId, 'REJECTED');
      emitToUser(state.callerId, 'call:rejected', { callId });
      socket.emit('call:rejected', { callId });

      logger.info({ callId, calleeId: userId }, 'call:reject processed');
    } catch (err) {
      captureException(err as Error, { userId, callId });
    }
  });

  // ── call:cancel ─────────────────────────────────────────────────────────────

  socket.on('call:cancel', async (payload: { callId: string }) => {
    wsMessagesTotal.inc({ event: 'call:cancel' });
    const { callId } = payload;

    try {
      const state = await getCallState(callId);
      if (!state || state.callerId !== userId) return;

      await endCall(callId, userId, 'CANCELLED');
      emitToUser(state.calleeId, 'call:cancelled', { callId });
      socket.emit('call:cancelled', { callId });
    } catch (err) {
      captureException(err as Error, { userId, callId });
    }
  });

  // ── call:end ────────────────────────────────────────────────────────────────

  socket.on('call:end', async (payload: CallEndPayload) => {
    wsMessagesTotal.inc({ event: 'call:end' });
    const { callId } = payload;

    try {
      const { state, durationS } = await endCall(callId, userId, 'NORMAL');
      const otherId = state.callerId === userId ? state.calleeId : state.callerId;

      const endedPayload = { callId, durationS, endReason: 'NORMAL' as const };
      socket.emit('call:ended', endedPayload);
      emitToUser(otherId, 'call:ended', endedPayload);

      // Billing hook (fire-and-forget)
      if (durationS > 0) {
        enqueueCallBilling({
          callId,
          callerId:  state.callerId,
          type:      state.type,
          durationS,
        }).catch(() => {});
      }
    } catch (err) {
      captureException(err as Error, { userId, callId });
    }
  });

  // ── call:ice-candidate (relay) ───────────────────────────────────────────────
  // For custom WebRTC mode. Agora/LiveKit/Twilio handle ICE internally.

  socket.on('call:ice-candidate', (payload: { callId: string; candidate: unknown; targetId: string }) => {
    wsMessagesTotal.inc({ event: 'call:ice-candidate' });
    const { callId, candidate, targetId } = payload;

    if (!callId || !candidate || !targetId) return;

    emitToUser(targetId, 'call:ice-candidate', {
      callId,
      candidate,
      senderId: userId,
    });
  });

  // ── call:quality-report ──────────────────────────────────────────────────────

  socket.on('call:quality-report', async (report: QosReport) => {
    wsMessagesTotal.inc({ event: 'call:quality-report' });
    const { callId, packetLossPct, jitterMs, rttMs, bitrateKbps, resolution, frameRate, networkType } = report;

    if (!callId) return;

    // Prometheus metrics for ops dashboard
    if (packetLossPct != null) callQosPacketLoss.observe({ userId }, packetLossPct);
    if (jitterMs      != null) callQosJitter.observe({ userId }, jitterMs);
    if (rttMs         != null) callQosRtt.observe({ userId }, rttMs);

    // Persist to DB (async — never blocks socket)
    prisma.callQualityEvent.create({
      data: {
        callId,
        userId,
        packetLossPct: packetLossPct ?? null,
        jitterMs:      jitterMs      ?? null,
        rttMs:         rttMs         ?? null,
        bitrateKbps:   bitrateKbps   ?? null,
        resolution:    resolution    ?? null,
        frameRate:     frameRate     ?? null,
        networkType:   networkType   ?? null,
      },
    }).catch(() => {});

    // Alert the other party if quality is severely degraded
    if ((packetLossPct ?? 0) > 20 || (jitterMs ?? 0) > 150) {
      const state = await getCallState(callId).catch(() => null);
      if (state?.status === 'ACTIVE') {
        const otherId = state.callerId === userId ? state.calleeId : state.callerId;
        emitToUser(otherId, 'call:quality-alert', {
          callId,
          message: 'Poor connection quality detected',
        });
      }
    }
  });

  // ── call:keepalive ───────────────────────────────────────────────────────────
  // Prevents Redis TTL expiry for long calls (sent every 5 min by client)

  socket.on('call:keepalive', async (payload: { callId: string }) => {
    const { callId } = payload;
    if (!callId) return;

    const state = await getCallState(callId).catch(() => null);
    if (state?.status === 'ACTIVE') {
      // Re-save extends TTL
      try {
        const { callRedis } = await import('../services/calls/call.state');
        await callRedis.expire(`call:state:${callId}`, 15 * 60);
      } catch { /* non-critical */ }
    }
  });

  // ── disconnect: end any active call ─────────────────────────────────────────

  socket.on('disconnect', async () => {
    const activeCallId = await getUserActiveCallId(userId).catch(() => null);
    if (!activeCallId) return;

    const state = await getCallState(activeCallId).catch(() => null);
    if (!state || !['RINGING', 'CONNECTING', 'ACTIVE'].includes(state.status)) return;

    logger.info({ userId, callId: activeCallId }, 'socket disconnect — ending call');

    const { durationS } = await endCall(activeCallId, userId, 'FAILED').catch(() => ({ durationS: 0 }));
    const otherId = state.callerId === userId ? state.calleeId : state.callerId;

    emitToUser(otherId, 'call:ended', {
      callId:    activeCallId,
      durationS,
      endReason: 'FAILED',
    });

    if (durationS > 0) {
      enqueueCallBilling({
        callId:    activeCallId,
        callerId:  state.callerId,
        type:      state.type,
        durationS,
      }).catch(() => {});
    }
  });
}

// ── Ring timeout worker (started from server.ts) ──────────────────────────────

export { ringTimeoutQueue };

export async function startRingTimeoutWorker(): Promise<() => Promise<void>> {
  const { Worker } = await import('bullmq');

  const worker = new Worker<{ callId: string; callerId: string; calleeId: string }>(
    'call-ring-timeout',
    async (job) => {
      const { callId, callerId, calleeId } = job.data;
      const missed = await handleRingTimeout(callId);

      if (missed) {
        emitToUser(callerId, 'call:ended', { callId, durationS: 0, endReason: 'MISSED' });
        emitToUser(calleeId, 'call:missed', { callId, callerId });
        logger.info({ callId }, 'ring timeout — call marked MISSED');
      }
    },
    { connection: redisConnection, concurrency: 20 },
  );

  return () => worker.close();
}
