import { parseEnv } from './env';

const base = {
  DATABASE_URL: 'postgresql://x:y@localhost:5432/db',
  JWT_ACCESS_SECRET: 'a'.repeat(40),
  MFA_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
} as NodeJS.ProcessEnv;
const prod = {
  ...base,
  NODE_ENV: 'production',
  CORS_ORIGINS: 'https://admin.example.com',
  COOKIE_SECURE: 'true',
  WEB_APP_URL: 'https://admin.example.com',
  MAIL_TRANSPORT: 'smtp',
  SMTP_HOST: 'smtp.example.com',
  REDIS_URL: 'rediss://default:x@redis.example.com:6380',
  STORAGE_DRIVER: 'supabase',
  SUPABASE_URL: 'https://abcdefgh.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'k'.repeat(40),
  PUSH_DRIVER: 'fcm',
  FCM_SERVICE_ACCOUNT_B64: 'e'.repeat(60),
  PUBLIC_LINK_BASE_URL: 'https://book.example.com',
} as NodeJS.ProcessEnv;

describe('Phase 10 environment', () => {
  it('has safe development defaults', () => {
    const env = parseEnv(base);
    expect(env.PUSH_DRIVER).toBe('log');
    expect(env.NOTIFICATIONS_WORKER_ENABLED).toBe(true);
    expect(env.NOTIFICATIONS_TICK_SECONDS).toBe(15);
    expect(env.NOTIFICATIONS_CRON_SECRET).toBeUndefined();
  });
  it('production needs the real push driver and its credentials', () => {
    expect(() => parseEnv(prod)).not.toThrow();
    expect(() => parseEnv({ ...prod, PUSH_DRIVER: 'log' })).toThrow(/PUSH_DRIVER/);
    const { FCM_SERVICE_ACCOUNT_B64: _omit, ...noKey } = prod;
    expect(() => parseEnv(noKey as NodeJS.ProcessEnv)).toThrow(/FCM_SERVICE_ACCOUNT_B64/);
  });
  it('the cron secret must be long, and the tick interval is bounded', () => {
    expect(() => parseEnv({ ...base, NOTIFICATIONS_CRON_SECRET: 'short' })).toThrow(/NOTIFICATIONS_CRON_SECRET/);
    expect(parseEnv({ ...base, NOTIFICATIONS_CRON_SECRET: 'c'.repeat(32) }).NOTIFICATIONS_CRON_SECRET).toHaveLength(32);
    expect(() => parseEnv({ ...base, NOTIFICATIONS_TICK_SECONDS: '1' })).toThrow();
    expect(parseEnv({ ...base, NOTIFICATIONS_WORKER_ENABLED: 'false' }).NOTIFICATIONS_WORKER_ENABLED).toBe(false);
  });
});
