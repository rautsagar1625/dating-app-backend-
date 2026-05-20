import { Server as SocketIOServer } from 'socket.io';

let io: SocketIOServer | null = null;

// Track which userIds have at least one connected socket.
// Used for instant delivery receipts: if recipient is online when a message
// arrives, we mark it DELIVERED immediately instead of waiting for next login.
const onlineUsers = new Set<string>();

export const initSocket = (ioInstance: SocketIOServer): void => {
  io = ioInstance;
};

export const emitToUser = (userId: string, event: string, data: unknown): void => {
  io?.to(`user:${userId}`).emit(event, data);
};

export const markUserOnline = (userId: string): void => {
  onlineUsers.add(userId);
};

export const markUserOffline = (userId: string): void => {
  onlineUsers.delete(userId);
};

export const isUserOnlineSocket = (userId: string): boolean => {
  return onlineUsers.has(userId);
};

export const broadcastToAll = (event: string, data: unknown): void => {
  io?.emit(event, data);
};
