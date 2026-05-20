// ── Agora RTC Provider ────────────────────────────────────────────────────────
//
// Requires: AGORA_APP_ID, AGORA_APP_CERTIFICATE
// Optional dep: agora-access-token2 — install with: npm i agora-access-token2
//
// Architecture:
//   - Channel name = callId (unique per call)
//   - Token role: publisher (can send+receive audio/video)
//   - Token TTL: 1 hour (call sessions are expected to be shorter)
//   - AppID is sent to clients so they can initialize the SDK
//
// Agora doesn't have a server-side "end room" concept — the room closes
// automatically when all participants leave. We call kick all users if we
// need force-end (requires Agora RESTful API).

import { registerCallProvider } from './call.provider.registry';
import type { CallProvider, CreateRoomParams, RoomCredentials, RoomStats } from '../call.types';
import { logger } from '../../../observability/logger';

const agoraProvider: CallProvider = {
  name: 'agora',

  async createRoom(params: CreateRoomParams): Promise<RoomCredentials> {
    const appId  = process.env.AGORA_APP_ID;
    const cert   = process.env.AGORA_APP_CERTIFICATE;

    if (!appId || !cert) {
      logger.warn('AGORA_APP_ID / AGORA_APP_CERTIFICATE not set — falling back to stub tokens');
      return {
        roomId:      params.callId,
        appId,
        callerToken: `agora-stub-caller-${params.callId}`,
        calleeToken: `agora-stub-callee-${params.callId}`,
      };
    }

    try {
      // @ts-expect-error optional peer dependency
      const { RtcTokenBuilder, RtcRole } = await import('agora-access-token2');
      const TTL     = 3600;
      const now     = Math.floor(Date.now() / 1000);
      const channel = params.callId;

      const callerToken = RtcTokenBuilder.buildTokenWithUid(
        appId, cert, channel, 0, RtcRole.PUBLISHER, now + TTL, now + TTL,
      );
      const calleeToken = RtcTokenBuilder.buildTokenWithUid(
        appId, cert, channel, 0, RtcRole.PUBLISHER, now + TTL, now + TTL,
      );

      return { roomId: channel, appId, callerToken, calleeToken };
    } catch (err) {
      logger.error({ err }, 'Agora token generation failed');
      throw new Error('Call provider error');
    }
  },

  async endRoom(roomId: string): Promise<void> {
    // Agora auto-closes rooms. For forced eviction use Agora RESTful Kick API.
    // https://docs.agora.io/en/video-calling/reference/agora-console-rest-api
    logger.debug({ roomId }, 'agora: room end requested (auto-close on participant exit)');
  },

  async getRoomStats(_roomId: string): Promise<RoomStats | null> {
    // Agora provides call quality stats via their Insight API (async report)
    return null;
  },
};

registerCallProvider('agora', () => agoraProvider);
export default agoraProvider;
