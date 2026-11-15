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
  console.warn('SKIPPED queue e2e: set TEST_DATABASE_URL (salon_app) and TEST_ADMIN_DATABASE_URL (salon_migrator).');
}

const totp = (secretB32: string, h: Harness) => hotp(base32Decode(secretB32), timeStep(h.clock.now().getTime()));
const png = () => sharp({ create: { width: 600, height: 400, channels: 3, background: '#c07840' } }).png().toBuffer();
const WEEK = [1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, closed: false, opensAt: '10:00', closesAt: '21:00' })).concat([{ weekday: 7, closed: true } as never]);
/** Staff: Monday-Friday 10:00-18:00 with a 13:00-14:00 break. */
const STAFF_WEEK = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, off: false, startsAt: '10:00', endsAt: '18:00' })).concat([{ weekday: 6, off: true }, { weekday: 7, off: true }] as never[]);
let cityCounter = 0;
const uniqueCity = () => `Queueville${Date.now().toString(36)}${cityCounter++}`;
let keyCounter = 0;
const idemKey = () => `queue-key-${Date.now().toString(36)}-${keyCounter++}`;
const hm = (iso: string) => {
  const t = new Date(new Date(iso).getTime() + 5 * 3_600_000);
  return `${String(t.getUTCHours()).padStart(2, '0')}:${String(t.getUTCMinutes()).padStart(2, '0')}`;
};

