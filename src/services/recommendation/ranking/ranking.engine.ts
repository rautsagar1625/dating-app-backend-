// ── Multi-Factor Ranking Engine ───────────────────────────────────────────────
//
// Scores each candidate profile against the requesting user using 7 factors.
// Each factor returns 0–1; final score = weighted sum × 100.
//
// Factor model:
//
//   attractionProb  = P(candidate likes viewer back)
//     → candidate.likeOutRate × profileQualityMultiplier × demographicBonus
//
//   replyProb       = P(candidate replies to first message)
//     → candidate.replyRate × (1 + viewer.trustNorm × 0.2)
//
//   trustSafety     = quality/safety gate
//     → (candidate.trustScore / 100) × (1 - fraudPenalty) × (1 - negPenalty)
//
//   activityRecency = time-decay of candidate's last activity
//     → recencyTable lookup (hours since active)
//
//   profileQuality  = candidate profile completeness + media richness
//     → 0-1 completeness score
//
//   diversityBonus  = reduces score if viewer has seen many similar candidates
//     → session-level age/location diversity counter
//
//   monetization    = paid boost factor (capped to prevent pay-to-win)
//     → checks Redis boost key
//
// The ranking engine is stateless — caller passes viewer signals, candidate
// profiles, and session context. No DB reads here (everything pre-loaded).

import IORedis from 'ioredis';
import { DEFAULT_WEIGHTS, recencyScore, MONETIZATION_CAPS } from './weights';
import type {
  RankingWeights,
  RankingFactors,
  RankedCandidate,
  CandidateProfile,
  UserSignals,
} from '../rec.types';
import { RANK_VERSION } from '../rec.types';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
const rankRedis = new IORedis(REDIS_URL, {
  maxRetriesPerRequest: 1,
  lazyConnect: true,
  enableReadyCheck: false,
});
rankRedis.connect().catch(() => {});

const BOOST_KEY = (uid: string) => `rec:boost:${uid}`;

// ── Factor computations ───────────────────────────────────────────────────────

function attractionProbFactor(
  candidateSignals: UserSignals | null,
  viewerSignals:    UserSignals,
): number {
  if (!candidateSignals) return 0.06;  // cold-start prior

  // Base rate: how often does this candidate like others?
  let base = candidateSignals.likeOutRate;

  // Popularity signal: high likeInRate means they're desirable → slightly harder match
  const popPenalty = Math.max(0, candidateSignals.likeInRate - 0.15) * 0.3;

  // Profile quality multiplier: better profiles generate more likes
  const qualMult = 0.5 + candidateSignals.profileQuality * 0.5;

  // Mutual interest signal: if viewer has a similar likeOutRate, they're active
  const activityBonus = viewerSignals.likeOutRate > 0.05 ? 0.05 : 0;

  return Math.min(base * qualMult + activityBonus - popPenalty, 1);
}

function replyProbFactor(
  candidateSignals: UserSignals | null,
  viewerSignals:    UserSignals,
): number {
  if (!candidateSignals) return 0.25;  // population average prior

  const baseReply = candidateSignals.replyRate;

  // High-trust senders get better reply rates
  const trustBonus = (viewerSignals.trustScore / 100) * 0.15;

  // Sender with good profile quality gets replied to more
  const qualBonus = viewerSignals.profileQuality * 0.10;

  return Math.min(baseReply + trustBonus + qualBonus, 1);
}

function trustSafetyFactor(candidateSignals: UserSignals | null): number {
  if (!candidateSignals) return 0.75;

  const trustNorm = candidateSignals.trustScore / 100;

  // Fraud penalty: nonlinear — moderate fraud is tolerated, high fraud is excluded
  const fraudPenalty = Math.pow(candidateSignals.fraudScore / 100, 1.5) * 0.5;

  // Negative signal penalty: blockRecvRate and reportRecvRate
  const negPenalty = Math.min(
    candidateSignals.blockRecvRate  * 0.4 +
    candidateSignals.reportRecvRate * 0.6,
    0.5,
  );

  return Math.max(trustNorm * (1 - fraudPenalty) * (1 - negPenalty), 0);
}

function profileQualityFactor(candidate: CandidateProfile): number {
  let q = 0;
  if (candidate.age)      q += 0.20;
  if (candidate.gender)   q += 0.15;
  if (candidate.location) q += 0.10;
  q += Math.min(candidate.photoCount, 4) * 0.1375;  // up to +0.55 for 4+ photos
  return Math.min(q, 1);
}

// Session diversity: penalize candidates too similar to recent ones in session
function diversityFactor(
  candidate:        CandidateProfile,
  sessionContext:   SessionContext,
): number {
  const ageBucket  = candidate.age ? Math.floor(candidate.age / 5) * 5 : null;
  const locKey     = candidate.location ?? 'unknown';

  const ageSeen  = ageBucket  ? (sessionContext.ageBuckets.get(ageBucket)  ?? 0) : 0;
  const locSeen  = (sessionContext.locationBuckets.get(locKey) ?? 0);

  // Diversity boost if this demographic has been underrepresented
  const agePenalty  = Math.min(ageSeen  * 0.08, 0.30);
  const locPenalty  = Math.min(locSeen  * 0.05, 0.20);
  const poolBonus   = candidate.poolType === 'FRESH' ? 0.10 : 0;

  return Math.max(0, 1 - agePenalty - locPenalty + poolBonus);
}

async function monetizationFactor(candidateId: string): Promise<number> {
  try {
    const boostScore = await rankRedis.get(BOOST_KEY(candidateId));
    if (!boostScore) return 0;
    return Math.min(parseFloat(boostScore), MONETIZATION_CAPS.boostScoreBonus);
  } catch {
    return 0;
  }
}

