import { createHmac, timingSafeEqual } from 'crypto';
import { env } from '../config/env';

const SECRET = env.ENCRYPTION_KEY; // dedicated secret from validated env
const DEFAULT_TTL_SECONDS = 60 * 60; // 1 hour

export const signUrl = (urlPath: string, ttlSeconds = DEFAULT_TTL_SECONDS): string => {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const payload = `${urlPath}:${exp}`;
  const sig = createHmac('sha256', SECRET).update(payload).digest('hex'); // full 64 hex chars
  return `${urlPath}?sig=${sig}&exp=${exp}`;
};

export const verifySignedUrl = (urlPath: string, sig: string, exp: string): boolean => {
  const expNum = parseInt(exp, 10);
  if (isNaN(expNum) || expNum < Math.floor(Date.now() / 1000)) return false;
  const payload = `${urlPath}:${expNum}`;
  const expected = createHmac('sha256', SECRET).update(payload).digest('hex');
  try {
    return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(sig, 'hex'));
  } catch {
    return false; // sig is wrong length / not valid hex
  }
};
