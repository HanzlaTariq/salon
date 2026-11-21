/**
 * Production pre-flight checks (Phase 16). Pure functions: no I/O, no framework, never prints a secret value
 * (messages name the variable only). `parseEnv` (env.ts) already refuses a malformed configuration; this file
 * catches configurations that are VALID but unsafe or unfinished: example values, owner credentials in the API
 * environment, localhost URLs, a missing proxy hop count, a worker that nobody runs, and so on.
 *
 *   docker compose -f infra/deploy/docker-compose.prod.yml run --rm cli npm run preflight
 */
export interface PreflightResult {
  errors: string[];
  warnings: string[];
}

type RawEnv = Record<string, string | undefined>;

const PLACEHOLDER = /(change_?me|dev_only|\[[A-Z_]+\]|<[a-z-]+>|your[-_ ]?secret)/i;
const SECRET_NAMES = [
  'JWT_ACCESS_SECRET',
  'MFA_ENCRYPTION_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'FCM_SERVICE_ACCOUNT_B64',
  'NOTIFICATIONS_CRON_SECRET',
  'MAINTENANCE_CRON_SECRET',
  'SMTP_PASS',
  'REDIS_URL',
  'DATABASE_URL',
];
const URL_NAMES = ['CORS_ORIGINS', 'WEB_APP_URL', 'PUBLIC_LINK_BASE_URL', 'SUPABASE_URL'];
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|10\.0\.2\.2)$/i;

const has = (v: string | undefined): v is string => typeof v === 'string' && v.trim() !== '';
const isTrue = (v: string | undefined, def: boolean): boolean => (has(v) ? v.trim() === 'true' : def);

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function dbChecks(raw: RawEnv, errors: string[], warnings: string[]): void {
  const db = has(raw.DATABASE_URL) ? parseUrl(raw.DATABASE_URL) : null;
  if (!db) {
    errors.push('DATABASE_URL: missing or not a valid URL');
  } else {
    const user = decodeURIComponent(db.username);
    if (user === 'postgres' || user.startsWith('postgres.') || user === 'supabase_admin') {
      errors.push('DATABASE_URL: uses the owner role (postgres). The API must connect as salon_app so Row Level Security applies');
    }
    if (LOCAL_HOST.test(db.hostname)) errors.push('DATABASE_URL: points to a local host');
    if (db.hostname.endsWith('.pooler.supabase.com')) {
      if (db.port !== '6543') errors.push('DATABASE_URL: Supabase pooler must use port 6543 (transaction mode) at runtime');
      if (db.searchParams.get('pgbouncer') !== 'true') errors.push('DATABASE_URL: add ?pgbouncer=true (required by Prisma behind the transaction pooler)');
    }
    const ssl = db.searchParams.get('sslmode');
    if (!ssl || ssl === 'disable' || ssl === 'allow' || ssl === 'prefer') errors.push('DATABASE_URL: add sslmode=require (encrypted database connection)');
    const limit = Number(db.searchParams.get('connection_limit') ?? '0');
    if (limit > 10) warnings.push('DATABASE_URL: connection_limit above 10 can exhaust a small Supabase plan (Free/Nano has about 60 connections in total)');
  }
  if (has(raw.DIRECT_URL)) {
    const direct = parseUrl(raw.DIRECT_URL);
    const user = direct ? decodeURIComponent(direct.username) : '';
    if (user === 'postgres' || user.startsWith('postgres.')) {
      errors.push('DIRECT_URL: the owner (postgres) credentials must not be in the API environment. Keep them only in .env.migrate');
    }
  }
}

function secretChecks(raw: RawEnv, errors: string[], warnings: string[]): void {
  for (const name of SECRET_NAMES) {
    const value = raw[name];
    if (has(value) && PLACEHOLDER.test(value)) errors.push(`${name}: still holds an example or placeholder value`);
  }
  const jwt = raw.JWT_ACCESS_SECRET ?? '';
  if (has(jwt)) {
    if (jwt.length < 43) warnings.push('JWT_ACCESS_SECRET: shorter than 43 characters; generate 48 random bytes (base64url)');
    if (new Set(jwt).size < 12) errors.push('JWT_ACCESS_SECRET: too few different characters; it does not look random');
  }
  const cron = [raw.NOTIFICATIONS_CRON_SECRET, raw.MAINTENANCE_CRON_SECRET, raw.JWT_ACCESS_SECRET].filter(has);
  if (new Set(cron).size !== cron.length) errors.push('NOTIFICATIONS_CRON_SECRET / MAINTENANCE_CRON_SECRET / JWT_ACCESS_SECRET: each secret must be different');
}

