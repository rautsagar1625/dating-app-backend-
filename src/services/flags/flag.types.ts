// ── Canonical flag keys — the single source of truth for type-safe access ─────
// Add new flags here. The string value is what's stored in the DB.
export const FEATURE_FLAGS = {
  ENABLE_VIDEO_CALLS:  'enableVideoCalls',
  ENABLE_BOOST:        'enableBoost',
  NEW_FEED_RANKING:    'newFeedRanking',
  PREMIUM_PAYWALL_V2:  'premiumPaywallV2',
  AI_MODERATION:       'aiModeration',
  VOICE_NOTES:         'voiceNotes',
} as const;

export type FeatureFlagKey = (typeof FEATURE_FLAGS)[keyof typeof FEATURE_FLAGS];

export type Platform = 'ios' | 'android' | 'web';

// Context passed to every flag evaluation — enriched from the auth token or request headers
export interface EvalContext {
  userId: string;
  platform?: Platform;
  region?: string; // ISO 3166-1 alpha-2, e.g. "in", "us"
}

// Internal representation of a flag after loading from cache/DB
export interface FlagConfig {
  id: string;
  key: string;
  description: string;
  enabled: boolean;
  rolloutPercentage: number;
  targetUserIds: string[];
  blockedUserIds: string[];
  platforms: string[];
  regions: string[];
  metadata: Record<string, unknown>;
  expiresAt: Date | string | null;
  overrides: Array<{ userId: string; enabled: boolean }>;
}

export type EvalReason =
  | 'disabled'
  | 'expired'
  | 'platform_mismatch'
  | 'region_mismatch'
  | 'blocked_user'
  | 'target_user'
  | 'override'
  | 'rollout_included'
  | 'rollout_excluded'
  | 'fully_enabled';

export interface EvalResult {
  enabled: boolean;
  reason: EvalReason;
}
