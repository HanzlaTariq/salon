import { Pool, PoolClient } from 'pg';
import sharp from 'sharp';
import { hotp, base32Decode, timeStep } from '../src/modules/auth/totp';
import { Harness, GOOD_PASSWORD, bearer, createHarness, dbEnabled, lastToken, loginMobile, registerAndVerify, uniqueEmail } from './support/harness';

const d = dbEnabled ? describe : describe.skip;
if (!dbEnabled) {
  // eslint-disable-next-line no-console
  console.warn('SKIPPED staff e2e: set TEST_DATABASE_URL (salon_app) and TEST_ADMIN_DATABASE_URL (salon_migrator).');
}

const totp = (secretB32: string, h: Harness) => hotp(base32Decode(secretB32), timeStep(h.clock.now().getTime()));
const png = (color = '#c07840') => sharp({ create: { width: 600, height: 400, channels: 3, background: color } }).png().toBuffer();
const SALON = { name: 'Glow Studio', salonType: 'UNISEX', city: 'Lahore', area: 'Gulberg', addressLine: '12 Main Boulevard, Gulberg III', phone: '0300 1234567' };
const WEEK = [1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, closed: false, opensAt: '10:00', closesAt: '21:00' })).concat([{ weekday: 7, closed: true } as never]);
/** A date `n` days from now (YYYY-MM-DD, UTC). Leave tests must use future dates. */
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const DAY = (weekday: number, startsAt = '11:00', endsAt = '19:00') => ({ weekday, off: weekday === 7, startsAt: weekday === 7 ? undefined : startsAt, endsAt: weekday === 7 ? undefined : endsAt });
const WORK_WEEK = [1, 2, 3, 4, 5, 6, 7].map((w) => DAY(w));

