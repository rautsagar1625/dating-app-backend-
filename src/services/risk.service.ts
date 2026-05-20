import prisma from './prisma.service';

// Risk point values for each event type
const RISK_WEIGHTS = {
  reported:   20,  // user got reported
  blocked:     5,  // user got blocked by someone
  spam_flag:  10,  // sent messages too rapidly
} as const;

// Thresholds
const SOFT_BAN_THRESHOLD = 75;

type RiskEvent = keyof typeof RISK_WEIGHTS;

/**
 * Increment risk score for a user. Auto-applies a soft ban when the score
 * crosses the threshold. Fire-and-forget — callers do NOT await.
 */
export const recordRiskEvent = async (
  userId: string,
  event: RiskEvent,
  reason?: string,
): Promise<void> => {
  const delta = RISK_WEIGHTS[event];

  const profile = await prisma.userRiskProfile.upsert({
    where:  { userId },
    create: {
      userId,
      riskScore:   delta,
      reportCount: event === 'reported' ? 1 : 0,
      blockCount:  event === 'blocked'  ? 1 : 0,
      spamFlags:   event === 'spam_flag' ? 1 : 0,
    },
    update: {
      riskScore:   { increment: delta },
      reportCount: event === 'reported'   ? { increment: 1 } : undefined,
      blockCount:  event === 'blocked'    ? { increment: 1 } : undefined,
      spamFlags:   event === 'spam_flag'  ? { increment: 1 } : undefined,
    },
  });

  // Auto soft-ban if threshold crossed for the first time
  if (profile.riskScore >= SOFT_BAN_THRESHOLD && !profile.isSoftBanned) {
    await prisma.userRiskProfile.update({
      where: { userId },
      data: {
        isSoftBanned:  true,
        softBanReason: reason ?? `Auto-flagged: score ${profile.riskScore}`,
        softBannedAt:  new Date(),
      },
    });
  }
};

/**
 * Returns true if the user is soft-banned. Used to gate sensitive operations
 * (sending messages, unlocking chats) without a full account ban.
 */
export const isSoftBanned = async (userId: string): Promise<boolean> => {
  const profile = await prisma.userRiskProfile.findUnique({
    where:  { userId },
    select: { isSoftBanned: true },
  });
  return profile?.isSoftBanned ?? false;
};

/**
 * Spam guard: flag users who send more than N messages within a short window.
 * Called on each message send — uses a Redis-less sliding-window approach
 * via an in-memory map (good enough for single-instance; replace with Redis
 * sorted sets for multi-instance deployments).
 */
const messageCounts = new Map<string, { count: number; windowStart: number }>();
const SPAM_WINDOW_MS = 60_000; // 1 minute
const SPAM_THRESHOLD = 30;    // >30 messages/min = spam

export const checkMessageSpam = async (userId: string): Promise<boolean> => {
  const now = Date.now();
  const entry = messageCounts.get(userId);

  if (!entry || now - entry.windowStart > SPAM_WINDOW_MS) {
    messageCounts.set(userId, { count: 1, windowStart: now });
    return false;
  }

  entry.count++;
  if (entry.count > SPAM_THRESHOLD) {
    recordRiskEvent(userId, 'spam_flag', 'Exceeded message rate limit').catch(() => {});
    return true;
  }

  return false;
};
