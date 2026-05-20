import { Request, Response, NextFunction } from 'express';
import IORedis from 'ioredis';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
const validatorRedis = new IORedis(REDIS_URL, {
  maxRetriesPerRequest: 1,
  lazyConnect: true,
  enableReadyCheck: false,
});
validatorRedis.connect().catch(() => {});

// ── Content-Type validation ───────────────────────────────────────────────────

export function validateContentType(allowedTypes: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (['GET', 'HEAD', 'DELETE', 'OPTIONS'].includes(req.method)) return next();
    const ct = req.headers['content-type']?.split(';')[0].trim() ?? '';
    if (!allowedTypes.some((t) => ct === t || ct.includes(t))) {
      res.status(415).json({ success: false, message: `Unsupported Content-Type: ${ct || '(none)'}` });
      return;
    }
    next();
  };
}

// ── Oversized payload rejection ───────────────────────────────────────────────

export function rejectOversizedPayloads(maxBytes: number) {
  return (req: Request, res: Response, next: NextFunction) => {
    const contentLength = parseInt(req.headers['content-length'] ?? '0', 10);
    if (contentLength > maxBytes) {
      res.status(413).json({
        success: false,
        message: `Payload too large. Maximum allowed: ${maxBytes} bytes`,
      });
      return;
    }
    next();
  };
}

// ── Suspicious pattern detection ──────────────────────────────────────────────

const SQLI_PATTERNS = [
  /'\s*OR\s*['"\d]/i,
  /UNION\s+SELECT/i,
  /;\s*DROP\s+TABLE/i,
  /;\s*DELETE\s+FROM/i,
  /SLEEP\s*\(\s*\d+\s*\)/i,
  /BENCHMARK\s*\(/i,
  /WAITFOR\s+DELAY/i,
  /xp_cmdshell/i,
];

const PATH_TRAVERSAL = [/\.\.\//g, /\.\.\\/g, /%2e%2e[/\\]/gi, /%252e/gi];

const SCANNER_USER_AGENTS = [
  'sqlmap', 'nikto', 'nmap', 'masscan', 'acunetix',
  'nessus', 'burpsuite', 'hydra', 'dirbuster', 'gobuster',
  'wfuzz', 'nuclei', 'openvas',
];

function flatten(obj: unknown, depth = 0): string {
  if (depth > 6) return '';
  if (typeof obj === 'string') return obj;
  if (typeof obj === 'number') return String(obj);
  if (!obj || typeof obj !== 'object') return '';
  return Object.values(obj as Record<string, unknown>)
    .map((v) => flatten(v, depth + 1))
    .join(' ');
}

export async function detectSuspiciousPatterns(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const ua = (req.headers['user-agent'] ?? '').toLowerCase();
  const payload = `${flatten(req.body)} ${flatten(req.query)} ${req.path}`;
  const ip = req.ip ?? '';

  const isScannerUa = SCANNER_USER_AGENTS.some((s) => ua.includes(s));
  const hasSqli     = SQLI_PATTERNS.some((p) => p.test(payload));
  const hasTraversal = PATH_TRAVERSAL.some((p) => p.test(payload));

  if (isScannerUa || hasSqli || hasTraversal) {
    if (ip) {
      const abuseKey = `abuse:${ip}`;
      const count    = await validatorRedis.incr(abuseKey).catch(() => 1);
      await validatorRedis.expire(abuseKey, 3600).catch(() => {});

      if (count >= 10) {
        await validatorRedis.setex(`blocked:ip:${ip}`, 86400, '1').catch(() => {});
      }
    }
    res.status(400).json({ success: false, message: 'Bad request' });
    return;
  }

  next();
}

// ── IP blocklist guard ────────────────────────────────────────────────────────

export async function ipBlocklistGuard(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const ip = req.ip ?? '';
  if (!ip) { next(); return; }

  const blocked = await validatorRedis.get(`blocked:ip:${ip}`).catch(() => null);
  if (blocked) {
    res.status(403).json({ success: false, message: 'Forbidden' });
    return;
  }
  next();
}

// ── Body sanitization (NoSQL injection protection) ────────────────────────────

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function sanitizeObj(obj: unknown, depth = 0): unknown {
  if (depth > 10 || !obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map((v: unknown) => sanitizeObj(v, depth + 1));
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (k.startsWith('$') || DANGEROUS_KEYS.has(k)) continue;
    clean[k] = typeof v === 'object' ? sanitizeObj(v, depth + 1) : v;
  }
  return clean;
}

export function sanitizeBody(req: Request, _res: Response, next: NextFunction): void {
  if (req.body && typeof req.body === 'object') {
    req.body = sanitizeObj(req.body);
  }
  next();
}

// ── Composite security suite ──────────────────────────────────────────────────

export const securitySuite = [
  ipBlocklistGuard,
  detectSuspiciousPatterns,
  validateContentType(['application/json']),
];
