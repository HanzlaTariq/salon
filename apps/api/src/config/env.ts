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
  }
  if (env.MAIL_TRANSPORT === 'smtp' && !env.SMTP_HOST) problems.push('SMTP_HOST: required when MAIL_TRANSPORT=smtp');
  if (problems.length > 0) throw new Error(`Invalid environment configuration:\n  - ${problems.join('\n  - ')}`);
  return env;
}

export const ENV = Symbol('ENV');
