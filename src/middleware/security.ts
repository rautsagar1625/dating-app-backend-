import { Application, Request, Response, NextFunction } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import crypto from 'crypto';
import IORedis from 'ioredis';
import { getCorsOrigins, env } from '../config/env';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
const securityRedis = new IORedis(REDIS_URL, {
  maxRetriesPerRequest: 1,
  lazyConnect: true,
  enableReadyCheck: false,
});
securityRedis.connect().catch(() => {});

// ── Helmet ────────────────────────────────────────────────────────────────────

function configureHelmet(app: Application) {
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc:     ["'none'"],
          scriptSrc:      ["'none'"],
          styleSrc:       ["'none'"],
          imgSrc:         ["'none'"],
          connectSrc:     ["'none'"],
          fontSrc:        ["'none'"],
          objectSrc:      ["'none'"],
          mediaSrc:       ["'none'"],
          frameSrc:       ["'none'"],
        },
      },
      hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
      noSniff: true,
      xssFilter: true,
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
      permittedCrossDomainPolicies: false,
    }),
  );
}

// ── CORS ──────────────────────────────────────────────────────────────────────

function configureCors(app: Application) {
  const origins = getCorsOrigins();
  app.use(
    cors({
      origin: (origin, cb) => {
        if (!origin) return cb(null, true); // server-to-server / curl
        if (origins.includes('*') || origins.includes(origin)) return cb(null, true);
        cb(new Error(`CORS: origin ${origin} not allowed`));
      },
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-ID', 'X-Idempotency-Key'],
      exposedHeaders: ['X-Request-ID', 'X-RateLimit-Remaining'],
    }),
  );
}

// ── Rate limiters ─────────────────────────────────────────────────────────────

export const globalLimiter = rateLimit({
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  max:      env.RATE_LIMIT_MAX_REQUESTS,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { success: false, message: 'Too many requests, please try again later.' },
});

export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,  // 15 minutes
  max:      10,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { success: false, message: 'Too many auth attempts, please try again in 15 minutes.' },
  skipSuccessfulRequests: false,
});

export const paymentLimiter = rateLimit({
  windowMs: 60 * 1000,
  max:      20,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { success: false, message: 'Too many payment requests.' },
});

export const uploadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,  // 1 hour
  max:      30,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { success: false, message: 'Upload limit reached. Try again in an hour.' },
});

export const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max:      200,
  keyGenerator: (req) => (req as any).user?.userId ?? req.ip ?? 'anon',
  standardHeaders: true,
  legacyHeaders:   false,
  message: { success: false, message: 'API rate limit exceeded.' },
});

// ── Request ID ────────────────────────────────────────────────────────────────

export function requestId(req: Request, res: Response, next: NextFunction) {
  const id = (req.headers['x-request-id'] as string) || crypto.randomUUID();
  (req as any).requestId = id;
  res.setHeader('X-Request-ID', id);
  next();
}

// ── SSRF protection ───────────────────────────────────────────────────────────

const PRIVATE_IP_PATTERNS = [
  /^10\.\d+\.\d+\.\d+$/,
  /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/,
  /^192\.168\.\d+\.\d+$/,
  /^127\.\d+\.\d+\.\d+$/,
  /^169\.254\.\d+\.\d+$/,
  /^::1$/,
  /^fc[0-9a-f]{2}:/i,
  /^fe80:/i,
];

const BLOCKED_HOSTS = ['169.254.169.254', 'metadata.google.internal', 'metadata.aws.internal'];

function isPrivateTarget(value: string): boolean {
  try {
    const url = new URL(value);
    const host = url.hostname;
    if (BLOCKED_HOSTS.includes(host)) return true;
    return PRIVATE_IP_PATTERNS.some((p) => p.test(host));
  } catch {
    return false;
  }
}

function extractUrls(obj: unknown, depth = 0): string[] {
  if (depth > 5 || !obj || typeof obj !== 'object') return [];
  const urls: string[] = [];
  for (const v of Object.values(obj as Record<string, unknown>)) {
    if (typeof v === 'string' && (v.startsWith('http://') || v.startsWith('https://'))) {
      urls.push(v);
    } else if (typeof v === 'object') {
      urls.push(...extractUrls(v, depth + 1));
    }
  }
  return urls;
}

