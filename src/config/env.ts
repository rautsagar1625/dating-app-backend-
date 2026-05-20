import 'dotenv/config';
import { z } from 'zod';

// ── Environment schema ────────────────────────────────────────────────────────

// z.coerce.number() handles string → number coercion from process.env
const portStr = z.coerce.number().int().positive();

// Boolean strings from env: 'true'/'1' → true, 'false'/'0' → false
const boolStr = z
  .string()
  .transform((v: string) => v === 'true' || v === '1')
  .pipe(z.boolean());

const envSchema = z.object({
  // ── App ───────────────────────────────────────────────────────────────────
  NODE_ENV:    z.enum(['local', 'development', 'staging', 'production']).default('local'),
  PORT:        portStr.default(3002),
  APP_URL:     z.string().url(),
  API_VERSION: z.string().default('v1'),

  // ── Database ──────────────────────────────────────────────────────────────
  DATABASE_URL:              z.string().min(10),
  DB_POOL_MIN:               portStr.default(2),
  DB_POOL_MAX:               portStr.default(20),
  DB_STATEMENT_TIMEOUT_MS:   portStr.default(10000),

  // ── Redis ─────────────────────────────────────────────────────────────────
  REDIS_URL:         z.string().min(5),
  REDIS_TLS_ENABLED: boolStr.default(false),
  REDIS_KEY_PREFIX:  z.string().default('velvet:'),

  // ── JWT ───────────────────────────────────────────────────────────────────
  JWT_ACCESS_SECRET:   z.string().min(32),
  JWT_REFRESH_SECRET:  z.string().min(32),
  JWT_ACCESS_EXPIRES:  z.string().default('15m'),
  JWT_REFRESH_EXPIRES: z.string().default('30d'),

  // ── AWS ───────────────────────────────────────────────────────────────────
  AWS_REGION:                z.string(),
  AWS_ACCESS_KEY_ID:         z.string(),
  AWS_SECRET_ACCESS_KEY:     z.string(),
  S3_MEDIA_BUCKET:           z.string(),
  S3_PRIVATE_BUCKET:         z.string(),
  CLOUDFRONT_DOMAIN:         z.string(),
  CLOUDFRONT_KEY_PAIR_ID:    z.string(),
  CLOUDFRONT_PRIVATE_KEY:    z.string(),

  // ── Stripe ────────────────────────────────────────────────────────────────
  STRIPE_SECRET_KEY:    z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  STRIPE_API_VERSION:   z.string().default('2024-06-20'),

  // ── Razorpay ──────────────────────────────────────────────────────────────
  RAZORPAY_KEY_ID:         z.string().optional(),
  RAZORPAY_KEY_SECRET:     z.string().optional(),
  RAZORPAY_WEBHOOK_SECRET: z.string().optional(),

  // ── Apple IAP ─────────────────────────────────────────────────────────────
  APPLE_BUNDLE_ID:      z.string().optional(),
  APPLE_IAP_SHARED_SECRET: z.string().optional(),
  APPLE_KEY_ID:         z.string().optional(),
  APPLE_ISSUER_ID:      z.string().optional(),
  APPLE_PRIVATE_KEY:    z.string().optional(),

  // ── Google Play ───────────────────────────────────────────────────────────
  GOOGLE_SERVICE_ACCOUNT_EMAIL: z.string().email().optional(),
  GOOGLE_PRIVATE_KEY:           z.string().optional(),
  GOOGLE_PACKAGE_NAME:          z.string().optional(),

  // ── Sentry ────────────────────────────────────────────────────────────────
  SENTRY_DSN:         z.string().optional(),
  SENTRY_ENVIRONMENT: z.string().optional(),

  // ── Feature flags ─────────────────────────────────────────────────────────
  LAUNCH_DARK_SDK_KEY: z.string().optional(),

  // ── Rate limiting ─────────────────────────────────────────────────────────
  RATE_LIMIT_WINDOW_MS:    portStr.default(60000),
  RATE_LIMIT_MAX_REQUESTS: portStr.default(100),

  // ── CORS ──────────────────────────────────────────────────────────────────
  CORS_ORIGINS: z.string().default('http://localhost:3000'),

  // ── Encryption ────────────────────────────────────────────────────────────
  ENCRYPTION_KEY: z.string().min(32),

  // ── Webhooks ──────────────────────────────────────────────────────────────
  WEBHOOK_TOLERANCE_SECS: portStr.default(300),

  // ── Workers ───────────────────────────────────────────────────────────────
  WORKER_CONCURRENCY:   portStr.default(5),
  MAX_JOBS_PER_WORKER:  portStr.default(100),

  // ── Media ─────────────────────────────────────────────────────────────────
  MAX_UPLOAD_SIZE_BYTES: portStr.default(52428800),
  ALLOWED_MIME_TYPES:    z.string().default('image/jpeg,image/png,image/webp,image/avif,video/mp4,audio/aac,audio/mpeg'),

  // ── Twilio ────────────────────────────────────────────────────────────────
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN:  z.string().optional(),
});

// ── Fail-fast validation ──────────────────────────────────────────────────────

function validateEnv() {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    const issues = result.error.issues.map((i: z.ZodIssue) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Environment validation failed:\n${issues}`);
  }

  const data = result.data;

  // Production-specific stricter checks
  if (data.NODE_ENV === 'production') {
    if (!data.SENTRY_DSN) {
      throw new Error('SENTRY_DSN is required in production');
    }
    if (data.JWT_ACCESS_SECRET.length < 64) {
      throw new Error('JWT_ACCESS_SECRET must be >= 64 characters in production');
    }
    if (data.JWT_REFRESH_SECRET.length < 64) {
      throw new Error('JWT_REFRESH_SECRET must be >= 64 characters in production');
    }
    if (data.ENCRYPTION_KEY.length !== 64) {
      throw new Error('ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes) in production');
    }
    if (!data.STRIPE_SECRET_KEY && !data.RAZORPAY_KEY_ID && !data.APPLE_BUNDLE_ID) {
      throw new Error('At least one payment provider must be configured in production');
    }
  }

  return data;
}

export type Env = z.infer<typeof envSchema>;
export const env: Env = validateEnv();

// ── Helpers ───────────────────────────────────────────────────────────────────

export const isLocal      = () => env.NODE_ENV === 'local';
export const isDev        = () => env.NODE_ENV === 'development';
export const isStaging    = () => env.NODE_ENV === 'staging';
export const isProd       = () => env.NODE_ENV === 'production';
export const isCI         = () => !!process.env.CI;

export function requireProd(name: string, value: string | undefined): string {
  if (isProd() && !value) throw new Error(`${name} is required in production`);
  return value ?? '';
}

export function getCorsOrigins(): string[] {
  return env.CORS_ORIGINS.split(',').map((o: string) => o.trim()).filter(Boolean);
}

export function getAllowedMimeTypes(): string[] {
  return env.ALLOWED_MIME_TYPES.split(',').map((m: string) => m.trim()).filter(Boolean);
}
