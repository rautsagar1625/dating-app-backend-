import prisma from '../prisma.service';
import { getCachedFlags, setCachedFlags, invalidateFlagsCache } from './flag.cache';
import { broadcastToAll } from '../socket.service';
import type { EvalContext, EvalResult, FlagConfig, FeatureFlagKey } from './flag.types';
import { logger } from '../../observability/logger';

// ── Evaluation engine ─────────────────────────────────────────────────────────

// FNV-1a 32-bit hash — deterministic, no external dependency.
// Maps (flagKey, userId) → bucket 0-99. Same user always lands in the same
// bucket for a given flag, giving stable rollout membership (no flickering).
function hashUserBucket(flagKey: string, userId: string): number {
  const input = `${flagKey}:${userId}`;
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash % 100;
}

export function evaluateFlag(flag: FlagConfig, ctx: EvalContext): EvalResult {
  const { userId, platform, region } = ctx;

  // 1. Master kill switch
  if (!flag.enabled) return { enabled: false, reason: 'disabled' };

  // 2. Expiry check
  if (flag.expiresAt && new Date() > new Date(flag.expiresAt)) {
    return { enabled: false, reason: 'expired' };
  }

  // 3. Platform filter — empty array means "all platforms"
  if (flag.platforms.length > 0 && platform && !flag.platforms.includes(platform)) {
    return { enabled: false, reason: 'platform_mismatch' };
  }

  // 4. Region filter — empty array means "all regions"
  if (flag.regions.length > 0 && region && !flag.regions.includes(region)) {
    return { enabled: false, reason: 'region_mismatch' };
  }

  // 5. Explicit block list — always wins over allowlist
  if (flag.blockedUserIds.includes(userId)) {
    return { enabled: false, reason: 'blocked_user' };
  }

  // 6. Explicit allow list — bypasses rollout percentage
  if (flag.targetUserIds.includes(userId)) {
    return { enabled: true, reason: 'target_user' };
  }

  // 7. Per-user override (set via admin API)
  const override = flag.overrides.find((o) => o.userId === userId);
  if (override !== undefined) return { enabled: override.enabled, reason: 'override' };

  // 8. Percentage rollout — deterministic hash
  if (flag.rolloutPercentage >= 100) return { enabled: true, reason: 'fully_enabled' };
  if (flag.rolloutPercentage <= 0) return { enabled: false, reason: 'rollout_excluded' };

  const bucket = hashUserBucket(flag.key, userId);
  return bucket < flag.rolloutPercentage
    ? { enabled: true, reason: 'rollout_included' }
    : { enabled: false, reason: 'rollout_excluded' };
}

// ── Data loading ──────────────────────────────────────────────────────────────

async function loadAllFlags(): Promise<FlagConfig[]> {
  const cached = await getCachedFlags();
  if (cached) return cached;

  const rows = await prisma.featureFlag.findMany({
    include: { overrides: { select: { userId: true, enabled: true } } },
  });

  const configs: FlagConfig[] = rows.map((f) => ({
    id: f.id,
    key: f.key,
    description: f.description,
    enabled: f.enabled,
    rolloutPercentage: f.rolloutPercentage,
    targetUserIds: f.targetUserIds,
    blockedUserIds: f.blockedUserIds,
    platforms: f.platforms,
    regions: f.regions,
    metadata: (f.metadata ?? {}) as Record<string, unknown>,
    expiresAt: f.expiresAt,
    overrides: f.overrides,
  }));

  await setCachedFlags(configs);
  return configs;
}

// ── Public evaluation API ─────────────────────────────────────────────────────

// Evaluate a single flag. Returns false on any error (safe fallback).
export async function isEnabled(flagKey: FeatureFlagKey, ctx: EvalContext): Promise<boolean> {
  try {
    const flags = await loadAllFlags();
    const flag = flags.find((f) => f.key === flagKey);
    if (!flag) return false;
    return evaluateFlag(flag, ctx).enabled;
  } catch (err) {
    logger.warn({ flagKey, err }, 'flag evaluation failed — defaulting to false');
    return false;
  }
}

// Evaluate ALL flags in one pass. Use this at login/app-launch so the client
// can cache the full map and never round-trip per feature.
export async function evaluateAll(ctx: EvalContext): Promise<Record<string, boolean>> {
  try {
    const flags = await loadAllFlags();
    const result: Record<string, boolean> = {};
    for (const flag of flags) {
      result[flag.key] = evaluateFlag(flag, ctx).enabled;
    }
    return result;
  } catch (err) {
    logger.warn({ err }, 'evaluateAll failed — returning empty map');
    return {};
  }
}

