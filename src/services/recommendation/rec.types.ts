// ── Recommendation Engine — Shared Types ─────────────────────────────────────

export const RANK_VERSION = 'v1';

// ── Weights ───────────────────────────────────────────────────────────────────

export interface RankingWeights {
  attractionProb:  number;  // P(candidate likes viewer back)
  replyProb:       number;  // P(candidate replies to first message)
  trustSafety:     number;  // trust score component
  activityRecency: number;  // time-decay of last activity
  profileQuality:  number;  // profile completeness + media
  diversity:       number;  // diversity/freshness bonus
  monetization:    number;  // paid boost factor
}

// ── Signal profile ────────────────────────────────────────────────────────────

export interface UserSignals {
  userId: string;

  // Engagement ratios (14-day rolling)
  likeOutRate:   number;   // likes sent / profiles seen
  likeInRate:    number;   // likes received / distinct visitors
  replyRate:     number;   // chats replied to / chats received
  avgConvDepth:  number;   // avg messages per conversation
  convStartRate: number;   // matches with ≥1 message / total matches

  // Negative (7-day)
  blockRecvRate:  number;
  reportRecvRate: number;

  // Quality
  profileQuality: number;  // 0-1
  photoCount:     number;
  trustScore:     number;  // 0-100
  fraudScore:     number;  // 0-100

  // Activity
  lastActiveAt: Date | null;
  isOnline:     boolean;

  computedAt: Date;
}

// ── Candidate pool ────────────────────────────────────────────────────────────

export type CandidatePoolType =
  | 'PROXIMITY'
  | 'BEHAVIORAL'
  | 'MUTUAL_INTEREST'
  | 'POPULAR'
  | 'FRESH'
  | 'COLD_START'
  | 'BOOST';

export interface CandidateProfile {
  userId:      string;
  age:         number | null;
  gender:      string | null;
  location:    string | null;
  photoCount:  number;
  isOnline:    boolean;
  lastActiveAt: Date | null;
  trustScore:  number;
  poolType:    CandidatePoolType;
  preScore:    number;
}

// ── Ranking ───────────────────────────────────────────────────────────────────

export interface RankingFactors {
  attractionProb:  number;   // 0-1
  replyProb:       number;   // 0-1
  trustSafety:     number;   // 0-1
  activityRecency: number;   // 0-1
  profileQuality:  number;   // 0-1
  diversityBonus:  number;   // 0-1
  monetization:    number;   // 0-1
  finalScore:      number;   // 0-100 weighted sum
}

export interface RankedCandidate {
  userId:      string;
  score:       number;           // 0-100 final rank score
  factors:     RankingFactors;
  poolType:    CandidatePoolType;
  rankVersion: string;
}

// ── Feed ──────────────────────────────────────────────────────────────────────

export interface FeedRequest {
  userId:      string;
  sessionId?:  string;
  limit:       number;
  offset:      number;
  forceRefresh?: boolean;
}

export interface FeedResult {
  profiles:    RankedCandidate[];
  sessionId:   string;
  rankVersion: string;
  fromCache:   boolean;
  generatedAt: Date;
}

// ── Feedback ──────────────────────────────────────────────────────────────────

export type FeedbackAction =
  | 'LIKE'
  | 'SKIP'
  | 'SUPERLIKE'
  | 'BLOCK'
  | 'REPORT'
  | 'VIEW'
  | 'DWELL'
  | 'MATCH';

export interface FeedbackSignal {
  userId:     string;   // viewer
  targetId:   string;   // shown profile
  action:     FeedbackAction;
  sessionId?: string;
  dwellMs?:   number;
  position?:  number;
  rankScore?: number;
  rankVersion?: string;
  factors?:   RankingFactors;
}

// ── Experiment ────────────────────────────────────────────────────────────────

export type ExperimentVariant = 'CONTROL' | 'TREATMENT';

export interface ExperimentAssignment {
  experimentId: string;
  variant:      ExperimentVariant;
  weights:      RankingWeights;
}