d('Phase 9: staff queue, walk-ins, delay / ETA, early offers, arrival, no-show (real PostgreSQL)', () => {
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

  // ------------------------------------------------------------------ start, complete, order
  it('start -> complete: records the timestamps and history, frees the staff member, and every refusal is a clear 409', async () => {
    const m = await salon('Flow Salon');
    const c = await customer('Flow Customer');
    const D = workday();
    const b = await booked(m, c, 'Ali', ['Haircut'], D, '11:00');
    const ali = await staffAccount(m, 'Ali');

    goto(D, '09:30'); // 90 minutes before: too early to start
    const early = await S(ali.access).post(`/appointments/${b.id}/start`).expect(409);
    expect(early.body.error.details.rule).toBe('TOO_EARLY');
    await S(ali.access).post(`/appointments/${b.id}/complete`).expect(409); // not started yet

    goto(D, '10:30');
    const started = (await S(ali.access).post(`/appointments/${b.id}/start`).expect(200)).body.data;
    expect(started.appointment).toMatchObject({ status: 'IN_PROGRESS', time: '11:00' });
    expect(started.appointment.startedAt).toBeTruthy();
    expect(started.lane.current.id).toBe(b.id);
    expect((await myBooking(c, b.id).expect(200)).body.data.status).toBe('IN_PROGRESS');
    await S(ali.access).post(`/appointments/${b.id}/start`).expect(409); // already started

    goto(D, '11:05');
    const done = (await S(ali.access).post(`/appointments/${b.id}/complete`).expect(200)).body.data;
    expect(done.appointment.status).toBe('COMPLETED');
    expect(done.lane.today.completed).toBe(1);
    await S(ali.access).post(`/appointments/${b.id}/complete`).expect(409);
    const row = await dbRow(b.id);
    expect(row.completed_at).not.toBeNull();
    expect(row.started_at).not.toBeNull();
    const detail = (await myBooking(c, b.id).expect(200)).body.data;
    expect(detail.history.map((x: { event: string }) => x.event)).toEqual(['CREATED', 'STARTED', 'COMPLETED']);
    expect(detail.completedAt).toBeTruthy();
    // a completed appointment frees the slot (cannot block anyone any more)
    expect((await aq(`SELECT count(*)::int AS n FROM appointments WHERE id = $1 AND status IN ('PENDING','CONFIRMED','IN_PROGRESS','DELAYED')`, [b.id])).rows[0].n).toBe(0);
  });

  it('only ONE service in progress per staff member (API and database)', async () => {
    const m = await salon('One At A Time Salon');
    const c1 = await customer('One A');
    const c2 = await customer('One B');
    const D = workday();
    const a1 = await booked(m, c1, 'Ali', ['Haircut'], D, '11:00');
    const a2 = await booked(m, c2, 'Ali', ['Haircut'], D, '11:30');
    const ali = await staffAccount(m, 'Ali');
    goto(D, '11:00');
    await S(ali.access).post(`/appointments/${a1.id}/start`).expect(200);
    const second = await S(ali.access).post(`/appointments/${a2.id}/start`).expect(409);
    expect(second.body.error.details.rule).toBe('ALREADY_IN_PROGRESS');
    const ownerId = (await aq('SELECT owner_user_id FROM salons WHERE id = $1', [m.salonId])).rows[0].owner_user_id as string;
    await expect(asApp({ user: ownerId, salon: m.salonId }, (cl) => cl.query(`UPDATE appointments SET status = 'IN_PROGRESS', started_at = now() WHERE id = $1`, [a2.id]))).rejects.toThrow(/one_in_progress/);
  });

  it('Next customer never completes the current service silently: it asks first, then does both in one step', async () => {
    const m = await salon('Next Salon');
    const c1 = await customer('Next A');
    const c2 = await customer('Next B');
    const D = workday();
    const a1 = await booked(m, c1, 'Ali', ['Haircut'], D, '11:00');
    const a2 = await booked(m, c2, 'Ali', ['Haircut'], D, '11:30');
    const ali = await staffAccount(m, 'Ali');

    goto(D, '10:58');
    const first = (await S(ali.access).post('/queue/next', {}).expect(200)).body.data; // nothing in progress: starts A
    expect(first.completed).toBeNull();
    expect(first.started.id).toBe(a1.id);

    goto(D, '11:32'); // A is still in progress (running late)
    const warn = await S(ali.access).post('/queue/next', {}).expect(409);
    expect(warn.body.error.details).toMatchObject({ rule: 'CURRENT_IN_PROGRESS', current: { id: a1.id }, next: { id: a2.id } });
    expect((await dbRow(a1.id)).status).toBe('IN_PROGRESS'); // untouched
    expect((await dbRow(a2.id)).status).toBe('CONFIRMED');

    const both = (await S(ali.access).post('/queue/next', { completeCurrent: true }).expect(200)).body.data;
    expect(both.completed).toMatchObject({ id: a1.id, status: 'COMPLETED' });
    expect(both.started).toMatchObject({ id: a2.id, status: 'IN_PROGRESS' });
    expect(both.lane.current.id).toBe(a2.id);

    const empty = await S(ali.access).post('/queue/next', { completeCurrent: true }).expect(409);
    expect(empty.body.error.details.rule).toBe('QUEUE_EMPTY');
    expect((await dbRow(a2.id)).status).toBe('IN_PROGRESS'); // an empty queue does not complete anything
  });

  // ------------------------------------------------------------------ delay and ETA
  it('delay: an overrun is forecast for the next customers; the ORIGINAL time never changes; the customer sees both', async () => {
    const m = await salon('Delay Salon');
    const c1 = await customer('Delay A');
    const c2 = await customer('Delay B');
    const D = workday();
    const a1 = await booked(m, c1, 'Ali', ['Haircut'], D, '11:00');
    const a2 = await booked(m, c2, 'Ali', ['Haircut'], D, '11:30');
    const ali = await staffAccount(m, 'Ali');
    goto(D, '11:00');
    await S(ali.access).post(`/appointments/${a1.id}/start`).expect(200);

    goto(D, '11:40'); // A should have ended at 11:30
    const q = (await S(ali.access).get('/queue').expect(200)).body.data.lanes[0];
    expect(q.current.overrunMinutes).toBe(10);
    const waiting = q.waiting[0];
    expect(waiting).toMatchObject({ id: a2.id, time: '11:30', delayMinutes: 10, position: 1 });
    expect(hm(waiting.estimate.startsAt)).toBe('11:40');
    expect(waiting.estimate.delayMinutes).toBe(10);

    const seen = (await myBooking(c2, a2.id).expect(200)).body.data;
    expect(seen.time).toBe('11:30'); // original, unchanged
    expect(seen.estimate).toMatchObject({ time: '11:40', delayMinutes: 10 });
    expect(seen.history.map((x: { event: string }) => x.event)).toContain('ETA_CHANGED');
    expect(hm((await dbRow(a2.id)).starts_at.toISOString())).toBe('11:30');

    // reading again at the same moment writes nothing new (the estimate is saved only when the forecast moved)
    await S(ali.access).get('/queue').expect(200);
    await m.a.get('/queue').expect(200);
    expect((await aq(`SELECT count(*)::int AS n FROM appointment_status_history WHERE appointment_id = $1 AND event = 'ETA_CHANGED'`, [a2.id])).rows[0].n).toBe(1);
    // the longer the service runs over, the later the forecast: it moves on the 5-minute grid
    goto(D, '11:44');
    const later = (await S(ali.access).get('/queue').expect(200)).body.data.lanes[0].waiting[0];
    expect(hm(later.estimate.startsAt)).toBe('11:45');
    expect(later.time).toBe('11:30');

    // the owner sees the same truth, and finishing the service clears the delay
    const owner = (await m.a.get('/queue').expect(200)).body.data.lanes.find((l: { staff: { id: string } }) => l.staff.id === m.staff.Ali);
    expect(owner.waiting[0].delayMinutes).toBeGreaterThanOrEqual(10);
    await S(ali.access).post('/queue/next', { completeCurrent: true }).expect(200);
    expect((await myBooking(c2, a2.id).expect(200)).body.data.status).toBe('IN_PROGRESS');
  });

  it('a customer can never write the salon\'s estimate or progress (database trigger)', async () => {
    const m = await salon('Trigger Salon');
    const c = await customer('Trigger Customer');
    const b = await booked(m, c, 'Ali', ['Haircut'], workday(), '11:00');
    await expect(asApp({ user: c.id }, (cl) => cl.query(`UPDATE appointments SET estimated_starts_at = starts_at + interval '30 minutes', eta_updated_at = now() WHERE id = $1`, [b.id]))).rejects.toThrow();
    await expect(asApp({ user: c.id }, (cl) => cl.query(`UPDATE appointments SET status = 'IN_PROGRESS', started_at = now() WHERE id = $1`, [b.id]))).rejects.toThrow();
    // and the salon can never write the customer's arrival report
    const ali = await staffAccount(m, 'Ali');
    await expect(asApp({ user: ali.userId, salon: m.salonId }, (cl) => cl.query(`UPDATE appointments SET arrival_state = 'ON_THE_WAY', arrival_updated_at = now() WHERE id = $1`, [b.id]))).rejects.toThrow(/customer reports/);
    // staff cannot move the booked time either
    await expect(asApp({ user: ali.userId, salon: m.salonId }, (cl) => cl.query(`UPDATE appointments SET starts_at = starts_at + interval '1 hour', ends_at = ends_at + interval '1 hour', blocked_until = blocked_until + interval '1 hour' WHERE id = $1`, [b.id]))).rejects.toThrow(/only the customer/);
  });

  // ------------------------------------------------------------------ arrival and no-show
  it('arrival report and no-show: the salon grace period is always applied, counted from the later of booked time and customer ETA', async () => {
    const m = await salon('NoShow Salon');
    const c = await customer('Late Customer');
    const D = workday();
    const b = await booked(m, c, 'Ali', ['Haircut'], D, '11:00');
    const ali = await staffAccount(m, 'Ali');
    const arrival = (body: object) => h.http().post(`/api/v1/bookings/${b.id}/arrival`).set(bearer(c.access)).send(body);

    goto(D, '07:00'); // 4 hours before: outside the reporting window
    expect((await arrival({ state: 'ON_THE_WAY' }).expect(409)).body.error.details.rule).toBe('ARRIVAL_TOO_EARLY');

    goto(D, '10:50');
    await arrival({ state: 'RUNNING_LATE' }).expect(400); // minutes required
    await arrival({ state: 'ON_THE_WAY', etaMinutes: 0 }).expect(400);
    await arrival({ state: 'ON_THE_WAY', etaMinutes: 121 }).expect(400);
    await arrival({ state: 'GONE' }).expect(400);
    await arrival({ state: 'RUNNING_LATE', etaMinutes: 20, extra: 1 }).expect(400);
    const r = (await arrival({ state: 'RUNNING_LATE', etaMinutes: 20 }).expect(200)).body.data;
    expect(r.customerEta).toMatchObject({ state: 'RUNNING_LATE', etaTime: '11:10' });
    expect(r.time).toBe('11:00'); // booked time untouched

    const lane = (await S(ali.access).get('/queue').expect(200)).body.data.lanes[0];
    expect(lane.waiting[0].customerEta).toMatchObject({ state: 'RUNNING_LATE', etaTime: '11:10' });
    expect(lane.waiting[0].noShow.graceMinutes).toBe(15);

    goto(D, '11:20'); // booked 11:00, ETA 11:10, grace 15 -> allowed from 11:25
    const early = await S(ali.access).post(`/appointments/${b.id}/no-show`).expect(409);
    expect(early.body.error.details).toMatchObject({ rule: 'NO_SHOW_GRACE', graceMinutes: 15 });
    expect(hm(early.body.error.details.allowedFrom)).toBe('11:25');
    expect((await dbRow(b.id)).status).toBe('CONFIRMED'); // never automatic, never early

    goto(D, '11:25');
    const done = (await S(ali.access).post(`/appointments/${b.id}/no-show`, { reason: 'Not reachable' }).expect(200)).body.data;
    expect(done.appointment.status).toBe('NO_SHOW');
    expect(done.lane.today.noShows).toBe(1);
    await S(ali.access).post(`/appointments/${b.id}/no-show`).expect(409);
    const seen = (await myBooking(c, b.id).expect(200)).body.data;
    expect(seen.status).toBe('NO_SHOW');
    expect(seen.history.map((x: { event: string }) => x.event)).toEqual(['CREATED', 'ARRIVAL_UPDATE', 'ETA_CHANGED', 'NO_SHOW']); // ETA 11:10 -> the salon's forecast moved too
    await arrival({ state: 'ON_THE_WAY' }).expect(409); // too late to report
  });

  it('booking policy: the owner sets the grace period (optional field, audited); invalid values are refused', async () => {
    const m = await salon('Grace Salon');
    const c = await customer('Grace Customer');
    const six = { bufferMinutes: 0, minNoticeMinutes: 30, advanceDays: 14, cancelCutoffMinutes: 120, rescheduleCutoffMinutes: 120, maxReschedules: 2 };
    expect((await m.a.get('/booking-policy').expect(200)).body.data.noShowGraceMinutes).toBe(15);
    await m.a.put('/booking-policy', { ...six, noShowGraceMinutes: 7 }).expect(400);
    await m.a.put('/booking-policy', { ...six, noShowGraceMinutes: 125 }).expect(400);
    expect((await m.a.put('/booking-policy', { ...six, noShowGraceMinutes: 30 }).expect(200)).body.data.noShowGraceMinutes).toBe(30);
    expect((await m.a.put('/booking-policy', six).expect(200)).body.data.noShowGraceMinutes).toBe(30); // left out: unchanged

    const D = workday();
    const b = await booked(m, c, 'Ali', ['Haircut'], D, '11:00');
    goto(D, '11:20');
    const r = await m.a.post(`/appointments/${b.id}/no-show`).expect(409); // owner path, grace 30
    expect(r.body.error.details.graceMinutes).toBe(30);
    goto(D, '11:30');
    await m.a.post(`/appointments/${b.id}/no-show`).expect(200);
  });

  it('forgotten appointments from earlier days are listed as overdue and can be closed', async () => {
    const m = await salon('Overdue Salon');
    const c = await customer('Overdue Customer');
    const D = workday();
    const b = await booked(m, c, 'Ali', ['Haircut'], D, '11:00');
    goto(addDaysIso(D, 1), '10:00');
    const lane = (await m.a.get(`/queue?staffId=${m.staff.Ali}`).expect(200)).body.data.lanes[0];
    expect(lane.waiting).toHaveLength(0);
    expect(lane.overdue.map((x: { id: string }) => x.id)).toContain(b.id);
    await m.a.post(`/appointments/${b.id}/no-show`).expect(200);
  });

  // ------------------------------------------------------------------ walk-ins
  it('walk-in: earliest free time that respects bookings; price from the catalogue; staff need the permission and never see the phone', async () => {
    const m = await salon('Walk-in Salon');
    const c = await customer('Booked Customer');
    const D = workday();
    const online = await booked(m, c, 'Ali', ['Haircut'], D, '10:30');
    const noPerm = await staffAccount(m, 'Ahmed');
    const ali = await staffAccount(m, 'Ali', ['walk_ins.create']);

    // the walk-in form lists what THIS staff member offers, with THEIR prices; no other staff, no other salon
    const mineList = (await S(ali.access).get('/queue/services').expect(200)).body.data.items;
    expect(mineList).toHaveLength(2);
    expect(mineList).toEqual(expect.arrayContaining([
      { id: m.services.Haircut, name: 'Haircut', durationMinutes: 30, price: '300.00' },
      { id: m.services.Beard, name: 'Beard Trim', durationMinutes: 15, price: '150.00' },
    ]));
    expect((await m.a.get(`/queue/services?staffId=${m.staff.Ahmed}`).expect(200)).body.data.items).toEqual([{ id: m.services.Haircut, name: 'Haircut', durationMinutes: 30, price: '500.00' }]);
    await m.a.get('/queue/services').expect(400);
    const foreign = await salon('Foreign Services Salon');
    await foreign.a.get(`/queue/services?staffId=${m.staff.Ali}`).expect(404);

    goto(D, '10:12');
    const body = { customerName: 'Imran Walkin', phone: '0312 3456789', serviceIds: [m.services.Haircut], note: 'No appointment' };
    await S(noPerm.access).post('/walk-ins', { ...body, serviceIds: [m.services.Haircut] }).expect(403);
    await S(ali.access).post('/walk-ins', { ...body, price: 1 }).expect(400); // prices are never accepted
    await S(ali.access).post('/walk-ins', { ...body, staffId: m.staff.Ahmed }).expect(400); // staff cannot pick another staff member
    await S(ali.access).post('/walk-ins', { ...body, phone: '12' }).expect(400);
    await S(ali.access).post('/walk-ins', { ...body, customerName: '<b>x</b>' }).expect(400);
    await S(ali.access).post('/walk-ins', { ...body, serviceIds: [] }).expect(400);

    const key = idemKey();
    const r = (await S(ali.access).post('/walk-ins', body, key).expect(201)).body.data;
    // 10:15-10:45 would overlap the 10:30 booking, so the walk-in waits until 11:00
    expect(r.appointment).toMatchObject({ walkIn: true, status: 'CONFIRMED', time: '11:00', endTime: '11:30', totalPrice: '300.00', customer: { name: 'Imran Walkin', phone: null } });
    expect(JSON.stringify(r)).not.toContain('+92312');
    const again = (await S(ali.access).post('/walk-ins', body, key).expect(201)).body.data;
    expect(again.appointment.id).toBe(r.appointment.id);
    await S(ali.access).post('/walk-ins', { ...body, customerName: 'Someone Else' }, key).expect(409); // same key, different request
    expect((await aq(`SELECT count(*)::int AS n FROM appointments WHERE salon_id = $1 AND source = 'WALK_IN'`, [m.salonId])).rows[0].n).toBe(1);
    expect(hm((await dbRow(online.id)).starts_at.toISOString())).toBe('10:30'); // the booked customer keeps their time

    // the walk-in is part of the queue, in order, and of the owner calendar (with the phone)
    const lane = (await S(ali.access).get('/queue').expect(200)).body.data.lanes[0];
    expect(lane.waiting.map((x: { id: string }) => x.id)).toEqual([online.id, r.appointment.id]);
    const cal = (await m.a.get(`/bookings?from=${D}&to=${D}`).expect(200)).body.data.items;
    const wi = cal.find((x: { id: string }) => x.id === r.appointment.id);
    expect(wi).toMatchObject({ walkIn: true, customer: { name: 'Imran Walkin', phone: '+923123456789' } });
    expect(cal.find((x: { id: string }) => x.id === online.id).walkIn).toBe(false);

    // a walk-in goes through the same life cycle
    goto(D, '11:00');
    await S(ali.access).post(`/appointments/${r.appointment.id}/start`).expect(200);
    await S(ali.access).post(`/appointments/${r.appointment.id}/complete`).expect(200);
    // and a walk-in cannot be sent an early offer (no app account)
    const w2 = (await m.a.post('/walk-ins', { staffId: m.staff.Ali, customerName: 'Second Walkin', serviceIds: [m.services.Beard] }).expect(201)).body.data;
    expect((await m.a.post(`/appointments/${w2.appointment.id}/early-offer`).expect(409)).body.error.details.rule).toBe('WALK_IN');
  });

  it('walk-ins: four at once get four different, non-overlapping times; none is left when the day is over; same rules as bookings', async () => {
    const m = await salon('Walk-in Race Salon');
    const D = workday();
    goto(D, '10:02');
    const results = await Promise.all([1, 2, 3, 4].map((i) => m.a.post('/walk-ins', { staffId: m.staff.Ali, customerName: `Walkin ${i}`, serviceIds: [m.services.Haircut] })));
    const ok = results.filter((r) => r.status === 201);
    expect(ok.length).toBe(4);
    const starts = ok.map((r) => hm(r.body.data.appointment.startsAt)).sort();
    expect(new Set(starts).size).toBe(4);
    // not inside the 13:00-14:00 break and not past staff hours
    for (const s of starts) expect(s < '13:00' || s >= '14:00').toBe(true);
    const spans = (await aq(`SELECT starts_at, blocked_until FROM appointments WHERE salon_id = $1 ORDER BY starts_at`, [m.salonId])).rows;
    for (let i = 1; i < spans.length; i += 1) expect(spans[i].starts_at.getTime()).toBeGreaterThanOrEqual(spans[i - 1].blocked_until.getTime());

    goto(D, '17:50'); // 10 minutes before Ali's day ends: a 30-minute haircut cannot fit
    const none = await m.a.post('/walk-ins', { staffId: m.staff.Ali, customerName: 'Too Late', serviceIds: [m.services.Haircut] }).expect(409);
    expect(none.body.error.details.rule).toBe('NO_CAPACITY_TODAY');
    // Ahmed does not offer Beard Trim
    await m.a.post('/walk-ins', { staffId: m.staff.Ahmed, customerName: 'Wrong Staff', serviceIds: [m.services.Beard] }).expect(409);
  });

  it('a service that runs late pushes the walk-in time back (the staff member is not free until it ends)', async () => {
    const m = await salon('Busy Salon');
    const c = await customer('Busy Customer');
    const D = workday();
    const b = await booked(m, c, 'Ali', ['Haircut'], D, '10:30');
    const ali = await staffAccount(m, 'Ali');
    goto(D, '10:30');
    await S(ali.access).post(`/appointments/${b.id}/start`).expect(200);
    goto(D, '11:07'); // should have ended at 11:00
    const w = (await m.a.post('/walk-ins', { staffId: m.staff.Ali, customerName: 'Patient Walkin', serviceIds: [m.services.Beard] }).expect(201)).body.data;
    expect(w.appointment.time).toBe('11:10');
  });

  // ------------------------------------------------------------------ early availability offer
  it('early offer: staff ask, the customer accepts with an ETA; no reschedule is counted; the old slot is freed', async () => {
    const m = await salon('Early Salon');
    const c = await customer('Early Customer');
    const D = workday();
    const b = await booked(m, c, 'Ali', ['Haircut'], D, '12:00');
    const ali = await staffAccount(m, 'Ali');

    goto(D, '11:20');
    const cand = (await S(ali.access).get('/queue').expect(200)).body.data.lanes[0].earlyOfferCandidate;
    expect(cand).toMatchObject({ appointmentId: b.id, earliestTime: '11:25', savesMinutes: 35 });
    await S(ali.access).post(`/appointments/${b.id}/early-offer`, { time: '11:22' }).expect(400);
    await S(ali.access).post(`/appointments/${b.id}/early-offer`, { time: '11:10' }).expect(409); // before the staff member is free
    await S(ali.access).post(`/appointments/${b.id}/early-offer`, { time: '11:55' }).expect(409); // saves less than 10 minutes

    const sent = (await S(ali.access).post(`/appointments/${b.id}/early-offer`).expect(201)).body.data;
    expect(sent.offer).toMatchObject({ offeredTime: '11:25', originalTime: '12:00', savesMinutes: 35 });
    await S(ali.access).post(`/appointments/${b.id}/early-offer`).expect(409); // one open offer at a time

    const before = (await myBooking(c, b.id).expect(200)).body.data;
    expect(before.time).toBe('12:00');
    expect(before.earlyOffer.id).toBe(sent.offer.id);

    // somebody else cannot answer it
    const other = await customer('Other Customer');
    await h.http().post(`/api/v1/bookings/${b.id}/early-offer/accept`).set(bearer(other.access)).send({ offerId: sent.offer.id }).expect(404);
    // the staff view shows all three times: original, offer, customer ETA
    expect((await S(ali.access).get('/queue').expect(200)).body.data.lanes[0].waiting[0].earlyOffer.offeredTime).toBe('11:25');

    const accepted = (await h.http().post(`/api/v1/bookings/${b.id}/early-offer/accept`).set(bearer(c.access)).send({ offerId: sent.offer.id, etaMinutes: 15 }).expect(200)).body.data;
    expect(accepted).toMatchObject({ time: '11:25', endTime: '11:55', rescheduleCount: 0, earlyOffer: null, status: 'CONFIRMED' });
    expect(accepted.customerEta).toMatchObject({ state: 'ON_THE_WAY', etaTime: '11:35' });
    expect(accepted.history.map((x: { event: string }) => x.event)).toEqual(['CREATED', 'EARLY_OFFERED', 'EARLY_ACCEPTED', 'ARRIVAL_UPDATE']);
    expect((await dbRow(b.id)).reschedule_count).toBe(0); // no penalty: it was not counted as a reschedule
    await h.http().post(`/api/v1/bookings/${b.id}/early-offer/accept`).set(bearer(c.access)).send({ offerId: sent.offer.id }).expect(409); // answered once only
    // the old 12:00 slot is free again
    const c2 = await customer('Takes The Old Slot');
    goto(D, '09:00');
    await book(m, c2, 'Ali', ['Haircut'], D, '12:00').expect(201);
  });

  it('early offer: declining keeps the original time with no penalty; an expired or stolen offer changes nothing', async () => {
    const m = await salon('Early Decline Salon');
    const c = await customer('Decliner');
    const c3 = await customer('Slow Customer');
    const D = workday();
    const b = await booked(m, c, 'Ali', ['Haircut'], D, '15:00');
    const b3 = await booked(m, c3, 'Ahmed', ['Haircut'], D, '15:00');
    const ali = await staffAccount(m, 'Ali');
    const ahmed = await staffAccount(m, 'Ahmed');
    goto(D, '14:20');

    const offer = (await S(ali.access).post(`/appointments/${b.id}/early-offer`).expect(201)).body.data.offer;
    const declined = (await h.http().post(`/api/v1/bookings/${b.id}/early-offer/decline`).set(bearer(c.access)).send({ offerId: offer.id }).expect(200)).body.data;
    expect(declined).toMatchObject({ time: '15:00', status: 'CONFIRMED', earlyOffer: null, rescheduleCount: 0 });
    expect(declined.history.map((x: { event: string }) => x.event)).toEqual(['CREATED', 'EARLY_OFFERED', 'EARLY_DECLINED']);
    const second = (await S(ali.access).post(`/appointments/${b.id}/early-offer`).expect(201)).body.data.offer; // staff may ask again
    await S(ali.access).del(`/appointments/${b.id}/early-offer`).expect(200); // ... or take the offer back
    await h.http().post(`/api/v1/bookings/${b.id}/early-offer/accept`).set(bearer(c.access)).send({ offerId: second.id }).expect(409);
    await S(ali.access).del(`/appointments/${b.id}/early-offer`).expect(404);

    // expired: the customer answers after the offered time has passed
    const o3 = (await S(ahmed.access).post(`/appointments/${b3.id}/early-offer`).expect(201)).body.data.offer;
    goto(D, '14:40');
    const late = await h.http().post(`/api/v1/bookings/${b3.id}/early-offer/accept`).set(bearer(c3.access)).send({ offerId: o3.id }).expect(409);
    expect(late.body.error.details.rule).toBe('OFFER_EXPIRED');
    expect((await myBooking(c3, b3.id).expect(200)).body.data).toMatchObject({ time: '15:00', earlyOffer: null });

    // stolen: the offered time is taken by a walk-in before the customer answers
    goto(D, '14:20');
    const o4 = (await S(ali.access).post(`/appointments/${b.id}/early-offer`).expect(201)).body.data.offer;
    await m.a.post('/walk-ins', { staffId: m.staff.Ali, customerName: 'Quick Walkin', serviceIds: [m.services.Haircut] }).expect(201);
    const taken = await h.http().post(`/api/v1/bookings/${b.id}/early-offer/accept`).set(bearer(c.access)).send({ offerId: o4.id }).expect(409);
    expect(taken.body.error.code).toBe('SLOT_TAKEN');
    expect((await myBooking(c, b.id).expect(200)).body.data.time).toBe('15:00'); // the original slot is safe
  });

  it('early offer: nothing worth offering when the staff member is busy or the gain is small', async () => {
    const m = await salon('No Offer Salon');
    const c1 = await customer('Busy A');
    const c2 = await customer('Busy B');
    const D = workday();
    const a1 = await booked(m, c1, 'Ali', ['Haircut'], D, '11:00');
    const a2 = await booked(m, c2, 'Ali', ['Haircut'], D, '11:30');
    const ali = await staffAccount(m, 'Ali');
    goto(D, '11:00');
    await S(ali.access).post(`/appointments/${a1.id}/start`).expect(200);
    const lane = (await S(ali.access).get('/queue').expect(200)).body.data.lanes[0];
    expect(lane.earlyOfferCandidate).toBeNull();
    expect((await S(ali.access).post(`/appointments/${a2.id}/early-offer`).expect(409)).body.error.details.rule).toBe('NO_EARLIER_TIME');
  });

  // ------------------------------------------------------------------ security: isolation and roles
  it('IDOR / BOLA: staff see and touch only their own queue; other salons and other customers get 404; wrong roles get 403', async () => {
    const m = await salon('Iso Salon');
    const other = await salon('Other Iso Salon');
    const c = await customer('Iso Customer');
    const stranger = await customer('Stranger');
    const D = workday();
    const mineAppt = await booked(m, c, 'Ali', ['Haircut'], D, '11:00');
    const ahmedAppt = await booked(m, c, 'Ahmed', ['Haircut'], D, '11:00');
    const ali = await staffAccount(m, 'Ali');
    const otherAli = await staffAccount(other, 'Ali');
    goto(D, '11:00');

    // a colleague's appointment and another salon's appointment look like "not found"
    for (const path of ['start', 'complete', 'no-show']) {
      await S(ali.access).post(`/appointments/${ahmedAppt.id}/${path}`).expect(404);
      await S(otherAli.access).post(`/appointments/${mineAppt.id}/${path}`).expect(404);
      await other.a.post(`/appointments/${mineAppt.id}/${path}`).expect(404);
    }
    await S(ali.access).get(`/bookings/${ahmedAppt.id}`).expect(404);
    await S(ali.access).post(`/appointments/${ahmedAppt.id}/early-offer`).expect(404);
    expect((await S(ali.access).get('/queue').expect(200)).body.data.lanes.map((l: { staff: { id: string } }) => l.staff.id)).toEqual([m.staff.Ali]);
    expect((await S(ali.access).get(`/bookings/${mineAppt.id}`).expect(200)).body.data.customer.phone).toBeNull();

    // owner cannot address another salon's staff
    await other.a.get(`/queue?staffId=${m.staff.Ali}`).expect(404);
    await other.a.post('/queue/next', { staffId: m.staff.Ali }).expect(404);
    await other.a.post('/walk-ins', { staffId: m.staff.Ali, customerName: 'Cross Salon', serviceIds: [m.services.Haircut] }).expect(404);
    expect((await other.a.get('/queue').expect(200)).body.data.lanes.map((l: { staff: { id: string } }) => l.staff.id)).not.toContain(m.staff.Ali);

    // customers: only their own booking
    const arrival = (t: string) => h.http().post(`/api/v1/bookings/${mineAppt.id}/arrival`).set(bearer(t)).send({ state: 'ON_THE_WAY' });
    await arrival(stranger.access).expect(404);
    await arrival(c.access).expect(200);
    // roles
    await arrival(ali.access).expect(403);
    await arrival(m.o.access).expect(403);
    await h.http().get('/api/v1/staff/me/queue').set(bearer(c.access)).expect(403);
    await h.http().get('/api/v1/staff/me/queue').set(bearer(m.o.access)).expect(403);
    await h.http().get('/api/v1/salons/mine/queue').set(bearer(ali.access)).expect(403);
    await h.http().get('/api/v1/salons/mine/queue').set(bearer(c.access)).expect(403);
    await h.http().get('/api/v1/salons/mine/queue').expect(401);
    await h.http().post(`/api/v1/staff/me/appointments/${mineAppt.id}/start`).expect(401);
    await S(ali.access).post(`/appointments/not-a-uuid/start`).expect(400);
  });

  it('a suspended salon and a disabled staff member cannot run the queue', async () => {
    const m = await salon('Suspend Salon');
    const c = await customer('Suspend Customer');
    const D = workday();
    const b = await booked(m, c, 'Ali', ['Haircut'], D, '11:00');
    const ali = await staffAccount(m, 'Ali');
    goto(D, '10:55');
    await m.a.patch(`/team/${m.staff.Ali}`, { isActive: false }).expect(200);
    // switching a member off ends their sessions (401) and their profile is inactive (403): either way nothing runs
    expect([401, 403]).toContain((await S(ali.access).post(`/appointments/${b.id}/start`)).status);
    expect([401, 403]).toContain((await S(ali.access).get('/queue')).status);
    await m.a.patch(`/team/${m.staff.Ali}`, { isActive: true }).expect(200);
    const ali2 = await staffAccount(m, 'Ahmed');
    await h.http().post(`/api/v1/admin/salons/${m.salonId}/suspend`).set(bearer(m.adminToken)).send({ reason: 'Testing the queue guard' }).expect(200);
    expect((await S(ali2.access).get('/queue')).status).toBe(403);
    await m.a.get('/queue').expect(403);
    await m.a.post(`/appointments/${b.id}/start`).expect(403);
  });

  it('database: staff walk-in permission and early-offer answers are enforced by Row-Level Security and triggers, not only by the API', async () => {
    const m = await salon('Rls Salon');
    const c = await customer('Rls Customer');
    const D = workday();
    const b = await booked(m, c, 'Ali', ['Haircut'], D, '15:00');
    const noPerm = await staffAccount(m, 'Ahmed');
    const ali = await staffAccount(m, 'Ali', ['walk_ins.create']);
    goto(D, '14:00');
    const offer = (await S(ali.access).post(`/appointments/${b.id}/early-offer`).expect(201)).body.data.offer;

    const insertWalkIn = (userId: string, staffId: string, source = 'WALK_IN', customer: string | null = null) => asApp({ user: userId, salon: m.salonId }, (cl) => cl.query(
      `INSERT INTO appointments (salon_id, customer_user_id, staff_id, status, source, walk_in_name, starts_at, ends_at, blocked_until, total_duration_minutes, total_price, salon_name, staff_name, buffer_minutes)
       VALUES ($1, $4, $2, 'CONFIRMED', $3, $5, now() + interval '2 hours', now() + interval '2 hours 30 minutes', now() + interval '2 hours 30 minutes', 30, 0, 'S', 'N', 0)`,
      [m.salonId, staffId, source, customer, customer ? null : 'Raw Walkin']));
    await expect(insertWalkIn(noPerm.userId, m.staff.Ahmed)).rejects.toThrow(/row-level security/);
    await expect(insertWalkIn(ali.userId, m.staff.Ahmed)).rejects.toThrow(/row-level security/); // someone else's lane
    await expect(insertWalkIn(ali.userId, m.staff.Ali, 'WALK_IN', c.id)).rejects.toThrow(); // a walk-in has no account; an online row has no walk-in name

    // only the customer can answer; staff cannot accept their own offer
    await expect(asApp({ user: ali.userId, salon: m.salonId }, (cl) => cl.query(`UPDATE appointment_early_offers SET status = 'ACCEPTED', responded_at = now() WHERE id = $1`, [offer.id]))).rejects.toThrow();
    await expect(asApp({ user: c.id }, (cl) => cl.query(`UPDATE appointment_early_offers SET status = 'WITHDRAWN', responded_at = now() WHERE id = $1`, [offer.id]))).rejects.toThrow();
    // moving the appointment earlier WITHOUT an accepted offer needs a normal reschedule (counter +1) and is refused otherwise
    await expect(asApp({ user: c.id }, (cl) => cl.query(
      `UPDATE appointments SET starts_at = starts_at - interval '1 hour', ends_at = ends_at - interval '1 hour', blocked_until = blocked_until - interval '1 hour' WHERE id = $1`, [b.id]))).rejects.toThrow(/reschedule_count/);
    // offers can never be deleted by the runtime role
    await expect(asApp({ user: ali.userId, salon: m.salonId }, (cl) => cl.query(`DELETE FROM appointment_early_offers WHERE id = $1`, [offer.id]))).rejects.toThrow(/permission denied/);
    // the Data API roles (if they exist) have no access
    const roles = (await aq(`SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated')`)).rows.map((r) => r.rolname);
    for (const role of roles) {
      expect((await aq(`SELECT has_table_privilege($1, 'appointment_early_offers', 'SELECT') AS x`, [role])).rows[0].x).toBe(false);
    }
  });
});
