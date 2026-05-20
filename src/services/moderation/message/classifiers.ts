// ── Threat type classifiers ───────────────────────────────────────────────────
//
// Pure-function keyword/pattern classifiers for realtime path (<2ms each).
// Each returns a score 0.0–1.0. Zero = clean, 1.0 = high confidence threat.
//
// Design principles:
//   - No I/O, no async — must complete in <5ms total for all classifiers
//   - Deliberately conservative thresholds to minimize false positives
//   - Multilingual-safe: Unicode-normalized, handles Leetspeak/homoglyphs
//   - All patterns reviewed against common false-positive cases

// ── Normalisation helpers ─────────────────────────────────────────────────────

function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    // Common leetspeak / homoglyph substitutions
    .replace(/[@＠]/g, 'a')
    .replace(/[0]/g, 'o')
    .replace(/[1!|]/g, 'i')
    .replace(/[$]/g, 's')
    .replace(/[3]/g, 'e')
    .replace(/[4]/g, 'a')
    .replace(/\s+/g, ' ');
}

function matchKeywords(normalized: string, patterns: RegExp[]): number {
  let hits = 0;
  for (const p of patterns) {
    if (p.test(normalized)) hits++;
  }
  return Math.min(hits / patterns.length, 1.0);
}

// ── Escort / solicitation ─────────────────────────────────────────────────────

const ESCORT_PATTERNS: RegExp[] = [
  /\b(escort|call\s*girl|hooker|prostitut|sex\s*work|paid\s*sex)\b/,
  /\b(rates?|incall|outcall|full\s*service|nsa\s*fun)\b/,
  /\b(happy\s*ending|sensual\s*massage|adult\s*entertainment)\b/,
  /\b(meet\s+for\s+fun|fun\s+time\s+tonight|let['']?s\s+have\s+some\s+fun)\b/,
  /\b(looking\s+for\s+(sugar|arrangement|sponsor|benefactor))\b/,
  /\b(sugar\s+baby|sugar\s+daddy|arrangement\s+site)\b/,
];

export function scoreEscort(text: string): number {
  const n = normalize(text);
  const base = matchKeywords(n, ESCORT_PATTERNS);
  // Boost if combined with money mentions
  const moneyMention = /\b(\$|\£|\€|usd|gbp|eur|per\s+hour|per\s+session)\b/.test(n);
  return Math.min(base + (moneyMention ? 0.3 : 0), 1.0);
}

// ── Crypto / investment scam ──────────────────────────────────────────────────

const CRYPTO_SCAM_PATTERNS: RegExp[] = [
  /\b(bitcoin|btc|eth|ethereum|usdt|crypto|nft)\b/,
  /\b(invest|trading|profit|return|roi|passive\s+income)\b/,
  /\b(double\s+your|10x|100x|guaranteed\s+(return|profit|gain))\b/,
  /\b(pump|airdrop|mining\s+pool|cloud\s+mining|yield\s+farm)\b/,
  /\b(send\s+me\s+(money|bitcoin|eth)|transfer\s+funds?)\b/,
  /\b(my\s+(broker|platform|scheme|program))\b/,
];

export function scoreCryptoScam(text: string): number {
  const n = normalize(text);
  let score = matchKeywords(n, CRYPTO_SCAM_PATTERNS);
  // High confidence if combines money promise + crypto name
  const hasCrypto  = /\b(bitcoin|btc|eth|ethereum|usdt|crypto)\b/.test(n);
  const hasPromise = /\b(guaranteed|double|profit|invest)\b/.test(n);
  if (hasCrypto && hasPromise) score = Math.max(score, 0.75);
  return Math.min(score, 1.0);
}

// ── Spam / bulk messaging ─────────────────────────────────────────────────────

const SPAM_PATTERNS: RegExp[] = [
  /\b(click\s+here|limited\s+offer|act\s+now|don['']?t\s+miss)\b/,
  /\b(free\s+(gift|trial|sample)|win\s+(an?|the)?)\b/,
  /\b(verify\s+your\s+account|confirm\s+your\s+details)\b/,
  /\b(earn\s+(money|cash|income)\s+(from\s+home|online))\b/,
  /\b(promo\s*code|discount\s*code|coupon\s*code)\b/,
];

export function scoreSpam(text: string): number {
  return matchKeywords(normalize(text), SPAM_PATTERNS);
}

// ── Harassment / toxic language ───────────────────────────────────────────────
// Conservative — only high-severity slurs and direct threats.
// Mild rudeness is NOT flagged to avoid over-moderation.

