import { preflightChecks } from './preflight';

const good: Record<string, string> = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://salon_app.abcdefgh:Pw%40123@aws-0-ap-northeast-1.pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=5&sslmode=require',
  CORS_ORIGINS: 'https://admin.salonpk.com',
  WEB_APP_URL: 'https://admin.salonpk.com',
  PUBLIC_LINK_BASE_URL: 'https://api.salonpk.com',
  SUPABASE_URL: 'https://abcdefgh.supabase.co',
  TRUST_PROXY_HOPS: '1',
  JWT_ACCESS_SECRET: 'q8V2mK9xLp3RzT7wYc5NbH1dFg6JsA4eUo0iXvC2nMkPlQrWt9ZyBh',
  MFA_ENCRYPTION_KEY: 'a3J5b3VyMzJieXRlc2tleWZvcnRlc3RzMTIzNDU2Nzg=',
  NOTIFICATIONS_CRON_SECRET: 'n0tif1cati0ns-cr0n-s3cret-0123456789-abcdefgh',
  MAINTENANCE_CRON_SECRET: 'maint3nance-cr0n-s3cret-9876543210-zyxwvuts',
  MAIL_FROM: 'Salon Platform <no-reply@salonpk.com>',
  REDIS_URL: 'redis://:pw@redis:6379',
  SMTP_USER: 'u',
  SMTP_PASS: 'p',
  SENTRY_DSN: 'https://k@o1.ingest.sentry.io/1',
  APP_STORE_URL_ANDROID: 'https://play.google.com/store/apps/details?id=x',
};
const run = (over: Record<string, string | undefined> = {}) => preflightChecks({ ...good, ...over });

describe('preflightChecks', () => {
  it('accepts a sound production configuration', () => {
    const r = run();
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it('refuses the owner role at runtime (it bypasses RLS)', () => {
    const r = run({ DATABASE_URL: good.DATABASE_URL.replace('salon_app.abcdefgh', 'postgres.abcdefgh') });
    expect(r.errors.join(' ')).toContain('owner role');
  });

  it('refuses owner credentials in DIRECT_URL inside the API environment', () => {
    const r = run({ DIRECT_URL: 'postgresql://postgres.abcdefgh:pw@aws-0-x.pooler.supabase.com:5432/postgres' });
    expect(r.errors.join(' ')).toContain('DIRECT_URL');
  });

  it('requires port 6543, pgbouncer=true and TLS on the Supabase pooler', () => {
    expect(run({ DATABASE_URL: good.DATABASE_URL.replace(':6543', ':5432') }).errors.join(' ')).toContain('6543');
    expect(run({ DATABASE_URL: good.DATABASE_URL.replace('pgbouncer=true&', '') }).errors.join(' ')).toContain('pgbouncer=true');
    expect(run({ DATABASE_URL: good.DATABASE_URL.replace('&sslmode=require', '') }).errors.join(' ')).toContain('sslmode');
  });

  it('refuses placeholders, example domains and local URLs', () => {
    expect(run({ JWT_ACCESS_SECRET: 'CHANGE_ME_dev_only_secret_at_least_32_characters_long' }).errors.join(' ')).toContain('JWT_ACCESS_SECRET');
    expect(run({ CORS_ORIGINS: 'https://admin.example.com' }).errors.join(' ')).toContain('example domain');
    expect(run({ WEB_APP_URL: 'https://localhost:5173' }).errors.join(' ')).toContain('local host');
    expect(run({ DATABASE_URL: 'postgresql://salon_app.[PROJECT_REF]:[PW]@h:6543/postgres' }).errors.join(' ')).toContain('placeholder');
  });

  it('requires a proxy hop count of at least 1', () => {
    expect(run({ TRUST_PROXY_HOPS: '0' }).errors.join(' ')).toContain('TRUST_PROXY_HOPS');
    expect(run({ TRUST_PROXY_HOPS: undefined }).errors.join(' ')).toContain('TRUST_PROXY_HOPS');
  });

  it('requires distinct secrets', () => {
    const r = run({ MAINTENANCE_CRON_SECRET: good.NOTIFICATIONS_CRON_SECRET });
    expect(r.errors.join(' ')).toContain('must be different');
  });

  it('refuses a configuration where nobody sends notifications', () => {
    const r = run({ NOTIFICATIONS_WORKER_ENABLED: 'false', NOTIFICATIONS_CRON_SECRET: undefined });
    expect(r.errors.join(' ')).toContain('NOTIFICATIONS_WORKER_ENABLED');
  });

  it('refuses weak password hashing parameters', () => {
    expect(run({ ARGON2_MEMORY_KIB: '4096' }).errors.join(' ')).toContain('ARGON2_MEMORY_KIB');
  });

  it('warns (does not fail) about missing monitoring and store links', () => {
    const r = run({ SENTRY_DSN: undefined, APP_STORE_URL_ANDROID: undefined });
    expect(r.errors).toEqual([]);
    expect(r.warnings.join(' ')).toContain('SENTRY_DSN');
    expect(r.warnings.join(' ')).toContain('APP_STORE_URL');
  });

  it('never prints a secret value', () => {
    const secret = 'CHANGE_ME_super_secret_value_that_must_not_leak_1234567890';
    const r = run({ JWT_ACCESS_SECRET: secret, SMTP_PASS: secret });
    expect(JSON.stringify(r)).not.toContain(secret);
  });
});
