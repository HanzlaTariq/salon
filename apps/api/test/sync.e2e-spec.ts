import { randomUUID } from 'crypto';
import { Pool, PoolClient } from 'pg';
import sharp from 'sharp';
import { hotp, base32Decode, timeStep } from '../src/modules/auth/totp';
import { slotMs } from '../src/modules/booking/booking.types';
import { todayKarachi } from '../src/modules/billing/billing.types';
import { addDaysIso, isoWeekday } from '../src/modules/discovery/discovery.types';
import { Harness, bearer, createHarness, createPlatformUser, dbEnabled, loginMobile, registerAndVerify, lastToken, uniqueEmail, GOOD_PASSWORD } from './support/harness';

const d = dbEnabled ? describe : describe.skip;
if (!dbEnabled) {
  // eslint-disable-next-line no-console
  console.warn('SKIPPED sync e2e: set TEST_DATABASE_URL (salon_app) and TEST_ADMIN_DATABASE_URL (salon_migrator).');
}

const totp = (secretB32: string, h: Harness) => hotp(base32Decode(secretB32), timeStep(h.clock.now().getTime()));
const png = () => sharp({ create: { width: 600, height: 400, channels: 3, background: '#c07840' } }).png().toBuffer();
const WEEK = [1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, closed: false, opensAt: '10:00', closesAt: '21:00' })).concat([{ weekday: 7, closed: true } as never]);
/** Staff: Monday-Friday 10:00-18:00 with a 13:00-14:00 break. */
const STAFF_WEEK = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, off: false, startsAt: '10:00', endsAt: '18:00' })).concat([{ weekday: 6, off: true }, { weekday: 7, off: true }] as never[]);
let cityCounter = 0;
const uniqueCity = () => `Queueville${Date.now().toString(36)}${cityCounter++}`;

