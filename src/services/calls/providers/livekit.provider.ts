// ── LiveKit Provider ──────────────────────────────────────────────────────────
//
// Requires: LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET
// Optional dep: livekit-server-sdk — install with: npm i livekit-server-sdk
//
// LiveKit is a self-hostable WebRTC SFU. Rooms are created server-side.
// Tokens are JWT-based with explicit room and identity claims.
// Supports: audio, video, screen share, simulcast, E2EE.
//
// Architecture:
//   - Room name = callId
//   - Participant identity = userId
//   - CALLER gets CanPublish + CanSubscribe
//   - CALLEE gets CanPublish + CanSubscribe
//   - Room deleted on endRoom (LiveKit REST API)

import { registerCallProvider } from './call.provider.registry';
import type { CallProvider, CreateRoomParams, RoomCredentials, RoomStats } from '../call.types';
import { logger } from '../../../observability/logger';

const livekitProvider: CallProvider = {
  name: 'livekit',

  async createRoom(params: CreateRoomParams): Promise<RoomCredentials> {
    const url    = process.env.LIVEKIT_URL;
    const apiKey = process.env.LIVEKIT_API_KEY;
    const secret = process.env.LIVEKIT_API_SECRET;

    if (!url || !apiKey || !secret) {
      logger.warn('LIVEKIT_* env vars not set — falling back to stub tokens');
      return {
        roomId:      params.callId,
        callerToken: `lk-stub-caller-${params.callId}`,
        calleeToken: `lk-stub-callee-${params.callId}`,
      };
    }

    try {
      // @ts-expect-error optional peer dependency
      const livekit = await import('livekit-server-sdk');
      const RoomServiceClient = livekit.RoomServiceClient ?? livekit.default?.RoomServiceClient;
      const AccessToken        = livekit.AccessToken       ?? livekit.default?.AccessToken;
      const VideoGrant         = livekit.VideoGrant        ?? livekit.default?.VideoGrant;

      // Create the room
      const roomSvc = new RoomServiceClient(url, apiKey, secret);
      await roomSvc.createRoom({
        name:            params.callId,
        maxParticipants: params.maxParticipants,
        emptyTimeout:    120,  // delete after 2min empty
      });

      const makeToken = (identity: string) => {
        const at = new AccessToken(apiKey, secret, { identity, ttl: 3600 });
        at.addGrant(new VideoGrant({
          roomJoin:        true,
          room:            params.callId,
          canPublish:      true,
          canSubscribe:    true,
          canPublishData:  true,
        }));
        return at.toJwt();
      };

      return {
        roomId:      params.callId,
        callerToken: makeToken(`caller-${params.callId}`),
        calleeToken: makeToken(`callee-${params.callId}`),
      };
    } catch (err) {
      logger.error({ err }, 'LiveKit room creation failed');
      throw new Error('Call provider error');
    }
  },

  async endRoom(roomId: string): Promise<void> {
    const url    = process.env.LIVEKIT_URL;
    const apiKey = process.env.LIVEKIT_API_KEY;
    const secret = process.env.LIVEKIT_API_SECRET;
    if (!url || !apiKey || !secret) return;

    try {
      // @ts-expect-error optional peer dependency
      const { RoomServiceClient } = await import('livekit-server-sdk');
      const svc = new RoomServiceClient(url, apiKey, secret);
      await svc.deleteRoom(roomId);
    } catch (err) {
      logger.warn({ err, roomId }, 'LiveKit endRoom failed');
    }
  },

  async getRoomStats(roomId: string): Promise<RoomStats | null> {
    const url    = process.env.LIVEKIT_URL;
    const apiKey = process.env.LIVEKIT_API_KEY;
    const secret = process.env.LIVEKIT_API_SECRET;
    if (!url || !apiKey || !secret) return null;

    try {
      // @ts-expect-error optional peer dependency
      const { RoomServiceClient } = await import('livekit-server-sdk');
      const svc  = new RoomServiceClient(url, apiKey, secret);
      const room = await svc.getRoom(roomId);
      return {
        activeUsers: room.numParticipants ?? 0,
        durationS:   0,
      };
    } catch {
      return null;
    }
  },
};

registerCallProvider('livekit', () => livekitProvider);
export default livekitProvider;
