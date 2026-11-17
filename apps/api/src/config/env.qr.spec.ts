import { parseEnv } from './env';

const base = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  JWT_ACCESS_SECRET: 'j'.repeat(40),
  MFA_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
};
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
};

describe('Phase 11 environment', () => {
  it('has development defaults', () => {
    const env = parseEnv({ ...base } as NodeJS.ProcessEnv);
    expect(env.PUBLIC_LINK_BASE_URL).toBe('http://localhost:3000');
    expect(env.BRAND_NAME).toBe('Salon Platform');
    expect(env.APP_STORE_URL_ANDROID).toBeUndefined();
  });

  it('production requires an https PUBLIC_LINK_BASE_URL (the default is refused)', () => {
    expect(() => parseEnv({ ...prod } as NodeJS.ProcessEnv)).toThrow(/PUBLIC_LINK_BASE_URL/);
    expect(() => parseEnv({ ...prod, PUBLIC_LINK_BASE_URL: 'http://book.example.com' } as NodeJS.ProcessEnv)).toThrow(/PUBLIC_LINK_BASE_URL/);
    expect(parseEnv({ ...prod, PUBLIC_LINK_BASE_URL: 'https://book.example.com' } as NodeJS.ProcessEnv).PUBLIC_LINK_BASE_URL).toBe('https://book.example.com');
  });

  it('store links must be https', () => {
    expect(() => parseEnv({ ...base, APP_STORE_URL_IOS: 'http://apps.apple.com/x' } as NodeJS.ProcessEnv)).toThrow(/APP_STORE_URL_IOS/);
  });
});
