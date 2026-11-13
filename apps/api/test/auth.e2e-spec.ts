import { hotp, base32Decode, timeStep } from '../src/modules/auth/totp';
import {
  GOOD_PASSWORD, Harness, ORIGIN, bearer, createHarness, createPlatformUser, dbEnabled, lastToken, loginMobile,
  mobile, registerAndVerify, uniqueEmail,
} from './support/harness';

const d = dbEnabled ? describe : describe.skip;
if (!dbEnabled) {
  // eslint-disable-next-line no-console
  console.warn('SKIPPED auth e2e: set TEST_DATABASE_URL (salon_app) and TEST_ADMIN_DATABASE_URL (salon_migrator).');
}

const totp = (secretB32: string, h: Harness) => hotp(base32Decode(secretB32), timeStep(h.clock.now().getTime()));
const web = { Origin: ORIGIN, 'X-CSRF-Token': 'x' };
const cookieOf = (res: any, name = 'rt') =>
  (res.headers['set-cookie'] as string[] | undefined)?.find((c) => c.startsWith(`${name}=`));
const cookieValue = (c: string) => c.split(';')[0].split('=')[1];

d('Phase 2: authentication & authorization (real PostgreSQL)', () => {
  let h: Harness;
  beforeAll(async () => { h = await createHarness(); });
  afterAll(async () => { await h.close(); });

  // ------------------------------------------------------------ registration
  describe('registration', () => {
    it('creates a PENDING customer, stores an Argon2id hash, mails a verification link', async () => {
      const email = uniqueEmail();
      const res = await h.http().post('/api/v1/auth/register')
        .send({ email, password: GOOD_PASSWORD, fullName: 'Sana Khan', phone: '0300 1234567', accountType: 'CUSTOMER' }).expect(202);
      expect(JSON.stringify(res.body)).not.toContain(GOOD_PASSWORD);
      const row = (await h.admin.query('SELECT * FROM users WHERE email=$1', [email])).rows[0];
      expect(row.status).toBe('PENDING_VERIFICATION');
      expect(row.role).toBe('CUSTOMER');
      expect(row.phone).toBe('+923001234567');
      expect(row.password_hash.startsWith('$argon2id$')).toBe(true);
      expect(row.password_hash).not.toContain(GOOD_PASSWORD);
      expect(lastToken(h, email, 'Verify')).toBeTruthy();
    });

    it('blocks privilege escalation: privileged roles and extra fields are rejected', async () => {
      for (const accountType of ['SUPER_ADMIN', 'SUPPORT', 'FINANCE', 'SALON_STAFF']) {
        await h.http().post('/api/v1/auth/register')
          .send({ email: uniqueEmail(), password: GOOD_PASSWORD, fullName: 'Evil Person', accountType }).expect(400);
      }
      await h.http().post('/api/v1/auth/register')
        .send({ email: uniqueEmail(), password: GOOD_PASSWORD, fullName: 'Evil', accountType: 'CUSTOMER', role: 'SUPER_ADMIN', status: 'ACTIVE' })
        .expect(400);
    });

    it('does not reveal whether an e-mail is registered (identical response, notice mail instead)', async () => {
      const { email } = await registerAndVerify(h);
      const body = { email, password: GOOD_PASSWORD, fullName: 'Someone', accountType: 'CUSTOMER' };
      const fresh = await h.http().post('/api/v1/auth/register').send({ ...body, email: uniqueEmail() }).expect(202);
      const dup = await h.http().post('/api/v1/auth/register').send(body).expect(202);
      expect(dup.body).toEqual(fresh.body);
      expect(h.mailer.outbox.some((m) => m.to === email && m.subject.includes('already have an account'))).toBe(true);
      expect((await h.admin.query('SELECT count(*)::int n FROM users WHERE email=$1', [email])).rows[0].n).toBe(1);
    });

    it('rejects weak passwords, bad phones and malformed e-mail', async () => {
      const base = { email: uniqueEmail(), fullName: 'Test Person', accountType: 'CUSTOMER' };
      const weak = await h.http().post('/api/v1/auth/register').send({ ...base, password: 'Password123' }).expect(400);
      expect(weak.body.error.details).toContain('This password is too common.');
      await h.http().post('/api/v1/auth/register').send({ ...base, password: GOOD_PASSWORD, phone: '123' }).expect(400);
      await h.http().post('/api/v1/auth/register').send({ ...base, email: 'nope', password: GOOD_PASSWORD }).expect(400);
    });

    it('requires e-mail verification before login; verification links are single-use', async () => {
      const email = uniqueEmail();
      await h.http().post('/api/v1/auth/register').send({ email, password: GOOD_PASSWORD, fullName: 'Test Person', accountType: 'CUSTOMER' });
      const r = await loginMobile(h, email, GOOD_PASSWORD).then((x) => x);
      expect(r.status).toBe(403);
      expect(r.body.error.code).toBe('EMAIL_NOT_VERIFIED');
      const token = lastToken(h, email, 'Verify');
      await h.http().post('/api/v1/auth/verify-email').send({ token }).expect(200);
      await h.http().post('/api/v1/auth/verify-email').send({ token }).expect(400);
      await loginMobile(h, email, GOOD_PASSWORD).then((x) => expect(x.status).toBe(200));
    });

    it('verification links expire after 24 hours', async () => {
      const email = uniqueEmail();
      await h.http().post('/api/v1/auth/register').send({ email, password: GOOD_PASSWORD, fullName: 'Test Person', accountType: 'CUSTOMER' });
      const token = lastToken(h, email, 'Verify');
      h.clock.advance(25 * 3_600_000);
      await h.http().post('/api/v1/auth/verify-email').send({ token }).expect(400);
    });
  });

  // ------------------------------------------------------------ login & lockout
  describe('login', () => {
    it('gives identical errors for unknown user and wrong password', async () => {
      const { email } = await registerAndVerify(h);
      const a = await loginMobile(h, email, 'totally-wrong-password');
      const b = await loginMobile(h, uniqueEmail('ghost'), 'totally-wrong-password');
      expect(a.status).toBe(401);
      expect(b.status).toBe(401);
      expect(a.body.error.code).toBe('INVALID_CREDENTIALS');
      expect({ ...a.body.error, requestId: '' }).toEqual({ ...b.body.error, requestId: '' });
    });

    it('locks after 5 failures (even the right password is refused), then recovers after the lockout', async () => {
      const { email, password } = await registerAndVerify(h);
      for (let i = 0; i < 5; i++) await loginMobile(h, email, 'wrong-password-' + i).then((r) => expect(r.status).toBe(401));
      const locked = await loginMobile(h, email, password);
      expect(locked.status).toBe(401);
      expect(locked.body.error.code).toBe('INVALID_CREDENTIALS'); // same shape: no lock oracle
      h.clock.advance(16 * 60_000);
      await loginMobile(h, email, password).then((r) => expect(r.status).toBe(200));
    });

    it('a successful login resets the failure counter', async () => {
      const { email, password } = await registerAndVerify(h);
      for (let i = 0; i < 4; i++) await loginMobile(h, email, 'wrong-' + i);
      await loginMobile(h, email, password).then((r) => expect(r.status).toBe(200));
      for (let i = 0; i < 4; i++) await loginMobile(h, email, 'wrong-' + i);
      await loginMobile(h, email, password).then((r) => expect(r.status).toBe(200));
    });

    it('does not leak password hashes or MFA secrets in any auth response', async () => {
      const { email, password } = await registerAndVerify(h);
      const res = await loginMobile(h, email, password);
      expect(JSON.stringify(res.body)).not.toMatch(/argon2|password_hash|passwordHash|mfaSecret/i);
    });
  });

  // ------------------------------------------------------------ tokens & sessions
  describe('tokens and sessions', () => {
    it('web: refresh token lives only in an httpOnly SameSite=Strict cookie scoped to /api/v1/auth', async () => {
      const { email, password } = await registerAndVerify(h);
      const res = await h.http().post('/api/v1/auth/login').send({ email, password }).expect(200);
      expect(res.body.data.refreshToken).toBeUndefined();
      expect(res.body.data.accessToken).toBeTruthy();
      const c = cookieOf(res)!;
      expect(c).toMatch(/HttpOnly/i);
      expect(c).toMatch(/SameSite=Strict/i);
      expect(c).toMatch(/Path=\/api\/v1\/auth/);
    });

    it('web refresh rotates the token; replaying the OLD token revokes the whole session (theft detection)', async () => {
      const { email, password } = await registerAndVerify(h);
      const login = await h.http().post('/api/v1/auth/login').send({ email, password });
      const rt1 = cookieValue(cookieOf(login)!);
      const r2 = await h.http().post('/api/v1/auth/refresh').set(web).set('Cookie', `rt=${rt1}`).expect(200);
      const rt2 = cookieValue(cookieOf(r2)!);
      expect(rt2).not.toBe(rt1);
      await h.http().get('/api/v1/auth/me').set(bearer(r2.body.data.accessToken)).expect(200);

      h.clock.advance(15_000); // outside the concurrent-request grace window => real replay
      const replay = await h.http().post('/api/v1/auth/refresh').set(web).set('Cookie', `rt=${rt1}`);
      expect(replay.status).toBe(401);
      // the legitimate newest token and its access token are dead too
      await h.http().post('/api/v1/auth/refresh').set(web).set('Cookie', `rt=${rt2}`).expect(401);
      await h.http().get('/api/v1/auth/me').set(bearer(r2.body.data.accessToken)).expect(401);
      const audit = await h.admin.query("SELECT 1 FROM audit_logs WHERE action='auth.refresh_reuse_detected' AND request_id IS NOT NULL OR action='auth.refresh_reuse_detected'");
      expect(audit.rowCount).toBeGreaterThan(0);
    });

    it('cookie-authenticated requests need an allowlisted Origin and the custom header (CSRF)', async () => {
      const { email, password } = await registerAndVerify(h);
      const rt = cookieValue(cookieOf(await h.http().post('/api/v1/auth/login').send({ email, password }))!);
      const cookie = `rt=${rt}`;
      await h.http().post('/api/v1/auth/refresh').set('Cookie', cookie).expect(403);
      await h.http().post('/api/v1/auth/refresh').set('Cookie', cookie).set('Origin', ORIGIN).expect(403);
      await h.http().post('/api/v1/auth/refresh').set('Cookie', cookie).set('X-CSRF-Token', 'x').expect(403);
      const evil = await h.http().post('/api/v1/auth/refresh').set('Cookie', cookie).set({ Origin: 'https://evil.test', 'X-CSRF-Token': 'x' });
      expect(evil.status).toBe(403);
      expect(evil.body.error.code).toBe('CSRF_REJECTED');
      await h.http().post('/api/v1/auth/logout').set('Cookie', cookie).expect(403);
      // none of those rejected attempts consumed the token
      await h.http().post('/api/v1/auth/refresh').set(web).set('Cookie', cookie).expect(200);
    });

    it('mobile: tokens travel in the body and rotate the same way', async () => {
      const { email, password } = await registerAndVerify(h);
      const login = await loginMobile(h, email, password);
      const r1 = login.body.data.refreshToken as string;
      const next = await h.http().post('/api/v1/auth/refresh').set(mobile).send({ refreshToken: r1 }).expect(200);
      expect(next.body.data.refreshToken).not.toBe(r1);
      await h.http().post('/api/v1/auth/refresh').set(mobile).send({ refreshToken: r1 }).expect(401);
      await h.http().post('/api/v1/auth/refresh').set(mobile).send({}).expect(401);
      await h.http().post('/api/v1/auth/refresh').set(mobile).send({ refreshToken: 'x'.repeat(43) }).expect(401);
    });

    it('two concurrent refreshes with the same token: exactly one wins', async () => {
      const { email, password } = await registerAndVerify(h);
      const rt = (await loginMobile(h, email, password)).body.data.refreshToken as string;
      const results = await Promise.all([1, 2, 3].map(() => h.http().post('/api/v1/auth/refresh').set(mobile).send({ refreshToken: rt })));
      const winners = results.filter((r) => r.status === 200);
      expect(winners).toHaveLength(1);
      // the parallel losers must NOT have killed the winner's session
      await h.http().post('/api/v1/auth/refresh').set(mobile).send({ refreshToken: winners[0].body.data.refreshToken }).expect(200);
    });

    it('refresh tokens expire', async () => {
      const { email, password } = await registerAndVerify(h);
      const rt = (await loginMobile(h, email, password)).body.data.refreshToken as string;
      h.clock.advance(31 * 86_400_000);
      await h.http().post('/api/v1/auth/refresh').set(mobile).send({ refreshToken: rt }).expect(401);
    });

    it('logout revokes the session immediately and is idempotent', async () => {
      const { email, password } = await registerAndVerify(h);
      const login = await loginMobile(h, email, password);
      const { accessToken, refreshToken } = login.body.data;
      await h.http().get('/api/v1/auth/me').set(bearer(accessToken)).expect(200);
      await h.http().post('/api/v1/auth/logout').set(mobile).send({ refreshToken }).expect(204);
      await h.http().get('/api/v1/auth/me').set(bearer(accessToken)).expect(401);
      await h.http().post('/api/v1/auth/logout').set(mobile).send({ refreshToken }).expect(204);
    });

    it('logout-all signs out every device', async () => {
      const { email, password } = await registerAndVerify(h);
      const a = (await loginMobile(h, email, password)).body.data.accessToken;
      const b = (await loginMobile(h, email, password)).body.data.accessToken;
      await h.http().post('/api/v1/auth/logout-all').set(bearer(a)).send({}).expect(200);
      await h.http().get('/api/v1/auth/me').set(bearer(a)).expect(401);
      await h.http().get('/api/v1/auth/me').set(bearer(b)).expect(401);
    });

    it('rejects missing, malformed and tampered bearer tokens', async () => {
      await h.http().get('/api/v1/auth/me').expect(401);
      await h.http().get('/api/v1/auth/me').set({ Authorization: 'Bearer nope' }).expect(401);
      await h.http().get('/api/v1/auth/me').set({ Authorization: 'Basic abc' }).expect(401);
      const { email, password } = await registerAndVerify(h);
      const t = (await loginMobile(h, email, password)).body.data.accessToken as string;
      await h.http().get('/api/v1/auth/me').set(bearer(t.slice(0, -3) + 'abc')).expect(401);
    });

    it("users can list their own sessions but cannot revoke someone else's (no IDOR)", async () => {
      const a = await registerAndVerify(h);
      const b = await registerAndVerify(h);
      const ta = (await loginMobile(h, a.email, a.password)).body.data.accessToken;
      const tb = (await loginMobile(h, b.email, b.password)).body.data.accessToken;
      const sessB = (await h.http().get('/api/v1/auth/sessions').set(bearer(tb)).expect(200)).body.data;
      expect(sessB).toHaveLength(1);
      expect(sessB[0].current).toBe(true);
      await h.http().delete(`/api/v1/auth/sessions/${sessB[0].id}`).set(bearer(ta)).expect(404);
      await h.http().get('/api/v1/auth/me').set(bearer(tb)).expect(200);
      await h.http().delete('/api/v1/auth/sessions/not-a-uuid').set(bearer(ta)).expect(400);
    });
  });

  // ------------------------------------------------------------ passwords
  describe('password reset and change', () => {
    it('forgot-password answers identically for known and unknown addresses', async () => {
      const { email } = await registerAndVerify(h);
      const a = await h.http().post('/api/v1/auth/forgot-password').send({ email }).expect(202);
      const b = await h.http().post('/api/v1/auth/forgot-password').send({ email: uniqueEmail('ghost') }).expect(202);
      expect(a.body).toEqual(b.body);
    });

    it('reset: single-use, kills all sessions, old password dies; weak password does not burn the link', async () => {
      const { email, password } = await registerAndVerify(h);
      const session = (await loginMobile(h, email, password)).body.data.accessToken;
      await h.http().post('/api/v1/auth/forgot-password').send({ email }).expect(202);
      const token = lastToken(h, email, 'Reset');
      await h.http().post('/api/v1/auth/reset-password').send({ token, newPassword: 'Password123' }).expect(400);
      const next = 'Maple-River-Sunrise-77';
      await h.http().post('/api/v1/auth/reset-password').send({ token, newPassword: next }).expect(204);
      await h.http().post('/api/v1/auth/reset-password').send({ token, newPassword: 'Another-Fine-Pass-88' }).expect(400);
      await h.http().get('/api/v1/auth/me').set(bearer(session)).expect(401);
      expect((await loginMobile(h, email, password)).status).toBe(401);
      expect((await loginMobile(h, email, next)).status).toBe(200);
      expect(h.mailer.outbox.some((m) => m.to === email && m.subject.includes('password was changed'))).toBe(true);
    });

    it('reset tokens expire after 30 minutes and a newer request voids the older link', async () => {
      const { email } = await registerAndVerify(h);
      await h.http().post('/api/v1/auth/forgot-password').send({ email });
      const old = lastToken(h, email, 'Reset');
      h.clock.advance(61_000); // past the resend cool-down
      await h.http().post('/api/v1/auth/forgot-password').send({ email });
      const fresh = lastToken(h, email, 'Reset');
      expect(fresh).not.toBe(old);
      await h.http().post('/api/v1/auth/reset-password').send({ token: old, newPassword: 'Maple-River-Sunrise-77' }).expect(400);
      h.clock.advance(31 * 60_000);
      await h.http().post('/api/v1/auth/reset-password').send({ token: fresh, newPassword: 'Maple-River-Sunrise-77' }).expect(400);
    });

    it('reset tokens are stored only as hashes', async () => {
      const { email } = await registerAndVerify(h);
      await h.http().post('/api/v1/auth/forgot-password').send({ email });
      const raw = lastToken(h, email, 'Reset');
      const rows = await h.admin.query('SELECT token_hash FROM auth_tokens');
      expect(rows.rows.some((r) => r.token_hash === raw)).toBe(false);
    });

    it('change-password needs the current password and signs out OTHER devices only', async () => {
      const { email, password } = await registerAndVerify(h);
      const cur = (await loginMobile(h, email, password)).body.data.accessToken;
      const other = (await loginMobile(h, email, password)).body.data.accessToken;
      await h.http().post('/api/v1/auth/change-password').set(bearer(cur)).send({ currentPassword: 'wrong', newPassword: 'Maple-River-Sunrise-77' }).expect(400);
      await h.http().post('/api/v1/auth/change-password').set(bearer(cur)).send({ currentPassword: password, newPassword: password }).expect(400);
      await h.http().post('/api/v1/auth/change-password').set(bearer(cur)).send({ currentPassword: password, newPassword: 'Maple-River-Sunrise-77' }).expect(204);
      await h.http().get('/api/v1/auth/me').set(bearer(cur)).expect(200);
      await h.http().get('/api/v1/auth/me').set(bearer(other)).expect(401);
    });
  });

  // ------------------------------------------------------------ MFA
  describe('multi-factor authentication', () => {
    async function ownerWithMfa() {
      const { email, password } = await registerAndVerify(h, { accountType: 'SALON_OWNER' });
      const access = (await loginMobile(h, email, password)).body.data.accessToken as string;
      await h.http().post('/api/v1/auth/mfa/setup').set(bearer(access)).send({ password: 'wrong' }).expect(400);
      const setup = (await h.http().post('/api/v1/auth/mfa/setup').set(bearer(access)).send({ password }).expect(200)).body.data;
      expect(setup.otpauthUri).toContain('otpauth://totp/');
      const stored = (await h.admin.query('SELECT mfa_secret_enc FROM users WHERE email=$1', [email])).rows[0].mfa_secret_enc as string;
      expect(stored).not.toContain(setup.secret); // encrypted at rest
      await h.http().post('/api/v1/auth/mfa/enable').set(bearer(access)).send({ code: '000000' }).expect(400);
      const en = await h.http().post('/api/v1/auth/mfa/enable').set(bearer(access)).send({ code: totp(setup.secret, h) }).expect(200);
      expect(en.body.data.recoveryCodes).toHaveLength(10);
      return { email, password, secret: setup.secret as string, recovery: en.body.data.recoveryCodes as string[], access };
    }

    it('enrol, then login requires a valid code; codes cannot be replayed; recovery codes work once', async () => {
      const o = await ownerWithMfa();
      const noCode = await loginMobile(h, o.email, o.password);
      expect(noCode.status).toBe(401);
      expect(noCode.body.error.code).toBe('MFA_REQUIRED');
      h.clock.advance(31_000); // next TOTP step (the enrolment step is already spent)
      const code = totp(o.secret, h);
      expect((await loginMobile(h, o.email, o.password, code)).status).toBe(200);
      expect((await loginMobile(h, o.email, o.password, code)).status).toBe(401); // replay
      expect((await loginMobile(h, o.email, o.password, '123456')).status).toBe(401);
      expect((await loginMobile(h, o.email, o.password, o.recovery[0])).status).toBe(200);
      expect((await loginMobile(h, o.email, o.password, o.recovery[0])).status).toBe(401); // single use
      const rows = await h.admin.query('SELECT code_hash FROM mfa_recovery_codes WHERE user_id=(SELECT id FROM users WHERE email=$1)', [o.email]);
      expect(rows.rows.some((r) => o.recovery.some((c) => c.replace(/-/g, '') === r.code_hash))).toBe(false);
    });

    it('wrong second factors count toward lockout', async () => {
      const o = await ownerWithMfa();
      for (let i = 0; i < 5; i++) await loginMobile(h, o.email, o.password, '111111');
      h.clock.advance(31_000);
      expect((await loginMobile(h, o.email, o.password, totp(o.secret, h))).status).toBe(401); // locked
    });

    it('disabling requires password + a code', async () => {
      const o = await ownerWithMfa();
      h.clock.advance(31_000);
      await h.http().post('/api/v1/auth/mfa/disable').set(bearer(o.access)).send({ password: 'wrong', code: totp(o.secret, h) }).expect(400);
      await h.http().post('/api/v1/auth/mfa/disable').set(bearer(o.access)).send({ password: o.password, code: totp(o.secret, h) }).expect(204);
      expect((await loginMobile(h, o.email, o.password)).status).toBe(200);
    });
  });

  // ------------------------------------------------------------ RBAC, platform admins, suspension
  describe('role-based access and admin protections', () => {
    it('customers, owners and staff cannot reach admin endpoints (403), anonymous gets 401', async () => {
      await h.http().get('/api/v1/admin/users').expect(401);
      await h.http().get('/api/v1/admin/audit-logs').expect(401);
      for (const accountType of ['CUSTOMER', 'SALON_OWNER'] as const) {
        const u = await registerAndVerify(h, { accountType });
        const t = (await loginMobile(h, u.email, u.password)).body.data.accessToken;
        await h.http().get('/api/v1/admin/users').set(bearer(t)).expect(403);
        await h.http().get('/api/v1/admin/audit-logs').set(bearer(t)).expect(403);
        await h.http().patch('/api/v1/admin/users/0192b3c4-d5e6-7f80-9a1b-2c3d4e5f6071/status').set(bearer(t)).send({ status: 'SUSPENDED', reason: 'abc' }).expect(403);
      }
    });

    async function adminSession(role: 'SUPER_ADMIN' | 'SUPPORT') {
      const u = await createPlatformUser(h, role);
      const access = (await loginMobile(h, u.email, u.password)).body.data.accessToken as string;
      return { ...u, access };
    }

    it('platform users must enrol MFA before touching anything but the enrolment endpoints', async () => {
      const a = await adminSession('SUPER_ADMIN');
      const me = await h.http().get('/api/v1/auth/me').set(bearer(a.access)).expect(200);
      expect(me.body.data.mfaEnrollmentRequired).toBe(true);
      const blocked = await h.http().get('/api/v1/admin/users').set(bearer(a.access));
      expect(blocked.status).toBe(403);
      expect(blocked.body.error.code).toBe('MFA_ENROLLMENT_REQUIRED');
      const setup = (await h.http().post('/api/v1/auth/mfa/setup').set(bearer(a.access)).send({ password: a.password }).expect(200)).body.data;
      await h.http().post('/api/v1/auth/mfa/enable').set(bearer(a.access)).send({ code: totp(setup.secret, h) }).expect(200);
      await h.http().get('/api/v1/admin/users').set(bearer(a.access)).expect(200);
      // mandatory MFA cannot be switched off
      h.clock.advance(31_000);
      await h.http().post('/api/v1/auth/mfa/disable').set(bearer(a.access)).send({ password: a.password, code: totp(setup.secret, h) }).expect(403);
    });

    async function mfaAdmin(role: 'SUPER_ADMIN' | 'SUPPORT') {
      const a = await adminSession(role);
      const setup = (await h.http().post('/api/v1/auth/mfa/setup').set(bearer(a.access)).send({ password: a.password }).expect(200)).body.data;
      await h.http().post('/api/v1/auth/mfa/enable').set(bearer(a.access)).send({ code: totp(setup.secret, h) }).expect(200);
      return a;
    }

    it('SUPPORT can read users but not change status; the user list never exposes secrets', async () => {
      const s = await mfaAdmin('SUPPORT');
      const victim = await registerAndVerify(h);
      const list = await h.http().get('/api/v1/admin/users').set(bearer(s.access)).query({ q: victim.email }).expect(200);
      expect(list.body.data.items).toHaveLength(1);
      expect(JSON.stringify(list.body)).not.toMatch(/passwordHash|password_hash|mfaSecret|argon2/i);
      await h.http().get('/api/v1/admin/audit-logs').set(bearer(s.access)).expect(403);
      await h.http().patch(`/api/v1/admin/users/${list.body.data.items[0].id}/status`).set(bearer(s.access)).send({ status: 'SUSPENDED', reason: 'testing' }).expect(403);
    });

    it('SUPER_ADMIN suspends a user: sessions die instantly, login is refused, action is audited atomically', async () => {
      const admin = await mfaAdmin('SUPER_ADMIN');
      const victim = await registerAndVerify(h);
      const vt = (await loginMobile(h, victim.email, victim.password)).body.data.accessToken;
      const vid = (await h.http().get('/api/v1/auth/me').set(bearer(vt))).body.data.user.id;
      await h.http().patch(`/api/v1/admin/users/${vid}/status`).set(bearer(admin.access)).send({ status: 'SUSPENDED' }).expect(400); // reason required
      await h.http().patch(`/api/v1/admin/users/${vid}/status`).set(bearer(admin.access)).send({ status: 'SUSPENDED', reason: 'Fraud report #1', role: 'SUPER_ADMIN' }).expect(400);
      await h.http().patch(`/api/v1/admin/users/${vid}/status`).set(bearer(admin.access)).send({ status: 'SUSPENDED', reason: 'Fraud report #1' }).expect(200);
      await h.http().get('/api/v1/auth/me').set(bearer(vt)).expect(401);
      const login = await loginMobile(h, victim.email, victim.password);
      expect(login.status).toBe(403);
      expect(login.body.error.code).toBe('ACCOUNT_SUSPENDED');
      const log = await h.admin.query("SELECT * FROM audit_logs WHERE action='admin.user_suspended' AND target_id=$1", [vid]);
      expect(log.rowCount).toBe(1);
      expect(log.rows[0].actor_user_id).toBeTruthy();
      expect(log.rows[0].metadata.reason).toBe('Fraud report #1');
      await h.http().patch(`/api/v1/admin/users/${vid}/status`).set(bearer(admin.access)).send({ status: 'ACTIVE', reason: 'Resolved' }).expect(200);
      expect((await loginMobile(h, victim.email, victim.password)).status).toBe(200);
    });

    it('SUPER_ADMIN cannot suspend themselves or another SUPER_ADMIN; unknown ids are 404', async () => {
      const a = await mfaAdmin('SUPER_ADMIN');
      const b = await createPlatformUser(h, 'SUPER_ADMIN');
      const aid = (await h.http().get('/api/v1/auth/me').set(bearer(a.access))).body.data.user.id;
      await h.http().patch(`/api/v1/admin/users/${aid}/status`).set(bearer(a.access)).send({ status: 'SUSPENDED', reason: 'oops' }).expect(403);
      await h.http().patch(`/api/v1/admin/users/${b.id}/status`).set(bearer(a.access)).send({ status: 'SUSPENDED', reason: 'coup' }).expect(403);
      await h.http().patch('/api/v1/admin/users/0192b3c4-d5e6-7f80-9a1b-2c3d4e5f6071/status').set(bearer(a.access)).send({ status: 'SUSPENDED', reason: 'nope' }).expect(404);
    });

    it('audit log is readable by SUPER_ADMIN and records auth events without secrets', async () => {
      const admin = await mfaAdmin('SUPER_ADMIN');
      const u = await registerAndVerify(h);
      await loginMobile(h, u.email, 'wrong-password-xx');
      const res = await h.http().get('/api/v1/admin/audit-logs').set(bearer(admin.access)).query({ pageSize: 100 }).expect(200);
      expect(res.body.data.items.length).toBeGreaterThan(0);
      const all = await h.admin.query('SELECT * FROM audit_logs');
      const dump = JSON.stringify(all.rows);
      expect(dump).not.toContain(GOOD_PASSWORD);
      expect(dump).not.toContain('wrong-password-xx');
      expect(dump).not.toMatch(/#token=|argon2id/);
      expect(all.rows.some((r) => r.action === 'auth.login_failed')).toBe(true);
    });
  });

  // ------------------------------------------------------------ route inventory & db hardening
  describe('guards and database hardening', () => {
    it('only the intended routes are public (default deny)', async () => {
      const { ModulesContainer } = await import('@nestjs/core');
      const { IS_PUBLIC } = await import('../src/common/auth/decorators');
      const PATH = 'path';
      const METHOD = 'method';
      const found: string[] = [];
      for (const mod of h.app.get(ModulesContainer).values()) {
        for (const w of mod.controllers.values()) {
          const proto = w.metatype?.prototype as Record<string, unknown> | undefined;
          if (!proto) continue;
          const base = String(Reflect.getMetadata(PATH, w.metatype!) ?? '');
          for (const name of Object.getOwnPropertyNames(proto)) {
            const fn = proto[name];
            if (typeof fn !== 'function' || name === 'constructor') continue;
            if (Reflect.getMetadata(METHOD, fn) === undefined) continue;
            const isPublic = Reflect.getMetadata(IS_PUBLIC, fn) === true || Reflect.getMetadata(IS_PUBLIC, w.metatype!) === true;
            if (isPublic) found.push(`${base}/${String(Reflect.getMetadata(PATH, fn))}`.replace(/\/+/g, '/'));
          }
        }
      }
      expect(found.sort()).toEqual([
        'auth/forgot-password', 'auth/login', 'auth/logout', 'auth/refresh', 'auth/register',
        'auth/resend-verification', 'auth/reset-password', 'auth/verify-email', 'health/', 'health/ready',
        // Phase 3: approved-salon read endpoints (RLS only exposes APPROVED salons to public-read transactions)
        'public/salons/', 'public/salons/:id',
        // Phase 4: customer-facing catalogue of an approved salon
        'public/salons/:id/catalog',
        // Phase 5: token-in-body invitation preview and accept (single-use, hashed, rate limited)
        'public/staff-invitations/accept', 'public/staff-invitations/preview',
        // Phase 7: customer discovery (read-only; APPROVED and currently listed salons only)
        'public/discovery/options', 'public/discovery/salons', 'public/discovery/salons/:id/availability',
      ].sort());
    });

    it('the runtime DB role cannot rewrite or delete audit records', async () => {
      const { Pool } = await import('pg');
      const app = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
      try {
        await expect(app.query("UPDATE audit_logs SET action='tampered'")).rejects.toThrow(/permission denied/);
        await expect(app.query('DELETE FROM audit_logs')).rejects.toThrow(/permission denied/);
      } finally {
        await app.end();
      }
    });

    it('SQL-injection payloads in credentials are inert', async () => {
      const r = await loginMobile(h, "a@b.com' OR '1'='1", "' OR '1'='1");
      expect(r.status).toBe(400);
      const email = uniqueEmail();
      await h.http().post('/api/v1/auth/register').send({ email, password: GOOD_PASSWORD, fullName: "Robert'); DROP TABLE users;--", accountType: 'CUSTOMER' }).expect(202);
      expect((await h.admin.query('SELECT full_name FROM users WHERE email=$1', [email])).rows[0].full_name).toContain('DROP TABLE');
      expect((await h.admin.query('SELECT count(*)::int n FROM users')).rows[0].n).toBeGreaterThan(0);
    });
  });
});
