import { Harness, bearer, createHarness, dbEnabled, loginMobile, registerAndVerify } from './support/harness';

const d = dbEnabled ? describe : describe.skip;

d('Phase 15: rate limits are per signed-in user, not only per IP (factor = 1)', () => {
  let h: Harness;
  beforeAll(async () => {
    process.env.AUTH_RATE_LIMIT_FACTOR = '1';
    h = await createHarness();
  });
  afterAll(async () => {
    delete process.env.AUTH_RATE_LIMIT_FACTOR;
    await h.close();
  });

  const token = async () => {
    const u = await registerAndVerify(h);
    return (await loginMobile(h, u.email, u.password)).body.data.accessToken as string;
  };

  it('one user exhausting a route does not block another user behind the same IP', async () => {
    const a = await token();
    const b = await token();
    let limited = 0;
    // GET /notifications/preferences allows 60 per minute
    for (let i = 0; i < 64; i += 1) {
      const r = await h.http().get('/api/v1/notifications/preferences').set(bearer(a));
      if (r.status === 429) {
        limited += 1;
        expect(r.body.error.code).toBe('RATE_LIMITED');
      }
    }
    expect(limited).toBeGreaterThanOrEqual(1);
    // same IP, different user: not affected
    await h.http().get('/api/v1/notifications/preferences').set(bearer(b)).expect(200);
    // and user A is still limited
    await h.http().get('/api/v1/notifications/preferences').set(bearer(a)).expect(429);
  });

  it('a junk token cannot borrow or escape a bucket: it falls back to the IP bucket and is refused as 401', async () => {
    const r = await h.http().get('/api/v1/notifications/preferences').set(bearer('not-a-real-token'));
    expect(r.status).toBe(401);
  });
});
