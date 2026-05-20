// ── Stub Call Provider ────────────────────────────────────────────────────────
// Dev/test provider. Returns mock tokens with no external calls.
// Set CALL_PROVIDER=stub (default when no real provider is configured).

import { registerCallProvider } from './call.provider.registry';
import type { CallProvider, CreateRoomParams, RoomCredentials, RoomStats } from '../call.types';

const stubProvider: CallProvider = {
  name: 'stub',

  async createRoom(params: CreateRoomParams): Promise<RoomCredentials> {
    const roomId = `stub-room-${params.callId}`;
    return {
      roomId,
      callerToken: `stub-caller-token-${params.callId}`,
      calleeToken: `stub-callee-token-${params.callId}`,
    };
  },

  async endRoom(_roomId: string): Promise<void> {
    // no-op
  },

  async getRoomStats(_roomId: string): Promise<RoomStats | null> {
    return { activeUsers: 2, durationS: 0 };
  },
};

registerCallProvider('stub', () => stubProvider);
export default stubProvider;
