import { Request, Response, NextFunction } from 'express';
import { verifyToken } from '../utils/jwt.util';
import prisma from '../services/prisma.service';
import IORedis from 'ioredis';
import { env } from '../config/env';

// ── Dedicated Redis client for auth ban cache ─────────────────────────────────
// Separate from BullMQ/entitlement clients to avoid queue interference.
// Uses lazy connect so it doesn't block startup if Redis is briefly unavailable.
const authRedis = new IORedis(env.REDIS_URL, {
  maxRetriesPerRequest: 1,
  lazyConnect: true,
  enableReadyCheck: false,
  keyPrefix: `${env.REDIS_KEY_PREFIX}auth:`,
});
authRedis.connect().catch(() => {});

// Ban status TTL: 30 seconds.
// Short enough to react to bans quickly, long enough to protect the DB at scale.
// At 1,000 concurrent users each making 10 req/min: this reduces ban-check DB
// queries from 10,000/min → ~2,000/min (cache miss only on first request per window).
const BAN_CACHE_TTL_SECS = 30;

export const requireAuth = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({ success: false, message: 'Unauthorized: No token provided' });
      return;
    }

    const token = authHeader.split(' ')[1];
    const decoded = verifyToken(token);
    const { userId } = decoded;

    // ── Redis fast path ───────────────────────────────────────────────────────
    // '0' = clean (not banned), '1' = banned. null = not cached (DB fallback needed).
    let isBanned: boolean | null = null;
    try {
      const cached = await authRedis.get(`ban:${userId}`);
      if (cached !== null) {
        if (cached === '1') {
          res.status(403).json({ success: false, message: 'Account suspended' });
          return;
        }
        // cached === '0' → not banned, skip DB entirely
        isBanned = false;
      }
    } catch {
      // Redis unavailable — fall through to DB. Never block a request on cache failure.
    }

    // ── DB fallback (only on cache miss) ─────────────────────────────────────
    if (isBanned === null) {
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { isBanned: true },
      });

      if (!user) {
        res.status(401).json({ success: false, message: 'Unauthorized' });
        return;
      }

      isBanned = user.isBanned;

      // Write result to Redis (fire-and-forget — never block the request)
      authRedis
        .setex(`ban:${userId}`, BAN_CACHE_TTL_SECS, isBanned ? '1' : '0')
        .catch(() => {});
    }

    if (isBanned) {
      res.status(403).json({ success: false, message: 'Account suspended' });
      return;
    }

    req.user = { userId };
    next();
  } catch {
    res.status(401).json({ success: false, message: 'Unauthorized: Invalid token' });
  }
};

/**
 * Call this when an admin bans a user to immediately invalidate their cached
 * ban status. Without this, a newly banned user could continue making requests
 * for up to BAN_CACHE_TTL_SECS seconds before the cache expires.
 */
export async function invalidateBanCache(userId: string): Promise<void> {
  await authRedis.del(`ban:${userId}`).catch(() => {});
}
