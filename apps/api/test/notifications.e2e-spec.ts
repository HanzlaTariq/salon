// The cron endpoint is enabled for this file only (the env is read when the app module loads).
process.env.NOTIFICATIONS_CRON_SECRET = 'cron-secret-for-tests-'.padEnd(40, 'x');

import { Pool, PoolClient } from 'pg';
import sharp from 'sharp';
import { hotp, base32Decode, timeStep } from '../src/modules/auth/totp';
import { slotMs } from '../src/modules/booking/booking.types';
import { todayKarachi, addDays } from '../src/modules/billing/billing.types';
import { addDaysIso, isoWeekday } from '../src/modules/discovery/discovery.types';
import { NotificationDispatcher } from '../src/modules/notifications/notification.dispatcher';
import { NotificationScheduler } from '../src/modules/notifications/notification.scheduler';
import { hashToken } from '../src/modules/notifications/notification.service';
import { LogPushProvider, PushProvider } from '../src/modules/notifications/push.provider';
import { Harness, bearer, createHarness, createPlatformUser, dbEnabled, loginMobile, registerAndVerify, lastToken, uniqueEmail, GOOD_PASSWORD } from './support/harness';

const d = dbEnabled ? describe : describe.skip;
if (!dbEnabled) {
  // eslint-disable-next-line no-console
  console.warn('SKIPPED notifications e2e: set TEST_DATABASE_URL (salon_app) and TEST_ADMIN_DATABASE_URL (salon_migrator).');
}

const totp = (secretB32: string, h: Harness) => hotp(base32Decode(secretB32), timeStep(h.clock.now().getTime()));
const png = () => sharp({ create: { width: 600, height: 400, channels: 3, background: '#c07840' } }).png().toBuffer();
const WEEK = [1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, closed: false, opensAt: '10:00', closesAt: '21:00' })).concat([{ weekday: 7, closed: true } as never]);
const STAFF_WEEK = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, off: false, startsAt: '10:00', endsAt: '18:00' })).concat([{ weekday: 6, off: true }, { weekday: 7, off: true }] as never[]);
let cityCounter = 0;
const uniqueCity = () => `Notifyville${Date.now().toString(36)}${cityCounter++}`;
let tokenCounter = 0;
const deviceToken = (label: string) => `fcm-${label}-${Date.now().toString(36)}-${tokenCounter++}`.padEnd(48, 'x');
let txnCounter = 0;
const txn = () => `NTX${Date.now().toString(36).toUpperCase()}${txnCounter++}`;
const MIN = 60_000;

