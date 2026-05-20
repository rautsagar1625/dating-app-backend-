// ── Monetization Experimentation ──────────────────────────────────────────────
//
// Deterministic A/B assignment for pricing, paywall copy, and offer timing.
// Separate from RankingExperiment — revenue causality requires isolation.
//
// Assignment: sha256(userId:experimentId)[0:4] % 100 → bucket → variant
// Caching: Redis `mexp:{userId}:{experimentId}` TTL 5min
//
// Causal analysis support:
//   - OfferExposure rows link experimentId + variantId + converted flag
//   - Revenue from converted exposures queryable per variant
//   - Holdout group (variant "control") gets baseline behavior

import crypto from 'crypto';
import IORedis from 'ioredis';
import prisma from '../prisma.service';
import { logger } from '../../observability/logger';
import { monetizationExperimentAssignment } from '../../observability/metrics';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
const mexpRedis = new IORedis(REDIS_URL, {
  maxRetriesPerRequest: 2,
  lazyConnect: true,
  enableReadyCheck: false,
});
mexpRedis.connect().catch(() => {});

const CACHE_TTL  = 300;  // 5 minutes
const mexpKey    = (userId: string, expId: string) => `mexp:${userId}:${expId}`;

interface VariantAssignment {
  experimentId: string;
  variantId:    string;
  variantName:  string;
  config:       Record<string, unknown>;
}

// ── Get assignment (cached) ───────────────────────────────────────────────────

export async function getMonetizationVariant(
  userId:       string,
  experimentId: string,
): Promise<VariantAssignment | null> {
  // Check cache
  const cached = await mexpRedis.get(mexpKey(userId, experimentId)).catch(() => null);
  if (cached) return JSON.parse(cached) as VariantAssignment;

  const experiment = await prisma.monetizationExperiment.findUnique({
    where:   { id: experimentId },
    include: { variants: { orderBy: { weight: 'asc' } } },
  });

  if (!experiment || experiment.status !== 'ACTIVE') return null;

  // Traffic allocation — skip users outside trafficPct
  const trafficBucket = userBucket(userId, `${experimentId}:traffic`);
  if (trafficBucket >= experiment.trafficPct) return null;

  // Variant assignment
  const bucket   = userBucket(userId, experimentId);
  const variant  = assignVariant(bucket, experiment.variants);
  if (!variant) return null;

  const result: VariantAssignment = {
    experimentId,
    variantId:   variant.id,
    variantName: variant.name,
    config:      variant.config as Record<string, unknown>,
  };

  await mexpRedis.setex(mexpKey(userId, experimentId), CACHE_TTL, JSON.stringify(result)).catch(() => {});

  monetizationExperimentAssignment.inc({ experimentId, variant: variant.name });
  return result;
}

// ── Create / manage experiments ───────────────────────────────────────────────

export async function createMonetizationExperiment(params: {
  name:        string;
  type:        string;
  description?: string;
  trafficPct:  number;
  variants:    Array<{ name: string; config: Record<string, unknown>; weight: number }>;
}): Promise<string> {
  const exp = await prisma.monetizationExperiment.create({
    data: {
      name:        params.name,
      type:        params.type,
      description: params.description,
      trafficPct:  params.trafficPct,
      status:      'DRAFT',
      variants:    { create: params.variants },
    },
    select: { id: true },
  });
  return exp.id;
}

export async function activateMonetizationExperiment(experimentId: string): Promise<void> {
  await prisma.monetizationExperiment.update({
    where: { id: experimentId },
    data:  { status: 'ACTIVE', startedAt: new Date() },
  });
  logger.info({ experimentId }, 'monetization experiment activated');
}

export async function stopMonetizationExperiment(experimentId: string): Promise<void> {
  await prisma.monetizationExperiment.update({
    where: { id: experimentId },
    data:  { status: 'STOPPED', stoppedAt: new Date() },
  });
  // Flush cached assignments
  const keys = await mexpRedis.keys(`mexp:*:${experimentId}`);
  if (keys.length) await mexpRedis.del(...keys);
  logger.info({ experimentId, flushed: keys.length }, 'monetization experiment stopped');
}

// ── Experiment results ────────────────────────────────────────────────────────

export async function getExperimentResults(experimentId: string) {
  const exposures = await prisma.offerExposure.findMany({
    where: { experimentId },
    select: { variantId: true, convertedAt: true, revenue: true },
  });

  const byVariant = new Map<string, { shown: number; converted: number; revenue: number }>();
  for (const e of exposures) {
    if (!e.variantId) continue;
    const agg = byVariant.get(e.variantId) ?? { shown: 0, converted: 0, revenue: 0 };
    agg.shown++;
    if (e.convertedAt) agg.converted++;
    if (e.revenue) agg.revenue += Number(e.revenue);
    byVariant.set(e.variantId, agg);
  }

  return Array.from(byVariant.entries()).map(([variantId, stats]) => ({
    variantId,
    shown:          stats.shown,
    converted:      stats.converted,
    revenue:        stats.revenue,
    conversionRate: stats.shown > 0 ? stats.converted / stats.shown : 0,
    rpc:            stats.converted > 0 ? stats.revenue / stats.converted : 0,  // revenue per conversion
  }));
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function userBucket(userId: string, seed: string): number {
  const hash = crypto.createHash('sha256').update(`${userId}:${seed}`).digest('hex');
  return parseInt(hash.slice(0, 4), 16) % 100;
}

function assignVariant<T extends { weight: number }>(bucket: number, variants: T[]): T | null {
  if (variants.length === 0) return null;
  const total = variants.reduce((s, v) => s + v.weight, 0);
  let cursor  = 0;
  for (const variant of variants) {
    cursor += (variant.weight / total) * 100;
    if (bucket < cursor) return variant;
  }
  return variants[variants.length - 1];
}