d('Phase 12: offline sync (operation ledger, replay, conflicts, pull, notes) on real PostgreSQL', () => {
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
  // Every test starts from the real "now" (sessions, tokens and the salon trial stay valid) and then moves into its working day.
  beforeEach(() => h.clock.set(Date.now()));

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
  async function asApp<T>(ctx: { user?: string; salon?: string }, fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await appPool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.user_id',$1,true), set_config('app.salon_id',$2,true), set_config('app.is_platform_admin','false',true), set_config('app.public_read','false',true)`, [ctx.user ?? '', ctx.salon ?? '']);
      return await fn(c);
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  }
  async function admin() {
    const u = await createPlatformUser(h, 'SUPER_ADMIN');
    const access = (await loginMobile(h, u.email, u.password)).body.data.accessToken as string;
    const setup = (await h.http().post('/api/v1/auth/mfa/setup').set(bearer(access)).send({ password: u.password }).expect(200)).body.data;
    await h.http().post('/api/v1/auth/mfa/enable').set(bearer(access)).send({ code: totp(setup.secret, h) }).expect(200);
    return access;
  }
  async function owner() {
    const u = await registerAndVerify(h, { accountType: 'SALON_OWNER', fullName: 'Owner Person' });
    const access = (await loginMobile(h, u.email, u.password)).body.data.accessToken as string;
    return { ...u, access };
  }
  async function customer(name: string) {
    const u = await registerAndVerify(h, { accountType: 'CUSTOMER', fullName: name });
    const access = (await loginMobile(h, u.email, u.password)).body.data.accessToken as string;
    const id = (await aq('SELECT id FROM users WHERE email = $1', [u.email])).rows[0].id as string;
    await aq(`UPDATE users SET phone = '+923001234567' WHERE id = $1`, [id]);
    return { ...u, access, id, name };
  }
  const mine = (t: string) => ({
    get: (p: string) => h.http().get(`/api/v1/salons/mine${p}`).set(bearer(t)),
    post: (p: string, b: object = {}) => h.http().post(`/api/v1/salons/mine${p}`).set(bearer(t)).send(b),
    put: (p: string, b: object) => h.http().put(`/api/v1/salons/mine${p}`).set(bearer(t)).send(b),
    patch: (p: string, b: object) => h.http().patch(`/api/v1/salons/mine${p}`).set(bearer(t)).send(b),
  });
  const upload = (token: string, kind: string, docType: string, buf: Buffer) =>
    h.http().post('/api/v1/salons/mine/files').set(bearer(token)).field('kind', kind).field('docType', docType).attach('file', buf, 'x.png');
  const today = () => todayKarachi(h.clock.now());
  /** A working day (Mon-Fri) 2..6 days away. */
  const workday = () => {
    for (let i = 2; i <= 6; i += 1) if (isoWeekday(addDaysIso(today(), i)) <= 5) return addDaysIso(today(), i);
    throw new Error('unreachable');
  };
  /** Moves the fake clock to HH:MM (Karachi) of `date`. */
  const goto = (date: string, time: string) => {
    const [hh, mm] = time.split(':').map(Number);
    h.clock.set(slotMs(date, hh * 60 + mm));
  };

  interface Made { o: Awaited<ReturnType<typeof owner>>; salonId: string; staff: Record<string, string>; services: Record<string, string>; a: ReturnType<typeof mine>; adminToken: string }
  /** An APPROVED salon: Ali + Ahmed (Mon-Fri 10-18, break 13-14), Haircut (Ali 300 / Ahmed 500, 30 min), Beard (150, 15 min, Ali only). */
  async function salon(name: string): Promise<Made> {
    const adminToken = await admin();
    const o = await owner();
    const a = mine(o.access);
    const salonId = (await h.http().post('/api/v1/salons').set(bearer(o.access)).send({
      name, salonType: 'UNISEX', city: uniqueCity(), area: 'Central', addressLine: '12 Main Boulevard, Central', phone: '0300 1234567',
    }).expect(201)).body.data.salon.id as string;
    await a.put('/opening-hours', { days: WEEK }).expect(200);
    const staff: Record<string, string> = {};
    for (const n of ['Ali', 'Ahmed']) {
      const id = (await a.post('/team', { displayName: n }).expect(201)).body.data.id as string;
      staff[n] = id;
      await a.put(`/team/${id}/working-hours`, { days: STAFF_WEEK }).expect(200);
      await a.put(`/team/${id}/breaks`, { breaks: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startsAt: '13:00', endsAt: '14:00' })) }).expect(200);
    }
    const hair = (await a.post('/categories', { name: 'Hair' }).expect(201)).body.data.id as string;
    const services: Record<string, string> = {};
    services.Haircut = (await a.post('/services', { categoryId: hair, name: 'Haircut', durationMinutes: 30, pricing: { mode: 'STAFF_BASED' }, staff: [{ staffId: staff.Ali, price: 300 }, { staffId: staff.Ahmed, price: 500 }] }).expect(201)).body.data.id;
    services.Beard = (await a.post('/services', { categoryId: hair, name: 'Beard Trim', durationMinutes: 15, pricing: { mode: 'FIXED', price: 150 }, staff: [{ staffId: staff.Ali }] }).expect(201)).body.data.id;
    await upload(o.access, 'DOCUMENT', 'CNIC_FRONT', await png()).expect(201);
    await upload(o.access, 'DOCUMENT', 'CNIC_BACK', await png()).expect(201);
    await upload(o.access, 'PHOTO', 'COVER', await png()).expect(201);
    await a.post('/submit').expect(200);
    await h.http().post(`/api/v1/admin/salons/${salonId}/approve`).set(bearer(adminToken)).expect(200);
    return { o, salonId, staff, services, a, adminToken };
  }

  /** Invites, accepts and logs in a staff member of the salon (optionally with the walk-in permission). */
  async function staffAccount(m: Made, who: 'Ali' | 'Ahmed', permissions: string[] = []) {
    if (permissions.length) await m.a.patch(`/team/${m.staff[who]}`, { permissions }).expect(200);
    const email = uniqueEmail('staff');
    await m.a.post(`/team/${m.staff[who]}/invitation`, { email }).expect(201);
    const token = lastToken(h, email, 'Invitation');
    await h.http().post('/api/v1/public/staff-invitations/accept').send({ token, fullName: `${who} Staff`, password: GOOD_PASSWORD }).expect(201);
    const access = (await loginMobile(h, email, GOOD_PASSWORD)).body.data.accessToken as string;
    const userId = (await aq('SELECT id FROM users WHERE email=$1', [email])).rows[0].id as string;
    return { access, userId };
  }

  const book = (m: Made, c: { access: string }, who: string, services: string[], date: string, time: string) =>
    h.http().post('/api/v1/bookings').set(bearer(c.access)).send({ salonId: m.salonId, staffId: m.staff[who], serviceIds: services.map((s) => m.services[s]), date, time });
  const booked = async (m: Made, c: { access: string }, who: string, services: string[], date: string, time: string) =>
    (await book(m, c, who, services, date, time).expect(201)).body.data as { id: string };
  const S = (t: string) => ({
    get: (p: string) => h.http().get(`/api/v1/staff/me${p}`).set(bearer(t)),
    post: (p: string, b: object = {}, key?: string) => { const r = h.http().post(`/api/v1/staff/me${p}`).set(bearer(t)); return (key ? r.set('Idempotency-Key', key) : r).send(b); },
    del: (p: string) => h.http().delete(`/api/v1/staff/me${p}`).set(bearer(t)),
  });
  const myBooking = (c: { access: string }, id: string) => h.http().get(`/api/v1/bookings/${id}`).set(bearer(c.access));
  const dbRow = async (id: string) => (await aq('SELECT * FROM appointments WHERE id = $1', [id])).rows[0];

  // ------------------------------------------------------------------ sync helpers
  const DEVICE = '0b9f5f2e-6c4d-4a58-8f0a-1d2e3f4a5b6c';
  const uuid = () => randomUUID();
  const iso = (date: string, time: string) => { const [hh, mm] = time.split(':').map(Number); return new Date(slotMs(date, hh * 60 + mm)).toISOString(); };
  const at = (date: string, time: string) => { const [hh, mm] = time.split(':').map(Number); return slotMs(date, hh * 60 + mm); };
  type Op = { operationId: string; kind: string; createdAt: string; appointmentId?: string; refOperationId?: string; payload?: object };
  const op = (kind: string, createdAt: string, extra: Partial<Op> = {}): Op => ({ operationId: uuid(), kind, createdAt, ...extra });
  const push = (token: string, operations: Op[], deviceId = DEVICE) => h.http().post('/api/v1/sync/push').set(bearer(token)).send({ deviceId, operations });
  const pull = (token: string, qs = '') => h.http().get(`/api/v1/sync/pull${qs}`).set(bearer(token));
  const results = (r: { body: { data: { results: Array<Record<string, unknown>> } } }) => r.body.data.results;
  const ledgerCount = async (salonId: string) => (await aq('SELECT count(*)::int AS n FROM sync_operations WHERE salon_id = $1', [salonId])).rows[0].n as number;
  const events = async (id: string) => (await aq('SELECT event FROM appointment_status_history WHERE appointment_id = $1 ORDER BY created_at, id', [id])).rows.map((x) => x.event as string);
  const cancelByCustomer = (c: { access: string }, id: string) => h.http().post(`/api/v1/bookings/${id}/cancel`).set(bearer(c.access)).send({});

  // ------------------------------------------------------------------ a whole offline day
  it('an offline day is replayed: real times are recorded, a walk-in made offline is placed and served, a replay changes nothing', async () => {
    const m = await salon('Sync Day Salon');
    const c1 = await customer('Sync Customer');
    const D = workday();
    const b = await booked(m, c1, 'Ali', ['Haircut'], D, '11:00');
    const ali = await staffAccount(m, 'Ali', ['walk_ins.create']);
    goto(D, '12:10'); // the phone finds a signal now; everything below happened earlier

    const walk = op('WALK_IN_CREATE', iso(D, '11:40'), { payload: { customerName: 'Bilal Walkin', serviceIds: [m.services.Haircut], note: 'Fade', price: 1, durationMinutes: 1 } });
    // the device must NOT be able to send a price: the strict envelope refuses unknown fields only at the top level, the payload ignores them
    const ops = [
      op('APPT_START', iso(D, '11:02'), { appointmentId: b.id }),
      op('APPT_COMPLETE', iso(D, '11:35'), { appointmentId: b.id }),
      walk,
      op('APPT_START', iso(D, '11:41'), { refOperationId: walk.operationId }),
      op('APPT_COMPLETE', iso(D, '12:05'), { refOperationId: walk.operationId }),
      op('NOTE_ADD', iso(D, '12:06'), { appointmentId: b.id, payload: { body: 'Prefers scissors' } }),
    ];
    const first = await push(ali.access, ops).expect(200);
    const res = results(first);
    expect(res.map((x) => x.status)).toEqual(['APPLIED', 'APPLIED', 'APPLIED', 'APPLIED', 'APPLIED', 'APPLIED']);
    expect(res.every((x) => x.replayed === false)).toBe(true);
    const walkId = res[2].appointmentId as string;
    expect(res[3].appointmentId).toBe(walkId);

    const row = await dbRow(b.id);
    expect(row.status).toBe('COMPLETED');
    expect(new Date(row.started_at).getTime()).toBe(at(D, '11:02'));
    expect(new Date(row.completed_at).getTime()).toBe(at(D, '11:35'));
    const w = await dbRow(walkId);
    expect(w).toMatchObject({ status: 'COMPLETED', source: 'WALK_IN', walk_in_name: 'Bilal Walkin' });
    expect(Number(w.total_price)).toBe(300); // the catalogue price, not what the device claimed
    expect(new Date(w.starts_at).getTime()).toBe(at(D, '11:40'));
    expect(new Date(w.started_at).getTime()).toBe(at(D, '11:41'));
    expect(new Date(w.completed_at).getTime()).toBe(at(D, '12:05'));

    const history = await events(b.id);
    const ledger = await ledgerCount(m.salonId);
    expect(ledger).toBe(6);

    const again = results(await push(ali.access, ops).expect(200));
    expect(again.map((x) => x.status)).toEqual(['APPLIED', 'APPLIED', 'APPLIED', 'APPLIED', 'APPLIED', 'APPLIED']);
    expect(again.every((x) => x.replayed === true)).toBe(true);
    expect(again[2].appointmentId).toBe(walkId);
    expect(await events(b.id)).toEqual(history);
    expect(await ledgerCount(m.salonId)).toBe(ledger);
    expect((await aq(`SELECT count(*)::int AS n FROM appointments WHERE salon_id = $1 AND source = 'WALK_IN'`, [m.salonId])).rows[0].n).toBe(1);
    expect((await aq('SELECT count(*)::int AS n FROM appointment_notes WHERE appointment_id = $1', [b.id])).rows[0].n).toBe(1);
  });

  // ------------------------------------------------------------------ rules are judged at the claimed moment, refusals are final
  it('rules apply at the moment the person acted; a refusal is final and replays the same; a completion never precedes its start', async () => {
    const m = await salon('Sync Rules Salon');
    const c1 = await customer('Rules A');
    const c2 = await customer('Rules B');
    const c3 = await customer('Rules C');
    const D = workday();
    const a1 = await booked(m, c1, 'Ali', ['Haircut'], D, '11:00');
    const a2 = await booked(m, c2, 'Ali', ['Haircut'], D, '14:00');
    const a3 = await booked(m, c3, 'Ali', ['Haircut'], D, '15:00');
    await cancelByCustomer(c3, a3.id).expect(200);
    const ali = await staffAccount(m, 'Ali');
    goto(D, '16:00');

    const early = op('APPT_NO_SHOW', iso(D, '11:10'), { appointmentId: a1.id });
    const r1 = results(await push(ali.access, [
      early,
      op('APPT_START', iso(D, '10:00'), { appointmentId: a2.id }), // 4 hours before: too early AT THAT MOMENT
      op('APPT_START', iso(D, '15:30'), { appointmentId: a3.id }), // the customer cancelled online
    ]).expect(200));
    expect(r1[0]).toMatchObject({ status: 'REJECTED', code: 'NO_SHOW_GRACE' });
    expect(r1[1]).toMatchObject({ status: 'REJECTED', code: 'TOO_EARLY' });
    expect(r1[2]).toMatchObject({ status: 'REJECTED', code: 'STATUS' });
    expect((await dbRow(a1.id)).status).toBe('CONFIRMED');

    const r2 = results(await push(ali.access, [
      op('APPT_NO_SHOW', iso(D, '11:20'), { appointmentId: a1.id, payload: { reason: 'Did not come' } }),
      op('APPT_START', iso(D, '13:30'), { appointmentId: a2.id }),
      op('APPT_COMPLETE', iso(D, '13:00'), { appointmentId: a2.id }), // a clock that jumped back
    ]).expect(200));
    expect(r2.map((x) => x.status)).toEqual(['APPLIED', 'APPLIED', 'APPLIED']);
    expect(new Date((await dbRow(a1.id)).no_show_at).getTime()).toBe(at(D, '11:20'));
    const done = await dbRow(a2.id);
    expect(done.status).toBe('COMPLETED');
    expect(new Date(done.completed_at).getTime()).toBe(new Date(done.started_at).getTime());

    // final: the same refused operation answers the same, even though it would be allowed now
    const replay = results(await push(ali.access, [early]).expect(200));
    expect(replay[0]).toMatchObject({ status: 'REJECTED', code: 'NO_SHOW_GRACE', replayed: true });
  });

  // ------------------------------------------------------------------ envelope, idempotency, authorization
  it('validation, idempotency conflicts, batch limits and roles', async () => {
    const m = await salon('Sync Guard Salon');
    const c1 = await customer('Guard A');
    const D = workday();
    const a1 = await booked(m, c1, 'Ali', ['Haircut'], D, '11:00');
    const ali = await staffAccount(m, 'Ali');
    goto(D, '11:30');

    // the same operation id for another action is never applied
    const id = uuid();
    const okOp: Op = { operationId: id, kind: 'APPT_START', createdAt: iso(D, '11:01'), appointmentId: a1.id };
    expect(results(await push(ali.access, [okOp]).expect(200))[0].status).toBe('APPLIED');
    const clash = results(await push(ali.access, [{ operationId: id, kind: 'APPT_COMPLETE', createdAt: iso(D, '11:20'), appointmentId: a1.id }]).expect(200));
    expect(clash[0]).toMatchObject({ status: 'REJECTED', code: 'IDEMPOTENCY_MISMATCH', replayed: true });
    expect((await dbRow(a1.id)).status).toBe('IN_PROGRESS');

    // a bad payload or a bad reference refuses ONE operation, not the batch
    const mixed = results(await push(ali.access, [
      op('NOTE_ADD', iso(D, '11:10'), { appointmentId: a1.id, payload: { body: '' } }),
      op('APPT_COMPLETE', iso(D, '11:20')), // names no appointment
      op('APPT_COMPLETE', iso(D, '11:21'), { appointmentId: a1.id, refOperationId: uuid() }), // names two
      op('APPT_COMPLETE', iso(D, '11:22'), { refOperationId: uuid() }), // unknown walk-in
      op('APPT_COMPLETE', iso(D, '11:25'), { appointmentId: a1.id }),
    ]).expect(200));
    expect(mixed.map((x) => x.code ?? x.status)).toEqual(['VALIDATION_FAILED', 'VALIDATION_FAILED', 'VALIDATION_FAILED', 'DEPENDENCY_MISSING', 'APPLIED']);

    // envelope errors reject the whole request
    await push(ali.access, []).expect(400);
    await push(ali.access, Array.from({ length: 26 }, () => op('APPT_START', iso(D, '11:00'), { appointmentId: a1.id }))).expect(400);
    const dup = op('APPT_START', iso(D, '11:00'), { appointmentId: a1.id });
    await push(ali.access, [dup, dup]).expect(400);
    await push(ali.access, [{ ...okOp, operationId: uuid(), salonId: m.salonId } as Op]).expect(400); // mass assignment
    await push(ali.access, [{ ...okOp, operationId: uuid(), kind: 'DELETE_EVERYTHING' }]).expect(400);
    await push(ali.access, [{ ...okOp, operationId: uuid(), createdAt: 'yesterday' }]).expect(400);
    await push(ali.access, [okOp], 'not-a-uuid').expect(400);

    // roles
    await h.http().post('/api/v1/sync/push').send({ deviceId: DEVICE, operations: [okOp] }).expect(401);
    await push(c1.access, [okOp]).expect(403);
    await pull(c1.access).expect(403);
    await h.http().get('/api/v1/sync/pull').expect(401);
  });

  // ------------------------------------------------------------------ concurrency
  it('the same operation sent twice at the same time is applied once', async () => {
    const m = await salon('Sync Race Salon');
    const c1 = await customer('Race A');
    const D = workday();
    const a1 = await booked(m, c1, 'Ali', ['Haircut'], D, '11:00');
    const ali = await staffAccount(m, 'Ali', ['walk_ins.create']);
    goto(D, '11:30');

    const start = op('APPT_START', iso(D, '11:01'), { appointmentId: a1.id });
    const [s1, s2] = await Promise.all([push(ali.access, [start]), push(ali.access, [start])]);
    const out = [results(s1)[0], results(s2)[0]];
    expect(out.map((x) => x.status)).toEqual(['APPLIED', 'APPLIED']);
    expect(out.filter((x) => x.replayed === false)).toHaveLength(1);
    expect((await events(a1.id)).filter((e) => e === 'STARTED')).toHaveLength(1);

    const walk = op('WALK_IN_CREATE', iso(D, '11:25'), { payload: { customerName: 'Race Walkin', serviceIds: [m.services.Haircut] } });
    const [w1, w2] = await Promise.all([push(ali.access, [walk]), push(ali.access, [walk])]);
    expect([results(w1)[0].status, results(w2)[0].status]).toEqual(['APPLIED', 'APPLIED']);
    expect(results(w1)[0].appointmentId).toBe(results(w2)[0].appointmentId);
    expect((await aq(`SELECT count(*)::int AS n FROM appointments WHERE salon_id = $1 AND source = 'WALK_IN'`, [m.salonId])).rows[0].n).toBe(1);
    expect((await aq(`SELECT count(*)::int AS n FROM sync_operations WHERE salon_id = $1 AND operation_id = $2`, [m.salonId, walk.operationId])).rows[0].n).toBe(1);
  });

  // ------------------------------------------------------------------ tenant isolation, IDOR, permissions
  it('IDOR / BOLA: staff touch only their own appointments; another salon sees nothing; walk-in permission and owner rules hold', async () => {
    const m = await salon('Sync Tenant A');
    const other = await salon('Sync Tenant B');
    const c1 = await customer('Tenant A1');
    const c2 = await customer('Tenant A2');
    const D = workday();
    const aliBooking = await booked(m, c1, 'Ali', ['Haircut'], D, '11:00');
    const ahmedBooking = await booked(m, c2, 'Ahmed', ['Haircut'], D, '11:00');
    const ali = await staffAccount(m, 'Ali');
    const ahmed = await staffAccount(m, 'Ahmed', ['walk_ins.create']);
    const otherAli = await staffAccount(other, 'Ali');
    goto(D, '11:30');

    // a colleague's and another salon's appointments look like "not found", and so do notes
    const cross = results(await push(ahmed.access, [
      op('APPT_START', iso(D, '11:05'), { appointmentId: aliBooking.id }),
      op('NOTE_ADD', iso(D, '11:06'), { appointmentId: aliBooking.id, payload: { body: 'sneaky' } }),
    ]).expect(200));
    expect(cross.map((x) => x.code)).toEqual(['NOT_FOUND', 'NOT_FOUND']);
    const foreign = results(await push(otherAli.access, [op('APPT_START', iso(D, '11:05'), { appointmentId: aliBooking.id })]).expect(200));
    expect(foreign[0]).toMatchObject({ status: 'REJECTED', code: 'NOT_FOUND' });
    expect((await dbRow(aliBooking.id)).status).toBe('CONFIRMED');
    expect((await aq('SELECT count(*)::int AS n FROM appointment_notes WHERE salon_id = $1', [m.salonId])).rows[0].n).toBe(0);

    // an operation id belongs to its user: re-using somebody else's id is just another, independent operation
    const shared = op('APPT_START', iso(D, '11:05'), { appointmentId: ahmedBooking.id });
    expect(results(await push(ahmed.access, [shared]).expect(200))[0]).toMatchObject({ status: 'APPLIED', replayed: false });
    expect(results(await push(ali.access, [{ ...shared, appointmentId: aliBooking.id }]).expect(200))[0]).toMatchObject({ status: 'APPLIED', replayed: false });

    // walk-in permission: Ali has none, Ahmed has it; staff cannot pick another staff member
    const noPerm = results(await push(ali.access, [op('WALK_IN_CREATE', iso(D, '11:20'), { payload: { customerName: 'No Permission', serviceIds: [m.services.Haircut] } })]).expect(200));
    expect(noPerm[0]).toMatchObject({ status: 'REJECTED', code: 'FORBIDDEN' });
    const mine = results(await push(ahmed.access, [op('WALK_IN_CREATE', iso(D, '11:25'), { payload: { customerName: 'Ahmed Walkin', serviceIds: [m.services.Haircut], staffId: m.staff.Ali } })]).expect(200));
    expect(mine[0].status).toBe('APPLIED');
    expect((await dbRow(mine[0].appointmentId as string)).staff_id).toBe(m.staff.Ahmed); // the staff id came from the session

    // owner: needs a staff id, works for any staff member of the OWN salon only
    const noStaff = results(await push(m.o.access, [op('WALK_IN_CREATE', iso(D, '11:26'), { payload: { customerName: 'Owner Walkin', serviceIds: [m.services.Beard] } })]).expect(200));
    expect(noStaff[0]).toMatchObject({ status: 'REJECTED', code: 'VALIDATION_FAILED' });
    const ownerOk = results(await push(m.o.access, [op('WALK_IN_CREATE', iso(D, '11:27'), { payload: { customerName: 'Owner Walkin', serviceIds: [m.services.Beard], staffId: m.staff.Ali } })]).expect(200));
    expect(ownerOk[0].status).toBe('APPLIED');
    const foreignStaff = results(await push(m.o.access, [op('WALK_IN_CREATE', iso(D, '11:28'), { payload: { customerName: 'Owner Walkin', serviceIds: [m.services.Haircut], staffId: other.staff.Ali } })]).expect(200));
    expect(foreignStaff[0]).toMatchObject({ status: 'REJECTED', code: 'NOT_FOUND' });

    // the ledger is private: RLS shows each user only their own rows (the owner: the whole salon), never another salon's
    const ownerId = (await aq('SELECT owner_user_id FROM salons WHERE id = $1', [m.salonId])).rows[0].owner_user_id as string;
    const otherOwnerId = (await aq('SELECT owner_user_id FROM salons WHERE id = $1', [other.salonId])).rows[0].owner_user_id as string;
    const count = (ctx: { user: string; salon: string }) => asApp(ctx, async (c) => Number((await c.query('SELECT count(*)::int AS n FROM sync_operations')).rows[0].n));
    expect(await count({ user: ali.userId, salon: m.salonId })).toBe(2); // the refused walk-in + the shared-id start (the cross-salon attempts are other users' rows)
    expect(await count({ user: ahmed.userId, salon: m.salonId })).toBeGreaterThanOrEqual(4);
    expect(await count({ user: ownerId, salon: m.salonId })).toBe(await ledgerCount(m.salonId));
    expect(await count({ user: otherOwnerId, salon: m.salonId })).toBe(0);
    expect(await count({ user: otherOwnerId, salon: other.salonId })).toBe(1 + 0 + 0);
  });

  // ------------------------------------------------------------------ pull
  it('pull: staff get only their own appointments without phone numbers; the owner gets everything; delta and notes work', async () => {
    const m = await salon('Sync Pull Salon');
    const other = await salon('Sync Pull Other');
    const c1 = await customer('Pull A');
    const c2 = await customer('Pull B');
    const D = workday();
    const a1 = await booked(m, c1, 'Ali', ['Haircut'], D, '11:00');
    const a2 = await booked(m, c2, 'Ahmed', ['Haircut'], D, '12:00');
    const ali = await staffAccount(m, 'Ali', ['walk_ins.create']);
    await new Promise((r) => setTimeout(r, 11_000)); // a delta re-reads 10 s before its cursor (late commits): let the setup age out

    const full = (await pull(ali.access).expect(200)).body.data;
    expect(full.mode).toBe('FULL');
    expect(full.truncated).toBe(false);
    expect(full.appointments.map((x: { id: string }) => x.id)).toEqual([a1.id]);
    expect(full.appointments[0].customer.phone).toBeNull();
    expect(full.appointments[0]).toMatchObject({ status: 'CONFIRMED', time: '11:00', startsAt: expect.any(String) });
    expect(full.catalog).toMatchObject({ role: 'STAFF', ownStaffId: m.staff.Ali, noShowGraceMinutes: 15 });
    expect(full.catalog.staff).toHaveLength(1);
    expect(full.catalog.staff[0]).toMatchObject({ canAddWalkIn: true });
    expect(full.catalog.staff[0].services.map((s: { name: string }) => s.name).sort()).toEqual(['Beard Trim', 'Haircut']);

    const owner = (await pull(m.o.access).expect(200)).body.data;
    expect(owner.appointments.map((x: { id: string }) => x.id).sort()).toEqual([a1.id, a2.id].sort());
    expect(owner.appointments[0].customer.phone).toBe('+923001234567');
    expect(owner.catalog.staff).toHaveLength(2);
    expect((await pull(other.o.access).expect(200)).body.data.appointments).toEqual([]);

    // delta: nothing changed -> nothing; a customer cancels -> exactly that appointment; a note on an unchanged one -> still delivered
    const cursor = full.serverTime as string;
    const quiet = (await pull(ali.access, `?since=${encodeURIComponent(cursor)}`).expect(200)).body.data;
    expect(quiet.mode).toBe('DELTA');
    expect(quiet.appointments).toEqual([]);
    expect(quiet.catalog).toBeUndefined();
    const cursor2 = (await pull(ali.access, `?since=${encodeURIComponent(cursor)}`).expect(200)).body.data.serverTime as string;
    await cancelByCustomer(c1, a1.id).expect(200);
    const changed = (await pull(ali.access, `?since=${encodeURIComponent(cursor2)}`).expect(200)).body.data;
    expect(changed.appointments.map((x: { id: string; status: string }) => [x.id, x.status])).toEqual([[a1.id, 'CANCELLED']]);
    expect((await pull(ali.access, `?since=${encodeURIComponent(cursor2)}&catalog=true`).expect(200)).body.data.catalog).toBeDefined();

    await new Promise((r) => setTimeout(r, 12_000 + 200));
    const cursor3 = (await pull(m.o.access, `?since=${encodeURIComponent(cursor2)}`).expect(200)).body.data.serverTime as string;
    goto(D, '12:00');
    await push(m.o.access, [op('NOTE_ADD', iso(D, '11:59'), { appointmentId: a2.id, payload: { body: 'VIP guest' } })]).expect(200);
    const withNote = (await pull(m.o.access, `?since=${encodeURIComponent(cursor3)}`).expect(200)).body.data;
    expect(withNote.appointments.map((x: { id: string }) => x.id)).toEqual([a2.id]);
    expect(withNote.notes).toEqual([expect.objectContaining({ appointmentId: a2.id, body: 'VIP guest', mine: true })]);
    h.clock.set(Date.now());

    // a cursor from the future or from long ago is not trusted: full snapshot
    expect((await pull(ali.access, `?since=${encodeURIComponent(new Date(Date.now() + 3_600_000).toISOString())}`).expect(200)).body.data.mode).toBe('FULL');
    expect((await pull(ali.access, `?since=${encodeURIComponent(new Date(Date.now() - 30 * 86_400_000).toISOString())}`).expect(200)).body.data.mode).toBe('FULL');
    await pull(ali.access, '?since=garbage').expect(400);

    // customers never see a note
    const view = (await myBooking(c2, a2.id).expect(200)).body.data;
    expect(JSON.stringify(view)).not.toContain('VIP guest');
  }, 90_000);

  // ------------------------------------------------------------------ database rules
  it('database: append-only ledger and notes, RLS on notes, database-clock updated_at, and the 48-hour walk-in rule only inside the sync flag', async () => {
    const m = await salon('Sync Database Salon');
    const c1 = await customer('Db A');
    const D = workday();
    const a1 = await booked(m, c1, 'Ali', ['Haircut'], D, '11:00');
    const ali = await staffAccount(m, 'Ali');
    const ahmed = await staffAccount(m, 'Ahmed');
    goto(D, '11:30');
    await push(ali.access, [op('APPT_START', iso(D, '11:01'), { appointmentId: a1.id }), op('NOTE_ADD', iso(D, '11:02'), { appointmentId: a1.id, payload: { body: 'Hello' } })]).expect(200);
    const ownerId = (await aq('SELECT owner_user_id FROM salons WHERE id = $1', [m.salonId])).rows[0].owner_user_id as string;

    // append-only for the runtime role
    await expect(asApp({ user: ali.userId, salon: m.salonId }, (c) => c.query(`UPDATE sync_operations SET status = 'REJECTED', result_code = 'X'`))).rejects.toThrow(/permission denied/);
    await expect(asApp({ user: ali.userId, salon: m.salonId }, (c) => c.query('DELETE FROM sync_operations'))).rejects.toThrow(/permission denied/);
    await expect(asApp({ user: ali.userId, salon: m.salonId }, (c) => c.query(`UPDATE appointment_notes SET body = 'x'`))).rejects.toThrow(/permission denied/);

    // a ledger row cannot be written for somebody else
    await expect(asApp({ user: ahmed.userId, salon: m.salonId }, (c) => c.query(
      `INSERT INTO sync_operations (salon_id, user_id, device_id, operation_id, kind, fingerprint, client_created_at, effective_at, status, result_code)
       VALUES ($1, $2, $3, $4, 'APPT_START', repeat('a', 64), now(), now(), 'REJECTED', 'X')`, [m.salonId, ali.userId, DEVICE, uuid()]))).rejects.toThrow(/row-level security/);

    // notes: the author, the owner and the appointment's staff member see them; a colleague and a customer do not
    const notes = (ctx: { user: string; salon?: string }) => asApp(ctx, async (c) => Number((await c.query('SELECT count(*)::int AS n FROM appointment_notes')).rows[0].n));
    expect(await notes({ user: ali.userId, salon: m.salonId })).toBe(1);
    expect(await notes({ user: ownerId, salon: m.salonId })).toBe(1);
    expect(await notes({ user: ahmed.userId, salon: m.salonId })).toBe(0);
    expect(await notes({ user: c1.id })).toBe(0);
    await expect(asApp({ user: ahmed.userId, salon: m.salonId }, (c) => c.query(
      `INSERT INTO appointment_notes (salon_id, appointment_id, author_user_id, body) VALUES ($1, $2, $3, 'not mine')`, [m.salonId, a1.id, ahmed.userId]))).rejects.toThrow(/row-level security/);

    // updated_at belongs to the database clock
    const touched = await asApp({ user: ownerId, salon: m.salonId }, (c) => c.query(`UPDATE appointments SET updated_at = '2001-01-01' WHERE id = $1 RETURNING updated_at`, [a1.id]));
    expect(new Date(touched.rows[0].updated_at).getFullYear()).toBeGreaterThanOrEqual(2025);

    // the 48-hour walk-in rule exists only inside the sync flag
    const insertWalkIn = (hoursBack: number, flag: boolean) => asApp({ user: ownerId, salon: m.salonId }, async (c) => {
      if (flag) await c.query(`SELECT set_config('app.offline_sync', 'on', true)`);
      return c.query(
        `INSERT INTO appointments (salon_id, customer_user_id, staff_id, status, source, walk_in_name, starts_at, ends_at, buffer_minutes, blocked_until,
                                   total_duration_minutes, total_price, salon_name, staff_name)
         VALUES ($1, NULL, $2, 'CONFIRMED', 'WALK_IN', 'Backdated', now() - ($3 || ' hours')::interval, now() - ($3 || ' hours')::interval + interval '30 minutes',
                 0, now() - ($3 || ' hours')::interval + interval '30 minutes', 30, 300, 'S', 'Ali')`, [m.salonId, m.staff.Ahmed, String(hoursBack)]);
    });
    await expect(insertWalkIn(1, false)).rejects.toThrow(/walk-in must be a CONFIRMED/);
    await expect(insertWalkIn(1, true)).resolves.toBeDefined();
    await expect(insertWalkIn(72, true)).rejects.toThrow(/walk-in must be a CONFIRMED/);
  });
});
