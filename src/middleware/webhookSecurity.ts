import { Request, Response, NextFunction } from 'express';
import IORedis from 'ioredis';

// ── Timestamp verification (replay attack protection) ─────────────────────────

export function verifyTimestamp(tolerance: number) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const rawTs = req.headers['x-webhook-timestamp'] as string | undefined;
    if (!rawTs) {
      res.status(400).json({ success: false, message: 'Missing webhook timestamp' });
      return;
    }

    const ts = parseInt(rawTs, 10);
    if (isNaN(ts)) {
      res.status(400).json({ success: false, message: 'Invalid webhook timestamp' });
      return;
    }

    const ageSeconds = Math.abs(Math.floor(Date.now() / 1000) - ts);
    if (ageSeconds > tolerance) {
      res.status(400).json({ success: false, message: 'Webhook timestamp too old (replay rejected)' });
      return;
    }

    next();
  };
}

// ── Webhook idempotency ───────────────────────────────────────────────────────

export async function enforceWebhookIdempotency(
  redis: IORedis,
  eventId: string,
  ttlSecs = 86400,
): Promise<boolean> {
  const key = `webhook:seen:${eventId}`;
  const set = await redis.set(key, '1', 'EX', ttlSecs, 'NX').catch(() => null);
  return set === null; // null = key already existed = already processed
}

export function webhookIdempotencyMiddleware(redis: IORedis, ttlSecs = 86400) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const eventId =
      (req.headers['x-event-id'] as string) ||
      (req.headers['idempotency-key'] as string);

    if (!eventId) { next(); return; }

    const alreadyProcessed = await enforceWebhookIdempotency(redis, eventId, ttlSecs);
    if (alreadyProcessed) {
      res.status(200).json({ success: true, message: 'Already processed' });
      return;
    }

    next();
  };
}