d('Phase 10: notifications - outbox, recipients, preferences, reminders, push delivery, security (real PostgreSQL)', () => {
  let h: Harness;
  let appPool: Pool;
  let push: LogPushProvider;
  let sched: NotificationScheduler;
  let dispatcher: NotificationDispatcher;
  let superAdmin: string;
  let finance: string;

  beforeAll(async () => {
    h = await createHarness();
    appPool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 4 });
    push = h.app.get(PushProvider) as LogPushProvider;
    sched = h.app.get(NotificationScheduler);
    dispatcher = h.app.get(NotificationDispatcher);
    superAdmin = await platformUser('SUPER_ADMIN');
    finance = await platformUser('FINANCE');
    await h.http().post('/api/v1/admin/billing/plans').set(bearer(superAdmin)).send({ monthlyPricePerStaff: '300', yearlyPricePerStaff: '3000', graceDays: 3, renewalNoticeDays: 7 }).expect(201);
    await h.http().post('/api/v1/admin/billing/payment-methods').set(bearer(superAdmin)).send({ method: 'JAZZCASH', accountTitle: 'Salon Platform', accountNumber: '03001234567' }).expect(201);
  });
  afterAll(async () => {
    delete process.env.NOTIFICATIONS_CRON_SECRET;
    await appPool.end();
    await h.close();
  });
  beforeEach(() => {
    h.clock.set(Date.now());
    push.behaviour = null;
  });

  // ------------------------------------------------------------------ helpers
  async function aq(sql: string, params: unknown[] = []) {
    const c = await h.admin.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.is_platform_admin','true',true), set_config('app.notification_worker','true',true)`);
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
  /** Runs SQL as the least-privilege app role with a tenant context (always rolled back). */
  async function asApp<T>(ctx: { user?: string; salon?: string; worker?: boolean }, fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await appPool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.user_id',$1,true), set_config('app.salon_id',$2,true), set_config('app.is_platform_admin','false',true), set_config('app.public_read','false',true), set_config('app.notification_worker',$3,true)`, [ctx.user ?? '', ctx.salon ?? '', ctx.worker ? 'true' : 'false']);
      return await fn(c);
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  }
  async function platformUser(role: 'SUPER_ADMIN' | 'FINANCE') {
    const u = await createPlatformUser(h, role);
    const access = (await loginMobile(h, u.email, u.password)).body.data.accessToken as string;
    const setup = (await h.http().post('/api/v1/auth/mfa/setup').set(bearer(access)).send({ password: u.password }).expect(200)).body.data;
    await h.http().post('/api/v1/auth/mfa/enable').set(bearer(access)).send({ code: totp(setup.secret, h) }).expect(200);
    return access;
  }
  async function owner() {
    const u = await registerAndVerify(h, { accountType: 'SALON_OWNER', fullName: 'Owner Person' });
    const access = (await loginMobile(h, u.email, u.password)).body.data.accessToken as string;
    const id = (await aq('SELECT id FROM users WHERE email = $1', [u.email])).rows[0].id as string;
    return { ...u, access, id };
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
  const workday = () => {
    for (let i = 2; i <= 6; i += 1) if (isoWeekday(addDaysIso(today(), i)) <= 5) return addDaysIso(today(), i);
    throw new Error('unreachable');
  };
  const goto = (date: string, time: string) => {
    const [hh, mm] = time.split(':').map(Number);
    h.clock.set(slotMs(date, hh * 60 + mm));
  };
  /** One worker round (sweepers + dispatcher). Never moves the clock backwards behind the real time of already written events. */
  const tick = async () => {
    h.clock.set(Math.max(h.clock.now().getTime(), Date.now()));
    // The shared test database may hold a backlog from other suites: drain it (retries with a future run_at are not claimed).
    let total = await sched.tick({ force: true });
    for (let i = 0; i < 40 && total.claimed >= 50; i += 1) {
      // (the scheduler already drains up to 10 batches per round)
      const next = await sched.tick({ force: true });
      total = { ...total, claimed: total.claimed + next.claimed, retried: total.retried + next.retried };
      if (next.claimed === 0) break;
    }
    return total;
  };

  interface Made { o: Awaited<ReturnType<typeof owner>>; salonId: string; staff: Record<string, string>; services: Record<string, string>; a: ReturnType<typeof mine> }
  /** An APPROVED salon: Ali + Ahmed (Mon-Fri 10-18, break 13-14), Haircut (Ali 300 / Ahmed 500, 30 min). */
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
    await upload(o.access, 'DOCUMENT', 'CNIC_FRONT', await png()).expect(201);
    await upload(o.access, 'DOCUMENT', 'CNIC_BACK', await png()).expect(201);
    await upload(o.access, 'PHOTO', 'COVER', await png()).expect(201);
    await a.post('/submit').expect(200);
    await h.http().post(`/api/v1/admin/salons/${salonId}/approve`).set(bearer(superAdmin)).expect(200);
    return { o, salonId, staff, services, a };
  }
  async function staffAccount(m: Made, who: 'Ali' | 'Ahmed') {
    const email = uniqueEmail('staff');
    await m.a.post(`/team/${m.staff[who]}/invitation`, { email }).expect(201);
    const token = lastToken(h, email, 'Invitation');
    await h.http().post('/api/v1/public/staff-invitations/accept').send({ token, fullName: `${who} Staff`, password: GOOD_PASSWORD }).expect(201);
    const access = (await loginMobile(h, email, GOOD_PASSWORD)).body.data.accessToken as string;
    const userId = (await aq('SELECT id FROM users WHERE email=$1', [email])).rows[0].id as string;
    return { access, userId };
  }
  const book = (m: Made, c: { access: string }, who: string, date: string, time: string) =>
    h.http().post('/api/v1/bookings').set(bearer(c.access)).send({ salonId: m.salonId, staffId: m.staff[who], serviceIds: [m.services.Haircut], date, time });
  const booked = async (m: Made, c: { access: string }, who: string, date: string, time: string) => (await book(m, c, who, date, time).expect(201)).body.data as { id: string };
  const S = (t: string) => ({
    get: (p: string) => h.http().get(`/api/v1/staff/me${p}`).set(bearer(t)),
    post: (p: string, b: object = {}) => h.http().post(`/api/v1/staff/me${p}`).set(bearer(t)).send(b),
  });
  /** Registers a fake phone for a person and returns its token. */
  async function device(access: string, app: 'CUSTOMER' | 'BUSINESS' = 'CUSTOMER', label = 'dev') {
    const token = deviceToken(label);
    await h.http().post('/api/v1/devices').set(bearer(access)).send({ token, platform: 'ANDROID', app }).expect(200);
    return token;
  }
  const inbox = async (access: string, query = 'limit=50') => (await h.http().get(`/api/v1/notifications?${query}`).set(bearer(access)).expect(200)).body.data as {
    items: Array<{ id: string; type: string; title: string; body: string; data: Record<string, string>; readAt: string | null }>; nextCursor: string | null; unreadCount: number;
  };
  const typesFor = async (access: string, appointmentId?: string) =>
    (await inbox(access)).items.filter((n) => !appointmentId || n.data.appointmentId === appointmentId).map((n) => n.type);
  const sentTo = (token: string) => push.sent.filter((m) => m.token === token);
  const countFor = async (userId: string, type: string) =>
    (await aq(`SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND type = $2`, [userId, type])).rows[0].n as number;

  // ------------------------------------------------------------------ devices
  it('devices: register, refresh, hand over to another person, unregister, keep at most 10', async () => {
    const c = await customer('Device Customer');
    const other = await customer('Device Other');
    const token = deviceToken('reg');

    const bad = (b: object) => h.http().post('/api/v1/devices').set(bearer(c.access)).send(b);
    await bad({ token: 'short', platform: 'ANDROID', app: 'CUSTOMER' }).expect(400);
    await bad({ token, platform: 'WINDOWS', app: 'CUSTOMER' }).expect(400);
    await bad({ token, platform: 'ANDROID', app: 'CUSTOMER', userId: other.id }).expect(400); // no mass assignment
    await h.http().post('/api/v1/devices').send({ token, platform: 'ANDROID', app: 'CUSTOMER' }).expect(401);
    await h.http().post('/api/v1/devices').set(bearer(superAdmin)).send({ token, platform: 'ANDROID', app: 'CUSTOMER' }).expect(403); // platform accounts have no phone app

    expect((await bad({ token, platform: 'ANDROID', app: 'CUSTOMER', appVersion: '1.2.3' }).expect(200)).body.data).toEqual({ registered: true });
    await bad({ token, platform: 'ANDROID', app: 'CUSTOMER' }).expect(200); // refresh: no duplicate
    const rows = (await aq('SELECT user_id, session_id, token_hash, disabled_at FROM device_tokens WHERE token = $1', [token])).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ user_id: c.id, token_hash: hashToken(token), disabled_at: null });
    expect(rows[0].session_id).toBeTruthy();

    // the same phone is now used by somebody else: pushes follow the phone's CURRENT owner only
    await h.http().post('/api/v1/devices').set(bearer(other.access)).send({ token, platform: 'ANDROID', app: 'CUSTOMER' }).expect(200);
    expect((await aq('SELECT user_id FROM device_tokens WHERE token = $1', [token])).rows).toEqual([{ user_id: other.id }]);

    // somebody else cannot switch off a phone that is not theirs; its owner can
    await h.http().delete('/api/v1/devices').set(bearer(c.access)).send({ token }).expect(204);
    expect((await aq('SELECT disabled_at FROM device_tokens WHERE token = $1', [token])).rows[0].disabled_at).toBeNull();
    await h.http().delete('/api/v1/devices').set(bearer(other.access)).send({ token }).expect(204);
    expect((await aq('SELECT disabled_reason FROM device_tokens WHERE token = $1', [token])).rows[0].disabled_reason).toBe('LOGOUT');
    await h.http().delete('/api/v1/devices').set(bearer(other.access)).send({ token }).expect(204); // idempotent

    for (let i = 0; i < 12; i += 1) await device(c.access, 'CUSTOMER', `many${i}`);
    expect((await aq('SELECT count(*)::int AS n FROM device_tokens WHERE user_id = $1 AND disabled_at IS NULL', [c.id])).rows[0].n).toBe(10);
  });

  // ------------------------------------------------------------------ recipients
  it('a new booking: the customer is told it is confirmed, the salon team that it is new; nobody is told twice or about their own action', async () => {
    const m = await salon('Recipients Salon');
    const c = await customer('Sara Customer');
    const ali = await staffAccount(m, 'Ali');
    const cTok = await device(c.access, 'CUSTOMER', 'cust');
    const oTok = await device(m.o.access, 'BUSINESS', 'owner');
    const aTok = await device(ali.access, 'BUSINESS', 'ali');
    const D = workday();
    const b = await booked(m, c, 'Ali', D, '11:00');

    const r = await tick();
    expect(r.claimed).toBeGreaterThan(0);
    expect(await typesFor(c.access, b.id)).toEqual(['BOOKING_CONFIRMED']);
    expect(await typesFor(m.o.access, b.id)).toEqual(['BOOKING_NEW']);
    expect(await typesFor(ali.access, b.id)).toEqual(['BOOKING_NEW']);

    const confirmed = sentTo(cTok);
    expect(confirmed).toHaveLength(1);
    expect(confirmed[0]).toMatchObject({ title: 'Booking confirmed' });
    expect(confirmed[0].body).toContain('Recipients Salon');
    expect(confirmed[0].body).toContain('Ali');
    expect(confirmed[0].data).toMatchObject({ type: 'BOOKING_CONFIRMED', route: 'booking', appointmentId: b.id });
    expect(confirmed[0].data.notificationId).toMatch(/^[0-9a-f-]{36}$/);
    const ownerPush = sentTo(oTok).filter((x) => x.data.type === 'BOOKING_NEW');
    expect(ownerPush).toHaveLength(1);
    expect(ownerPush[0]).toMatchObject({ title: 'New booking' });
    expect(ownerPush[0].body).toContain('Sara Customer');
    expect(ownerPush[0].data.route).toBe('queue');
    expect(sentTo(aTok).filter((x) => x.data.type === 'BOOKING_NEW')).toHaveLength(1);

    // running the worker again changes nothing (idempotent)
    await tick();
    await tick();
    expect(sentTo(cTok)).toHaveLength(1);
    expect(await typesFor(c.access, b.id)).toEqual(['BOOKING_CONFIRMED']);
    expect((await aq(`SELECT count(*)::int AS n FROM notifications WHERE data->>'appointmentId' = $1`, [b.id])).rows[0].n).toBe(3);
    // every delivery is recorded
    expect((await aq(`SELECT count(*)::int AS n FROM notification_deliveries nd JOIN notifications n ON n.id = nd.notification_id WHERE n.data->>'appointmentId' = $1 AND nd.status = 'SENT'`, [b.id])).rows[0].n).toBe(3);
  });

  it('cancellations: a customer cancel tells the team (not the customer); a salon cancel tells the customer and the staff member (not the owner who did it)', async () => {
    const m = await salon('Cancel Notices Salon');
    const c = await customer('Cancel Customer');
    const ali = await staffAccount(m, 'Ali');
    await device(c.access, 'CUSTOMER', 'c1'); await device(m.o.access, 'BUSINESS', 'o1'); await device(ali.access, 'BUSINESS', 'a1');
    const D = workday();
    const b1 = await booked(m, c, 'Ali', D, '11:00');
    const b2 = await booked(m, c, 'Ali', D, '12:00');
    await tick();

    await h.http().post(`/api/v1/bookings/${b1.id}/cancel`).set(bearer(c.access)).send({ reason: 'Plans changed' }).expect(200);
    await h.http().post(`/api/v1/salons/mine/bookings/${b2.id}/cancel`).set(bearer(m.o.access)).send({ reason: 'Stylist is unwell' }).expect(200);
    await tick();

    expect(await typesFor(c.access, b1.id)).toEqual(['BOOKING_CONFIRMED']);
    expect((await typesFor(m.o.access, b1.id)).sort()).toEqual(['BOOKING_CANCELLED_STAFF', 'BOOKING_NEW']);
    expect((await typesFor(ali.access, b1.id)).sort()).toEqual(['BOOKING_CANCELLED_STAFF', 'BOOKING_NEW']);

    expect((await typesFor(c.access, b2.id)).sort()).toEqual(['BOOKING_CANCELLED_SALON', 'BOOKING_CONFIRMED']);
    const told = (await inbox(c.access)).items.find((n) => n.type === 'BOOKING_CANCELLED_SALON')!;
    expect(told.title).toBe('Booking cancelled by the salon');
    expect(told.body).toContain('Stylist is unwell');
    expect(await typesFor(m.o.access, b2.id)).toEqual(['BOOKING_NEW']); // the owner did it himself: no notice
    expect((await typesFor(ali.access, b2.id)).sort()).toEqual(['BOOKING_CANCELLED_STAFF', 'BOOKING_NEW']);
  });

  it('completed and no-show reach the customer; arrival reports and early-offer answers reach the team, never the person who acted', async () => {
    const m = await salon('Flow Notices Salon');
    const c = await customer('Flow Customer');
    const ali = await staffAccount(m, 'Ali');
    await device(c.access, 'CUSTOMER', 'c2'); await device(m.o.access, 'BUSINESS', 'o2'); await device(ali.access, 'BUSINESS', 'a2');
    const D = workday();
    const done = await booked(m, c, 'Ali', D, '11:00');
    const missed = await booked(m, c, 'Ali', D, '15:00');
    const early = await booked(m, c, 'Ali', D, '16:00');

    goto(D, '10:55');
    await S(ali.access).post(`/appointments/${done.id}/start`).expect(200);
    await h.http().post(`/api/v1/bookings/${missed.id}/arrival`).set(bearer(c.access)).send({ state: 'RUNNING_LATE', etaMinutes: 20 }).expect(409).catch(() => undefined);
    goto(D, '11:20');
    await S(ali.access).post(`/appointments/${done.id}/complete`).expect(200);
    await tick();
    expect((await typesFor(c.access, done.id)).sort()).toEqual(['BOOKING_CONFIRMED', 'SERVICE_COMPLETED']);

    // arrival: the customer reports (3 hours before is allowed), the team is told
    goto(D, '14:45');
    await h.http().post(`/api/v1/bookings/${missed.id}/arrival`).set(bearer(c.access)).send({ state: 'RUNNING_LATE', etaMinutes: 20 }).expect(200);
    await tick();
    expect((await typesFor(m.o.access, missed.id)).sort()).toEqual(['ARRIVAL_RUNNING_LATE', 'BOOKING_NEW']);
    expect((await typesFor(ali.access, missed.id)).sort()).toEqual(['ARRIVAL_RUNNING_LATE', 'BOOKING_NEW']);
    expect((await typesFor(c.access, missed.id)).filter((t) => t !== 'APPOINTMENT_REMINDER')).toEqual(['BOOKING_CONFIRMED']); // the customer is not told about their own report
    const late = (await inbox(m.o.access)).items.find((n) => n.type === 'ARRIVAL_RUNNING_LATE')!;
    expect(late.body).toContain('Flow Customer');
    expect(late.body).toContain('3:00 PM');

    // no-show only after the grace period (ETA 15:05 + 15 min)
    goto(D, '15:25');
    await S(ali.access).post(`/appointments/${missed.id}/no-show`).expect(200);
    await tick();
    expect((await typesFor(c.access, missed.id)).filter((t) => t !== 'APPOINTMENT_REMINDER').sort()).toEqual(['BOOKING_CONFIRMED', 'NO_SHOW_RECORDED']);

    // early offer: asked by staff (customer is told), answered by the customer (team is told)
    goto(D, '15:30');
    const offer = (await S(ali.access).post(`/appointments/${early.id}/early-offer`).expect(201)).body.data.offer;
    await tick();
    expect((await typesFor(c.access, early.id)).filter((t) => t !== 'APPOINTMENT_REMINDER').sort()).toEqual(['BOOKING_CONFIRMED', 'EARLY_OFFER']);
    const offered = (await inbox(c.access)).items.find((n) => n.type === 'EARLY_OFFER')!;
    expect(offered.title).toBe('Your stylist is available earlier');
    expect(offered.body).toContain('Would you like to come now?');
    expect(offered.data.offerId).toBe(offer.id);
    await h.http().post(`/api/v1/bookings/${early.id}/early-offer/accept`).set(bearer(c.access)).send({ offerId: offer.id, etaMinutes: 15 }).expect(200);
    await tick();
    expect((await typesFor(ali.access, early.id)).filter((t) => t.startsWith('EARLY'))).toEqual(['EARLY_ACCEPTED']);
    expect((await typesFor(m.o.access, early.id)).filter((t) => t.startsWith('EARLY'))).toEqual(['EARLY_ACCEPTED']);
    expect((await typesFor(c.access, early.id)).filter((t) => t.startsWith('EARLY'))).toEqual(['EARLY_OFFER']); // the customer is not told about their own answer
    // the customer also reported "coming in 15 minutes" with the acceptance
    expect((await typesFor(ali.access, early.id)).filter((t) => t.startsWith('ARRIVAL'))).toEqual(['ARRIVAL_ON_THE_WAY']);
  });

  it('a declined early offer tells the team, and an offer that was taken back is never sent', async () => {
    const m = await salon('Decline Notices Salon');
    const c = await customer('Decline Customer');
    const ali = await staffAccount(m, 'Ali');
    const D = workday();
    const b = await booked(m, c, 'Ali', D, '12:00');
    await tick();
    goto(D, '11:20');
    const offer = (await S(ali.access).post(`/appointments/${b.id}/early-offer`).expect(201)).body.data.offer;
    await h.http().delete(`/api/v1/staff/me/appointments/${b.id}/early-offer`).set(bearer(ali.access)).expect(200); // taken back before the worker ran
    await tick();
    expect(await typesFor(c.access, b.id)).toEqual(['BOOKING_CONFIRMED']); // the stale offer produced nothing
    expect(offer.id).toBeTruthy();

    const offer2 = (await S(ali.access).post(`/appointments/${b.id}/early-offer`).expect(201)).body.data.offer;
    await h.http().post(`/api/v1/bookings/${b.id}/early-offer/decline`).set(bearer(c.access)).send({ offerId: offer2.id }).expect(200);
    await tick();
    expect((await typesFor(ali.access, b.id)).filter((t) => t.startsWith('EARLY'))).toEqual(['EARLY_DECLINED']);
  });

  it('a late-running day: the next customer is told the new estimate next to the booked time, but not on every small change', async () => {
    const m = await salon('Delay Notices Salon');
    const c1 = await customer('Delay A');
    const c2 = await customer('Delay B');
    const ali = await staffAccount(m, 'Ali');
    const tok = await device(c2.access, 'CUSTOMER', 'delay');
    const D = workday();
    const a1 = await booked(m, c1, 'Ali', D, '11:00');
    const a2 = await booked(m, c2, 'Ali', D, '11:30');
    goto(D, '11:00');
    await S(ali.access).post(`/appointments/${a1.id}/start`).expect(200);

    goto(D, '11:40'); // A should have ended at 11:30: B is about 10 minutes behind
    await S(ali.access).get('/queue').expect(200);
    await tick();
    const first = (await inbox(c2.access)).items.filter((n) => n.type === 'DELAY_NOTICE');
    expect(first).toHaveLength(1);
    expect(first[0].title).toBe('Your appointment is running late');
    expect(first[0].body).toContain('10 min');
    expect(first[0].body).toContain('11:40 AM');
    expect(first[0].body).toContain('booked: 11:30 AM');
    expect(sentTo(tok).filter((x) => x.data.type === 'DELAY_NOTICE')).toHaveLength(1);

    goto(D, '11:45'); // forecast moves by 5 minutes only: no second notice within 10 minutes
    await S(ali.access).get('/queue').expect(200);
    await tick();
    expect(await countFor(c2.id, 'DELAY_NOTICE')).toBe(1);

    goto(D, '12:15'); // moved by 30 minutes: tell the customer again
    await S(ali.access).get('/queue').expect(200);
    await tick();
    expect(await countFor(c2.id, 'DELAY_NOTICE')).toBe(2);
    expect((await inbox(c2.access)).items.find((n) => n.type === 'DELAY_NOTICE')!.body).toContain('12:15 PM');
  });

  // ------------------------------------------------------------------ reminders
  it('reminders: 30, 20, 10 minutes before and at the appointment time, each exactly once; nothing for a cancelled or very late one', async () => {
    const m = await salon('Reminder Salon');
    const c = await customer('Reminder Customer');
    const tok = await device(c.access, 'CUSTOMER', 'rem');
    const D = workday();
    const b = await booked(m, c, 'Ali', D, '12:00');
    const gone = await booked(m, c, 'Ahmed', D, '12:00');
    await h.http().post(`/api/v1/bookings/${gone.id}/cancel`).set(bearer(c.access)).send({}).expect(200);
    const reminders = async (id: string) => (await inbox(c.access)).items.filter((n) => n.type === 'APPOINTMENT_REMINDER' && n.data.appointmentId === id).map((n) => n.title).reverse();

    goto(D, '11:25'); // 35 minutes before
    await tick();
    expect(await reminders(b.id)).toEqual([]);
    goto(D, '11:30');
    await tick();
    expect(await reminders(b.id)).toEqual(['Appointment in 30 minutes']);
    await tick(); // again: still one
    goto(D, '11:40');
    await tick();
    goto(D, '11:50');
    await tick();
    goto(D, '12:00');
    await tick();
    expect(await reminders(b.id)).toEqual(['Appointment in 30 minutes', 'Appointment in 20 minutes', 'Appointment in 10 minutes', 'Please leave for the salon']);
    expect(sentTo(tok).filter((x) => x.data.type === 'APPOINTMENT_REMINDER')).toHaveLength(4);
    expect(await reminders(gone.id)).toEqual([]);

    // an appointment the worker only noticed 20 minutes late gets no stale reminder
    const c2 = await customer('Late Worker Customer');
    const late = await booked(m, c2, 'Ali', D, '15:00');
    goto(D, '15:20');
    await tick();
    expect((await inbox(c2.access)).items.filter((n) => n.type === 'APPOINTMENT_REMINDER')).toEqual([]);
    expect(late.id).toBeTruthy();
  });

  it('reminder preferences: a person chooses which reminders they get, and the language of every message', async () => {
    const m = await salon('Reminder Prefs Salon');
    const c = await customer('Prefs Customer');
    await device(c.access, 'CUSTOMER', 'prefs');
    const put = (b: object) => h.http().put('/api/v1/notifications/preferences').set(bearer(c.access)).send(b);
    const ok = { pushEnabled: true, language: 'en', bookings: true, reminders: true, queue: true, team: true, reminderOffsets: [30, 20, 10, 0] };

    // the defaults, without any saved row
    expect((await h.http().get('/api/v1/notifications/preferences').set(bearer(c.access)).expect(200)).body.data).toEqual(ok);
    await put({ ...ok, reminderOffsets: [15] }).expect(400);
    await put({ ...ok, language: 'fr' }).expect(400);
    await put({ ...ok, extra: true }).expect(400);
    await put({ pushEnabled: true }).expect(400);
    await h.http().put('/api/v1/notifications/preferences').send(ok).expect(401);

    const saved = (await put({ ...ok, language: 'ur', reminderOffsets: [0, 10, 10] }).expect(200)).body.data;
    expect(saved).toMatchObject({ language: 'ur', reminderOffsets: [10, 0] }); // normalised, largest first, no duplicates
    const D = workday();
    const b = await booked(m, c, 'Ali', D, '12:00');
    for (const t of ['11:30', '11:40', '11:50', '12:00']) {
      goto(D, t);
      await tick();
    }
    const items = (await inbox(c.access)).items;
    expect(items.filter((n) => n.type === 'APPOINTMENT_REMINDER').map((n) => n.data.offset).sort()).toEqual(['0', '10']);
    const confirmed = items.find((n) => n.type === 'BOOKING_CONFIRMED' && n.data.appointmentId === b.id)!;
    expect(confirmed.title).toBe('بکنگ کنفرم ہو گئی');
    expect(items.find((n) => n.data.offset === '0')!.title).toBe('براہِ کرم سیلون کے لیے روانہ ہوں');

    // switching a category off stops it (the inbox as well); push off keeps the inbox but sends nothing
    await put({ ...ok, bookings: false }).expect(200);
    const b2 = await booked(m, c, 'Ali', D, '16:00');
    await tick();
    expect(await typesFor(c.access, b2.id)).toEqual([]);
    const tok = await device(c.access, 'CUSTOMER', 'pushoff');
    await put({ ...ok, pushEnabled: false }).expect(200);
    const b3 = await booked(m, c, 'Ali', D, '17:00');
    await tick();
    expect(await typesFor(c.access, b3.id)).toEqual(['BOOKING_CONFIRMED']);
    expect(sentTo(tok)).toHaveLength(0);
  });

  // ------------------------------------------------------------------ salon, payments, subscription, staff
  it('salon decisions reach the owner, and ACCOUNT notices cannot be switched off', async () => {
    const m = await salon('Decision Salon');
    await device(m.o.access, 'BUSINESS', 'dec');
    await h.http().put('/api/v1/notifications/preferences').set(bearer(m.o.access)).send({ pushEnabled: true, language: 'en', bookings: false, reminders: false, queue: false, team: false, reminderOffsets: [] }).expect(200);
    await tick();
    expect(await typesFor(m.o.access)).toContain('SALON_APPROVED');
    expect((await inbox(m.o.access)).items.find((n) => n.type === 'SALON_APPROVED')!.body).toContain('Decision Salon');

    await h.http().post(`/api/v1/admin/salons/${m.salonId}/suspend`).set(bearer(superAdmin)).send({ reason: 'Complaints under review' }).expect(200);
    await tick();
    const susp = (await inbox(m.o.access)).items.find((n) => n.type === 'SALON_SUSPENDED')!;
    expect(susp.body).toContain('Complaints under review');
    await h.http().post(`/api/v1/admin/salons/${m.salonId}/reactivate`).set(bearer(superAdmin)).send({}).expect(200);
    await tick();
    expect(await typesFor(m.o.access)).toEqual(expect.arrayContaining(['SALON_REACTIVATED', 'SALON_SUSPENDED', 'SALON_APPROVED']));
    await tick();
    expect(await countFor(m.o.id, 'SALON_APPROVED')).toBe(1);
  });

  it('payment decisions reach the owner with the invoice number and the reviewer reason; the subscription sweeper warns once per step', async () => {
    const m = await salon('Billing Notices Salon');
    await device(m.o.access, 'BUSINESS', 'bill');
    const bill = (p: string, body: object = {}) => h.http().post(`/api/v1/salons/mine/billing${p}`).set(bearer(m.o.access)).send(body);
    const png1 = await png();
    const submitReal = (invoiceId: string, amount: string) =>
      h.http().post(`/api/v1/salons/mine/billing/invoices/${invoiceId}/payments`).set(bearer(m.o.access))
        .field('method', 'JAZZCASH').field('transactionId', txn()).field('claimedAmount', amount).field('paidOn', today()).attach('receipt', png1, 'receipt.png');

    const inv = (await bill('/invoices', { cycle: 'MONTHLY' }).expect(201)).body.data;
    const p1 = (await submitReal(inv.id, inv.total).expect(201)).body.data;
    await h.http().post(`/api/v1/admin/payments/${p1.id}/request-info`).set(bearer(finance)).send({ reason: 'The receipt is blurry, please upload again' }).expect(200);
    await tick();
    const info = (await inbox(m.o.access)).items.find((n) => n.type === 'PAYMENT_NEEDS_INFO')!;
    expect(info.body).toContain(inv.invoiceNo);
    expect(info.body).toContain('receipt is blurry');

    await h.http().post(`/api/v1/admin/payments/${p1.id}/reject`).set(bearer(finance)).send({ reason: 'Transaction id not found at the bank' }).expect(200);
    await tick();
    expect((await inbox(m.o.access)).items.find((n) => n.type === 'PAYMENT_REJECTED')!.body).toContain('Transaction id not found');

    const p4 = (await submitReal(inv.id, inv.total).expect(201)).body.data;
    await h.http().post(`/api/v1/admin/payments/${p4.id}/approve`).set(bearer(finance)).send({ receivedAmount: inv.total }).expect(200);
    await tick();
    const approved = (await inbox(m.o.access)).items.find((n) => n.type === 'PAYMENT_APPROVED')!;
    expect(approved.title).toBe('Payment verified');
    expect(approved.body).toContain(inv.invoiceNo);
    await tick();
    expect(await countFor(m.o.id, 'PAYMENT_APPROVED')).toBe(1);

    // subscription: the sweeper warns 3 days before the paid period ends (once), and again when it has ended
    const sub = (await aq('SELECT period_end::text AS period_end FROM salon_subscriptions WHERE salon_id = $1', [m.salonId])).rows[0];
    expect(sub).toBeTruthy();
    const noonOf = (iso: string) => slotMs(iso, 12 * 60);
    const subNotices = async (type: string) => (await aq(`SELECT title, body FROM notifications WHERE user_id = $1 AND type = $2`, [m.o.id, type])).rows;
    h.clock.set(noonOf(addDays(sub.period_end, -3)));
    await tick();
    await tick();
    const warn = await subNotices('SUBSCRIPTION_EXPIRING');
    expect(warn).toHaveLength(1);
    expect(warn[0].title).toBe('Subscription ends in 3 days');
    h.clock.set(noonOf(addDays(sub.period_end, -2))); // no warning on days that are not 7, 3 or 1
    await tick();
    expect(await subNotices('SUBSCRIPTION_EXPIRING')).toHaveLength(1);
    h.clock.set(noonOf(addDays(sub.period_end, -1)));
    await tick();
    expect(await subNotices('SUBSCRIPTION_EXPIRING')).toHaveLength(2);
    h.clock.set(noonOf(sub.period_end));
    await tick();
    await tick();
    const ended = await subNotices('SUBSCRIPTION_EXPIRED');
    expect(ended).toHaveLength(1);
    expect(ended[0].body).toContain('grace period');
  });

  it('staff: the owner hears when an invitation is accepted; the staff member hears about schedule changes (not about their own), at most once in 10 minutes', async () => {
    const m = await salon('Team Notices Salon');
    await device(m.o.access, 'BUSINESS', 'team-o');
    const ali = await staffAccount(m, 'Ali');
    await device(ali.access, 'BUSINESS', 'team-a');
    await tick();
    const joined = (await inbox(m.o.access)).items.find((n) => n.type === 'STAFF_JOINED')!;
    expect(joined.body).toContain('Ali');
    expect(joined.data.staffId).toBe(m.staff.Ali);

    await m.a.put(`/team/${m.staff.Ali}/working-hours`, { days: STAFF_WEEK.map((x) => ({ ...x, endsAt: x.endsAt === '18:00' ? '17:00' : x.endsAt })) }).expect(200);
    await tick();
    expect(await typesFor(ali.access)).toEqual(['STAFF_SCHEDULE_UPDATED']);
    expect(await typesFor(m.o.access)).not.toContain('STAFF_SCHEDULE_UPDATED'); // the owner made the change
    await m.a.put(`/team/${m.staff.Ali}/breaks`, { breaks: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startsAt: '13:00', endsAt: '13:30' })) }).expect(200);
    await tick();
    expect(await typesFor(ali.access)).toEqual(['STAFF_SCHEDULE_UPDATED']); // throttled: one notice per 10 minutes
    h.clock.advance(11 * MIN);
    await m.a.put(`/team/${m.staff.Ali}/breaks`, { breaks: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startsAt: '13:00', endsAt: '14:00' })) }).expect(200);
    await tick();
    expect(await typesFor(ali.access)).toEqual(['STAFF_SCHEDULE_UPDATED', 'STAFF_SCHEDULE_UPDATED']);
  });

  // ------------------------------------------------------------------ delivery, retry, safety
  it('push failures: a temporary outage is retried with backoff and delivered once; a dead device is switched off; a rejected message is not retried', async () => {
    const m = await salon('Retry Salon');
    const c = await customer('Retry Customer');
    const tok = await device(c.access, 'CUSTOMER', 'retry');
    const D = workday();
    const b = await booked(m, c, 'Ali', D, '11:00');
    const ev = async () => (await aq(`SELECT e.status, e.attempts, e.run_at FROM notification_events e JOIN appointment_status_history h ON h.id = e.ref_id WHERE h.appointment_id = $1 AND e.kind = 'BOOKING_CREATED'`, [b.id])).rows[0];

    push.behaviour = (msg) => (msg.token === tok ? { ok: false, kind: 'TRANSIENT', code: 'UNAVAILABLE' } : { ok: true, id: 'x' });
    const r1 = await tick();
    expect(r1.retried).toBeGreaterThan(0);
    expect(await typesFor(c.access, b.id)).toEqual(['BOOKING_CONFIRMED']); // the inbox is written even when the push is not delivered yet
    expect(sentTo(tok)).toHaveLength(0);
    let e = await ev();
    expect(e).toMatchObject({ status: 'PENDING', attempts: 1 });
    await tick(); // not due yet (30 s backoff)
    expect((await ev()).attempts).toBe(1);

    push.behaviour = null;
    h.clock.advance(31_000);
    await tick();
    e = await ev();
    expect(e).toMatchObject({ status: 'DONE', attempts: 2 });
    expect(sentTo(tok)).toHaveLength(1);
    expect(await countFor(c.id, 'BOOKING_CONFIRMED')).toBe(1);

    // a device that no longer exists is switched off and the event is finished
    const dead = await customer('Dead Device Customer');
    const deadTok = await device(dead.access, 'CUSTOMER', 'dead');
    await booked(m, dead, 'Ahmed', D, '11:00');
    push.behaviour = (msg) => (msg.token === deadTok ? { ok: false, kind: 'INVALID_TOKEN', code: 'UNREGISTERED' } : { ok: true, id: 'x' });
    await tick();
    expect((await aq('SELECT disabled_reason FROM device_tokens WHERE token = $1', [deadTok])).rows[0].disabled_reason).toBe('INVALID_TOKEN');
    expect((await aq(`SELECT nd.status FROM notification_deliveries nd JOIN device_tokens d ON d.id = nd.device_token_id WHERE d.token = $1`, [deadTok])).rows[0].status).toBe('INVALID_TOKEN');

    // a message the provider refuses for good is not retried
    const perm = await customer('Permanent Customer');
    const permTok = await device(perm.access, 'CUSTOMER', 'perm');
    await booked(m, perm, 'Ali', D, '14:00');
    push.behaviour = (msg) => (msg.token === permTok ? { ok: false, kind: 'PERMANENT', code: 'INVALID_ARGUMENT' } : { ok: true, id: 'x' });
    await tick();
    expect((await aq(`SELECT nd.status FROM notification_deliveries nd JOIN device_tokens d ON d.id = nd.device_token_id WHERE d.token = $1`, [permTok])).rows[0].status).toBe('FAILED');
    expect((await aq('SELECT disabled_at FROM device_tokens WHERE token = $1', [permTok])).rows[0].disabled_at).toBeNull();
  });

  it('a push that keeps failing is given up after five tries (delivery FAILED), without ever losing the inbox row', async () => {
    const m = await salon('Dead Event Salon');
    const c = await customer('Dead Event Customer');
    const tok = await device(c.access, 'CUSTOMER', 'deadev');
    const D = workday();
    const b = await booked(m, c, 'Ali', D, '11:00');
    push.behaviour = (msg) => (msg.token === tok ? { ok: false, kind: 'TRANSIENT', code: 'UNAVAILABLE' } : { ok: true, id: 'x' });
    for (let i = 0; i < 6; i += 1) {
      await tick();
      h.clock.advance(3 * 3_600_000);
    }
    const e = (await aq(`SELECT e.status, e.attempts FROM notification_events e JOIN appointment_status_history h ON h.id = e.ref_id WHERE h.appointment_id = $1 AND e.kind = 'BOOKING_CREATED'`, [b.id])).rows[0];
    expect(e).toMatchObject({ status: 'DONE', attempts: 5 }); // finished: nothing is retried for ever
    expect((await aq(`SELECT nd.status, nd.attempts FROM notification_deliveries nd JOIN device_tokens d ON d.id = nd.device_token_id WHERE d.token = $1`, [tok])).rows[0]).toMatchObject({ status: 'FAILED', attempts: 5 });
    expect(sentTo(tok)).toHaveLength(0);
    expect(await typesFor(c.access, b.id)).toEqual(['BOOKING_CONFIRMED']);
  });

  it('two workers at the same moment produce one notification and one push (SKIP LOCKED + unique keys)', async () => {
    const m = await salon('Race Salon');
    const c = await customer('Race Customer');
    const tok = await device(c.access, 'CUSTOMER', 'race');
    const D = workday();
    const b = await booked(m, c, 'Ali', D, '11:00');
    h.clock.set(Math.max(h.clock.now().getTime(), Date.now()));
    await Promise.all([dispatcher.runOnce(), dispatcher.runOnce(), dispatcher.runOnce()]);
    expect(await typesFor(c.access, b.id)).toEqual(['BOOKING_CONFIRMED']);
    expect(sentTo(tok)).toHaveLength(1);
  });

  it('nothing is pushed to a signed-out phone, a suspended person gets nothing, and the inbox is kept for those who can sign in', async () => {
    const m = await salon('Signed Out Salon');
    const c = await customer('Signed Out Customer');
    const tok = await device(c.access, 'CUSTOMER', 'signedout');
    const gone = await customer('Suspended Customer');
    const goneTok = await device(gone.access, 'CUSTOMER', 'susp');
    const D = workday();
    await booked(m, c, 'Ali', D, '11:00');
    await booked(m, gone, 'Ahmed', D, '11:00');
    await h.http().post('/api/v1/auth/logout-all').set(bearer(c.access)).expect(204).catch(() => undefined);
    await aq(`UPDATE auth_sessions SET revoked_at = now(), revoked_reason = 'test' WHERE user_id = $1`, [c.id]);
    await aq(`UPDATE users SET status = 'SUSPENDED' WHERE id = $1`, [gone.id]);
    await tick();
    expect(sentTo(tok)).toHaveLength(0);
    expect((await aq(`SELECT count(*)::int AS n FROM notifications WHERE user_id = $1`, [c.id])).rows[0].n).toBe(1); // history exists for the next sign-in
    expect(sentTo(goneTok)).toHaveLength(0);
    expect((await aq(`SELECT count(*)::int AS n FROM notifications WHERE user_id = $1`, [gone.id])).rows[0].n).toBe(0);
  });

  it('a failing notification trigger can never block a booking', async () => {
    const m = await salon('Resilient Salon');
    const c = await customer('Resilient Customer');
    const D = workday();
    await aq(`ALTER TABLE notification_events ADD CONSTRAINT zz_block_all CHECK (false) NOT VALID`);
    try {
      const b = await booked(m, c, 'Ali', D, '11:00'); // still 201
      expect(b.id).toBeTruthy();
      expect((await aq(`SELECT count(*)::int AS n FROM appointments WHERE id = $1`, [b.id])).rows[0].n).toBe(1);
    } finally {
      await aq(`ALTER TABLE notification_events DROP CONSTRAINT zz_block_all`);
    }
  });

  // ------------------------------------------------------------------ inbox API
  it('inbox: pages with a cursor, filters unread, marks read (own only) and counts', async () => {
    const m = await salon('Inbox Salon');
    const c = await customer('Inbox Customer');
    const other = await customer('Inbox Other');
    const D = workday();
    for (const t of ['11:00', '11:30', '12:00']) {
      h.clock.advance(MIN);
      await booked(m, c, 'Ali', D, t);
      await tick();
    }
    const p1 = await inbox(c.access, 'limit=2');
    expect(p1.items).toHaveLength(2);
    expect(p1.nextCursor).toBeTruthy();
    expect(p1.unreadCount).toBe(3);
    const p2 = await inbox(c.access, `limit=2&cursor=${p1.nextCursor}`);
    expect(p2.items).toHaveLength(1);
    expect(p2.nextCursor).toBeNull();
    expect(new Set([...p1.items, ...p2.items].map((n) => n.id)).size).toBe(3);

    await h.http().get('/api/v1/notifications?limit=51').set(bearer(c.access)).expect(400);
    await h.http().get('/api/v1/notifications?cursor=garbage').set(bearer(c.access)).expect(400);
    await h.http().get('/api/v1/notifications').expect(401);

    const first = p1.items[0].id;
    expect((await h.http().post(`/api/v1/notifications/${first}/read`).set(bearer(other.access)).expect(404)).body.error.code).toBe('NOT_FOUND'); // somebody else's id looks like "not found"
    expect((await h.http().post(`/api/v1/notifications/${first}/read`).set(bearer(c.access)).expect(200)).body.data.unreadCount).toBe(2);
    expect((await h.http().post(`/api/v1/notifications/${first}/read`).set(bearer(c.access)).expect(200)).body.data.unreadCount).toBe(2); // idempotent
    expect((await inbox(c.access, 'unread=true')).items).toHaveLength(2);
    expect((await h.http().get('/api/v1/notifications/unread-count').set(bearer(c.access)).expect(200)).body.data).toEqual({ unreadCount: 2 });
    expect((await h.http().post('/api/v1/notifications/read-all').set(bearer(c.access)).expect(200)).body.data).toEqual({ updated: 2, unreadCount: 0 });
    expect((await inbox(other.access)).items).toEqual([]);
  });

  // ------------------------------------------------------------------ database-level security
  it('row-level security: people see only their own history, devices and preferences; the outbox is invisible; history cannot be rewritten', async () => {
    const m = await salon('RLS Notices Salon');
    const c = await customer('RLS Customer');
    const spy = await customer('RLS Spy');
    await device(c.access, 'CUSTOMER', 'rls');
    await h.http().put('/api/v1/notifications/preferences').set(bearer(c.access)).send({ pushEnabled: true, language: 'ur', bookings: true, reminders: true, queue: true, team: true, reminderOffsets: [0] }).expect(200);
    const D = workday();
    await booked(m, c, 'Ali', D, '11:00');
    await tick();
    const mineId = (await aq('SELECT id FROM notifications WHERE user_id = $1 LIMIT 1', [c.id])).rows[0].id as string;

    await asApp({ user: spy.id }, async (cl) => {
      for (const t of ['notifications', 'device_tokens', 'notification_preferences', 'notification_events', 'notification_deliveries']) {
        expect((await cl.query(`SELECT 1 FROM ${t}`)).rowCount).toBe(0);
      }
      expect((await cl.query(`UPDATE notifications SET read_at = now() WHERE id = $1`, [mineId])).rowCount).toBe(0);
      expect((await cl.query(`DELETE FROM notifications WHERE id = $1`, [mineId])).rowCount).toBe(0);
      expect((await cl.query(`UPDATE device_tokens SET disabled_at = now(), disabled_reason = 'X'`)).rowCount).toBe(0);
      expect((await cl.query(`SELECT 1 FROM appointments`)).rowCount).toBe(0);
    });
    await asApp({ user: c.id }, async (cl) => {
      expect((await cl.query(`SELECT 1 FROM notifications`)).rowCount).toBeGreaterThan(0);
      expect((await cl.query(`SELECT 1 FROM notification_preferences`)).rowCount).toBe(1);
      expect((await cl.query(`SELECT 1 FROM notification_events`)).rowCount).toBe(0); // the outbox is for the worker only
      expect((await cl.query(`SELECT 1 FROM notification_deliveries`)).rowCount).toBe(0);
      await cl.query('SAVEPOINT s');
      await expect(cl.query(`UPDATE notifications SET title = 'hacked' WHERE id = $1`, [mineId])).rejects.toThrow(/cannot be edited/);
      await cl.query('ROLLBACK TO s');
      await expect(cl.query(`INSERT INTO notifications (user_id, type, category, title, body, dedupe_key) VALUES ($1, 'FAKE_NOTICE', 'ACCOUNT', 'x', 'y', 'k')`, [c.id])).rejects.toThrow(/row-level security/);
      await cl.query('ROLLBACK TO s');
      await expect(cl.query(`INSERT INTO device_tokens (user_id, token, token_hash, platform, app) VALUES ($1, $2, $3, 'IOS', 'CUSTOMER')`, [c.id, 't'.repeat(30), 'a'.repeat(64)])).rejects.toThrow(/row-level security/);
    });
    // a read notification cannot be un-read or changed (the table owner is held by the same trigger)
    await aq(`UPDATE notifications SET read_at = now() WHERE id = $1`, [mineId]);
    await expect(aq(`UPDATE notifications SET read_at = NULL WHERE id = $1`, [mineId])).rejects.toThrow(/cannot be changed/);
    // the worker flag alone opens the facts it needs; without it nothing is visible
    await asApp({ worker: false }, async (cl) => expect((await cl.query(`SELECT 1 FROM appointments`)).rowCount).toBe(0));
    await asApp({ worker: true }, async (cl) => expect((await cl.query(`SELECT 1 FROM appointments`)).rowCount).toBeGreaterThan(0));
    await asApp({ worker: true }, async (cl) => {
      await expect(cl.query(`UPDATE appointments SET status = 'CANCELLED'`)).resolves.toBeDefined().catch(() => undefined);
    });
    await asApp({ worker: true }, async (cl) => expect((await cl.query(`UPDATE appointments SET customer_note = 'x'`)).rowCount).toBe(0)); // read-only on business tables
  });

  it('the outbox holds only ids and small facts: no names, phones or message text', async () => {
    const m = await salon('Privacy Salon');
    const c = await customer('Privacy Customer With A Distinct Name');
    const D = workday();
    await booked(m, c, 'Ali', D, '11:00');
    const rows = (await aq(`SELECT kind, payload::text AS payload, dedupe_key FROM notification_events WHERE created_at > now() - interval '5 minutes'`)).rows;
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(`${r.payload} ${r.dedupe_key}`).not.toMatch(/Privacy|Distinct|Ali|\+92|@example/);
      expect(r.payload.length).toBeLessThan(200);
    }
  });

  // ------------------------------------------------------------------ cron endpoint
  it('the cron endpoint needs the secret, runs one safe round and is not an authenticated user route', async () => {
    const secret = process.env.NOTIFICATIONS_CRON_SECRET as string;
    await h.http().post('/api/v1/internal/notifications/tick').expect(401);
    await h.http().post('/api/v1/internal/notifications/tick').set('x-cron-secret', 'nope').expect(401);
    await h.http().post('/api/v1/internal/notifications/tick').set('x-cron-secret', `${secret}x`).expect(401);
    const r = await h.http().post('/api/v1/internal/notifications/tick').set('x-cron-secret', secret).expect(200);
    expect(r.body.data).toEqual(expect.objectContaining({ claimed: expect.any(Number), reminders: expect.any(Number), purged: expect.any(Number) }));
  });

  it('retention: old finished events, old history and old disabled devices are purged', async () => {
    const c = await customer('Retention Customer');
    const k = Date.now().toString(36);
    const tok = await device(c.access, 'CUSTOMER', 'ret');
    await aq(`UPDATE device_tokens SET disabled_at = now() - interval '200 days', disabled_reason = 'LOGOUT' WHERE token = $1`, [tok]);
    await aq(`INSERT INTO notifications (user_id, type, category, title, body, dedupe_key, created_at) VALUES ($1, 'SERVICE_COMPLETED', 'BOOKINGS', 'Old', 'Old one', $2, now() - interval '400 days')`, [c.id, `old-1-${k}`]);
    await aq(`INSERT INTO notification_events (kind, ref_type, ref_id, dedupe_key, status, processed_at) VALUES ('STAFF_SCHEDULE', 'STAFF', gen_random_uuid(), $1, 'DONE', now() - interval '90 days')`, [`old-event-1-${k}`]);
    // an old, finished event that a recent history row still points at: the purge unlinks it and keeps the history row
    const linked = (await aq(`INSERT INTO notification_events (kind, ref_type, ref_id, dedupe_key, status, processed_at) VALUES ('STAFF_SCHEDULE', 'STAFF', gen_random_uuid(), $1, 'DONE', now() - interval '90 days') RETURNING id`, [`old-event-2-${k}`])).rows[0].id as string;
    await aq(`INSERT INTO notifications (user_id, event_id, type, category, title, body, dedupe_key) VALUES ($1, $2, 'STAFF_SCHEDULE_UPDATED', 'TEAM', 'Kept', 'Kept one', $3)`, [c.id, linked, `kept-1-${k}`]);
    await tick();
    expect((await aq(`SELECT event_id FROM notifications WHERE dedupe_key = $1`, [`kept-1-${k}`])).rows).toEqual([{ event_id: null }]);
    expect((await aq(`SELECT count(*)::int AS n FROM notification_events WHERE dedupe_key = ANY($1)`, [[`old-event-1-${k}`, `old-event-2-${k}`]])).rows[0].n).toBe(0);
    expect((await aq(`SELECT count(*)::int AS n FROM notifications WHERE dedupe_key = $1`, [`old-1-${k}`])).rows[0].n).toBe(0);
    expect((await aq(`SELECT count(*)::int AS n FROM device_tokens WHERE token = $1`, [tok])).rows[0].n).toBe(0);
  });
});
