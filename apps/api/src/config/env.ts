import { z } from 'zod';

const bool = (def: 'true' | 'false') =>
  z
    .enum(['true', 'false'])
    .default(def)
    .transform((v) => v === 'true');

/**
 * Environment schema. The app FAILS FAST at boot if anything is missing or invalid,
 * so a misconfigured deployment can never start in an insecure state.
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  CORS_ORIGINS: z
    .string()
    .default('')
    .transform((v) =>
      v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    )
    .refine((list) => !list.includes('*'), 'Wildcard CORS origin is not allowed'),
  RATE_LIMIT_TTL_MS: z.coerce.number().int().positive().default(60_000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
  ENABLE_SWAGGER: bool('false'),
  /** Shared rate-limit counters (risk R5). Required in production; optional for dev/tests (in-memory). */
  REDIS_URL: z.string().url().optional(),
  /** Breached-password check via HIBP k-anonymity range API (only a 5-char SHA-1 prefix leaves the server). */
  HIBP_CHECK_ENABLED: bool('true'),
  /** If true, a password is refused when the HIBP service cannot be reached. Default: allow (availability). */
  HIBP_FAIL_CLOSED: bool('false'),

  // ---- Phase 2: authentication ----
  /** Number of reverse proxies in front of the API (so req.ip, and therefore rate limits, are correct). */
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  JWT_ISSUER: z.string().min(1).default('salon-api'),
  JWT_AUDIENCE: z.string().min(1).default('salon-clients'),
  ACCESS_TOKEN_TTL_SEC: z.coerce.number().int().min(60).max(3600).default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30),
  SESSION_MAX_DAYS: z.coerce.number().int().min(1).max(365).default(90),
  COOKIE_SECURE: bool('false'),
  /** Public base URL of the web app that hosts /verify-email and /reset-password pages. */
  WEB_APP_URL: z.string().url().default('http://localhost:5173'),
  /** base64 of exactly 32 random bytes (AES-256-GCM key protecting TOTP secrets). */
  MFA_ENCRYPTION_KEY: z
    .string()
    .refine((v) => Buffer.from(v, 'base64').length === 32, 'MFA_ENCRYPTION_KEY must be base64 of exactly 32 bytes'),
  REQUIRE_ADMIN_MFA: bool('true'),
  ARGON2_MEMORY_KIB: z.coerce.number().int().min(8).default(19_456),
  ARGON2_TIME_COST: z.coerce.number().int().min(1).default(2),
  ARGON2_PARALLELISM: z.coerce.number().int().min(1).default(1),
  LOGIN_MAX_ATTEMPTS: z.coerce.number().int().min(3).max(20).default(5),
  LOGIN_LOCKOUT_MINUTES: z.coerce.number().int().min(1).max(1440).default(15),
  MAIL_TRANSPORT: z.enum(['console', 'smtp']).default('console'),
  MAIL_FROM: z.string().min(3).default('Salon Platform <no-reply@localhost>'),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_SECURE: bool('false'),

  // ---- Phase 3: private object storage for salon documents and photos ----
  /** `memory` is for tests/local development only (refused in production). */
  STORAGE_DRIVER: z.enum(['memory', 'supabase']).default('memory'),
  /** https://<project-ref>.supabase.co  (backend only). */
  SUPABASE_URL: z.string().url().optional(),
  /** BACKEND ONLY. Never in Flutter, admin-web, git or logs. Bypasses all Supabase policies. */
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20).optional(),
  /** Must be a PRIVATE bucket (public = off). */
  SUPABASE_STORAGE_BUCKET: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/, 'SUPABASE_STORAGE_BUCKET must be a valid bucket name')
    .default('salon-private'),
  /** Per-file upload cap in bytes (hard ceiling 10 MiB; also enforced by a DB CHECK). */
  UPLOAD_MAX_BYTES: z.coerce.number().int().min(100_000).max(10_485_760).default(5_242_880),
  /** Lifetime of signed download URLs. Keep short. */
  SIGNED_URL_TTL_SEC: z.coerce.number().int().min(30).max(3600).default(300),

  // ---- Phase 10: notifications ----
  /** `log` keeps messages in memory (development / tests only, refused in production). `fcm` sends through Firebase Cloud Messaging. */
  PUSH_DRIVER: z.enum(['log', 'fcm']).default('log'),
  /** BACKEND ONLY. base64 of the Firebase service-account JSON (Firebase console > Project settings > Service accounts). */
  FCM_SERVICE_ACCOUNT_B64: z.string().min(40).optional(),
  /** Runs the notification worker loop inside this process (never in NODE_ENV=test). Turn off when a cron calls the tick endpoint instead. */
  NOTIFICATIONS_WORKER_ENABLED: bool('true'),
  NOTIFICATIONS_TICK_SECONDS: z.coerce.number().int().min(5).max(300).default(15),
  /** Enables POST /internal/notifications/tick for a cron service (serverless hosting). At least 32 characters; unset = endpoint disabled. */
  NOTIFICATIONS_CRON_SECRET: z.string().min(32, 'NOTIFICATIONS_CRON_SECRET must be at least 32 characters').optional(),

  // ---- Phase 11: salon link, QR code and poster ----
  /** Public base URL printed into every QR code: <base>/s/<code>. Changing it later invalidates printed posters, so choose your final domain first. */
  PUBLIC_LINK_BASE_URL: z.string().url().default('http://localhost:3000'),
  /** Optional store links shown on the scan landing page. https only. */
  APP_STORE_URL_ANDROID: z.string().url().startsWith('https://').optional(),
  APP_STORE_URL_IOS: z.string().url().startsWith('https://').optional(),
  /** Platform name printed on posters and the landing page. */
  BRAND_NAME: z.string().trim().min(2).max(40).default('Salon Platform'),

  // ---- Phase 15: maintenance, monitoring, performance ----
  /** Runs the maintenance loop (retention purge + storage reconciliation) inside this process (never in NODE_ENV=test). Turn off when a cron calls the endpoint instead. */
  MAINTENANCE_WORKER_ENABLED: bool('true'),
  /** Enables POST /internal/maintenance/run for a cron service (serverless hosting). At least 32 characters; unset = endpoint disabled. */
  MAINTENANCE_CRON_SECRET: z.string().min(32, 'MAINTENANCE_CRON_SECRET must be at least 32 characters').optional(),
  /** false (default) = the storage reconciliation only REPORTS orphaned files; true = it deletes them (after the safety checks in docs/PHASE15.md). */
  MAINTENANCE_DELETE_ORPHANS: bool('false'),
  /** A storage object younger than this is never an orphan (an upload may still be saving its database row). */
  MAINTENANCE_ORPHAN_MIN_AGE_HOURS: z.coerce.number().int().min(1).max(720).default(24),
  /** Error monitoring (Sentry-compatible DSN). Unset = errors are only logged. The DSN is a write-only key, but keep it out of git anyway. */
  SENTRY_DSN: z.string().url().optional(),
  /** Free text shown next to every reported error (for example a git commit). Optional. */
  APP_RELEASE: z.string().trim().min(1).max(64).optional(),
  /** Requests slower than this are logged as warnings (0 disables). */
  SLOW_REQUEST_MS: z.coerce.number().int().min(0).max(120_000).default(1_500),
  /** Hard limit for receiving one whole request (slow-loris protection). */
  REQUEST_TIMEOUT_MS: z.coerce.number().int().min(5_000).max(300_000).default(30_000),
});