const HARASSMENT_PATTERNS: RegExp[] = [
  /\b(kill\s+(your)?self|kys|go\s+die|i['']?ll\s+(kill|hurt|rape|find)\s+you)\b/,
  /\b(stupid\s+bitch|dumb\s+whore|fucking\s+slut|piece\s+of\s+shit)\b/,
  /\b(i\s+know\s+where\s+you\s+live|i\s+will\s+come\s+for\s+you)\b/,
  /\b(doxx|doxing|leak\s+your\s+(address|photos|nudes))\b/,
];

export function scoreHarassment(text: string): number {
  return matchKeywords(normalize(text), HARASSMENT_PATTERNS);
}

// ── Underage risk ─────────────────────────────────────────────────────────────

const UNDERAGE_PATTERNS: RegExp[] = [
  /\b(i['']?m\s+1[0-7]\s+years?\s+old|i['']?m\s+[1-9]\s+years?\s+old)\b/,
  /\b(minor|underage|jailbait|barely\s+legal|lolita)\b/,
  /\b(how\s+old\s+are\s+you[?]?)\s*\n*.*(1[0-5])\b/,  // asking age, then low number
  /\b(teen\s+sex|preteen|child\s+model|cp\b)\b/,
];

export function scoreUnderageRisk(text: string): number {
  const n = normalize(text);
  // Any match is high-risk; immediately return elevated score
  for (const p of UNDERAGE_PATTERNS) {
    if (p.test(n)) return 0.9;
  }
  return 0;
}

// ── Grooming patterns ─────────────────────────────────────────────────────────

const GROOMING_PATTERNS: RegExp[] = [
  /\b(don['']?t\s+tell\s+(your|anyone|parents?)|keep\s+this\s+(secret|between\s+us))\b/,
  /\b(special\s+relationship|only\s+(i|we)\s+understand|no\s+one\s+understands\s+you)\b/,
  /\b(buy\s+you\s+(gifts?|things?|anything)|treat\s+you\s+like\s+a\s+princess)\b/,
  /\b(you['']?re\s+(so\s+)?(mature|special)\s+for\s+your\s+age)\b/,
];

export function scoreGrooming(text: string): number {
  return matchKeywords(normalize(text), GROOMING_PATTERNS);
}

// ── Bot / gibberish detection ─────────────────────────────────────────────────

export function scoreBotPattern(text: string): number {
  // Very short repeat runs: "aaaaaaa", "hahahaha", nonsense
  const repeatRun = /(.)\1{8,}/.test(text);
  // All caps with no punctuation
  const allCaps   = text.length > 20 && text === text.toUpperCase() && !/[.!?,]/.test(text);
  // Char-class ratio: too many numbers or special chars for natural language
  const numRatio  = (text.match(/\d/g) ?? []).length / Math.max(text.length, 1);

  let score = 0;
  if (repeatRun) score += 0.4;
  if (allCaps)   score += 0.2;
  if (numRatio > 0.5) score += 0.3;
  return Math.min(score, 0.9); // Never 1.0 alone — needs human review
}

// ── Aggregated realtime scorer ────────────────────────────────────────────────

import type { ModerationSignal } from '../../trust/trust.types';

export interface ClassificationResult {
  signals:   ModerationSignal[];
  topScore:  number;
  topType:   string;
}

export function classifyMessage(text: string): ClassificationResult {
  const checks: Array<{ type: string; score: number }> = [
    { type: 'ESCORT_SOLICITATION', score: scoreEscort(text)        },
    { type: 'CRYPTO_SCAM',         score: scoreCryptoScam(text)     },
    { type: 'SPAM_BULK',           score: scoreSpam(text)           },
    { type: 'HARASSMENT',          score: scoreHarassment(text)     },
    { type: 'UNDERAGE_RISK',       score: scoreUnderageRisk(text)   },
    { type: 'GROOMING_PATTERN',    score: scoreGrooming(text)       },
    { type: 'BOT_PATTERN',         score: scoreBotPattern(text)     },
  ];

  const signals: ModerationSignal[] = checks
    .filter((c) => c.score > 0.2)
    .map((c) => ({ type: c.type, score: c.score, detail: `${c.type} score: ${c.score.toFixed(2)}` }));

  const top = checks.reduce((a, b) => (b.score > a.score ? b : a), { type: 'CLEAN', score: 0 });

  return { signals, topScore: top.score, topType: top.type };
}
