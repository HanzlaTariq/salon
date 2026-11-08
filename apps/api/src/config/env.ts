import { z } from 'zod';

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
  ENABLE_SWAGGER: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
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
  if (env.NODE_ENV === 'production') {
    if (env.CORS_ORIGINS.length === 0) {
      throw new Error('Invalid environment configuration:\n  - CORS_ORIGINS: required in production');
    }
    if (env.CORS_ORIGINS.some((o) => !o.startsWith('https://'))) {
      throw new Error('Invalid environment configuration:\n  - CORS_ORIGINS: must use https:// in production');
    }
  }
  return env;
}

export const ENV = Symbol('ENV');
