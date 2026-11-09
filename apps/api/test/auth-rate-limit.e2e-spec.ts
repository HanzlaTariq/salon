import { GOOD_PASSWORD, Harness, createHarness, dbEnabled, loginMobile, uniqueEmail } from './support/harness';

const d = dbEnabled ? describe : describe.skip;

d('auth endpoint rate limits (factor = 1, production behaviour)', () => {
  let h: Harness;
  beforeAll(async () => {
    process.env.AUTH_RATE_LIMIT_FACTOR = '1';
    h = await createHarness();
  });
  afterAll(async () => {
    delete process.env.AUTH_RATE_LIMIT_FACTOR;
    await h.close();
  });

  it('throttles login to 10/min per client and answers 429 in the error envelope', async () => {
    const email = uniqueEmail();
    let tooMany: any;
    for (let i = 0; i < 14 && !tooMany; i++) {
      const r = await loginMobile(h, email, GOOD_PASSWORD + i);
      if (r.status === 429) tooMany = r;
    }
    expect(tooMany).toBeDefined();
    expect(tooMany.body.error.code).toBe('RATE_LIMITED');
  });

  it('throttles registration, forgot-password and resend-verification harder', async () => {
    const hit = async (path: string, body: object) => {
      for (let i = 0; i < 8; i++) {
        const r = await h.http().post(path).send(body);
        if (r.status === 429) return true;
      }
      return false;
    };
    expect(await hit('/api/v1/auth/register', { email: uniqueEmail(), password: GOOD_PASSWORD, fullName: 'Rate Test', accountType: 'CUSTOMER' })).toBe(true);
    expect(await hit('/api/v1/auth/forgot-password', { email: uniqueEmail() })).toBe(true);
    expect(await hit('/api/v1/auth/resend-verification', { email: uniqueEmail() })).toBe(true);
  });
});