export function blockSsrfTargets(req: Request, res: Response, next: NextFunction) {
  const candidates = [
    ...extractUrls(req.body),
    ...extractUrls(req.query),
    ...Object.values(req.query).filter((v): v is string => typeof v === 'string'),
  ];

  for (const candidate of candidates) {
    if (isPrivateTarget(candidate)) {
      res.status(400).json({ success: false, message: 'Invalid request' });
      return;
    }
  }
  next();
}

// ── Body sanitization ─────────────────────────────────────────────────────────

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function sanitizeObj(obj: unknown, depth = 0): unknown {
  if (depth > 10 || !obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map((v) => sanitizeObj(v, depth + 1));
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (k.startsWith('$') || DANGEROUS_KEYS.has(k)) continue;
    clean[k] = typeof v === 'object' ? sanitizeObj(v, depth + 1) : v;
  }
  return clean;
}

export function sanitizeBody(req: Request, _res: Response, next: NextFunction) {
  if (req.body && typeof req.body === 'object') {
    req.body = sanitizeObj(req.body);
  }
  next();
}

// ── IP blocklist guard ────────────────────────────────────────────────────────

export async function ipBlocklistGuard(req: Request, res: Response, next: NextFunction) {
  const ip = req.ip ?? '';
  if (!ip) return next();

  const blocked = await securityRedis.get(`blocked:ip:${ip}`).catch(() => null);
  if (blocked) {
    res.status(403).json({ success: false, message: 'Forbidden' });
    return;
  }
  next();
}

// ── Suspicious pattern detection ──────────────────────────────────────────────

const SQLI_PATTERNS   = [/'\s*OR\s*['"\d]/i, /UNION\s+SELECT/i, /--\s*$/, /;\s*DROP\s/i, /SLEEP\s*\(/i, /BENCHMARK\s*\(/i];
const PATH_TRAVERSAL  = [/\.\.\//, /\.\.\\/, /%2e%2e/i, /\.\.%2f/i];
const SCANNER_UA      = ['sqlmap', 'nikto', 'nmap', 'masscan', 'acunetix', 'nessus', 'burpsuite', 'hydra'];

function stringifyForScan(obj: unknown): string {
  try { return JSON.stringify(obj) ?? ''; } catch { return ''; }
}

export async function detectSuspiciousPatterns(req: Request, res: Response, next: NextFunction) {
  const ua = (req.headers['user-agent'] ?? '').toLowerCase();
  const payload = `${stringifyForScan(req.body)} ${stringifyForScan(req.query)} ${req.path}`;
  const ip = req.ip ?? '';

  const isScannerUa = SCANNER_UA.some((s) => ua.includes(s));
  const hasSqli     = SQLI_PATTERNS.some((p) => p.test(payload));
  const hasTraversal = PATH_TRAVERSAL.some((p) => p.test(payload));

  if (isScannerUa || hasSqli || hasTraversal) {
    if (ip) {
      const key   = `abuse:${ip}`;
      const count = await securityRedis.incr(key).catch(() => 1);
      await securityRedis.expire(key, 3600).catch(() => {});

      if (count >= 10) {
        await securityRedis.setex(`blocked:ip:${ip}`, 86400, '1').catch(() => {});
      }
    }
    res.status(400).json({ success: false, message: 'Bad request' });
    return;
  }
  next();
}

// ── Slow-down for auth routes ─────────────────────────────────────────────────
// Progressive delay after 5 requests from same IP

export function authSlowDown(req: Request, res: Response, next: NextFunction) {
  const ip = req.ip ?? 'anon';
  const key = `slowdown:auth:${ip}`;

  securityRedis.incr(key).then((count) => {
    securityRedis.expire(key, 900).catch(() => {}); // 15 min window

    if (count > 5) {
      const delayMs = Math.min((count - 5) * 500, 10000); // max 10s
      setTimeout(next, delayMs);
    } else {
      next();
    }
  }).catch(() => next());
}

// ── Composite security suite export ──────────────────────────────────────────

export const securitySuite = [ipBlocklistGuard, detectSuspiciousPatterns, sanitizeBody];

// ── Apply all security middleware ─────────────────────────────────────────────

export function applySecurityMiddleware(app: Application) {
  configureHelmet(app);
  configureCors(app);
  app.use(requestId);
  app.use(sanitizeBody);
  app.use(globalLimiter);
}
