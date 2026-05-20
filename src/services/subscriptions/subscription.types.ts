// ── Subscription System Types ─────────────────────────────────────────────────

export type SubscriptionStatus = 'ACTIVE' | 'CANCELLED' | 'PAST_DUE' | 'EXPIRED' | 'PAUSED';
export type SubscriptionTier   = 'VELVET_GOLD' | 'VELVET_PLATINUM' | 'VELVET_DIAMOND';

// Features granted per tier. Feature list is additive upward.
export const TIER_FEATURES: Record<SubscriptionTier, string[]> = {
  VELVET_GOLD: [
    'UNLIMITED_LIKES',          // no daily like cap
    'SEE_WHO_LIKED_YOU',        // visible likes wall
    'ADVANCED_FILTERS',         // age, distance, intent filters
    'READ_RECEIPTS',            // see message read status
    'PRIORITY_RANKING',         // 20% recommendation ranking boost
    'AD_FREE',
  ],
  VELVET_PLATINUM: [
    'UNLIMITED_LIKES',
    'SEE_WHO_LIKED_YOU',
    'ADVANCED_FILTERS',
    'READ_RECEIPTS',
    'PRIORITY_RANKING',         // 30% boost
    'AD_FREE',
    'FREE_CHAT_UNLOCKS',        // 5 free chat unlocks/month
    'INVISIBLE_BROWSE',         // visit profiles without appearing in visitors
    'SUPER_LIKES_5_MONTHLY',    // 5 bonus super likes per month
    'PROFILE_BADGE',            // Platinum badge
  ],
  VELVET_DIAMOND: [
    'UNLIMITED_LIKES',
    'SEE_WHO_LIKED_YOU',
    'ADVANCED_FILTERS',
    'READ_RECEIPTS',
    'PRIORITY_RANKING',         // 50% boost — premium slot
    'AD_FREE',
    'FREE_CHAT_UNLOCKS',        // 10 free chat unlocks/month
    'INVISIBLE_BROWSE',
    'SUPER_LIKES_10_MONTHLY',   // 10 bonus super likes per month
    'PROFILE_BADGE',            // Diamond badge
    'CONCIERGE_SUPPORT',        // priority customer support
    'PROFILE_BOOST_WEEKLY',     // 1 free 30min boost per week
  ],
};

// Grace period before subscription is treated as EXPIRED after PAST_DUE
export const GRACE_PERIOD_DAYS = 7;

// How long before expiry to attempt renewal
export const RENEWAL_LEAD_HOURS = 48;
