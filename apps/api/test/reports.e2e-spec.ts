import { Pool, PoolClient } from 'pg';
import sharp from 'sharp';
import { hotp, base32Decode, timeStep } from '../src/modules/auth/totp';
import { slotMs } from '../src/modules/booking/booking.types';
import { todayKarachi } from '../src/modules/billing/billing.types';
import { addDaysIso } from '../src/modules/discovery/discovery.types';
import { Harness, bearer, createHarness, createPlatformUser, dbEnabled, loginMobile, registerAndVerify, lastToken, uniqueEmail, GOOD_PASSWORD } from './support/harness';

const d = dbEnabled ? describe : describe.skip;
if (!dbEnabled) {
  // eslint-disable-next-line no-console
  console.warn('SKIPPED reports e2e: set TEST_DATABASE_URL (salon_app) and TEST_ADMIN_DATABASE_URL (salon_migrator).');
}

const totp = (secretB32: string, h: Harness) => hotp(base32Decode(secretB32), timeStep(h.clock.now().getTime()));
const png = () => sharp({ create: { width: 600, height: 400, channels: 3, background: '#40a0c0' } }).png().toBuffer();
const WEEK = [1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, closed: false, opensAt: '10:00', closesAt: '21:00' })).concat([{ weekday: 7, closed: true } as never]);
const STAFF_WEEK = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, off: false, startsAt: '10:00', endsAt: '18:00' })).concat([{ weekday: 6, off: true }, { weekday: 7, off: true }] as never[]);
let cityCounter = 0;
const uniqueCity = () => `Reportville${Date.now().toString(36)}${cityCounter++}`;
let keyCounter = 0;
const idemKey = () => `report-key-${Date.now().toString(36)}-${keyCounter++}`;

type Status = 'COMPLETED' | 'CANCELLED' | 'NO_SHOW';
interface Line { id: string; name: string; minutes: number; price: number }