export type Env = z.infer<typeof schema>;

export function parseEnv(raw: NodeJS.ProcessEnv = process.env): Env {
  const result = schema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    // Only variable names / messages are printed, never values (they may be secrets).
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const env = result.data;
  const problems: string[] = [];
  if (env.NODE_ENV === 'production') {
    if (env.CORS_ORIGINS.length === 0) problems.push('CORS_ORIGINS: required in production');
    else if (env.CORS_ORIGINS.some((o) => !o.startsWith('https://'))) {
      problems.push('CORS_ORIGINS: must use https:// in production');
    }
    if (!env.COOKIE_SECURE) problems.push('COOKIE_SECURE: must be true in production');
    if (!env.WEB_APP_URL.startsWith('https://')) problems.push('WEB_APP_URL: must use https:// in production');
    if (env.MAIL_TRANSPORT !== 'smtp') problems.push('MAIL_TRANSPORT: must be smtp in production');
    if (!env.REQUIRE_ADMIN_MFA) problems.push('REQUIRE_ADMIN_MFA: must be true in production');
    if (!env.REDIS_URL) problems.push('REDIS_URL: required in production (shared rate limits, risk R5)');
  }
  if (env.STORAGE_DRIVER === 'supabase') {
    if (!env.SUPABASE_URL) problems.push('SUPABASE_URL: required when STORAGE_DRIVER=supabase');
    if (!env.SUPABASE_SERVICE_ROLE_KEY) problems.push('SUPABASE_SERVICE_ROLE_KEY: required when STORAGE_DRIVER=supabase');
  }
  if (env.NODE_ENV === 'production') {
    if (env.STORAGE_DRIVER !== 'supabase') problems.push('STORAGE_DRIVER: must be supabase in production');
    if (env.SUPABASE_URL && !env.SUPABASE_URL.startsWith('https://')) problems.push('SUPABASE_URL: must use https:// in production');
  }
  if (env.NODE_ENV === 'production' && !env.PUBLIC_LINK_BASE_URL.startsWith('https://')) problems.push('PUBLIC_LINK_BASE_URL: must use https:// in production');
  if (env.PUSH_DRIVER === 'fcm' && !env.FCM_SERVICE_ACCOUNT_B64) problems.push('FCM_SERVICE_ACCOUNT_B64: required when PUSH_DRIVER=fcm');
  if (env.NODE_ENV === 'production' && env.PUSH_DRIVER !== 'fcm') problems.push('PUSH_DRIVER: must be fcm in production');
  if (env.SENTRY_DSN && !env.SENTRY_DSN.startsWith('https://')) problems.push('SENTRY_DSN: must use https://');
  if (env.NODE_ENV === 'production' && env.MAINTENANCE_DELETE_ORPHANS && env.STORAGE_DRIVER !== 'supabase') problems.push('MAINTENANCE_DELETE_ORPHANS: needs STORAGE_DRIVER=supabase');
  if (env.MAIL_TRANSPORT === 'smtp' && !env.SMTP_HOST) problems.push('SMTP_HOST: required when MAIL_TRANSPORT=smtp');
  if (problems.length > 0) throw new Error(`Invalid environment configuration:\n  - ${problems.join('\n  - ')}`);
  return env;
}

export const ENV = Symbol('ENV');
