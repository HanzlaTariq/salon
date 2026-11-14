import { Pool, PoolClient } from 'pg';
import sharp from 'sharp';
import { hotp, base32Decode, timeStep } from '../src/modules/auth/totp';
import { todayKarachi } from '../src/modules/billing/billing.types';
import { addDaysIso, isoWeekday } from '../src/modules/discovery/discovery.types';
import { Harness, bearer, createHarness, createPlatformUser, dbEnabled, loginMobile, registerAndVerify } from './support/harness';

const d = dbEnabled ? describe : describe.skip;
if (!dbEnabled) {
  // eslint-disable-next-line no-console
  console.warn('SKIPPED booking e2e: set TEST_DATABASE_URL (salon_app) and TEST_ADMIN_DATABASE_URL (salon_migrator).');
}

const totp = (secretB32: string, h: Harness) => hotp(base32Decode(secretB32), timeStep(h.clock.now().getTime()));
const png = () => sharp({ create: { width: 600, height: 400, channels: 3, background: '#c07840' } }).png().toBuffer();
const WEEK = [1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, closed: false, opensAt: '10:00', closesAt: '21:00' })).concat([{ weekday: 7, closed: true } as never]);
/** Staff: Monday-Friday 10:00-18:00 with a 13:00-14:00 break. */
const STAFF_WEEK = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, off: false, startsAt: '10:00', endsAt: '18:00' })).concat([{ weekday: 6, off: true }, { weekday: 7, off: true }] as never[]);
let cityCounter = 0;
const uniqueCity = () => `Bookville${Date.now().toString(36)}${cityCounter++}`;
let keyCounter = 0;
const idemKey = () => `test-key-${Date.now().toString(36)}-${keyCounter++}`;