d('Phase 5: team, invitations, staff accounts, hours, breaks, leave (real PostgreSQL)', () => {
  let h: Harness;
  let appPool: Pool;

  beforeAll(async () => {
    h = await createHarness();
    appPool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 2 });
  });
  afterAll(async () => {
    await appPool.end();
    await h.close();
  });

  // ------------------------------------------------------------------ helpers
  async function aq(sql: string, params: unknown[] = []) {
    const c = await h.admin.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.is_platform_admin','true',true)`);
      const r = await c.query(sql, params);
      await c.query('COMMIT');
      return r;
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  }
  /** Runs queries as the RUNTIME role (salon_app, RLS enforced) under a chosen identity. */
  async function asApp<T>(ctx: { user?: string; salon?: string }, fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await appPool.connect();
    try {
      await c.query('BEGIN');
      await c.query(
        `SELECT set_config('app.user_id',$1,true), set_config('app.salon_id',$2,true), set_config('app.is_platform_admin','false',true), set_config('app.public_read','false',true)`,
        [ctx.user ?? '', ctx.salon ?? ''],
      );
      return await fn(c);
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  }
  async function owner() {
    const u = await registerAndVerify(h, { accountType: 'SALON_OWNER', fullName: 'Owner Person' });
    const access = (await loginMobile(h, u.email, u.password)).body.data.accessToken as string;
    const id = (await aq('SELECT id FROM users WHERE email=$1', [u.email])).rows[0].id as string;
    return { ...u, access, id };
  }
  async function platformAdmin() {
    const { createPlatformUser } = await import('./support/harness');
    const u = await createPlatformUser(h, 'SUPER_ADMIN');
    const access = (await loginMobile(h, u.email, u.password)).body.data.accessToken as string;
    const setup = (await h.http().post('/api/v1/auth/mfa/setup').set(bearer(access)).send({ password: u.password }).expect(200)).body.data;
    await h.http().post('/api/v1/auth/mfa/enable').set(bearer(access)).send({ code: totp(setup.secret, h) }).expect(200);
    return { ...u, access };
  }
  const upload = (token: string, kind: string, docType: string, buf: Buffer) =>
    h.http().post('/api/v1/salons/mine/files').set(bearer(token)).field('kind', kind).field('docType', docType).attach('file', buf, 'x.png');
  const owned = (t: string) => ({
    get: (p: string) => h.http().get(`/api/v1/salons/mine/team${p}`).set(bearer(t)),
    post: (p: string, b?: object) => h.http().post(`/api/v1/salons/mine/team${p}`).set(bearer(t)).send(b ?? {}),
    patch: (p: string, b: object) => h.http().patch(`/api/v1/salons/mine/team${p}`).set(bearer(t)).send(b),
    put: (p: string, b: object) => h.http().put(`/api/v1/salons/mine/team${p}`).set(bearer(t)).send(b),
    del: (p: string) => h.http().delete(`/api/v1/salons/mine/team${p}`).set(bearer(t)),
  });

  /** Owner with a salon, opening hours set (Mon-Sat 10-21, Sunday closed). Not approved yet. */
  async function draftOwner() {
    const o = await owner();
    const salonId = (await h.http().post('/api/v1/salons').set(bearer(o.access)).send(SALON).expect(201)).body.data.salon.id as string;
    await h.http().put('/api/v1/salons/mine/opening-hours').set(bearer(o.access)).send({ days: WEEK }).expect(200);
    return { o, salonId, a: owned(o.access) };
  }
  /** Owner whose salon is APPROVED (staff can log in and use their own dashboard only then). */
  async function approvedOwner() {
    const x = await draftOwner();
    await upload(x.o.access, 'DOCUMENT', 'CNIC_FRONT', await png()).expect(201);
    await upload(x.o.access, 'DOCUMENT', 'CNIC_BACK', await png()).expect(201);
    await upload(x.o.access, 'PHOTO', 'COVER', await png()).expect(201);
    await h.http().post('/api/v1/salons/mine/submit').set(bearer(x.o.access)).expect(200);
    const sa = await platformAdmin();
    await h.http().post(`/api/v1/admin/salons/${x.salonId}/approve`).set(bearer(sa.access)).expect(200);
    return x;
  }
  async function staffMember(a: ReturnType<typeof owned>, displayName: string) {
    return (await a.post('', { displayName }).expect(201)).body.data.id as string;
  }
  /** Sends an invitation and returns the raw token from the e-mail. */
  async function invite(a: ReturnType<typeof owned>, staffId: string, email: string, h2 = h) {
    await a.post(`/${staffId}/invitation`, { email }).expect(201);
    return lastToken(h2, email, 'Invitation');
  }
  function accept(token: string, fullName = 'Staff Person', password = GOOD_PASSWORD) {
    return h.http().post('/api/v1/public/staff-invitations/accept').send({ token, fullName, password });
  }
  /** Invites, accepts and logs in a staff member. Returns their e-mail, access token and user id. */
  async function activeStaff(a: ReturnType<typeof owned>, staffId: string) {
    const email = uniqueEmail('staff');
    const token = await invite(a, staffId, email);
    await accept(token).expect(201);
    const access = (await loginMobile(h, email, GOOD_PASSWORD)).body.data.accessToken as string;
    const userId = (await aq('SELECT id FROM users WHERE email=$1', [email])).rows[0].id as string;
    return { email, access, userId };
  }

  // ------------------------------------------------------------------ authorization
  it('role gates: owner routes need SALON_OWNER, staff routes need SALON_STAFF, anonymous gets 401', async () => {
    await h.http().get('/api/v1/salons/mine/team').expect(401);
    await h.http().get('/api/v1/staff/me').expect(401);
    const c = await registerAndVerify(h, { accountType: 'CUSTOMER' });
    const ct = (await loginMobile(h, c.email, c.password)).body.data.accessToken as string;
    await owned(ct).get('').expect(403);
    await h.http().get('/api/v1/staff/me').set(bearer(ct)).expect(403);
    const { o, a } = await draftOwner();
    await a.get('').expect(200);
    await h.http().get('/api/v1/staff/me').set(bearer(o.access)).expect(403);
  });

  // ------------------------------------------------------------------ roster
  it('roster: the owner profile is created once, validation and mass assignment are refused', async () => {
    const { o, a } = await draftOwner();
    const self = (await a.post('', { self: true }).expect(201)).body.data;
    expect(self).toMatchObject({ isOwner: true, isActive: true, performsServices: true, billable: true, account: 'LINKED' });
    await a.post('', { self: true }).expect(409);
    await a.post('', { displayName: 'Ali', permissions: ['users.delete'] }).expect(400);
    await a.post('', { displayName: 'Ali', salonId: '00000000-0000-4000-8000-000000000000' }).expect(400); // mass assignment
    await a.post('', { displayName: '<b>x</b>' }).expect(400);
    await a.patch(`/${self.id}`, { isActive: false }).expect(409); // owner cannot be deactivated
    await a.del(`/${self.id}`).expect(409); // owner cannot be removed
    const list = (await a.get('').expect(200)).body.data;
    expect(list.billing).toMatchObject({ billableStaff: 1, activeNonPerforming: 0, inactive: 0, ownerBillable: true });
    expect(o.id).toBeTruthy();
  });

  // ------------------------------------------------------------------ invitations and accounts
  it('invitations: one live link per member, resend invalidates the old link, single use, generic errors', async () => {
    const { a } = await approvedOwner();
    const ali = await staffMember(a, 'Ali');
    const email = uniqueEmail('ali');
    const first = await invite(a, ali, email);
    const second = await invite(a, ali, email); // resend
    expect(second).not.toBe(first);

    const old = await h.http().post('/api/v1/public/staff-invitations/preview').send({ token: first });
    expect(old.status).toBe(400);
    expect(old.body.error.message).toBe('This invitation link is invalid or has expired.');

    const preview = (await h.http().post('/api/v1/public/staff-invitations/preview').send({ token: second }).expect(200)).body.data;
    expect(preview).toMatchObject({ salonName: SALON.name, displayName: 'Ali' });
    expect(JSON.stringify(preview)).not.toContain(email); // only a masked address is shown
    await h.http().post('/api/v1/public/staff-invitations/preview').send({ token: 'x'.repeat(40) }).expect(400);

    await accept(second, 'Ali Raza', 'short').expect(400); // password policy
    await accept(second).expect(201);
    await accept(second).expect(400); // replay refused

    const list = (await a.get('').expect(200)).body.data;
    expect(list.members.find((m: { id: string }) => m.id === ali)).toMatchObject({ account: 'LINKED' });
    await a.post(`/${ali}/invitation`, { email: uniqueEmail('other') }).expect(409); // already linked
  });

  it('the staff account can read ONLY its own dashboard; colleagues are invisible', async () => {
    const { salonId, a } = await approvedOwner();
    const ali = await staffMember(a, 'Ali');
    const bilal = await staffMember(a, 'Bilal');
    const s = await activeStaff(a, ali);

    const me = (await h.http().get('/api/v1/staff/me').set(bearer(s.access)).expect(200)).body.data;
    expect(me.profile).toMatchObject({ id: ali, displayName: 'Ali' });
    expect(me.salon).toMatchObject({ id: salonId, name: SALON.name });
    expect(me.workingHours).toHaveLength(7);
    expect(JSON.stringify(me)).not.toContain('Bilal');
    expect(JSON.stringify(me)).not.toContain(bilal);

    // Database check as the runtime role: Ali's context sees no colleague rows in the team tables.
    await a.put(`/${bilal}/working-hours`, { days: WORK_WEEK }).expect(200);
    const colleagueHours = await asApp({ user: s.userId, salon: salonId }, async (c) =>
      (await c.query(`SELECT count(*)::int AS n FROM staff_working_hours WHERE staff_id = $1`, [bilal])).rows[0].n);
    const ownHours = await asApp({ user: s.userId, salon: salonId }, async (c) =>
      (await c.query(`SELECT count(*)::int AS n FROM staff_working_hours WHERE staff_id = $1`, [ali])).rows[0].n);
    expect(colleagueHours).toBe(0);
    expect(ownHours).toBe(0); // Ali has no hours yet
    const invites = await asApp({ user: s.userId, salon: salonId }, async (c) =>
      (await c.query(`SELECT count(*)::int AS n FROM staff_invitations`)).rows[0].n);
    expect(invites).toBe(0); // invitations are never visible to staff
  });

  it('a second owner cannot see or change this salon\'s team (404, no leakage)', async () => {
    const x = await approvedOwner();
    const bilal = await staffMember(x.a, 'Bilal');
    const other = await approvedOwner();
    await other.a.get(`/${bilal}`).expect(404);
    await other.a.patch(`/${bilal}`, { displayName: 'Hacked' }).expect(404);
    await other.a.del(`/${bilal}`).expect(404);
    const list = (await other.a.get('').expect(200)).body.data;
    expect(list.members.map((m: { id: string }) => m.id)).not.toContain(bilal);
  });

  // ------------------------------------------------------------------ hours and breaks
  it('working hours must sit inside salon hours; breaks need permission and must fit the hours', async () => {
    const { o, a } = await approvedOwner();
    const ali = await staffMember(a, 'Ali');
    const s = await activeStaff(a, ali);
    const sundayOpen = WORK_WEEK.map((x) => (x.weekday === 7 ? { ...x, off: false, startsAt: '11:00', endsAt: '12:00' } : x));
    await a.put(`/${ali}/working-hours`, { days: sundayOpen }).expect(400); // salon closed on Sunday
    await a.put(`/${ali}/working-hours`, { days: WORK_WEEK.map((x) => (x.weekday === 1 ? { ...x, startsAt: '08:00' } : x)) }).expect(400);
    await a.put(`/${ali}/working-hours`, { days: WORK_WEEK.slice(0, 6) }).expect(400);
    const set = (await a.put(`/${ali}/working-hours`, { days: WORK_WEEK }).expect(200)).body.data.workingHours;
    expect(set.find((x: { weekday: number }) => x.weekday === 1)).toMatchObject({ off: false, startsAt: '11:00', endsAt: '19:00' });

    // Staff breaks need the owner's permission.
    await h.http().put('/api/v1/staff/me/breaks').set(bearer(s.access)).send({ breaks: [{ weekday: 1, startsAt: '13:00', endsAt: '13:30' }] }).expect(403);
    await a.patch(`/${ali}`, { permissions: ['schedule.manage_own'] }).expect(200);
    const br = await h.http().put('/api/v1/staff/me/breaks').set(bearer(s.access)).send({ breaks: [{ weekday: 1, startsAt: '13:00', endsAt: '13:30', label: 'Lunch' }] }).expect(200);
    expect(br.body.data.breaks).toEqual([{ weekday: 1, startsAt: '13:00', endsAt: '13:30', label: 'Lunch' }]);
    await h.http().put('/api/v1/staff/me/breaks').set(bearer(s.access)).send({
      breaks: [{ weekday: 1, startsAt: '13:00', endsAt: '13:30' }, { weekday: 1, startsAt: '13:15', endsAt: '13:45' }],
    }).expect(400); // overlap

    // Owner cannot move the hours past an existing break.
    await a.put(`/${ali}/working-hours`, { days: WORK_WEEK.map((x) => (x.weekday === 1 ? { ...x, startsAt: '14:00' } : x)) }).expect(409);
    expect(o.id).toBeTruthy();
  });

  // ------------------------------------------------------------------ leave
  it('leave: owner records approved leave; staff requests are pending until approved; overlaps are refused', async () => {
    const { a } = await approvedOwner();
    const ali = await staffMember(a, 'Ali');
    const s = await activeStaff(a, ali);
    await a.patch(`/${ali}`, { permissions: ['schedule.manage_own'] }).expect(200);

    const ownerLeave = (await a.post(`/${ali}/leaves`, { startsOn: inDays(30), endsOn: inDays(32), reason: 'Eid' }).expect(201)).body.data;
    expect(ownerLeave).toMatchObject({ status: 'APPROVED', startsOn: inDays(30), endsOn: inDays(32) });
    await a.post(`/${ali}/leaves`, { startsOn: inDays(31), endsOn: inDays(33) }).expect(409); // overlap (DB exclusion)

    const req = (await h.http().post('/api/v1/staff/me/leaves').set(bearer(s.access)).send({ startsOn: inDays(60), endsOn: inDays(61) }).expect(201)).body.data;
    expect(req.status).toBe('PENDING');
    await h.http().post('/api/v1/staff/me/leaves').set(bearer(s.access)).send({ startsOn: inDays(-3), endsOn: inDays(1) }).expect(400); // starts in the past
    await h.http().post('/api/v1/staff/me/leaves').set(bearer(s.access)).send({ startsOn: inDays(61), endsOn: inDays(62) }).expect(409); // overlaps pending

    const approved = (await a.patch(`/leaves/${req.id}`, { decision: 'APPROVE' }).expect(200)).body.data;
    expect(approved.status).toBe('APPROVED');
    await a.patch(`/leaves/${req.id}`, { decision: 'REJECT' }).expect(409); // already decided

    const cancelled = await h.http().delete(`/api/v1/staff/me/leaves/${approved.id}`).set(bearer(s.access));
    expect(cancelled.status).toBe(409); // staff can only withdraw a PENDING request
    await a.del(`/${ali}/leaves/${approved.id}`).expect(204);
  });

  // ------------------------------------------------------------------ deactivation
  it('deactivation ends the staff session at once and drops the member from billing', async () => {
    const { a } = await approvedOwner();
    const ali = await staffMember(a, 'Ali');
    const s = await activeStaff(a, ali);
    await h.http().get('/api/v1/staff/me').set(bearer(s.access)).expect(200);
    expect((await a.get('').expect(200)).body.data.billing.billableStaff).toBe(1);

    await a.patch(`/${ali}`, { isActive: false }).expect(200);
    await h.http().get('/api/v1/staff/me').set(bearer(s.access)).expect(401); // session revoked
    expect((await a.get('').expect(200)).body.data.billing).toMatchObject({ billableStaff: 0, inactive: 1 });

    const again = await loginMobile(h, s.email, GOOD_PASSWORD);
    expect(again.status).toBe(200);
    await h.http().get('/api/v1/staff/me').set(bearer(again.body.data.accessToken as string)).expect(403);

    await a.patch(`/${ali}`, { isActive: true }).expect(200);
    await h.http().get('/api/v1/staff/me').set(bearer(again.body.data.accessToken as string)).expect(200);
  });

  it('a non-performing member (receptionist) is not billed; an owner who only manages is not billed', async () => {
    const { a } = await approvedOwner();
    const rec = await staffMember(a, 'Front Desk');
    await a.patch(`/${rec}`, { performsServices: false }).expect(200);
    const list = (await a.get('').expect(200)).body.data;
    expect(list.billing).toMatchObject({ billableStaff: 0, activeNonPerforming: 1 });
  });
});
