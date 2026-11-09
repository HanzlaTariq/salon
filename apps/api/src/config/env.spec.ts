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
};

describe('parseEnv', () => {
  it('applies safe defaults', () => {
    const env = parseEnv({ ...base } as NodeJS.ProcessEnv);
    expect(env.PORT).toBe(3000);
    expect(env.ENABLE_SWAGGER).toBe(false);
    expect(env.CORS_ORIGINS).toEqual([]);
    expect(env.REQUIRE_ADMIN_MFA).toBe(true);
    expect(env.ACCESS_TOKEN_TTL_SEC).toBe(900);
  });

  it('fails fast when DATABASE_URL is missing and never prints values', () => {
    expect(() => parseEnv({} as NodeJS.ProcessEnv)).toThrow(/DATABASE_URL/);
  });

  it('rejects wildcard CORS', () => {
    expect(() => parseEnv({ ...base, CORS_ORIGINS: '*' } as NodeJS.ProcessEnv)).toThrow(/Wildcard/);
  });

  it('requires https CORS origins in production', () => {
    expect(() => parseEnv({ ...prod, CORS_ORIGINS: 'http://a.com' } as NodeJS.ProcessEnv)).toThrow(/https/);
    expect(() => parseEnv({ ...prod, CORS_ORIGINS: '' } as NodeJS.ProcessEnv)).toThrow(/CORS_ORIGINS/);
  });

  it('refuses weak or missing auth secrets without echoing their values', () => {
    expect(() => parseEnv({ ...base, JWT_ACCESS_SECRET: 'short-secret-value' } as NodeJS.ProcessEnv)).toThrow(
      /JWT_ACCESS_SECRET/,
    );
    try {
      parseEnv({ ...base, JWT_ACCESS_SECRET: 'short-secret-value' } as NodeJS.ProcessEnv);
    } catch (e) {
      expect(String(e)).not.toContain('short-secret-value');
    }
    expect(() => parseEnv({ ...base, MFA_ENCRYPTION_KEY: 'bm90LTMyLWJ5dGVz' } as NodeJS.ProcessEnv)).toThrow(
      /MFA_ENCRYPTION_KEY/,
    );
    const { JWT_ACCESS_SECRET: _omit, ...noJwt } = base;
    expect(() => parseEnv(noJwt as NodeJS.ProcessEnv)).toThrow(/JWT_ACCESS_SECRET/);
  });

  it('accepts a complete production configuration', () => {
    expect(() => parseEnv(prod as NodeJS.ProcessEnv)).not.toThrow();
  });

  it('enforces secure production defaults (cookies, https links, real mail, admin MFA)', () => {
    expect(() => parseEnv({ ...prod, COOKIE_SECURE: 'false' } as NodeJS.ProcessEnv)).toThrow(/COOKIE_SECURE/);
    expect(() => parseEnv({ ...prod, WEB_APP_URL: 'http://x.com' } as NodeJS.ProcessEnv)).toThrow(/WEB_APP_URL/);
    expect(() => parseEnv({ ...prod, MAIL_TRANSPORT: 'console' } as NodeJS.ProcessEnv)).toThrow(/MAIL_TRANSPORT/);
    expect(() => parseEnv({ ...prod, REQUIRE_ADMIN_MFA: 'false' } as NodeJS.ProcessEnv)).toThrow(/REQUIRE_ADMIN_MFA/);
  });

  it('requires REDIS_URL in production (shared rate limits)', () => {
    const { REDIS_URL: _omit, ...noRedis } = prod;
    expect(() => parseEnv(noRedis as NodeJS.ProcessEnv)).toThrow(/REDIS_URL/);
  });

  it('keeps REDIS_URL optional outside production', () => {
    expect(parseEnv({ ...base } as NodeJS.ProcessEnv).REDIS_URL).toBeUndefined();
  });

  it('enables the breached-password check by default and fails open', () => {
    const env = parseEnv({ ...base } as NodeJS.ProcessEnv);
    expect(env.HIBP_CHECK_ENABLED).toBe(true);
    expect(env.HIBP_FAIL_CLOSED).toBe(false);
  });

  it('requires SMTP_HOST when using the smtp transport', () => {
    expect(() => parseEnv({ ...base, MAIL_TRANSPORT: 'smtp' } as NodeJS.ProcessEnv)).toThrow(/SMTP_HOST/);
  });
});
