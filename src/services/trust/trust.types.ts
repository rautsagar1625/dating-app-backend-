// ── Trust & Safety — shared type definitions ──────────────────────────────────

export type ModerationSourceType = 'MESSAGE' | 'MEDIA' | 'PROFILE' | 'CONVERSATION';

export type ModerationTriggerType =
  | 'REALTIME_RULES'
  | 'ASYNC_ML'
  | 'REPORT'
  | 'PHASH'
  | 'MANUAL';

export type ModerationDecisionType =
  | 'CLEAN'
  | 'APPROVED'
  | 'WARNED'
  | 'SUPPRESSED'
  | 'ESCALATED'
  | 'REJECTED';

export type MessageThreatType =
  | 'ESCORT_SOLICITATION'
  | 'CRYPTO_SCAM'
  | 'INVESTMENT_SCAM'
  | 'SPAM_REPETITION'
  | 'SPAM_BULK'
  | 'HARASSMENT'
  | 'TOXIC_LANGUAGE'
  | 'CONTACT_EXTRACTION'   // phone/email/social pushed off-platform
  | 'EXTERNAL_LINK'
  | 'UNDERAGE_RISK'
  | 'GROOMING_PATTERN'
  | 'MANIPULATION_PATTERN'
  | 'BOT_PATTERN'
  | 'GIBBERISH';

// A single scored signal from any detector
export interface ModerationSignal {
  type:   MessageThreatType | string;
  score:  number;           // 0.0–1.0
  detail: string;           // human-readable explanation
}

// Result from the synchronous realtime rules engine
export interface RealtimeModerationResult {
  riskScore:    number;              // 0-100 integer
  action:       'CLEAN' | 'WARN' | 'SUPPRESS' | 'SHADOW';
  signals:      ModerationSignal[];
  contactsFound: boolean;
  explanation:  string;
}

// Result from an async ML text moderation provider
export interface TextModerationResult {
  decision:    ModerationDecisionType;
  confidence:  number;         // 0.0–1.0
  signals:     ModerationSignal[];
  flaggedCategories: string[];
  explanation: string;
  raw:         Record<string, unknown>;
}

// ── Trust Score components (0-100 unified score) ──────────────────────────────

export interface TrustScoreComponents {
  // Penalty inputs (lower trust = higher penalty)
  fraudRiskPenalty:    number;  // 0-25  derived from UserRiskProfile.riskScore
  modViolationPenalty: number;  // 0-20  from ModerationEvent count/severity
  reportRatePenalty:   number;  // 0-15  reports received per week
  toxicityPenalty:     number;  // 0-10  ConversationRiskProfile averages
  spamPenalty:         number;  // 0-10  spam signal frequency
  blockRatePenalty:    number;  // 0-5   blocks received per week
  mediaViolPenalty:    number;  // 0-10  quarantined/rejected media count

  // Bonus inputs (raise trust)
  profileBonus:        number;  // 0-5   completeness
  ageBonus:            number;  // 0-5   account age
  verifiedBonus:       number;  // 0-10  verified status

  // Final
  totalScore:          number;  // 0-100
}

export interface TrustScoreSnapshot {
  userId:     string;
  score:      number;
  components: TrustScoreComponents;
  computedAt: string;
}

// ── Conversation risk level thresholds ────────────────────────────────────────

export const CONV_RISK_THRESHOLDS = {
  CLEAN:    0,
  LOW:      15,
  MEDIUM:   35,
  HIGH:     60,
  CRITICAL: 80,
} as const;

export type ConvRiskLevel = keyof typeof CONV_RISK_THRESHOLDS;

export function convScoreToLevel(score: number): ConvRiskLevel {
  if (score >= CONV_RISK_THRESHOLDS.CRITICAL) return 'CRITICAL';
  if (score >= CONV_RISK_THRESHOLDS.HIGH)     return 'HIGH';
  if (score >= CONV_RISK_THRESHOLDS.MEDIUM)   return 'MEDIUM';
  if (score >= CONV_RISK_THRESHOLDS.LOW)      return 'LOW';
  return 'CLEAN';
}
