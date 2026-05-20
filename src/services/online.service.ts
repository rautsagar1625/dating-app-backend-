import prisma from './prisma.service';

export const ONLINE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

export const isOnline = (lastSeen: Date | null | undefined): boolean => {
  if (!lastSeen) return false;
  return Date.now() - new Date(lastSeen).getTime() < ONLINE_THRESHOLD_MS;
};

// In-memory debounce: only write lastSeen to DB at most once per 60s per user.
// Prevents a DB write storm when the frontend pings every 30s for many concurrent users.
const lastWrittenAt = new Map<string, number>();
const WRITE_INTERVAL_MS = 60_000;

export const touchLastSeen = async (userId: string): Promise<Date> => {
  const now = new Date();
  const last = lastWrittenAt.get(userId) ?? 0;

  if (Date.now() - last >= WRITE_INTERVAL_MS) {
    lastWrittenAt.set(userId, Date.now());
    await prisma.user.update({ where: { id: userId }, data: { lastSeen: now } });
  }

  return now;
};
