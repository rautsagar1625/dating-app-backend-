// ── Ranking weight definitions ────────────────────────────────────────────────
//
// Weights are fractions that sum to 1.0. The final score is the weighted sum
// of factor scores (each 0-1) × 100.
//
// The DEFAULT weights represent the production-validated baseline (v1).
// Experiments override specific weights via RankingExperiment.variants.
//
// Factor intuition:
//   attractionProb  — quality × mutual likelihood (biggest driver)
//   replyProb       — conversation-start quality
//   trustSafety     — keeps ranking trustworthy (safety floor)
//   activityRecency — fresh users appear higher (retention signal)
//   profileQuality  — incentivizes profile completion
//   diversity       — prevents feed homogeneity / fatigue
//   monetization    — fair boost without pay-to-win dominance

import type { RankingWeights } from '../rec.types';

export const DEFAULT_WEIGHTS: RankingWeights = {
  attractionProb:  0.28,
  replyProb:       0.22,
  trustSafety:     0.15,
  activityRecency: 0.12,
  profileQuality:  0.10,
  diversity:       0.07,
  monetization:    0.06,
};

// Weight presets for common experiment variants
export const WEIGHT_PRESETS: Record<string, RankingWeights> = {
  // Optimize for conversation starts (A/B test candidate)
  conversationFirst: {
    attractionProb:  0.22,
    replyProb:       0.32,
    trustSafety:     0.15,
    activityRecency: 0.10,
    profileQuality:  0.10,
    diversity:       0.07,
    monetization:    0.04,
  },
  // Optimize for long-term retention (churn-reduction experiment)
  retentionFirst: {
    attractionProb:  0.22,
    replyProb:       0.18,
    trustSafety:     0.18,
    activityRecency: 0.15,
    profileQuality:  0.08,
    diversity:       0.13,
    monetization:    0.06,
  },
  // Safety-weighted (used after moderation incidents)
  safetyFirst: {
    attractionProb:  0.22,
    replyProb:       0.20,
    trustSafety:     0.28,
    activityRecency: 0.10,
    profileQuality:  0.08,
    diversity:       0.08,
    monetization:    0.04,
  },
};

// Monetization score caps: prevents paid boost from dominating organic ranking
export const MONETIZATION_CAPS = {
  boostScoreBonus:     0.15,  // max 15% raw factor boost for active boost
  spotlightScoreBonus: 0.10,  // max 10% for spotlight
  superlikeScoreBonus: 0.08,  // max 8% for received super-like
};

// Activity recency decay thresholds (maps hours-since-active → score 0-1)
export const RECENCY_TABLE: Array<[number, number]> = [
  [0,    1.00],   // online now
  [1,    0.95],   // < 1 hour
  [6,    0.85],   // < 6 hours
  [24,   0.70],   // < 1 day
  [72,   0.45],   // < 3 days
  [168,  0.20],   // < 7 days
  [720,  0.05],   // < 30 days
  [Infinity, 0.01],
];

export function recencyScore(lastActiveAt: Date | null): number {
  if (!lastActiveAt) return 0.01;
  const hoursAgo = (Date.now() - lastActiveAt.getTime()) / 3_600_000;
  for (const [hours, score] of RECENCY_TABLE) {
    if (hoursAgo <= hours) return score;
  }
  return 0.01;
}