function urlChecks(raw: RawEnv, errors: string[]): void {
  for (const name of URL_NAMES) {
    const value = raw[name];
    if (!has(value)) continue;
    for (const part of value.split(',').map((s) => s.trim()).filter(Boolean)) {
      const url = parseUrl(part);
      if (!url) {
        errors.push(`${name}: "${name === 'SUPABASE_URL' ? 'value' : part}" is not a valid URL`);
        continue;
      }
      if (LOCAL_HOST.test(url.hostname)) errors.push(`${name}: points to a local host`);
      if (url.hostname === 'example.com' || url.hostname.endsWith('.example.com')) errors.push(`${name}: still uses the example domain`);
    }
  }
  if (has(raw.MAIL_FROM) && /(@|\.)(example\.com|localhost)\b/i.test(raw.MAIL_FROM)) errors.push('MAIL_FROM: still uses the example or localhost address');
}

export function preflightChecks(raw: RawEnv): PreflightResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (raw.NODE_ENV !== 'production') errors.push('NODE_ENV: must be production');

  dbChecks(raw, errors, warnings);
  secretChecks(raw, errors, warnings);
  urlChecks(raw, errors);

  const hops = Number(has(raw.TRUST_PROXY_HOPS) ? raw.TRUST_PROXY_HOPS : '0');
  if (!Number.isInteger(hops) || hops < 1) {
    errors.push('TRUST_PROXY_HOPS: must be 1 or more behind Caddy/a load balancer. With 0 every user shares the proxy IP and the rate limits block everybody together');
  }

  if (Number(has(raw.ARGON2_MEMORY_KIB) ? raw.ARGON2_MEMORY_KIB : '19456') < 19456) errors.push('ARGON2_MEMORY_KIB: below the OWASP minimum of 19456');
  if (Number(has(raw.ARGON2_TIME_COST) ? raw.ARGON2_TIME_COST : '2') < 2) errors.push('ARGON2_TIME_COST: below the OWASP minimum of 2');

  if (!isTrue(raw.NOTIFICATIONS_WORKER_ENABLED, true) && !has(raw.NOTIFICATIONS_CRON_SECRET)) {
    errors.push('NOTIFICATIONS_WORKER_ENABLED=false without NOTIFICATIONS_CRON_SECRET: nobody would send reminders and push messages');
  }
  if (!isTrue(raw.MAINTENANCE_WORKER_ENABLED, true) && !has(raw.MAINTENANCE_CRON_SECRET)) {
    warnings.push('MAINTENANCE_WORKER_ENABLED=false without MAINTENANCE_CRON_SECRET: the retention purge never runs');
  }

  if (has(raw.REDIS_URL)) {
    const redis = parseUrl(raw.REDIS_URL);
    if (redis && !redis.password && !LOCAL_HOST.test(redis.hostname) && redis.hostname !== 'redis') warnings.push('REDIS_URL: no password on a non-local Redis');
  }
  if (has(raw.SUPABASE_URL) && !/\.supabase\.co$/i.test(parseUrl(raw.SUPABASE_URL)?.hostname ?? '')) warnings.push('SUPABASE_URL: host does not end with .supabase.co');
  if (!has(raw.SMTP_USER) || !has(raw.SMTP_PASS)) warnings.push('SMTP_USER / SMTP_PASS: empty (fine only for a relay that needs no login)');
  if (!isTrue(raw.HIBP_CHECK_ENABLED, true)) warnings.push('HIBP_CHECK_ENABLED=false: breached passwords are accepted');
  if (isTrue(raw.ENABLE_SWAGGER, false)) warnings.push('ENABLE_SWAGGER=true: ignored in production, remove it');
  if (['debug', 'trace'].includes(raw.LOG_LEVEL ?? '')) warnings.push('LOG_LEVEL: debug/trace is noisy and slow in production');
  if (!has(raw.SENTRY_DSN)) warnings.push('SENTRY_DSN: not set, errors are only in the logs');
  if (!has(raw.APP_STORE_URL_ANDROID) && !has(raw.APP_STORE_URL_IOS)) warnings.push('APP_STORE_URL_ANDROID / APP_STORE_URL_IOS: not set, the QR landing page shows no store buttons (set them after publishing)');
  if (isTrue(raw.MAINTENANCE_DELETE_ORPHANS, false)) warnings.push('MAINTENANCE_DELETE_ORPHANS=true: orphaned files are deleted. Read one report first (docs/PHASE15.md)');

  return { errors, warnings };
}