// ── Admin mutations ───────────────────────────────────────────────────────────

async function audit(
  flagId: string,
  action: string,
  actorId: string | undefined,
  before?: object,
  after?: object,
) {
  await prisma.featureFlagAuditLog.create({
    data: {
      flagId,
      actorId,
      action,
      ...(before ? { before: before as object } : {}),
      ...(after ? { after: after as object } : {}),
    },
  });
}

async function pushFlagsUpdated() {
  await invalidateFlagsCache();
  broadcastToAll('flags_updated', { timestamp: new Date().toISOString() });
}

export async function createFlag(
  data: {
    key: string;
    description?: string;
    enabled?: boolean;
    rolloutPercentage?: number;
    targetUserIds?: string[];
    blockedUserIds?: string[];
    platforms?: string[];
    regions?: string[];
    metadata?: Record<string, unknown>;
    expiresAt?: Date;
  },
  actorId?: string,
) {
  const flag = await prisma.featureFlag.create({
    data: {
      key: data.key,
      description: data.description ?? '',
      enabled: data.enabled ?? false,
      rolloutPercentage: data.rolloutPercentage ?? 0,
      targetUserIds: data.targetUserIds ?? [],
      blockedUserIds: data.blockedUserIds ?? [],
      platforms: data.platforms ?? [],
      regions: data.regions ?? [],
      metadata: (data.metadata ?? {}) as object,
      expiresAt: data.expiresAt,
    },
  });

  await audit(flag.id, 'CREATED', actorId, undefined, flag as object);
  await pushFlagsUpdated();
  return flag;
}

export async function updateFlag(
  key: string,
  updates: Partial<{
    description: string;
    enabled: boolean;
    rolloutPercentage: number;
    targetUserIds: string[];
    blockedUserIds: string[];
    platforms: string[];
    regions: string[];
    metadata: Record<string, unknown>;
    expiresAt: Date | null;
  }>,
  actorId?: string,
) {
  const before = await prisma.featureFlag.findUnique({ where: { key } });
  if (!before) throw Object.assign(new Error('Flag not found'), { statusCode: 404 });

  const after = await prisma.featureFlag.update({
    where: { key },
    data: {
      ...updates,
      ...(updates.metadata !== undefined ? { metadata: updates.metadata as object } : {}),
      ...(updates.rolloutPercentage !== undefined
        ? { rolloutPercentage: Math.max(0, Math.min(100, updates.rolloutPercentage)) }
        : {}),
    },
  });

  await audit(after.id, 'UPDATED', actorId, before as object, after as object);
  await pushFlagsUpdated();
  return after;
}

export async function deleteFlag(key: string, actorId?: string) {
  const flag = await prisma.featureFlag.findUnique({ where: { key } });
  if (!flag) throw Object.assign(new Error('Flag not found'), { statusCode: 404 });

  await audit(flag.id, 'DELETED', actorId, flag as object);
  await prisma.featureFlag.delete({ where: { key } });
  await pushFlagsUpdated();
}

export async function setOverride(
  key: string,
  userId: string,
  enabled: boolean,
  reason: string,
  actorId?: string,
) {
  const flag = await prisma.featureFlag.findUnique({ where: { key } });
  if (!flag) throw Object.assign(new Error('Flag not found'), { statusCode: 404 });

  await prisma.featureFlagOverride.upsert({
    where: { flagId_userId: { flagId: flag.id, userId } },
    create: { flagId: flag.id, userId, enabled, reason },
    update: { enabled, reason },
  });

  await audit(flag.id, 'OVERRIDE_SET', actorId, undefined, { userId, enabled, reason } as object);
  await pushFlagsUpdated();
}

export async function removeOverride(key: string, userId: string, actorId?: string) {
  const flag = await prisma.featureFlag.findUnique({ where: { key } });
  if (!flag) throw Object.assign(new Error('Flag not found'), { statusCode: 404 });

  await prisma.featureFlagOverride.deleteMany({ where: { flagId: flag.id, userId } });
  await audit(flag.id, 'OVERRIDE_REMOVED', actorId, undefined, { userId } as object);
  await pushFlagsUpdated();
}

export async function listFlags() {
  return prisma.featureFlag.findMany({
    include: { overrides: { select: { userId: true, enabled: true, reason: true } } },
    orderBy: { createdAt: 'desc' },
  });
}

export async function getFlagAuditLog(key: string, limit = 50) {
  const flag = await prisma.featureFlag.findUnique({ where: { key } });
  if (!flag) throw Object.assign(new Error('Flag not found'), { statusCode: 404 });

  return prisma.featureFlagAuditLog.findMany({
    where: { flagId: flag.id },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
}
