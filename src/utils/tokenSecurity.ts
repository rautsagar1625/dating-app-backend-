import crypto from 'crypto';
import IORedis from 'ioredis';

// ── Secure token generation ───────────────────────────────────────────────────

export function generateSecureToken(length = 32): string {
  return crypto.randomBytes(length).toString('base64url');
}

// ── Token hashing (store hash, not raw token) ─────────────────────────────────

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// ── Refresh token family (theft detection) ────────────────────────────────────
// A "family" is a UUID assigned at login. All refresh tokens issued from the
// same session share the same family ID. When a token is reused after rotation
// (stolen), the family is immediately invalidated.

export function createRefreshTokenFamily(): string {
  return crypto.randomUUID();
}

export async function detectTokenReuse(
  familyId: string,
  redis: IORedis,
): Promise<boolean> {
  const key = `rtoken:family:invalid:${familyId}`;
  const invalidated = await redis.exists(key).catch(() => 0);
  return invalidated === 1;
}

export async function invalidateTokenFamily(
  familyId: string,
  redis: IORedis,
  ttlSecs = 30 * 24 * 3600,
): Promise<void> {
  const key = `rtoken:family:invalid:${familyId}`;
  await redis.setex(key, ttlSecs, '1').catch(() => {});
}

// ── Refresh token rotation ────────────────────────────────────────────────────

export async function rotateRefreshToken(params: {
  oldTokenHash: string;
  familyId:     string;
  userId:       string;
  redis:        IORedis;
}): Promise<{ newToken: string; newTokenHash: string; familyId: string; stolen: boolean }> {
  const { oldTokenHash, familyId, userId, redis } = params;

  // Check if family was already invalidated (indicates theft)
  const stolen = await detectTokenReuse(familyId, redis);
  if (stolen) {
    // Family compromised — invalidate all sessions for this user
    await invalidateAllUserSessions(userId, redis);
    return { newToken: '', newTokenHash: '', familyId, stolen: true };
  }

  // Mark old token as used
  await redis.setex(`rtoken:used:${oldTokenHash}`, 30 * 24 * 3600, '1').catch(() => {});

  const newToken     = generateSecureToken(48);
  const newTokenHash = hashToken(newToken);

  return { newToken, newTokenHash, familyId, stolen: false };
}

// ── Session invalidation ──────────────────────────────────────────────────────

export async function invalidateAllUserSessions(
  userId: string,
  redis: IORedis,
): Promise<void> {
  // Bump the user's session version — all existing JWTs become invalid on next check
  await redis.incr(`session:version:${userId}`).catch(() => {});
  await redis.expire(`session:version:${userId}`, 30 * 24 * 3600).catch(() => {});
}

export async function getUserSessionVersion(
  userId: string,
  redis: IORedis,
): Promise<number> {
  const v = await redis.get(`session:version:${userId}`).catch(() => null);
  return v ? parseInt(v, 10) : 0;
}
