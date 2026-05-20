import { flagsRedis } from '../flags/flag.cache';
import prisma from '../prisma.service';
import { SIGNAL_SCORES, hashIp } from './fraud.types';

// ── Redis sliding-window thresholds ──────────────────────────────────────────

const WINDOWS = {
  MESSAGES_PER_MIN:       { key: 'msgs1m',  ttl: 60,   max: 30  },
  MESSAGES_PER_HOUR:      { key: 'msgs1h',  ttl: 3600, max: 200 },
  UNIQUE_RECIPIENTS_HOUR: { key: 'rcpt1h',  ttl: 3600, max: 50  },
  IDENTICAL_MSGS:         { key: 'idmsg',   ttl: 3600, max: 10  },
  LIKES_PER_HOUR:         { key: 'likes1h', ttl: 3600, max: 500 },
  LOGINS_PER_HOUR:        { key: 'logins1h',ttl: 3600, max: 20  },
};

// ── Sliding-window counter (INCR + EXPIRE, not sorted-set — cheaper) ──────────

async function windowCount(userId: string, window: keyof typeof WINDOWS): Promise<number> {
  const w = WINDOWS[window];
  const key = `velvet:fraud:${w.key}:${userId}`;
  const count = await flagsRedis.incr(key);
  if (count === 1) await flagsRedis.expire(key, w.ttl);
  return count;
}

async function windowPeek(userId: string, window: keyof typeof WINDOWS): Promise<number> {
  const w = WINDOWS[window];
  const raw = await flagsRedis.get(`velvet:fraud:${w.key}:${userId}`);
  return raw ? parseInt(raw, 10) : 0;
}

// ── Identical message detection ───────────────────────────────────────────────
// Hash message text → count how many different users received the same text.

async function trackIdenticalMessage(userId: string, messageText: string): Promise<number> {
  // Simple djb2-style 32-bit hash (no crypto dep needed — not a security boundary)
  let hash = 5381;
  for (let i = 0; i < Math.min(messageText.length, 200); i++) {
    hash = ((hash * 33) ^ messageText.charCodeAt(i)) >>> 0;
  }
  const key = `velvet:fraud:idmsg:${userId}:${hash}`;
  const count = await flagsRedis.incr(key);
  if (count === 1) await flagsRedis.expire(key, WINDOWS.IDENTICAL_MSGS.ttl);
  return count;
}

// ── Bot timing detection ──────────────────────────────────────────────────────
// Human reaction time is typically > 200ms. A burst of actions < 100ms apart is robotic.

async function trackActionTiming(userId: string): Promise<boolean> {
  const key = `velvet:fraud:lastaction:${userId}`;
  const lastRaw = await flagsRedis.getset(key, String(Date.now()));
  await flagsRedis.expire(key, 10);

  if (!lastRaw) return false;
  const lastMs = parseInt(lastRaw, 10);
  return Date.now() - lastMs < 80; // < 80ms between actions = bot
}

// ── Public behavioral analysis API ───────────────────────────────────────────

export interface BehavioralSignals {
  isMsgSpam: boolean
  isMsgBot: boolean
  isLikeBot: boolean
  identicalMsgCount: number
  score: number
}

export async function analyzeMessageBehavior(
  userId: string,
  recipientId: string,
  messageText: string,
): Promise<BehavioralSignals> {
  const [msgsPerMin, msgsPerHour, identicalCount, isBotTiming] = await Promise.all([
    windowCount(userId, 'MESSAGES_PER_MIN'),
    windowCount(userId, 'MESSAGES_PER_HOUR'),
    trackIdenticalMessage(userId, messageText),
    trackActionTiming(userId),
  ]);

  // Track unique recipients (SADD to a set, not just a counter)
  const recipKey = `velvet:fraud:rcpt1h:${userId}`;
  await flagsRedis.sadd(recipKey, recipientId);
  await flagsRedis.expire(recipKey, 3600);
  const uniqueRecipients = await flagsRedis.scard(recipKey);

  const isMsgSpam =
    msgsPerMin > WINDOWS.MESSAGES_PER_MIN.max ||
    msgsPerHour > WINDOWS.MESSAGES_PER_HOUR.max ||
    uniqueRecipients > WINDOWS.UNIQUE_RECIPIENTS_HOUR.max ||
    identicalCount > WINDOWS.IDENTICAL_MSGS.max;

  const isMsgBot = isBotTiming || (msgsPerMin > WINDOWS.MESSAGES_PER_MIN.max * 2);

  let score = 0;
  if (isMsgSpam) score += SIGNAL_SCORES.BEHAVIORAL_SPAM;
  if (isMsgBot)  score += SIGNAL_SCORES.BEHAVIORAL_BOT;

  return { isMsgSpam, isMsgBot, isLikeBot: false, identicalMsgCount: identicalCount, score };
}

export async function analyzeLikeBehavior(userId: string): Promise<BehavioralSignals> {
  const [likesPerHour, isBotTiming] = await Promise.all([
    windowCount(userId, 'LIKES_PER_HOUR'),
    trackActionTiming(userId),
  ]);

  const isLikeBot = isBotTiming || likesPerHour > WINDOWS.LIKES_PER_HOUR.max;

  return {
    isMsgSpam: false,
    isMsgBot: false,
    isLikeBot,
    identicalMsgCount: 0,
    score: isLikeBot ? SIGNAL_SCORES.BEHAVIORAL_BOT : 0,
  };
}

export async function analyzeLoginBehavior(userId: string, ip: string): Promise<number> {
  const loginsPerHour = await windowCount(userId, 'LOGINS_PER_HOUR');

  // Unusual: >20 logins/hour = credential stuffing / account takeover attempt
  if (loginsPerHour > WINDOWS.LOGINS_PER_HOUR.max) {
    return SIGNAL_SCORES.BEHAVIORAL_BOT;
  }

  // Track IP velocity: how many different IPs used in last hour
  const ipKey = `velvet:fraud:login-ips:${userId}`;
  await flagsRedis.sadd(ipKey, hashIp(ip));
  await flagsRedis.expire(ipKey, 3600);
  const ipCount = await flagsRedis.scard(ipKey);

  // > 5 different IPs in an hour = suspicious (VPN switching, ATO attempt)
  if (ipCount > 5) return SIGNAL_SCORES.VPN_DATACENTER;

  return 0;
}

// ── Report velocity check ─────────────────────────────────────────────────────

export async function checkReportVelocity(userId: string): Promise<boolean> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const recentReports = await prisma.report.count({
    where: { reportedId: userId, createdAt: { gte: since } },
  });
  return recentReports >= 3;
}
