import prisma from '../prisma.service';
import { flagsRedis } from '../flags/flag.cache';
import { logger } from '../../observability/logger';
import { captureMessage } from '../../observability/sentry';
import { EnforcementType } from './fraud.types';
import { recordRiskEvent } from '../risk.service';

// Cache TTLs (enforcement decisions cached in Redis to avoid DB round-trips on every request)
const ENFORCEMENT_CACHE_TTL = 60; // seconds
const ENFORCEMENT_PREFIX = 'velvet:enforcement';

// ── Cache helpers ─────────────────────────────────────────────────────────────

function userKey(userId: string, type: EnforcementType) {
  return `${ENFORCEMENT_PREFIX}:user:${userId}:${type}`;
}

function deviceKey(deviceFpId: string, type: EnforcementType) {
  return `${ENFORCEMENT_PREFIX}:device:${deviceFpId}:${type}`;
}

// ── Apply enforcement ─────────────────────────────────────────────────────────

export async function applyEnforcement(
  userId: string | null,
  deviceFpId: string | null,
  actionType: EnforcementType,
  reason: string,
  ttlSeconds?: number,    // undefined = permanent
  actorId?: string,       // undefined = automated
  metadata: Record<string, unknown> = {},
): Promise<void> {
  const expiresAt = ttlSeconds ? new Date(Date.now() + ttlSeconds * 1000) : null;

  await prisma.fraudEnforcementAction.create({
    data: {
      userId,
      deviceFpId,
      actionType,
      reason,
      expiresAt,
      actorId,
      metadata: metadata as object,
    },
  });

  // Populate Redis cache immediately so middleware picks it up without a DB read
  const ttl = ttlSeconds ?? ENFORCEMENT_CACHE_TTL * 100; // long TTL for permanent bans
  if (userId) {
    await flagsRedis.setex(userKey(userId, actionType), Math.min(ttl, 86400 * 30), '1').catch(() => {});
  }
  if (deviceFpId) {
    await flagsRedis.setex(deviceKey(deviceFpId, actionType), Math.min(ttl, 86400 * 30), '1').catch(() => {});
  }

  // Align with existing UserRiskProfile for SOFT_BAN
  if (userId && (actionType === 'SOFT_BAN' || actionType === 'HARD_BAN')) {
    await recordRiskEvent(userId, 'reported', reason).catch(() => {});
    await prisma.userRiskProfile.upsert({
      where: { userId },
      create: { userId, riskScore: 75, isSoftBanned: true, softBanReason: reason, softBannedAt: new Date() },
      update: { isSoftBanned: true, softBanReason: reason, softBannedAt: new Date() },
    }).catch(() => {});
  }

  logger.warn({ userId, deviceFpId, actionType, reason, expiresAt, actorId }, 'enforcement applied');
  captureMessage(`Enforcement: ${actionType}`, 'warning', { userId, deviceFpId, reason });
}

// ── Check enforcement (fast path: Redis first) ─────────────────────────────────

export async function isEnforced(
  userId: string,
  actionType: EnforcementType,
): Promise<boolean> {
  // L1: Redis cache
  try {
    const cached = await flagsRedis.get(userKey(userId, actionType));
    if (cached !== null) return true;
  } catch { /* Redis down — fall through to DB */ }

  // L2: Database (also handles expired cache)
  const active = await prisma.fraudEnforcementAction.findFirst({
    where: {
      userId,
      actionType,
      isActive: true,
      OR: [
        { expiresAt: null },
        { expiresAt: { gt: new Date() } },
      ],
    },
    select: { id: true, expiresAt: true },
  });

  if (!active) return false;

  // Re-populate cache
  const ttl = active.expiresAt
    ? Math.max(1, Math.floor((active.expiresAt.getTime() - Date.now()) / 1000))
    : ENFORCEMENT_CACHE_TTL * 100;
  await flagsRedis.setex(userKey(userId, actionType), Math.min(ttl, 86400 * 30), '1').catch(() => {});
  return true;
}

export async function isShadowRestricted(userId: string): Promise<boolean> {
  return isEnforced(userId, 'SHADOW_RESTRICT');
}

