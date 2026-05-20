// ── A/B Ranking Experiment Service ───────────────────────────────────────────
//
// Manages ranking weight experiments.
//
// Assignment:
//   - Deterministic: hash(userId + experimentId) → bucket 0-99
//   - User in experiment if bucket < trafficPct * 100
//   - Bucket < trafficPct/2 → CONTROL, else → TREATMENT
//   - Users outside traffic window get DEFAULT_WEIGHTS
//
// Only one active experiment applies per user at a time.
// Experiment config is DB-sourced with a Redis cache (5-min TTL).

import IORedis from 'ioredis';
import prisma from '../../prisma.service';
import { DEFAULT_WEIGHTS } from '../ranking/weights';
import type { RankingWeights, ExperimentAssignment } from '../rec.types';
import { createHash } from 'crypto';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
const expRedis = new IORedis(REDIS_URL, {
  maxRetriesPerRequest: 1,
  lazyConnect: true,
  enableReadyCheck: false,
});
expRedis.connect().catch(() => {});

const EXP_CACHE_KEY = 'rec:experiments:active';
const EXP_CACHE_TTL = 5 * 60;

// ── Deterministic user assignment ─────────────────────────────────────────────

function userBucket(userId: string, experimentId: string): number {
  const hash = createHash('sha256')
    .update(`${userId}:${experimentId}`)
    .digest('hex');
  return parseInt(hash.slice(0, 4), 16) % 100;
}

// ── Active experiment cache ───────────────────────────────────────────────────

interface StoredExperiment {
  id:         string;
  trafficPct: number;
  variants:   { control: RankingWeights; treatment: RankingWeights };
}

async function getActiveExperiments(): Promise<StoredExperiment[]> {
  try {
    const cached = await expRedis.get(EXP_CACHE_KEY);
    if (cached) return JSON.parse(cached) as StoredExperiment[];
  } catch { /* miss */ }

  const active = await prisma.rankingExperiment.findMany({
    where: { status: 'ACTIVE' },
    select: { id: true, trafficPct: true, variants: true },
  });

  const experiments: StoredExperiment[] = active.map((e) => ({
    id:         e.id,
    trafficPct: e.trafficPct,
    variants:   e.variants as unknown as { control: RankingWeights; treatment: RankingWeights },
  }));

  try {
    await expRedis.setex(EXP_CACHE_KEY, EXP_CACHE_TTL, JSON.stringify(experiments));
  } catch { /* non-critical */ }

  return experiments;
}

export async function invalidateExperimentCache(): Promise<void> {
  try {
    await expRedis.del(EXP_CACHE_KEY);
  } catch { /* non-critical */ }
}

// ── Main assignment function ──────────────────────────────────────────────────

export async function getExperimentAssignment(
  userId: string,
): Promise<ExperimentAssignment | null> {
  const experiments = await getActiveExperiments();
  if (experiments.length === 0) return null;

  // Use first experiment that captures this user (single experiment per user)
  for (const exp of experiments) {
    const bucket     = userBucket(userId, exp.id);
    const cutoff     = Math.round(exp.trafficPct * 100);

    if (bucket >= cutoff) continue;  // not in experiment traffic

    const variant  = bucket < cutoff / 2 ? 'CONTROL' : 'TREATMENT';
    const weights  = variant === 'CONTROL'
      ? (exp.variants.control   ?? DEFAULT_WEIGHTS)
      : (exp.variants.treatment ?? DEFAULT_WEIGHTS);

    return { experimentId: exp.id, variant, weights };
  }

  return null;
}

// ── Admin experiment CRUD ─────────────────────────────────────────────────────

export async function createExperiment(params: {
  name:        string;
  description: string;
  trafficPct:  number;
  control:     RankingWeights;
  treatment:   RankingWeights;
}): Promise<string> {
  const exp = await prisma.rankingExperiment.create({
    data: {
      name:        params.name,
      description: params.description,
      trafficPct:  Math.min(params.trafficPct, 1),
      status:      'DRAFT',
      variants:    { control: params.control, treatment: params.treatment },
    },
  });
  return exp.id;
}

export async function activateExperiment(id: string): Promise<void> {
  await prisma.rankingExperiment.update({
    where: { id },
    data:  { status: 'ACTIVE', startedAt: new Date() },
  });
  await invalidateExperimentCache();
}

export async function stopExperiment(id: string): Promise<void> {
  await prisma.rankingExperiment.update({
    where: { id },
    data:  { status: 'COMPLETED', endedAt: new Date() },
  });
  await invalidateExperimentCache();
}
