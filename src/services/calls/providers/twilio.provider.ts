// ── Twilio Video Provider ─────────────────────────────────────────────────────
//
// Requires: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_API_KEY, TWILIO_API_SECRET
// Optional dep: twilio — install with: npm i twilio
//
// Twilio Video uses "Rooms" (server-side created) with AccessTokens for auth.
// Room type: peer-to-peer (2 participants) → go2p for audio calls.
// Room type: group → for future group calls.
//
// Architecture:
//   - Room name = callId (unique constraint enforced by Twilio)
//   - Each participant generates their own AccessToken with VideoGrant
//   - endRoom: complete the room via REST API
//   - Webhook: Twilio sends room status events to /api/calls/twilio/webhook

import { registerCallProvider } from './call.provider.registry';
import type { CallProvider, CreateRoomParams, RoomCredentials, RoomStats } from '../call.types';
import { logger } from '../../../observability/logger';

const twilioProvider: CallProvider = {
  name: 'twilio',

  async createRoom(params: CreateRoomParams): Promise<RoomCredentials> {
    const sid     = process.env.TWILIO_ACCOUNT_SID;
    const auth    = process.env.TWILIO_AUTH_TOKEN;
    const apiKey  = process.env.TWILIO_API_KEY;
    const apiSec  = process.env.TWILIO_API_SECRET;

    if (!sid || !auth || !apiKey || !apiSec) {
      logger.warn('TWILIO_* env vars not set — falling back to stub tokens');
      return {
        roomId:      params.callId,
        callerToken: `tw-stub-caller-${params.callId}`,
        calleeToken: `tw-stub-callee-${params.callId}`,
      };
    }

    try {
      // @ts-expect-error optional peer dependency
      const twilio = await import('twilio');
      const client = (twilio.default ?? twilio)(sid, auth);
      const { AccessToken } = twilio.default ?? twilio;
      const VideoGrant = AccessToken?.VideoGrant;

      // Create room
      const room = await client.video.v1.rooms.create({
        uniqueName: params.callId,
        type:       params.maxParticipants <= 2 ? 'go' : 'group',
      });

      const makeToken = (identity: string) => {
        const at = new AccessToken(sid, apiKey, apiSec, {
          identity,
          ttl: 3600,
        });
        const grant = new VideoGrant({ room: params.callId });
        at.addGrant(grant);
        return at.toJwt();
      };

      return {
        roomId:      room.sid,
        callerToken: makeToken(`caller-${params.callId}`),
        calleeToken: makeToken(`callee-${params.callId}`),
      };
    } catch (err) {
      logger.error({ err }, 'Twilio room creation failed');
      throw new Error('Call provider error');
    }
  },

  async endRoom(roomId: string): Promise<void> {
    const sid  = process.env.TWILIO_ACCOUNT_SID;
    const auth = process.env.TWILIO_AUTH_TOKEN;
    if (!sid || !auth) return;

    try {
      // @ts-expect-error optional peer dependency
      const twilio = await import('twilio');
      const client = (twilio.default ?? twilio)(sid, auth);
      await client.video.v1.rooms(roomId).update({ status: 'completed' });
    } catch (err) {
      logger.warn({ err, roomId }, 'Twilio endRoom failed');
    }
  },

  async getRoomStats(roomId: string): Promise<RoomStats | null> {
    const sid  = process.env.TWILIO_ACCOUNT_SID;
    const auth = process.env.TWILIO_AUTH_TOKEN;
    if (!sid || !auth) return null;

    try {
      // @ts-expect-error optional peer dependency
      const twilio = await import('twilio');
      const client = (twilio.default ?? twilio)(sid, auth);
      const room   = await client.video.v1.rooms(roomId).fetch();
      return {
        activeUsers: room.maxParticipants ?? 0,
        durationS:   0,
      };
    } catch {
      return null;
    }
  },
};

registerCallProvider('twilio', () => twilioProvider);
export default twilioProvider;
