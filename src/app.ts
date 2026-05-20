import './config/env';

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { getCorsOrigins } from './config/env';
import path from 'path';
import pinoHttp from 'pino-http';
import routes from './routes';
import { errorHandler } from './middleware/error.middleware';
import { requestIdMiddleware } from './middleware/requestId.middleware';
import { validateSignedUrl } from './middleware/signedUrl.middleware';
import { metricsMiddleware } from './middleware/metrics.middleware';
import { deviceMiddleware } from './middleware/device.middleware';
import { logger } from './observability/logger';
import { initSentry, Sentry } from './observability/sentry';
import { registry } from './observability/metrics';
import { healthCheck, readinessCheck, livenessCheck } from './observability/health';
import { ipBlocklistGuard, detectSuspiciousPatterns, sanitizeBody } from './middleware/requestValidator';
import { globalLimiter, authLimiter, paymentLimiter, uploadLimiter } from './middleware/security';

// ── Sentry must be initialised before any other middleware ────────────────────
initSentry();

const app = express();


// ── Request tracing ───────────────────────────────────────────────────────────
app.use(requestIdMiddleware);

// ── Structured HTTP logging (pino-http) ───────────────────────────────────────
app.use(
  pinoHttp({
    logger,
    genReqId: (req) => (req as any).requestId,
    customLogLevel: (_req, res) => {
      if (res.statusCode >= 500) return 'error';
      if (res.statusCode >= 400) return 'warn';
      return 'info';
    },
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url,
          ip: req.remoteAddress,
          userAgent: req.headers['user-agent'],
        };
      },
      res(res) {
        return { statusCode: res.statusCode };
      },
    },
    // Don't log health/metrics probes — they're high-frequency and low-value
    autoLogging: {
      ignore: (req) => ['/health', '/ready', '/live', '/metrics'].includes(req.url ?? ''),
    },
  }),
);

// ── Security headers ──────────────────────────────────────────────────────────
app.use(helmet());
app.use(cors({ origin: getCorsOrigins(), credentials: true }));

// ── Abuse protection — IP blocklist and suspicious pattern detection ──────────
// Must come before body parsing so scanners are rejected cheaply
app.use(ipBlocklistGuard as express.RequestHandler);
app.use(detectSuspiciousPatterns as express.RequestHandler);

// Webhook routes need raw body for signature verification — must come BEFORE json middleware
app.use('/api/payments/webhooks', express.raw({ type: '*/*', limit: '1mb' }));
app.use(express.json({ limit: '2mb' }));

// ── Body sanitization (remove NoSQL injection keys) ───────────────────────────
app.use(sanitizeBody);

// ── Device fingerprint extraction (attaches req.device to every request) ──────
app.use(deviceMiddleware);

// ── Prometheus metrics collection ─────────────────────────────────────────────
app.use(metricsMiddleware);

// ── Rate limiting — single authoritative source (security.ts) ─────────────────
// globalLimiter:  200 req / 15 min  (general API)
// authLimiter:     10 req / 15 min  (login + register)
// paymentLimiter:  20 req / 60 s   (payment intents + checkout)
// uploadLimiter:   30 req / 60 min  (media uploads)
app.use('/api', globalLimiter);
app.use('/api/auth/login',    authLimiter);
app.use('/api/auth/register', authLimiter);
app.use('/api/chat/unlock',   paymentLimiter);
app.use('/api/photos',        uploadLimiter);
app.use('/api/wallet',        paymentLimiter);
app.use('/api/payments/intent',    paymentLimiter);
app.use('/api/payments/checkout',  paymentLimiter);

// ── Static uploads (signed-URL validation for private photos) ─────────────────
app.use('/uploads', validateSignedUrl, express.static(path.join(__dirname, '..', 'uploads')));

// ── Observability endpoints ───────────────────────────────────────────────────
// Prometheus scrape endpoint — token-protected; set METRICS_TOKEN env var for the scraper
app.get('/metrics', async (req, res) => {
  const token = process.env.METRICS_TOKEN;
  if (token) {
    const provided = req.headers['authorization']?.replace('Bearer ', '');
    if (provided !== token) {
      res.status(401).end();
      return;
    }
  }
  res.set('Content-Type', registry.contentType);
  res.end(await registry.metrics());
});

app.get('/health', healthCheck);
app.get('/ready', readinessCheck);
app.get('/live', livenessCheck);

// ── API routes ────────────────────────────────────────────────────────────────
app.use('/api', routes);

// ── Sentry error handler (must come after routes, before custom error handler) ─
// Captures unhandled Express errors and sends them to Sentry before our handler runs
if (process.env.SENTRY_DSN) {
  Sentry.setupExpressErrorHandler(app);
}

// ── Global error handler ──────────────────────────────────────────────────────
app.use(errorHandler);

export default app;