d('Phase 8: booking engine - slots, double booking, policy, cancel, reschedule, isolation (real PostgreSQL)', () => {
  let h: Harness;
  let appPool: Pool;
  let superAdmin: { id: string; email: string; access: string };

  beforeAll(async () => {
    h = await createHarness();
    appPool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 2 });
    const u = await createPlatformUser(h, 'SUPER_ADMIN');
    const access = (await loginMobile(h, u.email, u.password)).body.data.accessToken as string;
    const setup = (await h.http().post('/api/v1/auth/mfa/setup').set(bearer(access)).send({ password: u.password }).expect(200)).body.data;
    await h.http().post('/api/v1/auth/mfa/enable').set(bearer(access)).send({ code: totp(setup.secret, h) }).expect(200);
    superAdmin = { id: u.id, email: u.email, access };
    await h.http().post('/api/v1/admin/billing/plans').set(bearer(superAdmin.access))
      .send({ monthlyPricePerStaff: '300', yearlyPricePerStaff: '3000', graceDays: 3, renewalNoticeDays: 7 }).expect(201);
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
  async function asApp<T>(ctx: { user?: string; salon?: string; admin?: boolean; publicRead?: boolean }, fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await appPool.connect();
    try {
      await c.query('BEGIN');
      await c.query(
        `SELECT set_config('app.user_id',$1,true), set_config('app.salon_id',$2,true), set_config('app.is_platform_admin',$3,true), set_config('app.public_read',$4,true)`,
        [ctx.user ?? '', ctx.salon ?? '', ctx.admin ? 'true' : 'false', ctx.publicRead ? 'true' : 'false'],
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
    return { ...u, access };
  }
  async function customer(name: string) {
    const u = await registerAndVerify(h, { accountType: 'CUSTOMER', fullName: name });
    const access = (await loginMobile(h, u.email, u.password)).body.data.accessToken as string;
    const id = (await aq('SELECT id FROM users WHERE email = $1', [u.email])).rows[0].id as string;
    await aq(`UPDATE users SET phone = '+923001234567' WHERE id = $1`, [id]);
    return { ...u, access, id, name };
  }
  const upload = (token: string, kind: string, docType: string, buf: Buffer) =>
    h.http().post('/api/v1/salons/mine/files').set(bearer(token)).field('kind', kind).field('docType', docType).attach('file', buf, 'x.png');
  const mine = (t: string) => ({
    get: (p: string) => h.http().get(`/api/v1/salons/mine${p}`).set(bearer(t)),
    post: (p: string, b: object = {}) => h.http().post(`/api/v1/salons/mine${p}`).set(bearer(t)).send(b),
    put: (p: string, b: object) => h.http().put(`/api/v1/salons/mine${p}`).set(bearer(t)).send(b),
    patch: (p: string, b: object) => h.http().patch(`/api/v1/salons/mine${p}`).set(bearer(t)).send(b),
  });
  const today = () => todayKarachi(h.clock.now());
  /** First date 1..7 days away that falls on ISO weekday `wd` (never today, so results do not depend on the time of day). */
  const nextWeekday = (wd: number) => {
    for (let i = 1; i <= 7; i += 1) if (isoWeekday(addDaysIso(today(), i)) === wd) return addDaysIso(today(), i);
    throw new Error('unreachable');
  };
  const MON = () => nextWeekday(1);
  const TUE = () => addDaysIso(MON(), 1);
  const SAT = () => nextWeekday(6);
  /** A working day (Mon-Fri) 2..6 days away: its start is always less than 7 days from now. */
  const nearWorkday = () => {
    for (let i = 2; i <= 6; i += 1) if (isoWeekday(addDaysIso(today(), i)) <= 5) return addDaysIso(today(), i);
    throw new Error('unreachable');
  };

  interface Made { o: Awaited<ReturnType<typeof owner>>; salonId: string; staff: Record<string, string>; services: Record<string, string>; a: ReturnType<typeof mine> }
  /** An APPROVED salon with staff Ali + Ahmed (Mon-Fri 10-18, break 13-14), Haircut (Ali 300 / Ahmed 500, 30 min), Beard (150, 15 min, Ali only). */
  async function salon(name: string): Promise<Made> {
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
    await h.http().post(`/api/v1/admin/salons/${salonId}/approve`).set(bearer(superAdmin.access)).expect(200);
    return { o, salonId, staff, services, a };
  }

  const book = (token: string, body: object, key?: string) => {
    const r = h.http().post('/api/v1/bookings').set(bearer(token));
    return (key ? r.set('Idempotency-Key', key) : r).send(body);
  };
  const req = (m: Made, staff: string, services: string[], date: string, time: string, extra: object = {}) =>
    ({ salonId: m.salonId, staffId: m.staff[staff], serviceIds: services.map((s) => m.services[s]), date, time, ...extra });
  const mineBookings = (t: string, qs = '') => h.http().get(`/api/v1/bookings${qs}`).set(bearer(t));

  // ------------------------------------------------------------------ creation, snapshots, validation
  it('creates a booking with server-derived price, duration and names (multiple services, staff-first)', async () => {
    const m = await salon('Create Salon');
    const c = await customer('Sara Customer');
    const r = await book(c.access, req(m, 'Ali', ['Haircut', 'Beard'], MON(), '11:00', { note: 'Short on the sides' })).expect(201);
    expect(r.body.data).toMatchObject({
      status: 'CONFIRMED', date: MON(), time: '11:00', endTime: '11:45', durationMinutes: 45, totalPrice: '450.00', currency: 'PKR',
      salon: { id: m.salonId, name: 'Create Salon' }, staff: { id: m.staff.Ali, name: 'Ali' }, note: 'Short on the sides', rescheduleCount: 0,
    });
    expect(r.body.data.services).toEqual([
      { serviceId: m.services.Haircut, name: 'Haircut', durationMinutes: 30, price: '300.00' },
      { serviceId: m.services.Beard, name: 'Beard Trim', durationMinutes: 15, price: '150.00' },
    ]);
    expect(r.body.data.history).toEqual([expect.objectContaining({ event: 'CREATED', toStatus: 'CONFIRMED', by: 'CUSTOMER' })]);
    expect(JSON.stringify(r.body)).not.toContain('bufferMinutes');
  });

  it('price snapshot: later catalogue price changes never alter an existing booking', async () => {
    const m = await salon('Snapshot Salon');
    const c = await customer('Snap Customer');
    const b = (await book(c.access, req(m, 'Ahmed', ['Haircut'], MON(), '10:00')).expect(201)).body.data;
    expect(b.totalPrice).toBe('500.00');
    await m.a.patch(`/services/${m.services.Haircut}`, { pricing: { mode: 'STAFF_BASED' }, staff: [{ staffId: m.staff.Ali, price: 300 }, { staffId: m.staff.Ahmed, price: 900 }] });
    const again = (await h.http().get(`/api/v1/bookings/${b.id}`).set(bearer(c.access)).expect(200)).body.data;
    expect(again.totalPrice).toBe('500.00');
    expect(again.services[0].price).toBe('500.00');
  });

  it('rejects client-supplied prices, unknown fields, bad input and the wrong role', async () => {
    const m = await salon('Validation Salon');
    const c = await customer('Val Customer');
    const ok = req(m, 'Ali', ['Haircut'], MON(), '10:00');
    await book(c.access, { ...ok, totalPrice: 1 }).expect(400);
    await book(c.access, { ...ok, customerUserId: c.id }).expect(400);
    await book(c.access, { ...ok, time: '10:07' }).expect(400);
    await book(c.access, { ...ok, time: '25:00' }).expect(400);
    await book(c.access, { ...ok, date: '2026-02-30' }).expect(400);
    await book(c.access, { ...ok, date: addDaysIso(today(), -1) }).expect(400);
    await book(c.access, { ...ok, date: addDaysIso(today(), 40) }).expect(400);
    await book(c.access, { ...ok, serviceIds: [m.services.Haircut, m.services.Haircut] }).expect(400);
    await book(c.access, { ...ok, serviceIds: [] }).expect(400);
    await book(c.access, { ...ok, note: '<script>x</script>' }).expect(400);
    await book(c.access, ok, 'short').expect(400);
    await h.http().post('/api/v1/bookings').send(ok).expect(401);
    await book(m.o.access, ok).expect(403);
    await book(superAdmin.access, ok).expect(403);
  });

  it('refuses a staff member who does not offer the chosen services, and another salon\'s staff', async () => {
    const m = await salon('Offer Salon');
    const other = await salon('Other Salon');
    const c = await customer('Offer Customer');
    await book(c.access, req(m, 'Ahmed', ['Beard'], MON(), '10:00')).expect(409);
    await book(c.access, { ...req(m, 'Ali', ['Haircut'], MON(), '10:00'), staffId: other.staff.Ali }).expect(409);
    await book(c.access, { ...req(m, 'Ali', ['Haircut'], MON(), '10:00'), serviceIds: [other.services.Haircut] }).expect(409);
    await book(c.access, { ...req(m, 'Ali', ['Haircut'], MON(), '10:00'), salonId: '0192b3c4-d5e6-7f80-9a1b-2c3d4e5f6071' }).expect(404);
  });

  // ------------------------------------------------------------------ the slot engine
  it('never offers or accepts times outside staff hours, in a break, or past closing; accepts the edges', async () => {
    const m = await salon('Hours Salon');
    const c = await customer('Hours Customer');
    for (const time of ['09:45', '12:45', '13:00', '13:30', '17:45', '18:00', '18:30']) {
      const r = await book(c.access, req(m, 'Ali', ['Haircut'], MON(), time));
      expect([time, r.status, r.body.error?.code]).toEqual([time, 409, 'SLOT_TAKEN']);
    }
    await book(c.access, req(m, 'Ali', ['Haircut'], MON(), '10:00')).expect(201);
    await book(c.access, req(m, 'Ali', ['Haircut'], MON(), '12:30')).expect(201); // ends exactly at the break
    await book(c.access, req(m, 'Ali', ['Haircut'], MON(), '17:30')).expect(201); // ends exactly at closing
    await book(c.access, req(m, 'Ali', ['Haircut'], SAT(), '11:00')).expect(409); // Saturday: staff off
  });

  it('double booking: overlap, equal start and containment are refused; back-to-back is allowed; free again after a cancel', async () => {
    const m = await salon('Double Salon');
    const a = await customer('Alice First');
    const b = await customer('Bob Second');
    const first = (await book(a.access, req(m, 'Ali', ['Haircut'], MON(), '11:00')).expect(201)).body.data;
    for (const time of ['11:00', '11:15', '10:45', '10:30']) {
      const r = await book(b.access, req(m, 'Ali', ['Haircut'], MON(), time));
      expect([time, r.status, r.body.error?.code]).toEqual([time, 409, 'SLOT_TAKEN']);
    }
    await book(b.access, req(m, 'Ali', ['Haircut'], MON(), '10:30')).expect(409);
    await book(b.access, req(m, 'Ali', ['Haircut'], MON(), '11:30')).expect(201); // starts when the first one ends
    await book(b.access, req(m, 'Ahmed', ['Haircut'], MON(), '11:00')).expect(201); // another staff member is independent
    // the availability endpoint agrees with the database
    const av = await h.http().get(`/api/v1/public/discovery/salons/${m.salonId}/availability?date=${MON()}&serviceIds=${m.services.Haircut}&staffId=${m.staff.Ali}`).expect(200);
    const slots: string[] = av.body.data.staff[0].slots;
    expect(slots).not.toContain('11:00');
    expect(slots).not.toContain('11:15');
    expect(slots).toContain('10:00');
    // cancelling frees the time
    await h.http().post(`/api/v1/bookings/${first.id}/cancel`).set(bearer(a.access)).send({}).expect(200);
    await book(b.access, req(m, 'Ali', ['Haircut'], MON(), '11:00')).expect(201); // 11:00-11:30 is free again and touches b's 11:30 booking only at the edge
  });

  it('race: two customers booking the same staff and time at the same moment -> exactly one wins', async () => {
    const m = await salon('Race Salon');
    const customers = await Promise.all([customer('Racer One'), customer('Racer Two'), customer('Racer Three'), customer('Racer Four')]);
    const results = await Promise.all(customers.map((c) => book(c.access, req(m, 'Ali', ['Haircut'], MON(), '15:00'))));
    const codes = results.map((r) => r.status).sort();
    expect(codes).toEqual([201, 409, 409, 409]);
    for (const r of results.filter((x) => x.status === 409)) expect(r.body.error.code).toBe('SLOT_TAKEN');
    const count = await aq(`SELECT count(*)::int AS n FROM appointments WHERE staff_id = $1 AND status = 'CONFIRMED'`, [m.staff.Ali]);
    expect(count.rows[0].n).toBe(1);
  });

  it('buffer: the salon\'s buffer after every appointment is kept free on both sides', async () => {
    const m = await salon('Buffer Salon');
    const a = await customer('Buf One');
    const b = await customer('Buf Two');
    await m.a.put('/booking-policy', { bufferMinutes: 15, minNoticeMinutes: 30, advanceDays: 14, cancelCutoffMinutes: 120, rescheduleCutoffMinutes: 120, maxReschedules: 2 }).expect(200);
    await book(a.access, req(m, 'Ali', ['Haircut'], MON(), '11:00')).expect(201); // 11:00-11:30, blocked until 11:45
    await book(b.access, req(m, 'Ali', ['Haircut'], MON(), '11:30')).expect(409);
    await book(b.access, req(m, 'Ali', ['Haircut'], MON(), '11:40')).expect(409);
    await book(b.access, req(m, 'Ali', ['Haircut'], MON(), '10:30')).expect(409); // 10:30-11:00 plus 15 minutes buffer runs into the 11:00 booking
    await book(b.access, req(m, 'Ali', ['Haircut'], MON(), '10:15')).expect(201); // 10:15-10:45 + 15 buffer = 11:00: exactly fits
    await book(b.access, req(m, 'Ali', ['Haircut'], MON(), '11:45')).expect(201);
    const raw = await aq(`SELECT buffer_minutes, (extract(epoch FROM (blocked_until - ends_at))/60)::int AS buf FROM appointments WHERE staff_id = $1 ORDER BY starts_at LIMIT 1`, [m.staff.Ali]);
    expect(raw.rows[0]).toEqual({ buffer_minutes: 15, buf: 15 });
  });

  it('listing rule: a suspended salon cannot be booked, but existing bookings can still be cancelled', async () => {
    const m = await salon('Suspend Salon');
    const c = await customer('Susp Customer');
    const b = (await book(c.access, req(m, 'Ali', ['Haircut'], MON(), '10:00')).expect(201)).body.data;
    await h.http().post(`/api/v1/admin/salons/${m.salonId}/suspend`).set(bearer(superAdmin.access)).send({ reason: 'Policy check for tests' }).expect(200);
    await book(c.access, req(m, 'Ali', ['Haircut'], MON(), '12:00')).expect(404);
    await h.http().post(`/api/v1/bookings/${b.id}/reschedule`).set(bearer(c.access)).send({ date: MON(), time: '11:00' }).expect(409);
    await h.http().post(`/api/v1/bookings/${b.id}/cancel`).set(bearer(c.access)).send({}).expect(200);
  });

  // ------------------------------------------------------------------ idempotency
  it('Idempotency-Key: a retry returns the same booking; a different request with the same key is refused', async () => {
    const m = await salon('Idem Salon');
    const c = await customer('Idem Customer');
    const key = idemKey();
    const one = await book(c.access, req(m, 'Ali', ['Haircut'], MON(), '10:00'), key).expect(201);
    const two = await book(c.access, req(m, 'Ali', ['Haircut'], MON(), '10:00'), key).expect(201);
    expect(two.body.data.id).toBe(one.body.data.id);
    await book(c.access, req(m, 'Ali', ['Haircut'], MON(), '11:00'), key).expect(409);
    const n = await aq(`SELECT count(*)::int AS n FROM appointments WHERE customer_user_id = $1`, [c.id]);
    expect(n.rows[0].n).toBe(1);
    // parallel retries of the same request create one booking
    const key2 = idemKey();
    const par = await Promise.all([1, 2, 3].map(() => book(c.access, req(m, 'Ali', ['Haircut'], MON(), '12:00'), key2)));
    expect(new Set(par.map((r) => r.body.data?.id)).size).toBe(1);
    expect(par.every((r) => r.status === 201)).toBe(true);
  });

  it('anti-hoarding: at most 3 open bookings per customer at one salon', async () => {
    const m = await salon('Hoard Salon');
    const c = await customer('Hoarder');
    for (const time of ['10:00', '10:30', '11:00']) await book(c.access, req(m, 'Ali', ['Haircut'], MON(), time)).expect(201);
    const r = await book(c.access, req(m, 'Ali', ['Haircut'], MON(), '11:30')).expect(409);
    expect(r.body.error.details).toMatchObject({ rule: 'ACTIVE_LIMIT' });
  });

  // ------------------------------------------------------------------ cancel and reschedule
  it('cancel: own booking, with reason and history; cancelled bookings cannot be cancelled or moved again', async () => {
    const m = await salon('Cancel Salon');
    const c = await customer('Cancel Customer');
    const b = (await book(c.access, req(m, 'Ali', ['Haircut'], MON(), '10:00')).expect(201)).body.data;
    expect(b).toMatchObject({ canCancel: true, canReschedule: true, reschedulesLeft: 2 });
    const r = await h.http().post(`/api/v1/bookings/${b.id}/cancel`).set(bearer(c.access)).send({ reason: 'Plans changed' }).expect(200);
    expect(r.body.data).toMatchObject({ status: 'CANCELLED', canCancel: false, cancellation: { by: 'CUSTOMER', reason: 'Plans changed' } });
    expect(r.body.data.history.map((x: { event: string }) => x.event)).toEqual(['CREATED', 'CANCELLED']);
    await h.http().post(`/api/v1/bookings/${b.id}/cancel`).set(bearer(c.access)).send({}).expect(409);
    await h.http().post(`/api/v1/bookings/${b.id}/reschedule`).set(bearer(c.access)).send({ date: MON(), time: '11:00' }).expect(409);
  });

  it('cancellation cutoff from the salon policy is enforced on the server', async () => {
    const m = await salon('Cutoff Salon');
    const c = await customer('Cutoff Customer');
    await m.a.put('/booking-policy', { bufferMinutes: 0, minNoticeMinutes: 30, advanceDays: 14, cancelCutoffMinutes: 10080, rescheduleCutoffMinutes: 10080, maxReschedules: 2 }).expect(200);
    const b = (await book(c.access, req(m, 'Ali', ['Haircut'], nearWorkday(), '10:00')).expect(201)).body.data;
    expect(b).toMatchObject({ canCancel: false, canReschedule: false });
    const cancel = await h.http().post(`/api/v1/bookings/${b.id}/cancel`).set(bearer(c.access)).send({}).expect(409);
    expect(cancel.body.error.details).toMatchObject({ rule: 'CANCEL_CUTOFF', cutoffMinutes: 10080 });
    const move = await h.http().post(`/api/v1/bookings/${b.id}/reschedule`).set(bearer(c.access)).send({ date: nearWorkday(), time: '11:00' }).expect(409);
    expect(move.body.error.details).toMatchObject({ rule: 'RESCHEDULE_CUTOFF' });
    // the salon itself can still cancel (with a reason)
    await h.http().post(`/api/v1/salons/mine/bookings/${b.id}/cancel`).set(bearer(m.o.access)).send({}).expect(400);
    await h.http().post(`/api/v1/salons/mine/bookings/${b.id}/cancel`).set(bearer(m.o.access)).send({ reason: 'Stylist is ill' }).expect(200);
    const seen = (await h.http().get(`/api/v1/bookings/${b.id}`).set(bearer(c.access)).expect(200)).body.data;
    expect(seen).toMatchObject({ status: 'CANCELLED', cancellation: { by: 'SALON', reason: 'Stylist is ill' } });
  });

  it('reschedule: moves to a free slot, frees the old one, may overlap its own old time, and respects the maximum', async () => {
    const m = await salon('Move Salon');
    const a = await customer('Move One');
    const other = await customer('Move Two');
    const b = (await book(a.access, req(m, 'Ali', ['Haircut'], MON(), '11:00')).expect(201)).body.data;
    await book(other.access, req(m, 'Ali', ['Haircut'], MON(), '12:00')).expect(201);
    const mv = (date: string, time: string) => h.http().post(`/api/v1/bookings/${b.id}/reschedule`).set(bearer(a.access)).send({ date, time });

    await mv(MON(), '12:00').expect(409); // taken by someone else
    await mv(MON(), '11:00').expect(400); // same time
    const r1 = (await mv(MON(), '11:15').expect(200)).body.data; // overlaps its own old slot: allowed
    expect(r1).toMatchObject({ time: '11:15', rescheduleCount: 1, reschedulesLeft: 1 });
    await book(other.access, req(m, 'Ali', ['Haircut'], MON(), '10:30')).expect(201); // old start is free again
    const r2 = (await mv(TUE(), '10:00').expect(200)).body.data;
    expect(r2).toMatchObject({ date: TUE(), time: '10:00', rescheduleCount: 2, reschedulesLeft: 0 });
    const r3 = await mv(TUE(), '11:00').expect(409);
    expect(r3.body.error.details).toMatchObject({ rule: 'RESCHEDULE_LIMIT' });
    expect(r2.history.map((x: { event: string }) => x.event)).toEqual(['CREATED', 'RESCHEDULED', 'RESCHEDULED']);
    expect(r2.totalPrice).toBe('300.00'); // price snapshot unchanged by a move
  });

  // ------------------------------------------------------------------ isolation
  it('IDOR / BOLA: another customer, another salon\'s owner and a stranger cannot read or change a booking', async () => {
    const m = await salon('Idor Salon');
    const other = await salon('Idor Other Salon');
    const a = await customer('Victim');
    const evil = await customer('Attacker');
    const b = (await book(a.access, req(m, 'Ali', ['Haircut'], MON(), '10:00')).expect(201)).body.data;

    await h.http().get(`/api/v1/bookings/${b.id}`).set(bearer(evil.access)).expect(404);
    await h.http().post(`/api/v1/bookings/${b.id}/cancel`).set(bearer(evil.access)).send({}).expect(404);
    await h.http().post(`/api/v1/bookings/${b.id}/reschedule`).set(bearer(evil.access)).send({ date: MON(), time: '12:00' }).expect(404);
    expect((await mineBookings(evil.access, '?scope=all').expect(200)).body.data.items).toEqual([]);
    expect((await mineBookings(a.access, '?scope=all').expect(200)).body.data.items).toHaveLength(1);

    await h.http().get(`/api/v1/salons/mine/bookings/${b.id}`).set(bearer(other.o.access)).expect(404);
    await h.http().post(`/api/v1/salons/mine/bookings/${b.id}/cancel`).set(bearer(other.o.access)).send({ reason: 'not mine' }).expect(404);
    const otherList = (await h.http().get(`/api/v1/salons/mine/bookings?from=${MON()}`).set(bearer(other.o.access)).expect(200)).body.data;
    expect(otherList.items).toEqual([]);
    await h.http().get('/api/v1/salons/mine/bookings').set(bearer(evil.access)).expect(403);
    await h.http().get('/api/v1/salons/mine/bookings').expect(401);
    // the status of the victim's booking is untouched
    expect((await aq('SELECT status FROM appointments WHERE id = $1', [b.id])).rows[0].status).toBe('CONFIRMED');
  });

  it('owner calendar: sees the customer name and phone, day and staff filters, never another salon\'s data', async () => {
    const m = await salon('Calendar Salon');
    const a = await customer('Calendar Cust');
    await book(a.access, req(m, 'Ali', ['Haircut'], MON(), '10:00')).expect(201);
    await book(a.access, req(m, 'Ahmed', ['Haircut'], MON(), '10:00')).expect(201);
    await book(a.access, req(m, 'Ali', ['Haircut'], TUE(), '10:00')).expect(201);
    const day = (await h.http().get(`/api/v1/salons/mine/bookings?from=${MON()}&to=${MON()}`).set(bearer(m.o.access)).expect(200)).body.data;
    expect(day.total).toBe(2);
    expect(day.items[0].customer).toEqual({ name: 'Calendar Cust', phone: '+923001234567' });
    const ali = (await h.http().get(`/api/v1/salons/mine/bookings?from=${MON()}&to=${TUE()}&staffId=${m.staff.Ali}`).set(bearer(m.o.access)).expect(200)).body.data;
    expect(ali.items.map((i: { staff: { name: string } }) => i.staff.name)).toEqual(['Ali', 'Ali']);
    await h.http().get(`/api/v1/salons/mine/bookings?from=${MON()}&to=${addDaysIso(MON(), 40)}`).set(bearer(m.o.access)).expect(400);
    await h.http().get(`/api/v1/salons/mine/bookings?from=2026-02-30`).set(bearer(m.o.access)).expect(400);
  });

  it('public availability and search expose no customer data', async () => {
    const m = await salon('Privacy Salon');
    const c = await customer('Very Private Name');
    await book(c.access, req(m, 'Ali', ['Haircut'], MON(), '10:00')).expect(201);
    const av = await h.http().get(`/api/v1/public/discovery/salons/${m.salonId}/availability?date=${MON()}&serviceIds=${m.services.Haircut}`).expect(200);
    const text = JSON.stringify(av.body);
    expect(text).not.toContain('Very Private Name');
    expect(text).not.toContain(c.email);
    expect(text).not.toContain(c.id);
    expect(text).not.toContain('+923001234567');
  });

  // ------------------------------------------------------------------ policy
  it('booking policy: public read, owner write with validation and audit; customers and staff cannot change it', async () => {
    const m = await salon('Policy Salon');
    const c = await customer('Policy Customer');
    const pub = (await h.http().get(`/api/v1/public/salons/${m.salonId}/booking-policy`).expect(200)).body.data;
    expect(pub).toMatchObject({ bufferMinutes: 0, minNoticeMinutes: 30, advanceDays: 14, cancelCutoffMinutes: 120, maxReschedules: 2, customized: false });
    const good = { bufferMinutes: 10, minNoticeMinutes: 60, advanceDays: 21, cancelCutoffMinutes: 240, rescheduleCutoffMinutes: 240, maxReschedules: 1 };
    expect((await m.a.put('/booking-policy', good).expect(200)).body.data).toMatchObject({ ...good, customized: true });
    expect((await h.http().get(`/api/v1/public/salons/${m.salonId}/booking-policy`).expect(200)).body.data).toMatchObject(good);
    for (const bad of [{ bufferMinutes: 7 }, { bufferMinutes: 65 }, { advanceDays: 0 }, { advanceDays: 61 }, { maxReschedules: 6 }, { minNoticeMinutes: -1 }, { cancelCutoffMinutes: 99999 }]) {
      await m.a.put('/booking-policy', { ...good, ...bad }).expect(400);
    }
    await m.a.put('/booking-policy', { ...good, extra: 1 }).expect(400);
    await h.http().put('/api/v1/salons/mine/booking-policy').set(bearer(c.access)).send(good).expect(403);
    const audit = await aq(`SELECT metadata FROM audit_logs WHERE action = 'booking.policy_updated' AND salon_id = $1`, [m.salonId]);
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].metadata.after).toMatchObject(good);
    // a longer window is honoured by the availability endpoint and by booking
    const far = addDaysIso(today(), 20);
    await h.http().get(`/api/v1/public/discovery/salons/${m.salonId}/availability?date=${far}&serviceIds=${m.services.Haircut}`).expect(200);
    await h.http().get(`/api/v1/public/discovery/salons/${m.salonId}/availability?date=${addDaysIso(today(), 21)}&serviceIds=${m.services.Haircut}`).expect(400);
  });

  it('booking window: a salon that only accepts today cannot be booked for tomorrow (minimum notice is covered by the unit tests)', async () => {
    const m = await salon('Window Salon');
    const c = await customer('Window Customer');
    await m.a.put('/booking-policy', { bufferMinutes: 0, minNoticeMinutes: 30, advanceDays: 1, cancelCutoffMinutes: 120, rescheduleCutoffMinutes: 120, maxReschedules: 2 }).expect(200);
    const r = await book(c.access, req(m, 'Ali', ['Haircut'], MON(), '11:00')).expect(400);
    expect(r.body.error.message).toMatch(/between today and 0 days/);
    await h.http().get(`/api/v1/public/discovery/salons/${m.salonId}/availability?date=${MON()}&serviceIds=${m.services.Haircut}`).expect(400);
  });

  // ------------------------------------------------------------------ database-level guarantees (as the runtime role)
  it('database: exclusion constraint, snapshot immutability, the salon cannot move a booking, history and lines are append-only', async () => {
    const m = await salon('Db Salon');
    const a = await customer('Db One');
    const b = (await book(a.access, req(m, 'Ali', ['Haircut', 'Beard'], MON(), '10:00')).expect(201)).body.data;

    // 1) a raw INSERT overlapping an active appointment is refused by the exclusion constraint (23P01)
    await expect(asApp({ user: a.id, publicRead: true }, async (c) => {
      await c.query(
        `INSERT INTO appointments (salon_id, customer_user_id, staff_id, starts_at, ends_at, blocked_until, total_duration_minutes, total_price, salon_name, staff_name)
         SELECT salon_id, customer_user_id, staff_id, starts_at + interval '15 minutes', ends_at + interval '15 minutes', blocked_until + interval '15 minutes',
                total_duration_minutes, total_price, salon_name, staff_name FROM appointments WHERE id = $1`, [b.id]);
    })).rejects.toMatchObject({ code: '23P01' });

    // 2) snapshots cannot be changed, not even by the customer who owns the row
    await expect(asApp({ user: a.id, publicRead: true }, (c) => c.query(`UPDATE appointments SET total_price = 1 WHERE id = $1`, [b.id]))).rejects.toThrow(/snapshot/);
    await expect(asApp({ user: a.id, publicRead: true }, (c) => c.query(`UPDATE appointments SET status = 'COMPLETED' WHERE id = $1`, [b.id]))).rejects.toThrow();

    // 3) the SALON (owner context) can never move the time, only cancel
    await expect(asApp({ user: await ownerId(m), salon: m.salonId }, (c) =>
      c.query(`UPDATE appointments SET starts_at = starts_at + interval '1 hour', ends_at = ends_at + interval '1 hour', blocked_until = blocked_until + interval '1 hour', reschedule_count = reschedule_count + 1 WHERE id = $1`, [b.id]),
    )).rejects.toThrow(/only the customer/);

    // 4) append-only history and immutable lines for the runtime role
    await expect(asApp({ user: a.id }, (c) => c.query(`UPDATE appointment_status_history SET reason = 'x' WHERE appointment_id = $1`, [b.id]))).rejects.toThrow();
    await expect(asApp({ user: a.id }, (c) => c.query(`DELETE FROM appointment_status_history WHERE appointment_id = $1`, [b.id]))).rejects.toThrow();
    await expect(asApp({ user: a.id }, (c) => c.query(`UPDATE appointment_services SET price = 0 WHERE appointment_id = $1`, [b.id]))).rejects.toThrow();
    await expect(asApp({ user: a.id }, (c) => c.query(`DELETE FROM appointments WHERE id = $1`, [b.id]))).rejects.toThrow();

    // 5) totals must equal the lines (checked at commit): an appointment without lines never commits
    const c2 = await appPool.connect();
    try {
      await c2.query('BEGIN');
      await c2.query(`SELECT set_config('app.user_id',$1,true), set_config('app.public_read','true',true)`, [a.id]);
      await c2.query(
        `INSERT INTO appointments (salon_id, customer_user_id, staff_id, starts_at, ends_at, blocked_until, total_duration_minutes, total_price, salon_name, staff_name)
         VALUES ($1, $2, $3, now() + interval '3 day', now() + interval '3 day 30 minutes', now() + interval '3 day 30 minutes', 30, 300, 'x', 'y')`,
        [m.salonId, a.id, m.staff.Ahmed]);
      await expect(c2.query('COMMIT')).rejects.toThrow(/totals/);
    } finally {
      await c2.query('ROLLBACK').catch(() => undefined);
      c2.release();
    }

    // 6) appointments and lines of one customer are invisible to another customer's RLS context, and to the public context in full
    const evil = await customer('Db Evil');
    const asEvil = await asApp({ user: evil.id, publicRead: true }, async (c) => (await c.query(`SELECT id, customer_user_id FROM appointments WHERE customer_user_id = $1`, [a.id])).rowCount);
    expect(asEvil).toBe(0);
    const lines = await asApp({ user: evil.id, publicRead: true }, async (c) => (await c.query('SELECT * FROM appointment_services')).rowCount);
    expect(lines).toBe(0);
    const publicOnly = await asApp({ publicRead: true }, async (c) => (await c.query('SELECT * FROM appointment_services')).rowCount);
    expect(publicOnly).toBe(0);
    const noContext = await asApp({}, async (c) => (await c.query('SELECT * FROM appointments')).rowCount);
    expect(noContext).toBe(0);
    // the public context can only write nothing
    await expect(asApp({ publicRead: true }, (c) => c.query(`UPDATE appointments SET customer_note = 'x'`))).resolves.toBeDefined();
    expect((await aq('SELECT customer_note FROM appointments WHERE id = $1', [b.id])).rows[0].customer_note).toBeNull();
  });

  async function ownerId(m: Made): Promise<string> {
    return (await aq('SELECT owner_user_id FROM salons WHERE id = $1', [m.salonId])).rows[0].owner_user_id as string;
  }

  it('database: a staff member sees only THEIR appointments (RLS)', async () => {
    const m = await salon('Staff Rls Salon');
    const c = await customer('Staff Rls Cust');
    await book(c.access, req(m, 'Ali', ['Haircut'], MON(), '10:00')).expect(201);
    await book(c.access, req(m, 'Ahmed', ['Haircut'], MON(), '11:00')).expect(201);
    const staffUser = await customer('Ali As Staff');
    await aq('UPDATE staff_profiles SET user_id = $1 WHERE id = $2', [staffUser.id, m.staff.Ali]);
    const rows = await asApp({ user: staffUser.id, salon: m.salonId }, async (cl) => (await cl.query('SELECT staff_id FROM appointments')).rows);
    expect(rows).toHaveLength(1);
    expect(rows[0].staff_id).toBe(m.staff.Ali);
    const lines = await asApp({ user: staffUser.id, salon: m.salonId }, async (cl) => (await cl.query('SELECT appointment_id FROM appointment_services')).rowCount);
    expect(lines).toBe(1);
    await expect(asApp({ user: staffUser.id, salon: m.salonId }, (cl) => cl.query(`UPDATE appointments SET status = 'CANCELLED'`))).resolves.toBeDefined();
    expect((await aq(`SELECT count(*)::int AS n FROM appointments WHERE salon_id = $1 AND status = 'CANCELLED'`, [m.salonId])).rows[0].n).toBe(0);
  });
});