d('Phase 13: reports, expenses and platform analytics (real PostgreSQL)', () => {
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
  const ctxSql = `SELECT set_config('app.user_id',$1,true), set_config('app.salon_id',$2,true), set_config('app.is_platform_admin',$3,true), set_config('app.public_read',$4,true)`;
  /** Runs as the least-privilege app role and ROLLS BACK (for probes that must not change anything). */
  async function asApp<T>(ctx: { user?: string; salon?: string; admin?: boolean; publicRead?: boolean }, fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await appPool.connect();
    try {
      await c.query('BEGIN');
      await c.query(ctxSql, [ctx.user ?? '', ctx.salon ?? '', ctx.admin ? 'true' : 'false', ctx.publicRead ? 'true' : 'false']);
      return await fn(c);
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  }
  /** Runs as the least-privilege app role and COMMITS (test data setup that goes through the real database rules). */
  async function commitAs<T>(ctx: { user: string; salon: string }, fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await appPool.connect();
    try {
      await c.query('BEGIN');
      await c.query(ctxSql, [ctx.user, ctx.salon, 'false', 'false']);
      const r = await fn(c);
      await c.query('COMMIT');
      return r;
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  }
  async function platform(role: 'SUPER_ADMIN' | 'SUPPORT' | 'FINANCE') {
    const u = await createPlatformUser(h, role);
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
    return { ...u, access, id };
  }
  const mine = (t: string) => ({
    get: (p: string) => h.http().get(`/api/v1/salons/mine${p}`).set(bearer(t)),
    post: (p: string, b: object = {}) => h.http().post(`/api/v1/salons/mine${p}`).set(bearer(t)).send(b),
    put: (p: string, b: object) => h.http().put(`/api/v1/salons/mine${p}`).set(bearer(t)).send(b),
    patch: (p: string, b: object) => h.http().patch(`/api/v1/salons/mine${p}`).set(bearer(t)).send(b),
    del: (p: string) => h.http().delete(`/api/v1/salons/mine${p}`).set(bearer(t)),
  });
  const upload = (token: string, kind: string, docType: string, buf: Buffer) =>
    h.http().post('/api/v1/salons/mine/files').set(bearer(token)).field('kind', kind).field('docType', docType).attach('file', buf, 'x.png');
  const today = () => todayKarachi(h.clock.now());
  const ago = (days: number) => addDaysIso(today(), -days);

  interface Made { o: Awaited<ReturnType<typeof owner>>; ownerId: string; salonId: string; city: string; staff: Record<string, string>; services: Record<string, Line>; a: ReturnType<typeof mine> }
  /** An APPROVED salon: Ali + Ahmed, Haircut (Ali 300 / Ahmed 500, 30 min), Beard Trim (150, 15 min, Ali only). */
  async function salon(name: string): Promise<Made> {
    const adminToken = await platform('SUPER_ADMIN');
    const o = await owner();
    const a = mine(o.access);
    const city = uniqueCity();
    const salonId = (await h.http().post('/api/v1/salons').set(bearer(o.access)).send({
      name, salonType: 'UNISEX', city, area: 'Central', addressLine: '12 Main Boulevard, Central', phone: '0300 1234567',
    }).expect(201)).body.data.salon.id as string;
    await a.put('/opening-hours', { days: WEEK }).expect(200);
    const staff: Record<string, string> = {};
    for (const n of ['Ali', 'Ahmed']) {
      const id = (await a.post('/team', { displayName: n }).expect(201)).body.data.id as string;
      staff[n] = id;
      await a.put(`/team/${id}/working-hours`, { days: STAFF_WEEK }).expect(200);
    }
    const hair = (await a.post('/categories', { name: 'Hair' }).expect(201)).body.data.id as string;
    const haircut = (await a.post('/services', { categoryId: hair, name: 'Haircut', durationMinutes: 30, pricing: { mode: 'STAFF_BASED' }, staff: [{ staffId: staff.Ali, price: 300 }, { staffId: staff.Ahmed, price: 500 }] }).expect(201)).body.data.id as string;
    const beard = (await a.post('/services', { categoryId: hair, name: 'Beard Trim', durationMinutes: 15, pricing: { mode: 'FIXED', price: 150 }, staff: [{ staffId: staff.Ali }] }).expect(201)).body.data.id as string;
    await upload(o.access, 'DOCUMENT', 'CNIC_FRONT', await png()).expect(201);
    await upload(o.access, 'DOCUMENT', 'CNIC_BACK', await png()).expect(201);
    await upload(o.access, 'PHOTO', 'COVER', await png()).expect(201);
    await a.post('/submit').expect(200);
    await h.http().post(`/api/v1/admin/salons/${salonId}/approve`).set(bearer(adminToken)).expect(200);
    const ownerId = (await aq('SELECT owner_user_id FROM salons WHERE id = $1', [salonId])).rows[0].owner_user_id as string;
    return {
      o, ownerId, salonId, city, staff, a,
      services: { Haircut: { id: haircut, name: 'Haircut', minutes: 30, price: 0 }, Beard: { id: beard, name: 'Beard Trim', minutes: 15, price: 150 } },
    };
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

  /** Writes a finished appointment of `daysAgo` days ago at 11:00 Karachi through the real database rules (guards, RLS, totals check). */
  async function seed(m: Made, o: { staff: 'Ali' | 'Ahmed'; status: Status; daysAgo: number; customerId: string; lines: Line[]; cancelledBy?: 'CUSTOMER' | 'SALON' }) {
    const minutes = o.lines.reduce((s, l) => s + l.minutes, 0);
    const price = o.lines.reduce((s, l) => s + l.price, 0);
    const start = slotMs(ago(o.daysAgo), 11 * 60);
    const startsAt = new Date(start);
    const endsAt = new Date(start + minutes * 60_000);
    await commitAs({ user: m.ownerId, salon: m.salonId }, async (c) => {
      const r = await c.query(
        `INSERT INTO appointments (salon_id, customer_user_id, staff_id, status, source, starts_at, ends_at, buffer_minutes, blocked_until, total_duration_minutes, total_price,
                                   salon_name, staff_name, started_at, completed_at, no_show_at, cancelled_at, cancelled_by, cancelled_by_role)
         VALUES ($1, $2, $3, $4::appointment_status, 'ONLINE', $5, $6, 0, $6, $7, $8, 'Seeded Salon', $9,
                 CASE WHEN $4 = 'COMPLETED' THEN $5::timestamptz END, CASE WHEN $4 = 'COMPLETED' THEN $6::timestamptz END,
                 CASE WHEN $4 = 'NO_SHOW' THEN $6::timestamptz END,
                 CASE WHEN $4 = 'CANCELLED' THEN $5::timestamptz - interval '1 day' END, CASE WHEN $4 = 'CANCELLED' THEN $11::uuid ELSE NULL END,
                 CASE WHEN $4 = 'CANCELLED' THEN $10 END)
         RETURNING id`,
        [m.salonId, o.customerId, m.staff[o.staff], o.status, startsAt, endsAt, minutes, price, o.staff, o.cancelledBy ?? null, m.ownerId],
      );
      let pos = 1;
      for (const l of o.lines) {
        await c.query(
          `INSERT INTO appointment_services (salon_id, appointment_id, service_id, position, service_name, duration_minutes, price) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [m.salonId, r.rows[0].id, l.id, pos, l.name, l.minutes, l.price],
        );
        pos += 1;
      }
    });
  }

  /** A walk-in that was served a few hours ago (written through the same offline-sync window the app uses). */
  async function seedWalkIn(m: Made, staff: 'Ali' | 'Ahmed', line: Line) {
    await commitAs({ user: m.ownerId, salon: m.salonId }, async (c) => {
      await c.query(`SELECT set_config('app.offline_sync', 'on', true)`);
      const r = await c.query(
        `INSERT INTO appointments (salon_id, customer_user_id, staff_id, status, source, walk_in_name, starts_at, ends_at, buffer_minutes, blocked_until,
                                   total_duration_minutes, total_price, salon_name, staff_name)
         VALUES ($1, NULL, $2, 'CONFIRMED', 'WALK_IN', 'Seed Walkin', now() - interval '5 hours', now() - interval '5 hours' + ($3 || ' minutes')::interval, 0,
                 now() - interval '5 hours' + ($3 || ' minutes')::interval, $3::int, $4::numeric, 'Seeded Salon', $5) RETURNING id`,
        [m.salonId, m.staff[staff], String(line.minutes), line.price, staff],
      );
      const id = r.rows[0].id as string;
      await c.query(`INSERT INTO appointment_services (salon_id, appointment_id, service_id, position, service_name, duration_minutes, price) VALUES ($1, $2, $3, 1, $4, $5, $6)`,
        [m.salonId, id, line.id, line.name, line.minutes, line.price]);
      await c.query(`UPDATE appointments SET status = 'IN_PROGRESS', started_at = starts_at WHERE id = $1`, [id]);
      await c.query(`UPDATE appointments SET status = 'COMPLETED', completed_at = ends_at WHERE id = $1`, [id]);
    });
  }

  const Haircut = (price: number): Line => ({ id: '', name: 'Haircut', minutes: 30, price });
  const withIds = (m: Made, l: Line): Line => ({ ...l, id: l.name === 'Haircut' ? m.services.Haircut.id : m.services.Beard.id });
  const R = (from: number, to = 0) => `from=${ago(from)}&to=${ago(to)}`;

  /** Salon A with a known history (see the expectations in the tests). */
  let A: Made;
  let B: Made;
  let ali: Awaited<ReturnType<typeof staffAccount>>;
  let ahmed: Awaited<ReturnType<typeof staffAccount>>;
  let c1: Awaited<ReturnType<typeof customer>>;
  let c2: Awaited<ReturnType<typeof customer>>;
  let c3: Awaited<ReturnType<typeof customer>>;
  let finance: string;
  let support: string;
  let superAdmin: string;

  beforeAll(async () => {
    superAdmin = await platform('SUPER_ADMIN');
    finance = await platform('FINANCE');
    support = await platform('SUPPORT');
    A = await salon('Report Salon A');
    B = await salon('Report Salon B');
    c1 = await customer('Reports One');
    c2 = await customer('Reports Two');
    c3 = await customer('Reports Three');
    ali = await staffAccount(A, 'Ali');
    ahmed = await staffAccount(A, 'Ahmed');
    const hc = (price: number) => withIds(A, Haircut(price));
    const beard = withIds(A, { id: '', name: 'Beard Trim', minutes: 15, price: 150 });
    // before the 20-day window (the "previous period"): c1's first visit
    await seed(A, { staff: 'Ali', status: 'COMPLETED', daysAgo: 30, customerId: c1.id, lines: [hc(300)] });
    // inside the window
    await seed(A, { staff: 'Ali', status: 'COMPLETED', daysAgo: 1, customerId: c1.id, lines: [hc(300)] });
    await seed(A, { staff: 'Ali', status: 'COMPLETED', daysAgo: 2, customerId: c1.id, lines: [hc(300), beard] });
    await seed(A, { staff: 'Ahmed', status: 'COMPLETED', daysAgo: 3, customerId: c2.id, lines: [hc(500)] });
    await seed(A, { staff: 'Ali', status: 'CANCELLED', daysAgo: 4, customerId: c2.id, lines: [hc(300)], cancelledBy: 'CUSTOMER' });
    await seed(A, { staff: 'Ahmed', status: 'NO_SHOW', daysAgo: 5, customerId: c3.id, lines: [hc(500)] });
    await seed(A, { staff: 'Ali', status: 'CANCELLED', daysAgo: 6, customerId: c3.id, lines: [hc(300)], cancelledBy: 'SALON' });
    await seedWalkIn(A, 'Ali', beard);
    // expenses through the API
    await A.a.post('/expenses', { category: 'RENT', amount: '500', expenseDate: ago(3) }).expect(201);
    await A.a.post('/expenses', { category: 'SUPPLIES', amount: '120.5', expenseDate: ago(1), description: 'Shampoo' }).expect(201);
    // salon B has one completed appointment and its own expense (must never leak into A)
    await seed(B, { staff: 'Ali', status: 'COMPLETED', daysAgo: 1, customerId: c1.id, lines: [withIds(B, Haircut(300))] });
    await B.a.post('/expenses', { category: 'RENT', amount: '9999', expenseDate: ago(2) }).expect(201);
  });

  // ------------------------------------------------------------------ numbers
  it('summary: counts, revenue, rates, expenses, net and the comparison with the previous period', async () => {
    const r = (await A.a.get(`/reports/summary?${R(19)}`).expect(200)).body.data;
    expect(r.currency).toBe('PKR');
    expect(r.range).toEqual({ from: ago(19), to: ago(0), days: 20 });
    expect(r.appointments).toEqual({ total: 7, completed: 4, cancelled: 2, noShow: 1, open: 0, walkIn: 1, online: 6, cancelledByCustomer: 1, cancelledBySalon: 1 });
    expect(r.revenue).toMatchObject({ total: '1400.00', online: '1250.00', walkIn: '150.00', averageTicket: '350.00', avgServiceMinutes: 30 });
    expect(r.rates).toEqual({ resolved: 7, completionRate: 57.1, cancellationRate: 28.6, noShowRate: 14.3 });
    expect(r.expenses).toEqual({ total: '620.50', count: 2 });
    expect(r.net).toBe('779.50');
    expect(r.previous).toMatchObject({ completed: 1, revenue: '300.00', expenses: '0.00', net: '300.00', revenueChangePct: 366.7, completedChangePct: 300 });
    expect(r.previous.range.to).toBe(ago(20));
    // money is always text, never a float
    expect(typeof r.revenue.total).toBe('string');
    expect(typeof r.net).toBe('string');
  });

  it('only COMPLETED appointments earn money: cancelled and no-show never add revenue', async () => {
    const r = (await A.a.get(`/reports/summary?from=${ago(6)}&to=${ago(4)}`).expect(200)).body.data; // D-6 (cancelled), D-5 (no-show), D-4 (cancelled)
    expect(r.appointments).toMatchObject({ total: 3, completed: 0, cancelled: 2, noShow: 1 });
    expect(r.revenue.total).toBe('0.00');
    expect(r.revenue.averageTicket).toBeNull();
    expect(r.rates).toMatchObject({ completionRate: 0, cancellationRate: 66.7, noShowRate: 33.3 });
  });

  it('trend: zero-filled buckets, the sums match the summary, expenses are placed on their day', async () => {
    const t = (await A.a.get(`/reports/trend?${R(6)}`).expect(200)).body.data;
    expect(t.group).toBe('day');
    expect(t.points).toHaveLength(7);
    expect(t.points.map((p: { bucket: string }) => p.bucket)).toEqual([6, 5, 4, 3, 2, 1, 0].map(ago));
    const sum = (k: string) => t.points.reduce((acc: number, p: Record<string, unknown>) => acc + Number(p[k]), 0);
    expect(sum('total')).toBe(7);
    expect(sum('completed')).toBe(4);
    expect(sum('cancelled')).toBe(2);
    expect(sum('noShow')).toBe(1);
    expect(sum('walkIn')).toBe(1);
    expect(sum('revenue')).toBe(1400);
    expect(sum('expenses')).toBe(620.5);
    const byDay = Object.fromEntries(t.points.map((p: { bucket: string }) => [p.bucket, p]));
    expect(byDay[ago(3)].expenses).toBe('500.00');
    expect(byDay[ago(2)].revenue).toBe('450.00');
    expect(byDay[ago(6)].total).toBe(1);
    // week and month buckets cover the same range and the same totals
    const w = (await A.a.get(`/reports/trend?${R(19)}&group=week`).expect(200)).body.data;
    expect(w.group).toBe('week');
    expect(w.points.reduce((a: number, p: { revenue: string }) => a + Number(p.revenue), 0)).toBe(1400);
    const mo = (await A.a.get(`/reports/trend?${R(19)}&group=month`).expect(200)).body.data;
    expect(mo.points.reduce((a: number, p: { total: number }) => a + p.total, 0)).toBe(7);
  });

  it('staff-wise: every staff member with their own completed, no-show, walk-in and revenue figures', async () => {
    const r = (await A.a.get(`/reports/staff?${R(19)}`).expect(200)).body.data;
    expect(r.items.map((x: { name: string }) => x.name)).toEqual(['Ali', 'Ahmed']); // by revenue
    const [a, b] = r.items;
    expect(a).toMatchObject({ staffId: A.staff.Ali, total: 5, completed: 3, cancelled: 2, noShow: 0, walkIn: 1, revenue: '900.00', averageTicket: '300.00', revenueSharePct: 64.3, isActive: true });
    expect(b).toMatchObject({ staffId: A.staff.Ahmed, total: 2, completed: 1, cancelled: 0, noShow: 1, walkIn: 0, revenue: '500.00', revenueSharePct: 35.7 });
    expect(Number(a.revenue) + Number(b.revenue)).toBe(1400);
  });

  it('popular services use the price and name on the booking, completed appointments only', async () => {
    const r = (await A.a.get(`/reports/services?${R(19)}`).expect(200)).body.data;
    expect(r.items).toEqual([
      { serviceId: A.services.Haircut.id, name: 'Haircut', times: 3, revenue: '1100.00' },
      { serviceId: A.services.Beard.id, name: 'Beard Trim', times: 2, revenue: '300.00' },
    ]);
    const one = (await A.a.get(`/reports/services?${R(19)}&limit=1`).expect(200)).body.data;
    expect(one.items).toHaveLength(1);
  });

  it('retention: new versus returning customers (walk-ins are visits without an account)', async () => {
    const r = (await A.a.get(`/reports/retention?${R(19)}`).expect(200)).body.data;
    expect(r.customers).toEqual({ served: 2, new: 1, returning: 1, returningRatePct: 50 });
    expect(r.visits).toEqual({ byCustomers: 3, avgPerCustomer: 1.5, walkIns: 1 });
  });

  it('expense report by category with shares', async () => {
    const r = (await A.a.get(`/reports/expenses?${R(19)}`).expect(200)).body.data;
    expect(r.total).toBe('620.50');
    expect(r.byCategory).toEqual([
      { category: 'RENT', total: '500.00', count: 1, sharePct: 80.6 },
      { category: 'SUPPLIES', total: '120.50', count: 1, sharePct: 19.4 },
    ]);
  });

  it('the default range is the last 30 days and an empty period answers zeros, not errors', async () => {
    const r = (await A.a.get('/reports/summary').expect(200)).body.data;
    expect(r.range.days).toBe(30);
    const empty = (await A.a.get(`/reports/summary?from=${ago(400 - 60)}&to=${ago(400 - 70)}`).expect(200)).body.data;
    expect(empty.appointments.total).toBe(0);
    expect(empty.revenue.total).toBe('0.00');
    expect(empty.rates.completionRate).toBeNull();
    expect(empty.previous.revenueChangePct).toBeNull();
  });

  // ------------------------------------------------------------------ input validation
  it('rejects bad ranges, groups and limits with a clear 400', async () => {
    const bad = (p: string) => A.a.get(p).expect(400);
    await bad('/reports/summary?from=2026-13-40');
    await bad('/reports/summary?from=yesterday');
    await bad(`/reports/summary?to=${addDaysIso(today(), 1)}`);
    await bad(`/reports/summary?from=${ago(1)}&to=${ago(5)}`);
    await bad(`/reports/summary?from=${ago(400)}&to=${ago(0)}`);
    await bad(`/reports/trend?${R(120)}&group=day`);
    await bad(`/reports/trend?${R(10)}&group=year`);
    await bad('/reports/services?limit=0');
    await bad('/reports/services?limit=51');
    await bad(`/reports/summary?${R(5)}&salonId=${B.salonId}`); // unknown parameters are refused (no mass assignment)
    await bad(`/reports/staff?staffId=${B.staff.Ali}`);
    const err = (await A.a.get(`/reports/summary?to=${addDaysIso(today(), 1)}`).expect(400)).body.error;
    expect(err.code).toBe('VALIDATION_FAILED');
    expect(err.requestId).toBeTruthy();
  });

  // ------------------------------------------------------------------ tenant isolation
  it('salon B sees nothing of salon A: not its appointments, revenue, staff, services, customers or expenses', async () => {
    const s = (await B.a.get(`/reports/summary?${R(19)}`).expect(200)).body.data;
    expect(s.appointments.total).toBe(1);
    expect(s.revenue.total).toBe('300.00');
    expect(s.expenses.total).toBe('9999.00');
    const staff = (await B.a.get(`/reports/staff?${R(19)}`).expect(200)).body.data;
    expect(staff.items.map((x: { staffId: string }) => x.staffId).sort()).toEqual([B.staff.Ali, B.staff.Ahmed].sort());
    for (const x of staff.items) expect([A.staff.Ali, A.staff.Ahmed]).not.toContain(x.staffId);
    const sv = (await B.a.get(`/reports/services?${R(19)}`).expect(200)).body.data;
    expect(sv.items).toEqual([{ serviceId: B.services.Haircut.id, name: 'Haircut', times: 1, revenue: '300.00' }]);
    const list = (await B.a.get(`/expenses?${R(19)}`).expect(200)).body.data;
    expect(list.items.map((e: { amount: string }) => e.amount)).toEqual(['9999.00']);
    // and the other way round
    const a = (await A.a.get(`/expenses?${R(19)}`).expect(200)).body.data;
    expect(a.items.map((e: { amount: string }) => e.amount).sort()).toEqual(['120.50', '500.00']);
  });

  it('an owner cannot change or delete another salon\'s expense (404, nothing happens)', async () => {
    const theirs = (await B.a.get(`/expenses?${R(19)}`).expect(200)).body.data.items[0].id as string;
    await A.a.patch(`/expenses/${theirs}`, { amount: '1' }).expect(404);
    await A.a.del(`/expenses/${theirs}`).expect(404);
    const still = (await B.a.get(`/expenses?${R(19)}`).expect(200)).body.data.items[0];
    expect(still.amount).toBe('9999.00');
    expect((await asApp({ user: B.ownerId, salon: B.salonId }, (c) => c.query('SELECT deleted_at FROM salon_expenses WHERE id = $1', [theirs]))).rows[0].deleted_at).toBeNull();
  });

  // ------------------------------------------------------------------ staff privacy
  it('a staff member sees ONLY their own performance: no colleagues, no expenses, no customers', async () => {
    const a = (await h.http().get(`/api/v1/staff/me/reports/performance?${R(19)}`).set(bearer(ali.access)).expect(200)).body.data;
    expect(a.staff).toEqual({ id: A.staff.Ali, name: 'Ali' });
    expect(a.appointments).toMatchObject({ total: 5, completed: 3, cancelled: 2, noShow: 0, walkIn: 1 });
    expect(a.revenue).toMatchObject({ total: '900.00', averageTicket: '300.00' });
    expect(a.topServices.map((s: { name: string }) => s.name)).toEqual(['Haircut', 'Beard Trim']);
    const text = JSON.stringify(a);
    for (const forbidden of ['expenses', 'expense', 'Ahmed', 'customer', c1.id, A.salonId]) expect(text).not.toContain(forbidden);
    expect(a.points.every((p: Record<string, unknown>) => !('expenses' in p))).toBe(true);

    const b = (await h.http().get(`/api/v1/staff/me/reports/performance?${R(19)}`).set(bearer(ahmed.access)).expect(200)).body.data;
    expect(b.staff.name).toBe('Ahmed');
    expect(b.appointments).toMatchObject({ total: 2, completed: 1, noShow: 1 });
    expect(b.revenue.total).toBe('500.00');
  });

  it('a staff member cannot pick another staff member, reach owner reports, or touch expenses', async () => {
    const S = (p: string) => h.http().get(`/api/v1${p}`).set(bearer(ali.access));
    await S(`/staff/me/reports/performance?staffId=${A.staff.Ahmed}`).expect(400);
    await S(`/staff/me/reports/performance?salonId=${B.salonId}`).expect(400);
    for (const p of ['summary', 'trend', 'staff', 'services', 'retention', 'expenses']) await S(`/salons/mine/reports/${p}`).expect(403);
    await S('/salons/mine/expenses').expect(403);
    await h.http().post('/api/v1/salons/mine/expenses').set(bearer(ali.access)).send({ category: 'RENT', amount: '1', expenseDate: ago(1) }).expect(403);
    await S('/admin/analytics/overview').expect(403);
  });

  it('a deactivated staff member loses the report', async () => {
    const m = await salon('Deactivated Reports Salon');
    const st = await staffAccount(m, 'Ali');
    await h.http().get('/api/v1/staff/me/reports/performance').set(bearer(st.access)).expect(200);
    await m.a.patch(`/team/${m.staff.Ali}`, { isActive: false });
    await aq('SELECT 1');
    const r = await h.http().get('/api/v1/staff/me/reports/performance').set(bearer(st.access));
    expect([401, 403, 404]).toContain(r.status);
  });

  // ------------------------------------------------------------------ roles
  it('customers, platform roles and anonymous callers cannot read salon reports or expenses', async () => {
    const paths = ['/salons/mine/reports/summary', '/salons/mine/reports/staff', '/salons/mine/expenses', '/staff/me/reports/performance'];
    for (const p of paths) {
      await h.http().get(`/api/v1${p}`).expect(401);
      await h.http().get(`/api/v1${p}`).set(bearer(c1.access)).expect(403);
      await h.http().get(`/api/v1${p}`).set(bearer(superAdmin)).expect(403); // the platform never reads a salon's money
      await h.http().get(`/api/v1${p}`).set(bearer(finance)).expect(403);
    }
    await h.http().post('/api/v1/salons/mine/expenses').set(bearer(superAdmin)).send({ category: 'RENT', amount: '1', expenseDate: ago(1) }).expect(403);
  });

  it('platform analytics: Super Admin, Support and Finance may read; owners, staff, customers and anonymous may not', async () => {
    for (const t of [superAdmin, support, finance]) await h.http().get('/api/v1/admin/analytics/overview').set(bearer(t)).expect(200);
    for (const p of ['overview', 'trend', 'cities']) {
      await h.http().get(`/api/v1/admin/analytics/${p}`).expect(401);
      for (const t of [A.o.access, ali.access, c1.access]) await h.http().get(`/api/v1/admin/analytics/${p}`).set(bearer(t)).expect(403);
    }
  });

  // ------------------------------------------------------------------ expenses
  it('expense validation: amounts, dates, categories, descriptions and unknown fields', async () => {
    const post = (b: object, key?: string) => { const r = h.http().post('/api/v1/salons/mine/expenses').set(bearer(A.o.access)); return (key ? r.set('Idempotency-Key', key) : r).send(b); };
    const ok = { category: 'UTILITIES', amount: '1000', expenseDate: ago(1) };
    for (const amount of ['0', '0.00', '-5', '1.234', '1e3', 'abc', '1,500', '100000000.01', '']) await post({ ...ok, amount }).expect(400);
    await post({ ...ok, expenseDate: addDaysIso(today(), 1) }).expect(400); // future
    await post({ ...ok, expenseDate: '2019-12-31' }).expect(400);
    await post({ ...ok, expenseDate: '2026-02-30' }).expect(400);
    await post({ ...ok, category: 'FUN' }).expect(400);
    await post({ ...ok, category: 'OTHER' }).expect(400); // needs a description
    await post({ ...ok, description: '<script>alert(1)</script>' }).expect(400);
    await post({ ...ok, description: 'x'.repeat(201) }).expect(400);
    await post({ ...ok, salonId: B.salonId }).expect(400); // mass assignment
    await post({ ...ok, createdBy: A.ownerId }).expect(400);
    await post({ ...ok }, 'short').expect(400); // malformed Idempotency-Key
    await post({ category: 'OTHER', amount: '10.5', expenseDate: ago(0), description: 'Tea for customers' }).expect(201);
    expect((await asApp({ user: A.ownerId, salon: A.salonId }, (c) => c.query(`SELECT count(*)::int AS n FROM salon_expenses WHERE amount = 1000`))).rows[0].n).toBe(0);
  });

  it('create is idempotent: a retry with the same key never records twice; the same key with other data is a 409', async () => {
    const key = idemKey();
    const body = { category: 'MARKETING', amount: '2500', expenseDate: ago(2), description: 'Flyers' };
    const first = (await h.http().post('/api/v1/salons/mine/expenses').set(bearer(B.o.access)).set('Idempotency-Key', key).send(body).expect(201)).body.data;
    const again = (await h.http().post('/api/v1/salons/mine/expenses').set(bearer(B.o.access)).set('Idempotency-Key', key).send({ ...body, amount: '2500.00' }).expect(201)).body.data;
    expect(first.replayed).toBe(false);
    expect(again.replayed).toBe(true);
    expect(again.expense.id).toBe(first.expense.id);
    await h.http().post('/api/v1/salons/mine/expenses').set(bearer(B.o.access)).set('Idempotency-Key', key).send({ ...body, amount: '2600' }).expect(409);
    const countKey = async (k: string) => (await asApp({ user: B.ownerId, salon: B.salonId }, (c) => c.query(`SELECT count(*)::int AS n FROM salon_expenses WHERE salon_id = $1 AND idempotency_key = $2`, [B.salonId, k]))).rows[0].n;
    expect(await countKey(key)).toBe(1);
    // two identical requests at the same moment still produce ONE row
    const key2 = idemKey();
    const both = await Promise.all([0, 1].map(() => h.http().post('/api/v1/salons/mine/expenses').set(bearer(B.o.access)).set('Idempotency-Key', key2).send(body)));
    expect(both.map((r) => r.status).sort()).toEqual([201, 201]);
    expect(await countKey(key2)).toBe(1);
    // the same key in ANOTHER salon is a different expense
    const other = (await h.http().post('/api/v1/salons/mine/expenses').set(bearer(A.o.access)).set('Idempotency-Key', key).send(body).expect(201)).body.data;
    expect(other.replayed).toBe(false);
    expect(other.expense.id).not.toBe(first.expense.id);
  });

  it('update, soft delete, audit trail and reports stay consistent', async () => {
    const m = await salon('Expense Lifecycle Salon');
    const created = (await m.a.post('/expenses', { category: 'EQUIPMENT', amount: '800', expenseDate: ago(1) }).expect(201)).body.data.expense;
    const patched = (await m.a.patch(`/expenses/${created.id}`, { amount: '950.25', category: 'OTHER', description: 'Hair dryer' }).expect(200)).body.data;
    expect(patched).toMatchObject({ amount: '950.25', category: 'OTHER', description: 'Hair dryer' });
    await m.a.patch(`/expenses/${created.id}`, {}).expect(400);
    await m.a.patch(`/expenses/${created.id}`, { description: null }).expect(400); // OTHER needs a description
    await m.a.patch(`/expenses/${created.id}`, { expenseDate: addDaysIso(today(), 2) }).expect(400);
    await m.a.patch(`/expenses/${created.id}`, { salonId: B.salonId }).expect(400);
    expect((await m.a.get(`/reports/summary?${R(5)}`).expect(200)).body.data.expenses.total).toBe('950.25');

    await m.a.del(`/expenses/${created.id}`).expect(204);
    await m.a.del(`/expenses/${created.id}`).expect(404);
    await m.a.patch(`/expenses/${created.id}`, { amount: '1' }).expect(404);
    expect((await m.a.get(`/expenses?${R(5)}`).expect(200)).body.data.items).toHaveLength(0);
    expect((await m.a.get(`/reports/summary?${R(5)}`).expect(200)).body.data.expenses).toEqual({ total: '0.00', count: 0 });
    // the row is kept (soft delete) and every step is on the immutable audit log
    const row = (await asApp({ user: m.ownerId, salon: m.salonId }, (c) => c.query('SELECT deleted_at, deleted_by FROM salon_expenses WHERE id = $1', [created.id]))).rows[0];
    expect(row.deleted_at).not.toBeNull();
    expect(row.deleted_by).toBe(m.ownerId);
    const actions = (await aq(`SELECT action FROM audit_logs WHERE target_type = 'salon_expense' AND target_id = $1 ORDER BY created_at, id`, [created.id])).rows.map((r) => r.action);
    expect(actions).toEqual(['expense.created', 'expense.updated', 'expense.deleted']);
  });

  it('expense list: pagination, category filter and a total that matches', async () => {
    const m = await salon('Expense Paging Salon');
    for (let i = 0; i < 27; i += 1) await m.a.post('/expenses', { category: i % 3 === 0 ? 'RENT' : 'SUPPLIES', amount: '10', expenseDate: ago(i % 10) }).expect(201);
    const p1 = (await m.a.get(`/expenses?${R(29)}`).expect(200)).body.data;
    expect(p1).toMatchObject({ total: 27, sum: '270.00', page: 1, pageSize: 25 });
    expect(p1.items).toHaveLength(25);
    const p2 = (await m.a.get(`/expenses?${R(29)}&page=2`).expect(200)).body.data;
    expect(p2.items).toHaveLength(2);
    const rent = (await m.a.get(`/expenses?${R(29)}&category=RENT`).expect(200)).body.data;
    expect(rent.total).toBe(9);
    expect(rent.sum).toBe('90.00');
    const dates = p1.items.map((e: { expenseDate: string }) => e.expenseDate);
    expect([...dates].sort().reverse()).toEqual(dates); // newest first
    await m.a.get(`/expenses?${R(29)}&category=NOPE`).expect(400);
    await m.a.get(`/expenses?${R(29)}&page=0`).expect(400);
  });

  // ------------------------------------------------------------------ database rules (Row-Level Security and guards)
  it('salon_expenses is invisible to everyone except its owner, in the database itself', async () => {
    const count = (ctx: Parameters<typeof asApp>[0]) => asApp(ctx, async (c) => Number((await c.query('SELECT count(*)::int AS n FROM salon_expenses')).rows[0].n));
    expect(await count({ user: A.ownerId, salon: A.salonId })).toBeGreaterThanOrEqual(2);
    expect(await count({ user: B.ownerId, salon: B.salonId })).toBeGreaterThanOrEqual(1);
    // salon A's context cannot see salon B's rows and vice versa
    const mineOnly = await asApp({ user: A.ownerId, salon: A.salonId }, async (c) => (await c.query('SELECT DISTINCT salon_id FROM salon_expenses')).rows.map((r) => r.salon_id));
    expect(mineOnly).toEqual([A.salonId]);
    // an owner claiming ANOTHER salon's context sees nothing
    expect(await count({ user: A.ownerId, salon: B.salonId })).toBe(0);
    // staff of the salon, customers, the public context, a platform admin and a request without any context see nothing
    expect(await count({ user: ali.userId, salon: A.salonId })).toBe(0);
    expect(await count({ user: c1.id })).toBe(0);
    expect(await count({ publicRead: true })).toBe(0);
    expect(await count({ admin: true })).toBe(0);
    expect(await count({})).toBe(0);
  });

  it('the database refuses cross-salon writes, hard deletes and tampering with an expense', async () => {
    const insert = (ctx: { user: string; salon: string }, salonId: string, by: string) => asApp(ctx, (c) => c.query(
      `INSERT INTO salon_expenses (salon_id, category, amount, expense_date, created_by) VALUES ($1, 'RENT', 5, $2::date, $3)`, [salonId, ago(1), by]));
    await expect(insert({ user: A.ownerId, salon: A.salonId }, B.salonId, A.ownerId)).rejects.toThrow(/row-level security/); // into another salon
    await expect(insert({ user: A.ownerId, salon: A.salonId }, A.salonId, B.ownerId)).rejects.toThrow(/row-level security/); // pretending to be someone else
    await expect(insert({ user: ali.userId, salon: A.salonId }, A.salonId, ali.userId)).rejects.toThrow(/row-level security/); // staff
    await expect(insert({ user: A.ownerId, salon: A.salonId }, A.salonId, A.ownerId)).resolves.toBeDefined();
    await expect(asApp({ user: A.ownerId, salon: A.salonId }, (c) => c.query(`INSERT INTO salon_expenses (salon_id, category, amount, expense_date, created_by) VALUES ($1, 'RENT', 5, $2::date, $3)`,
      [A.salonId, addDaysIso(today(), 1), A.ownerId]))).rejects.toThrow(/future/);
    await expect(asApp({ user: A.ownerId, salon: A.salonId }, (c) => c.query(`DELETE FROM salon_expenses WHERE salon_id = $1`, [A.salonId]))).rejects.toThrow(/permission denied/);
    const id = (await A.a.get(`/expenses?${R(19)}`).expect(200)).body.data.items[0].id as string;
    await expect(asApp({ user: A.ownerId, salon: A.salonId }, (c) => c.query(`UPDATE salon_expenses SET salon_id = $2 WHERE id = $1`, [id, B.salonId]))).rejects.toThrow();
    await expect(asApp({ user: A.ownerId, salon: A.salonId }, (c) => c.query(`UPDATE salon_expenses SET created_by = $2 WHERE id = $1`, [id, B.ownerId]))).rejects.toThrow();
    await expect(asApp({ user: A.ownerId, salon: A.salonId }, (c) => c.query(`UPDATE salon_expenses SET amount = 0 WHERE id = $1`, [id]))).rejects.toThrow(/amount_range/);
    await expect(asApp({ user: B.ownerId, salon: B.salonId }, (c) => c.query(`UPDATE salon_expenses SET amount = 1 WHERE id = $1`, [id]).then((r) => { if (r.rowCount === 0) throw new Error('no rows'); }))).rejects.toThrow(/no rows/);
    // the Data API roles (if they exist) have no access
    const roles = (await aq(`SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated')`)).rows.map((r) => r.rolname);
    for (const role of roles) expect((await aq(`SELECT has_table_privilege($1, 'salon_expenses', 'SELECT') AS x`, [role])).rows[0].x).toBe(false);
    // RLS is forced on the table
    expect((await aq(`SELECT relrowsecurity AS on, relforcerowsecurity AS forced FROM pg_class WHERE relname = 'salon_expenses'`)).rows[0]).toEqual({ on: true, forced: true });
  });

  // ------------------------------------------------------------------ platform analytics
  it('platform overview agrees with the database and with the billing screens, and carries no salon money', async () => {
    const range = `from=${ago(19)}&to=${ago(0)}`;
    const r = (await h.http().get(`/api/v1/admin/analytics/overview?${range}`).set(bearer(superAdmin)).expect(200)).body.data;
    expect(r.currency).toBe('PKR');
    // salons
    const sc = (await aq(`SELECT status::text AS s, count(*)::int AS n FROM salons GROUP BY 1`)).rows;
    for (const x of sc) expect(r.salons.byStatus[x.s]).toBe(x.n);
    expect(r.salons.total).toBe(sc.reduce((a, x) => a + x.n, 0));
    expect(r.salons.byStatus.APPROVED).toBeGreaterThanOrEqual(3);
    // staff
    const st = (await aq(`SELECT count(*) FILTER (WHERE sp.is_active)::int AS active, count(*) FILTER (WHERE sp.is_active AND sp.performs_services)::int AS billable
                          FROM staff_profiles sp JOIN salons s ON s.id = sp.salon_id WHERE sp.deleted_at IS NULL AND s.status IN ('APPROVED','SUSPENDED')`)).rows[0];
    expect(r.staff).toEqual(st);
    // customers
    const cu = (await aq(`SELECT count(*)::int AS n FROM users WHERE role = 'CUSTOMER'`)).rows[0].n;
    expect(r.customers.registered).toBe(cu);
    expect(r.customers.newInRange).toBeGreaterThanOrEqual(3);
    // bookings (counts only)
    const from = new Date(slotMs(ago(19), 0));
    const to = new Date(slotMs(ago(-1), 0));
    const bk = (await aq(`SELECT count(*)::int AS total, count(*) FILTER (WHERE status = 'COMPLETED')::int AS completed FROM appointments WHERE starts_at >= $1 AND starts_at < $2`, [from, to])).rows[0];
    expect(r.bookings.total).toBe(bk.total);
    expect(r.bookings.completed).toBe(bk.completed);
    expect(r.bookings.total).toBeGreaterThanOrEqual(8);
    expect(Object.keys(r.bookings).sort()).toEqual(['cancelled', 'completed', 'noShow', 'online', 'open', 'rates', 'total', 'walkIn', 'walkInSharePct']);
    // the SAME subscription numbers as the billing overview (no second copy of the MRR logic)
    const billing = (await h.http().get('/api/v1/admin/billing/overview').set(bearer(superAdmin)).expect(200)).body.data;
    expect(r.platformRevenue).toMatchObject({
      monthlyRecurringRevenue: billing.monthlyRecurringRevenue, verifiedThisMonth: billing.verifiedRevenueThisMonth, verifiedThisYear: billing.verifiedRevenueThisYear,
      pendingPayments: billing.pendingPayments, pendingAmount: billing.pendingAmount,
    });
    expect(r.subscriptions).toEqual({
      active: billing.subscriptions.ACTIVE, inGrace: billing.subscriptions.GRACE, expired: billing.subscriptions.EXPIRED,
      suspended: billing.subscriptions.SUSPENDED, neverSubscribed: billing.subscriptions.NONE,
    });
    expect(Number(r.platformRevenue.annualRunRate)).toBeCloseTo(Number(r.platformRevenue.monthlyRecurringRevenue) * 12, 2);
    // privacy: neither Salon A's takings nor any expense appears anywhere in the platform payload
    const text = JSON.stringify(r);
    for (const secret of ['1400.00', '620.50', '9999.00', 'expenses']) expect(text).not.toContain(secret);
  });

  it('platform city statistics: counts per city, no salon money', async () => {
    const r = (await h.http().get(`/api/v1/admin/analytics/cities?from=${ago(19)}&to=${ago(0)}`).set(bearer(finance)).expect(200)).body.data;
    const mineCity = r.items.find((x: { city: string }) => x.city === A.city);
    expect(mineCity).toMatchObject({ approvedSalons: 1, suspendedSalons: 0, activeStaff: 2, appointments: 7, completed: 4, cancelled: 2, noShow: 1 });
    expect(mineCity.rates.completionRate).toBe(57.1);
    expect(Object.keys(mineCity).sort()).toEqual(['activeStaff', 'appointments', 'approvedSalons', 'cancelled', 'city', 'completed', 'noShow', 'rates', 'subscribedSalons', 'suspendedSalons']);
    const counts = r.items.map((x: { appointments: number }) => x.appointments);
    expect([...counts].sort((a: number, b: number) => b - a)).toEqual(counts); // busiest first
    await h.http().get(`/api/v1/admin/analytics/cities?to=${addDaysIso(today(), 3)}`).set(bearer(finance)).expect(400);
  });

  it('platform trend: zero-filled months for growth and verified subscription revenue', async () => {
    const t = (await h.http().get('/api/v1/admin/analytics/trend?months=3').set(bearer(support)).expect(200)).body.data;
    expect(t.months).toBe(3);
    expect(t.growth).toHaveLength(3);
    expect(t.subscriptionRevenue).toHaveLength(3);
    const thisMonth = today().slice(0, 7);
    expect(t.growth[2].month).toBe(thisMonth);
    expect(t.subscriptionRevenue[2].month).toBe(thisMonth);
    expect(t.growth[2].newCustomers).toBeGreaterThanOrEqual(3);
    expect(t.growth[2].appointments).toBeGreaterThanOrEqual(1);
    expect(typeof t.subscriptionRevenue[2].verified).toBe('string');
    const def = (await h.http().get('/api/v1/admin/analytics/trend').set(bearer(support)).expect(200)).body.data;
    expect(def.growth).toHaveLength(12);
    await h.http().get('/api/v1/admin/analytics/trend?months=0').set(bearer(support)).expect(400);
    await h.http().get('/api/v1/admin/analytics/trend?months=25').set(bearer(support)).expect(400);
    await h.http().get('/api/v1/admin/analytics/trend?salonId=x').set(bearer(support)).expect(400);
  });

  it('the report queries use their indexes (no sequential scan of appointments for a one-salon range)', async () => {
    const c = await h.admin.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SET LOCAL enable_seqscan = off`);
      const plan = await c.query(
        `EXPLAIN SELECT count(*), sum(total_price) FROM appointments WHERE salon_id = $1 AND starts_at >= $2 AND starts_at < $3 AND status = 'COMPLETED'`,
        [A.salonId, new Date(slotMs(ago(19), 0)), new Date(slotMs(ago(-1), 0))],
      );
      await c.query('ROLLBACK');
      const text = plan.rows.map((r: Record<string, string>) => r['QUERY PLAN']).join('\n');
      expect(text).toMatch(/appointments_completed_idx|appointments_salon_day_idx/);
    } finally {
      c.release();
    }
  });
});
