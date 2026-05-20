// ── Contact & off-platform extraction ────────────────────────────────────────
//
// Detects attempts to move conversations off-platform:
//   - phone numbers (international formats)
//   - email addresses
//   - external URLs / deep links
//   - social handles (WhatsApp, Telegram, Instagram, Snapchat, etc.)
//
// Returns signal score based on how explicit the extraction attempt is.
// We do NOT store the extracted values — only signal presence (GDPR-conscious).

export interface ExtractionResult {
  hasPhone:      boolean;
  hasEmail:      boolean;
  hasUrl:        boolean;
  hasSocialRef:  boolean;
  platformRefs:  string[];   // which platforms were mentioned
  totalScore:    number;     // 0.0–1.0
}

// ── Phone number patterns ─────────────────────────────────────────────────────
// Covers obfuscated variants: (555) 123-4567, 555.123.4567, +91 9876543210,
// digit-separated: 5 5 5 1 2 3 4 5 6 7 (with spaces/dots)

const PHONE_RE = /(?:\+?[\d\s\-().]{7,20}(?<!\s))/g;

// Tighter: must have contiguous digit run ≥ 7 after stripping separators
function looksLikePhone(text: string): boolean {
  const stripped = text.replace(/[\s\-()+.]/g, '');
  return /\d{7,}/.test(stripped) && PHONE_RE.test(text);
}

// ── Email pattern ─────────────────────────────────────────────────────────────
const EMAIL_RE = /[a-zA-Z0-9._%+\-]+\s*[@＠]\s*[a-zA-Z0-9.\-]+\s*\.\s*[a-zA-Z]{2,}/;

// ── URL / external link ───────────────────────────────────────────────────────
// Catches http(s), bare domains, intentionally obfuscated "dot com" spellings
const URL_RE =
  /(?:https?:\/\/|www\.)\S+|(?:[a-zA-Z0-9\-]+\.(?:com|net|org|io|me|app|link|xyz)(?:\/\S*)?)/i;

// "dot com" obfuscation
const OBFUSCATED_URL_RE = /\bdot\s+com\b|\bwww\s+dot\b/i;

// ── Social handle / platform references ──────────────────────────────────────

const SOCIAL_KEYWORDS: Record<string, RegExp> = {
  whatsapp:  /\bwhats\s*app\b|wapp\b|wa\.me\b/i,
  telegram:  /\btelegram\b|\bt\.me\b|\btg\s*id\b/i,
  instagram: /\binstagram\b|\binsta\b|\bIG\b/,
  snapchat:  /\bsnapchat\b|\bsnap\b(?:\s+me)?/i,
  kik:       /\bkik\b/i,
  wechat:    /\bwechat\b|\bweixin\b/i,
  skype:     /\bskype\b/i,
  discord:   /\bdiscord\b/i,
  line:      /\bline\s+app\b|\bline\s+id\b/i,
  signal:    /\bsignal\s+app\b|\bsignal\s+me\b/i,
};

// At-handle extraction (e.g. @username, add me on IG: somehandle)
const HANDLE_RE = /(?:^|\s)@[a-zA-Z0-9_.]{3,}/;

// ── Main extractor ────────────────────────────────────────────────────────────

export function extractContacts(text: string): ExtractionResult {
  const t = text.toLowerCase();

  const hasPhone     = looksLikePhone(text);
  const hasEmail     = EMAIL_RE.test(text);
  const hasUrl       = URL_RE.test(text) || OBFUSCATED_URL_RE.test(t);
  const platformRefs: string[] = [];

  for (const [platform, re] of Object.entries(SOCIAL_KEYWORDS)) {
    if (re.test(t)) platformRefs.push(platform);
  }

  const hasSocialRef = platformRefs.length > 0 || HANDLE_RE.test(text);

  // Score: each signal type contributes independently
  let score = 0;
  if (hasPhone)    score += 0.4;
  if (hasEmail)    score += 0.4;
  if (hasUrl)      score += 0.2;
  if (hasSocialRef) score += Math.min(0.3 + platformRefs.length * 0.1, 0.5);

  return {
    hasPhone,
    hasEmail,
    hasUrl,
    hasSocialRef,
    platformRefs,
    totalScore: Math.min(score, 1.0),
  };
}
