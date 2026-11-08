import { parseEnv } from './env';

const base = { DATABASE_URL: 'postgresql://u:p@localhost:5432/db' };

describe('parseEnv', () => {
  it('applies safe defaults', () => {
    const env = parseEnv({ ...base } as NodeJS.ProcessEnv);
    expect(env.PORT).toBe(3000);
    expect(env.ENABLE_SWAGGER).toBe(false);
    expect(env.CORS_ORIGINS).toEqual([]);
  });

  it('fails fast when DATABASE_URL is missing and never prints values', () => {
    expect(() => parseEnv({} as NodeJS.ProcessEnv)).toThrow(/DATABASE_URL/);
  });

  it('rejects wildcard CORS', () => {
    expect(() => parseEnv({ ...base, CORS_ORIGINS: '*' } as NodeJS.ProcessEnv)).toThrow(/Wildcard/);
  });

  it('requires https CORS origins in production', () => {
    expect(() =>
      parseEnv({ ...base, NODE_ENV: 'production', CORS_ORIGINS: 'http://a.com' } as NodeJS.ProcessEnv),
    ).toThrow(/https/);
    expect(() => parseEnv({ ...base, NODE_ENV: 'production' } as NodeJS.ProcessEnv)).toThrow(/CORS_ORIGINS/);
  });
});
