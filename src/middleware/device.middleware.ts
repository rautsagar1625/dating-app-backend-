import { Request, Response, NextFunction } from 'express';
import { hashDeviceId, hashIp, DeviceContext, ClientFingerprint } from '../services/fraud/fraud.types';

// Augment Express Request with device context
declare global {
  namespace Express {
    interface Request {
      device: DeviceContext;
    }
  }
}

// Extract forwarded IP — trusts X-Forwarded-For only if behind a known proxy tier.
// In production, set TRUST_PROXY=true and configure express app.set('trust proxy', n).
function extractIp(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded && process.env.TRUST_PROXY === 'true') {
    const ips = (Array.isArray(forwarded) ? forwarded[0] : forwarded).split(',');
    return ips[0].trim();
  }
  return req.socket.remoteAddress ?? '0.0.0.0';
}

export const deviceMiddleware = (req: Request, _res: Response, next: NextFunction): void => {
  const rawIp = extractIp(req);
  const rawDeviceId = req.headers['x-device-id'] as string | undefined;

  const fingerprint: ClientFingerprint | null =
    req.body?.deviceFingerprint ?? null;

  req.device = {
    deviceId: rawDeviceId ?? null,
    deviceIdHash: rawDeviceId ? hashDeviceId(rawDeviceId) : null,
    ipHash: hashIp(rawIp),
    rawIp,
    fingerprint,
  };

  next();
};
