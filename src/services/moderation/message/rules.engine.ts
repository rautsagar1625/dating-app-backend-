// ── Realtime message rules engine ────────────────────────────────────────────
//
// Synchronous path — runs BEFORE the message is stored.
// Must complete in <10ms: no DB reads, no network calls.
// Uses only Redis counters (lazy, non-blocking on failure).
//
// Decision ladder:
//   riskScore ≥ 80 → SUPPRESS  (don't store, return 403 to sender)
//   riskScore ≥ 60 → SHADOW    (store silently, don't deliver)
//   riskScore ≥ 35 → WARN      (store, send in-app warning to sender)
//   riskScore < 35 → CLEAN     (pass through)
//
// Underage risk is always SUPPRESS regardless of score.

import IORedis from 'ioredis';
import { extractContacts } from './extractors';
import { classifyMessage } from './classifiers';
import type { RealtimeModerationResult, ModerationSignal } from '../../trust/trust.types';

const redis = new IORedis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
  maxRetriesPerRequest: 1, // fail fast — can't block message send
  lazyConnect: true,
  connectTimeout: 500,
});
redis.connect().catch(() => {});

// ── Repetition detection (Redis sliding window) ───────────────────────────────
//
// Tracks a rolling hash of recent messages per sender.
// If the same content is sent ≥ 3× in 30min → spam signal.

function msgHash(text: string): string {
  // Simple djb2 — no crypto needed here, just a fast content fingerprint
  let h = 5381;
  for (let i = 0; i < text.length; i++) {
    h = (h * 33) ^ text.charCodeAt(i);
  }
  return (h >>> 0).toString(16);
}

async function checkRepetition(senderId: string, text: string): Promise<number> {
  const key  = `velvet:msg:rep:${senderId}:${msgHash(text)}`;
  const ttl  = 30 * 60; // 30 minutes window
  try {
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, ttl);
    if (count >= 5)  return 0.9;  // definite spam
    if (count >= 3)  return 0.6;  // probable spam
    return 0;
  } catch {
    return 0; // Redis down — don't block sends
  }
}

// ── Message velocity check ────────────────────────────────────────────────────
// >30 messages in 5 minutes = bot behavior

async function checkVelocity(senderId: string): Promise<number> {
  const key = `velvet:msg:vel:${senderId}`;
  try {
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, 300); // 5-min window
    if (count > 50) return 0.9;
    if (count > 30) return 0.6;
    return 0;
  } catch {
    return 0;
  }
}

// ── Score → action mapping ────────────────────────────────────────────────────

function scoreToAction(
  score: number,
  signals: ModerationSignal[],
): RealtimeModerationResult['action'] {
  // Underage risk always suppresses, no threshold
  if (signals.some((s) => s.type === 'UNDERAGE_RISK' && s.score > 0.5)) return 'SUPPRESS';
  if (score >= 80) return 'SUPPRESS';
  if (score >= 60) return 'SHADOW';
  if (score >= 35) return 'WARN';
  return 'CLEAN';
}

// ── Main evaluate ─────────────────────────────────────────────────────────────

export async function evaluateMessage(
  text:     string,
  senderId: string,
  chatId:   string,
): Promise<RealtimeModerationResult> {
  const signals: ModerationSignal[] = [];

  // 1. Keyword classifiers (pure sync)
  const classification = classifyMessage(text);
  signals.push(...classification.signals);

  // 2. Contact extraction
  const extraction = extractContacts(text);
  if (extraction.totalScore > 0.2) {
    signals.push({
      type:   'CONTACT_EXTRACTION',
      score:  extraction.totalScore,
      detail: `Platforms: ${extraction.platformRefs.join(', ')||'phone/email'}`,
    });
  }

  // 3. Async Redis checks (fail-safe: won't block if Redis is down)
  const [repScore, velScore] = await Promise.all([
    checkRepetition(senderId, text),
    checkVelocity(senderId),
  ]);

  if (repScore > 0)  signals.push({ type: 'SPAM_REPETITION', score: repScore, detail: 'Repeated message detected' });
  if (velScore > 0)  signals.push({ type: 'BOT_PATTERN',    score: velScore, detail: 'Message velocity too high' });

  // 4. Compute composite risk score (0-100)
  // Highest single signal drives the score — not average (avoids diluting real threats)
  const maxSignalScore = signals.reduce((m, s) => Math.max(m, s.score), 0);
  // Escalate if multiple medium signals co-occur
  const mediumCount    = signals.filter((s) => s.score >= 0.4).length;
  const coOccurBoost   = mediumCount >= 2 ? 15 : 0;
  const riskScore      = Math.min(Math.round(maxSignalScore * 100 + coOccurBoost), 100);

  const action = scoreToAction(riskScore, signals);

  const topSignal = signals.sort((a, b) => b.score - a.score)[0];
  const explanation = topSignal
    ? `${topSignal.type} (${(topSignal.score * 100).toFixed(0)}% confidence)${signals.length > 1 ? ` +${signals.length - 1} other signals` : ''}`
    : 'No threats detected';

  return {
    riskScore,
    action,
    signals,
    contactsFound: extraction.totalScore > 0.2,
    explanation,
  };
}