// ── Session context (diversity tracking) ─────────────────────────────────────

export interface SessionContext {
  ageBuckets:      Map<number, number>;
  locationBuckets: Map<string, number>;
  position:        number;
}

export function newSessionContext(): SessionContext {
  return {
    ageBuckets:      new Map(),
    locationBuckets: new Map(),
    position:        0,
  };
}

export function updateSessionContext(ctx: SessionContext, c: CandidateProfile): void {
  if (c.age) {
    const bucket = Math.floor(c.age / 5) * 5;
    ctx.ageBuckets.set(bucket, (ctx.ageBuckets.get(bucket) ?? 0) + 1);
  }
  if (c.location) {
    ctx.locationBuckets.set(c.location, (ctx.locationBuckets.get(c.location) ?? 0) + 1);
  }
  ctx.position++;
}

// ── Main scoring function ─────────────────────────────────────────────────────

export async function scoreCandidate(
  candidate:        CandidateProfile,
  viewerSignals:    UserSignals,
  candidateSignals: UserSignals | null,
  sessionCtx:       SessionContext,
  weights:          RankingWeights = DEFAULT_WEIGHTS,
): Promise<RankingFactors> {
  const [monet] = await Promise.all([
    monetizationFactor(candidate.userId),
  ]);

  const factors: RankingFactors = {
    attractionProb:  attractionProbFactor(candidateSignals, viewerSignals),
    replyProb:       replyProbFactor(candidateSignals, viewerSignals),
    trustSafety:     trustSafetyFactor(candidateSignals),
    activityRecency: recencyScore(candidate.lastActiveAt),
    profileQuality:  profileQualityFactor(candidate),
    diversityBonus:  diversityFactor(candidate, sessionCtx),
    monetization:    monet,
    finalScore:      0,
  };

  // Hard safety gate: candidates with very low trust never surface in ranking
  if (factors.trustSafety < 0.15) {
    factors.finalScore = 0;
    return factors;
  }

  factors.finalScore = Math.min(
    (factors.attractionProb  * weights.attractionProb  +
     factors.replyProb        * weights.replyProb        +
     factors.trustSafety      * weights.trustSafety      +
     factors.activityRecency  * weights.activityRecency  +
     factors.profileQuality   * weights.profileQuality   +
     factors.diversityBonus   * weights.diversity        +
     factors.monetization     * weights.monetization) * 100,
    100,
  );

  return factors;
}

// ── Batch ranking ─────────────────────────────────────────────────────────────

export async function rankCandidates(
  candidates:          CandidateProfile[],
  viewerSignals:       UserSignals,
  candidateSignalsMap: Map<string, UserSignals>,
  weights:             RankingWeights = DEFAULT_WEIGHTS,
): Promise<RankedCandidate[]> {
  const ctx = newSessionContext();
  const ranked: RankedCandidate[] = [];

  // Score all candidates
  for (const candidate of candidates) {
    const cSignals = candidateSignalsMap.get(candidate.userId) ?? null;
    const factors  = await scoreCandidate(candidate, viewerSignals, cSignals, ctx, weights);

    if (factors.finalScore > 0) {
      ranked.push({
        userId:      candidate.userId,
        score:       factors.finalScore,
        factors,
        poolType:    candidate.poolType,
        rankVersion: RANK_VERSION,
      });
    }
  }

  // Sort descending by score
  ranked.sort((a, b) => b.score - a.score);

  // MMR-style re-ranking: every 5th slot, force a diversity injection
  // (swap the 5th candidate with the highest-diversity unranked one)
  return applyDiversityRerankingPass(ranked, candidates);
}

function applyDiversityRerankingPass(
  ranked:     RankedCandidate[],
  candidates: CandidateProfile[],
): RankedCandidate[] {
  if (ranked.length < 10) return ranked;

  const profileMap = new Map(candidates.map((c) => [c.userId, c]));
  const result     = [...ranked];

  const ctx = newSessionContext();
  for (let i = 0; i < Math.min(result.length, 50); i++) {
    const candidate = profileMap.get(result[i].userId);
    if (candidate) {
      // Every 5th slot: if diversity factor is low, swap with the best
      // unshown candidate that has high diversity
      if (i > 0 && i % 5 === 4) {
        const divScore = diversityFactor(candidate, ctx);
        if (divScore < 0.5 && i + 5 < result.length) {
          // Find a more diverse candidate from the next 10 slots
          let bestDivIdx = -1;
          let bestDivScore = divScore;
          for (let j = i + 1; j < Math.min(i + 10, result.length); j++) {
            const jCand = profileMap.get(result[j].userId);
            if (jCand) {
              const jDiv = diversityFactor(jCand, ctx);
              if (jDiv > bestDivScore) {
                bestDivScore = jDiv;
                bestDivIdx   = j;
              }
            }
          }
          if (bestDivIdx !== -1) {
            [result[i], result[bestDivIdx]] = [result[bestDivIdx], result[i]];
          }
        }
      }
      updateSessionContext(ctx, candidate);
    }
  }

  return result;
}

// ── Boost management ──────────────────────────────────────────────────────────

export async function setBoost(
  userId:     string,
  boostScore: number,
  ttlSeconds: number,
): Promise<void> {
  try {
    const clamped = Math.min(boostScore, MONETIZATION_CAPS.boostScoreBonus);
    await rankRedis.setex(BOOST_KEY(userId), ttlSeconds, clamped.toString());
    // Invalidate candidate caches that may include this user
    // (targeted invalidation via pub/sub would be better at scale)
  } catch { /* non-critical */ }
}

export async function clearBoost(userId: string): Promise<void> {
  try {
    await rankRedis.del(BOOST_KEY(userId));
  } catch { /* non-critical */ }
}