export async function isHardBanned(userId: string): Promise<boolean> {
  return isEnforced(userId, 'HARD_BAN');
}

// ── Revoke enforcement (admin action) ─────────────────────────────────────────

export async function revokeEnforcement(
  actionId: string,
  revokedBy: string,
): Promise<void> {
  const action = await prisma.fraudEnforcementAction.findUnique({ where: { id: actionId } });
  if (!action) throw Object.assign(new Error('Action not found'), { statusCode: 404 });

  await prisma.fraudEnforcementAction.update({
    where: { id: actionId },
    data: { isActive: false, revokedAt: new Date(), revokedBy },
  });

  // Expire Redis cache immediately
  if (action.userId) {
    await flagsRedis.del(userKey(action.userId, action.actionType as EnforcementType)).catch(() => {});
  }
  if (action.deviceFpId) {
    await flagsRedis.del(deviceKey(action.deviceFpId, action.actionType as EnforcementType)).catch(() => {});
  }

  // If un-soft-banning, also clear the UserRiskProfile soft ban
  if (action.userId && (action.actionType === 'SOFT_BAN' || action.actionType === 'HARD_BAN')) {
    await prisma.userRiskProfile.update({
      where: { userId: action.userId },
      data: { isSoftBanned: false, softBanReason: null },
    }).catch(() => {});
  }

  logger.info({ actionId, revokedBy }, 'enforcement revoked');
}

// ── Automated enforcement pipeline ───────────────────────────────────────────

export async function applyAutomatedEnforcement(
  userId: string,
  deviceFpId: string,
  riskScore: number,
  signals: string[],
): Promise<void> {
  if (riskScore >= 90) {
    await applyEnforcement(userId, deviceFpId, 'HARD_BAN', `Auto: score ${riskScore} [${signals.join(', ')}]`);
    await createFraudCase(userId, deviceFpId, riskScore, signals, 'CRITICAL');
    return;
  }

  if (riskScore >= 75) {
    // Don't hard-ban automatically — create a high-priority case and soft-ban
    const alreadySoftBanned = await isEnforced(userId, 'SOFT_BAN');
    if (!alreadySoftBanned) {
      await applyEnforcement(userId, deviceFpId, 'SOFT_BAN', `Auto: score ${riskScore}`, undefined);
    }
    await createFraudCase(userId, deviceFpId, riskScore, signals, 'HIGH');
    return;
  }

  if (riskScore >= 60) {
    const alreadyRestricted = await isEnforced(userId, 'SHADOW_RESTRICT');
    if (!alreadyRestricted) {
      await applyEnforcement(userId, deviceFpId, 'SHADOW_RESTRICT', `Auto: score ${riskScore}`, 7 * 86400);
    }
    await createFraudCase(userId, deviceFpId, riskScore, signals, 'NORMAL');
    return;
  }

  if (riskScore >= 40) {
    // Cooldown: rate-limited to 1 action/5s for 24h
    await applyEnforcement(userId, null, 'COOLDOWN', `Auto: score ${riskScore}`, 86400);
  }
}

// ── Fraud case creation ───────────────────────────────────────────────────────

async function createFraudCase(
  userId: string,
  deviceFpId: string,
  riskScore: number,
  signals: string[],
  priority: string,
): Promise<void> {
  // Avoid duplicate open cases for the same user
  const existingOpenCase = await prisma.fraudCase.findFirst({
    where: { userId, status: 'PENDING' },
    select: { id: true },
  });
  if (existingOpenCase) return;

  await prisma.fraudCase.create({
    data: {
      userId,
      deviceFpId,
      riskScore,
      priority,
      signals: signals as unknown as object,
    },
  });
}

// ── Expire stale enforcement actions (run as cron) ────────────────────────────

export async function expireStaleEnforcements(): Promise<void> {
  const expired = await prisma.fraudEnforcementAction.updateMany({
    where: { isActive: true, expiresAt: { lte: new Date() } },
    data: { isActive: false },
  });
  if (expired.count > 0) {
    logger.info({ count: expired.count }, 'expired stale enforcement actions');
  }
}
