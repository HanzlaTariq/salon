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
  console.warn('SKIPPED reviews e2e: set TEST_DATABASE_URL (salon_app) and TEST_ADMIN_DATABASE_URL (salon_migrator).');
}

const totp = (secretB32: string, h: Harness) => hotp(base32Decode(secretB32), timeStep(h.clock.now().getTime()));
const png = () => sharp({ create: { width: 600, height: 400, channels: 3, background: '#40a0c0' } }).png().toBuffer();
const WEEK = [1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, closed: false, opensAt: '10:00', closesAt: '21:00' })).concat([{ weekday: 7, closed: true } as never]);
const STAFF_WEEK = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, off: false, startsAt: '10:00', endsAt: '18:00' })).concat([{ weekday: 6, off: true }, { weekday: 7, off: true }] as never[]);
let cityCounter = 0;
const uniqueCity = () => `Reviewville${Date.now().toString(36)}${cityCounter++}`;
let keyCounter = 0;
const idemKey = () => `review-key-${Date.now().toString(36)}-${keyCounter++}`;

type Status = 'COMPLETED' | 'CANCELLED' | 'NO_SHOW';
interface Line { id: string; name: string; minutes: number; price: number }

d('Phase 14: reviews, ratings, moderation, favourites and customer history (real PostgreSQL)', () => {
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
    return { token: access, id: u.id };
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
    const adminToken = (await platform('SUPER_ADMIN')).token;
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
  async function seed(m: Made, o: { staff: 'Ali' | 'Ahmed'; status: Status; daysAgo: number; customerId: string; lines: Line[]; cancelledBy?: 'CUSTOMER' | 'SALON' }): Promise<string> {
    const minutes = o.lines.reduce((s, l) => s + l.minutes, 0);
    const price = o.lines.reduce((s, l) => s + l.price, 0);
    const start = slotMs(ago(o.daysAgo), 11 * 60);
    const startsAt = new Date(start);
    const endsAt = new Date(start + minutes * 60_000);
    return commitAs({ user: m.ownerId, salon: m.salonId }, async (c) => {
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
      return r.rows[0].id as string;
    });
  }

  const Haircut = (price: number): Line => ({ id: '', name: 'Haircut', minutes: 30, price });
  const withIds = (m: Made, l: Line): Line => ({ ...l, id: l.name === 'Haircut' ? m.services.Haircut.id : m.services.Beard.id });
  const beardOf = (m: Made): Line => withIds(m, { id: '', name: 'Beard Trim', minutes: 15, price: 150 });

  const cust = (t: string) => ({
    get: (p: string) => h.http().get(`/api/v1/customers/me${p}`).set(bearer(t)),
    post: (p: string, b: object = {}) => h.http().post(`/api/v1/customers/me${p}`).set(bearer(t)).send(b),
    patch: (p: string, b: object) => h.http().patch(`/api/v1/customers/me${p}`).set(bearer(t)).send(b),
    put: (p: string) => h.http().put(`/api/v1/customers/me${p}`).set(bearer(t)),
    del: (p: string) => h.http().delete(`/api/v1/customers/me${p}`).set(bearer(t)),
  });
  const pub = (p: string) => h.http().get(`/api/v1/public/discovery/salons${p}`);
  const adm = (t: string) => ({
    get: (p: string) => h.http().get(`/api/v1/admin/reviews${p}`).set(bearer(t)),
    post: (p: string, b: object = {}) => h.http().post(`/api/v1/admin/reviews${p}`).set(bearer(t)).send(b),
  });
  const statsOf = async (salonId: string) => {
    const r = await aq('SELECT review_count, rating_avg FROM salon_rating_stats WHERE salon_id = $1', [salonId]);
    return r.rows[0] ? { count: Number(r.rows[0].review_count), avg: r.rows[0].rating_avg === null ? null : Number(r.rows[0].rating_avg) } : { count: 0, avg: null };
  };
  /** The stats must ALWAYS equal what the PUBLISHED reviews say (the counters are maintained by a trigger). */
  const truth = async (salonId: string) => {
    const r = await aq(`SELECT count(*)::int AS n, round(avg(salon_rating)::numeric, 2) AS avg FROM reviews WHERE salon_id = $1 AND status = 'PUBLISHED'`, [salonId]);
    return { count: Number(r.rows[0].n), avg: r.rows[0].avg === null ? null : Number(r.rows[0].avg) };
  };

  let A: Made;
  let B: Made;
  let ali: Awaited<ReturnType<typeof staffAccount>>;
  let superAdmin: { token: string; id: string };
  let support: { token: string; id: string };
  let finance: { token: string; id: string };
  let c1: Awaited<ReturnType<typeof customer>>;
  let c2: Awaited<ReturnType<typeof customer>>;
  let c3: Awaited<ReturnType<typeof customer>>;
  const appt: Record<string, string> = {};
  const rev: Record<string, string> = {};

  beforeAll(async () => {
    superAdmin = await platform('SUPER_ADMIN');
    support = await platform('SUPPORT');
    finance = await platform('FINANCE');
    A = await salon('Review Salon A');
    B = await salon('Review Salon B');
    c1 = await customer('Rev One');
    c2 = await customer('Rev Two');
    c3 = await customer('Rev Three');
    ali = await staffAccount(A, 'Ali');
    const hc = (m: Made, price: number) => withIds(m, Haircut(price));
    appt.a1 = await seed(A, { staff: 'Ali', status: 'COMPLETED', daysAgo: 1, customerId: c1.id, lines: [hc(A, 300), beardOf(A)] });
    appt.a2 = await seed(A, { staff: 'Ahmed', status: 'COMPLETED', daysAgo: 2, customerId: c2.id, lines: [hc(A, 500)] });
    appt.a3 = await seed(A, { staff: 'Ali', status: 'CANCELLED', daysAgo: 3, customerId: c1.id, lines: [hc(A, 300)], cancelledBy: 'CUSTOMER' });
    appt.a4 = await seed(A, { staff: 'Ali', status: 'COMPLETED', daysAgo: 40, customerId: c3.id, lines: [hc(A, 300)] });
    appt.a5 = await seed(A, { staff: 'Ali', status: 'COMPLETED', daysAgo: 3, customerId: c3.id, lines: [hc(A, 300)] });
    appt.b1 = await seed(B, { staff: 'Ali', status: 'COMPLETED', daysAgo: 1, customerId: c1.id, lines: [hc(B, 300)] });
  });

  // ------------------------------------------------------------------ writing a review
  it('pending list: only completed, not yet reviewed visits inside the 30-day window', async () => {
    const r = (await cust(c1.access).get('/reviews/pending').expect(200)).body.data;
    expect(r.windowDays).toBe(30);
    expect(r.items.map((x: { appointmentId: string }) => x.appointmentId).sort()).toEqual([appt.a1, appt.b1].sort());
    const a1 = r.items.find((x: { appointmentId: string }) => x.appointmentId === appt.a1);
    expect(a1.services.map((s: { name: string }) => s.name)).toEqual(['Haircut', 'Beard Trim']);
    const c3p = (await cust(c3.access).get('/reviews/pending').expect(200)).body.data.items;
    expect(c3p.map((x: { appointmentId: string }) => x.appointmentId)).toEqual([appt.a5]); // a4 is 40 days old
  });

  it('a customer reviews a completed visit: salon rating, staff rating, comment and service ratings', async () => {
    const r = (await cust(c1.access).post('/reviews', {
      appointmentId: appt.a1, salonRating: 5, staffRating: 4, comment: '  Great haircut, very clean salon.  ',
      services: [{ serviceId: A.services.Haircut.id, rating: 5 }, { serviceId: A.services.Beard.id, rating: 4 }],
    }).expect(201)).body.data;
    rev.a1 = r.id;
    expect(r).toMatchObject({ appointmentId: appt.a1, rating: 5, staffRating: 4, comment: 'Great haircut, very clean salon.', status: 'PUBLISHED', canEdit: true, edited: false, response: null });
    expect(r.salon.id).toBe(A.salonId);
    expect(r.staff.id).toBe(A.staff.Ali);
    expect(r.services).toEqual([{ serviceId: A.services.Haircut.id, name: 'Haircut', rating: 5 }, { serviceId: A.services.Beard.id, name: 'Beard Trim', rating: 4 }]);
    expect((await cust(c1.access).get('/reviews/pending').expect(200)).body.data.items.map((x: { appointmentId: string }) => x.appointmentId)).toEqual([appt.b1]);
  });

  it('rules: one review per visit, only completed visits, 30-day window, only your own visits', async () => {
    const dup = await cust(c1.access).post('/reviews', { appointmentId: appt.a1, salonRating: 1 }).expect(409);
    expect(dup.body.error.details).toEqual({ reason: 'ALREADY_REVIEWED' });
    expect((await cust(c1.access).post('/reviews', { appointmentId: appt.a3, salonRating: 5 }).expect(409)).body.error.details.reason).toBe('NOT_COMPLETED');
    expect((await cust(c3.access).post('/reviews', { appointmentId: appt.a4, salonRating: 5 }).expect(409)).body.error.details.reason).toBe('WINDOW_CLOSED');
    // somebody else's visit looks exactly like a visit that does not exist
    await cust(c2.access).post('/reviews', { appointmentId: appt.a1, salonRating: 5 }).expect(404);
    await cust(c2.access).post('/reviews', { appointmentId: '00000000-0000-4000-8000-000000000000', salonRating: 5 }).expect(404);
    // a service that was not part of the visit
    await cust(c2.access).post('/reviews', { appointmentId: appt.a2, salonRating: 4, services: [{ serviceId: A.services.Beard.id, rating: 5 }] }).expect(400);
    expect((await cust(c1.access).get('/reviews').expect(200)).body.data.total).toBe(1);
  });

  it('validation: ratings 1-5 whole numbers, text limits, no markup, no mass assignment, no duplicates', async () => {
    const base = { appointmentId: appt.a2 };
    for (const bad of [0, 6, 4.5, -1, '5', null]) await cust(c2.access).post('/reviews', { ...base, salonRating: bad }).expect(400);
    await cust(c2.access).post('/reviews', { ...base, salonRating: 4, staffRating: 9 }).expect(400);
    await cust(c2.access).post('/reviews', { ...base, salonRating: 4, comment: '<script>alert(1)</script>' }).expect(400);
    await cust(c2.access).post('/reviews', { ...base, salonRating: 4, comment: 'x'.repeat(1001) }).expect(400);
    await cust(c2.access).post('/reviews', { ...base, salonRating: 4, comment: '   ' }).expect(400);
    await cust(c2.access).post('/reviews', { ...base, salonRating: 4, salonId: B.salonId }).expect(400);
    await cust(c2.access).post('/reviews', { ...base, salonRating: 4, customerUserId: c1.id }).expect(400);
    await cust(c2.access).post('/reviews', { ...base, salonRating: 4, status: 'HIDDEN' }).expect(400);
    await cust(c2.access).post('/reviews', { ...base, salonRating: 4, services: [{ serviceId: A.services.Haircut.id, rating: 5 }, { serviceId: A.services.Haircut.id, rating: 3 }] }).expect(400);
    await cust(c2.access).post('/reviews', { salonRating: 4 }).expect(400);
    await cust(c2.access).post('/reviews', { appointmentId: 'not-a-uuid', salonRating: 4 }).expect(400);
  });

  it('roles: only customers write; owner, staff, platform and anonymous callers are refused', async () => {
    const body = { appointmentId: appt.a2, salonRating: 4 };
    await h.http().post('/api/v1/customers/me/reviews').send(body).expect(401);
    await h.http().post('/api/v1/customers/me/reviews').set(bearer(A.o.access)).send(body).expect(403);
    await h.http().post('/api/v1/customers/me/reviews').set(bearer(ali.access)).send(body).expect(403);
    await h.http().post('/api/v1/customers/me/reviews').set(bearer(superAdmin.token)).send(body).expect(403);
    await h.http().get('/api/v1/customers/me/favourites').set(bearer(A.o.access)).expect(403);
  });

  it('more reviews: c2 on Ahmed (3 stars), c3 on Ali without a staff rating, c1 on salon B', async () => {
    rev.a2 = (await cust(c2.access).post('/reviews', { appointmentId: appt.a2, salonRating: 3, staffRating: 2, comment: 'Waited too long.' }).expect(201)).body.data.id;
    rev.a5 = (await cust(c3.access).post('/reviews', { appointmentId: appt.a5, salonRating: 4 }).expect(201)).body.data.id;
    rev.b1 = (await cust(c1.access).post('/reviews', { appointmentId: appt.b1, salonRating: 2, comment: 'Not for me.' }).expect(201)).body.data.id;
    expect(await statsOf(A.salonId)).toEqual({ count: 3, avg: 4 });
    expect(await statsOf(B.salonId)).toEqual({ count: 1, avg: 2 });
    expect(await truth(A.salonId)).toEqual({ count: 3, avg: 4 });
  });

  // ------------------------------------------------------------------ public side
  it('public: summary, distribution, staff ratings and items without any private data', async () => {
    const r = (await pub(`/${A.salonId}/reviews`).expect(200)).body.data;
    expect(r.summary).toEqual({ average: 4, count: 3, distribution: { '1': 0, '2': 0, '3': 1, '4': 1, '5': 1 } });
    expect(r.items).toHaveLength(3);
    expect(r.items.map((x: { rating: number }) => x.rating)).toEqual([4, 3, 5]); // newest first: a5, a2, a1 were written in that order reversed
    expect(r.staff.map((s: { name: string }) => s.name).sort()).toEqual(['Ahmed', 'Ali']);
    const ali1 = r.staff.find((s: { name: string }) => s.name === 'Ali');
    expect(ali1).toMatchObject({ average: 4, count: 1 });
    const item = r.items.find((x: { rating: number }) => x.rating === 5);
    expect(Object.keys(item).sort()).toEqual(['authorName', 'comment', 'createdAt', 'edited', 'id', 'rating', 'response', 'services', 'staffName', 'staffRating']);
    expect(item.authorName).toBe('Rev O.'); // never the full name
    expect(JSON.stringify(r)).not.toContain(c1.id);
    expect(JSON.stringify(r)).not.toContain(c1.email);
    expect((await pub(`/${A.salonId}/reviews?sort=highest`).expect(200)).body.data.items.map((x: { rating: number }) => x.rating)).toEqual([5, 4, 3]);
    expect((await pub(`/${A.salonId}/reviews?sort=lowest&pageSize=2`).expect(200)).body.data).toMatchObject({ total: 3, hasMore: true });
    expect((await pub(`/${B.salonId}/reviews`).expect(200)).body.data.summary).toMatchObject({ average: 2, count: 1 });
  });

  it('public: unknown / unlisted salons, bad input and unknown parameters', async () => {
    await pub('/00000000-0000-4000-8000-000000000000/reviews').expect(404);
    await pub('/not-a-uuid/reviews').expect(400);
    await pub(`/${A.salonId}/reviews?sort=best`).expect(400);
    await pub(`/${A.salonId}/reviews?pageSize=500`).expect(400);
    await pub(`/${A.salonId}/reviews?status=HIDDEN`).expect(400);
    // a suspended salon disappears together with its reviews, and returns with them
    await h.http().post(`/api/v1/admin/salons/${B.salonId}/suspend`).set(bearer(superAdmin.token)).send({ reason: 'Testing the review visibility rule' }).expect(200);
    await pub(`/${B.salonId}/reviews`).expect(404);
    await h.http().post(`/api/v1/admin/salons/${B.salonId}/reactivate`).set(bearer(superAdmin.token)).expect(200);
    await pub(`/${B.salonId}/reviews`).expect(200);
  });

  it('discovery: the card shows the real average and count; "rating" is now a sort order', async () => {
    const card = (await h.http().get(`/api/v1/public/discovery/salons?city=${A.city}`).expect(200)).body.data.items[0];
    expect(card).toMatchObject({ rating: 4, ratingCount: 3 });
    // put B into A's city so the two salons compete in one list (test data change as the owner role)
    await aq('UPDATE salons SET city = $1 WHERE id = $2', [A.city, B.salonId]);
    const byRating = (await h.http().get(`/api/v1/public/discovery/salons?city=${A.city}&sort=rating`).expect(200)).body.data.items;
    expect(byRating.map((x: { id: string }) => x.id)).toEqual([A.salonId, B.salonId]);
    expect(byRating.map((x: { rating: number }) => x.rating)).toEqual([4, 2]);
    expect((await h.http().get(`/api/v1/public/discovery/salons?city=${A.city}&sort=rating`).expect(200)).body.data.sort).toBe('rating');
    await aq('UPDATE salons SET city = $1 WHERE id = $2', [B.city, B.salonId]);
  });

  // ------------------------------------------------------------------ editing
  it('edit: author only, ratings and comment, counters follow, flagged as edited', async () => {
    const r = (await cust(c2.access).patch(`/reviews/${rev.a2}`, { salonRating: 4, comment: 'Better than I first thought.' }).expect(200)).body.data;
    expect(r).toMatchObject({ rating: 4, staffRating: 2, comment: 'Better than I first thought.', edited: true });
    expect(await statsOf(A.salonId)).toEqual({ count: 3, avg: 4.33 });
    expect(await truth(A.salonId)).toEqual({ count: 3, avg: 4.33 });
    // staff rating can be cleared, the comment can be cleared
    const cleared = (await cust(c2.access).patch(`/reviews/${rev.a2}`, { staffRating: null, comment: null }).expect(200)).body.data;
    expect(cleared).toMatchObject({ staffRating: null, comment: null });
    await cust(c2.access).patch(`/reviews/${rev.a2}`, {}).expect(400);
    await cust(c2.access).patch(`/reviews/${rev.a2}`, { salonRating: 7 }).expect(400);
    await cust(c2.access).patch(`/reviews/${rev.a2}`, { appointmentId: appt.a1 }).expect(400);
    await cust(c3.access).patch(`/reviews/${rev.a2}`, { salonRating: 1 }).expect(404); // not yours
    expect(await statsOf(A.salonId)).toEqual({ count: 3, avg: 4.33 });
  });

  it('edit window: closed after 7 days', async () => {
    const guard = 'ALTER TABLE reviews %s TRIGGER reviews_guard_trg';
    await aq(guard.replace('%s', 'DISABLE'));
    try {
      await aq(`UPDATE reviews SET created_at = now() - interval '8 days' WHERE id = $1`, [rev.a5]);
    } finally {
      await aq(guard.replace('%s', 'ENABLE'));
    }
    const r = await cust(c3.access).patch(`/reviews/${rev.a5}`, { salonRating: 1 }).expect(409);
    expect(r.body.error.details.reason).toBe('EDIT_WINDOW_CLOSED');
    expect((await cust(c3.access).get(`/reviews/${rev.a5}`).expect(200)).body.data.canEdit).toBe(false);
    expect(await truth(A.salonId)).toEqual(await statsOf(A.salonId));
  });

  // ------------------------------------------------------------------ owner
  it('owner: sees only own salon reviews, without customer identity; filters work', async () => {
    const r = (await A.a.get('/reviews').expect(200)).body.data;
    expect(r.total).toBe(3);
    expect(JSON.stringify(r)).not.toContain(c1.id);
    expect(JSON.stringify(r)).not.toContain(c1.email);
    expect(r.items.every((x: { reported: boolean }) => x.reported === false)).toBe(true);
    expect((await A.a.get('/reviews?rating=5').expect(200)).body.data.items.map((x: { id: string }) => x.id)).toEqual([rev.a1]);
    expect((await A.a.get(`/reviews?staffId=${A.staff.Ahmed}`).expect(200)).body.data.items.map((x: { id: string }) => x.id)).toEqual([rev.a2]);
    expect((await A.a.get('/reviews?unanswered=true').expect(200)).body.data.total).toBe(3);
    const sum = (await A.a.get('/reviews/summary').expect(200)).body.data;
    expect(sum).toMatchObject({ count: 3, unanswered: 3 });
    expect(sum.staff.map((s: { name: string }) => s.name)).toEqual(['Ali']); // Ahmed's only review had its staff rating cleared by the author
    expect((await B.a.get('/reviews').expect(200)).body.data.items.map((x: { id: string }) => x.id)).toEqual([rev.b1]);
    await A.a.get('/reviews?rating=9').expect(400);
    await A.a.get('/reviews?salonId=' + B.salonId).expect(400);
  });

  it('owner response: public, editable, removable; other salons, staff and customers cannot respond', async () => {
    const r = (await A.a.put(`/reviews/${rev.a2}/response`, { text: '  Sorry about the wait, we added a chair.  ' }).expect(200)).body.data;
    expect(r.response.text).toBe('Sorry about the wait, we added a chair.');
    expect((await pub(`/${A.salonId}/reviews`).expect(200)).body.data.items.find((x: { id: string }) => x.id === rev.a2).response.text).toBe('Sorry about the wait, we added a chair.');
    expect((await cust(c2.access).get(`/reviews/${rev.a2}`).expect(200)).body.data.response.text).toContain('added a chair');
    await A.a.put(`/reviews/${rev.a2}/response`, { text: 'Updated: thank you for the feedback.' }).expect(200);
    expect((await A.a.get('/reviews?unanswered=true').expect(200)).body.data.total).toBe(2);
    await A.a.put(`/reviews/${rev.a2}/response`, { text: '' }).expect(400);
    await A.a.put(`/reviews/${rev.a2}/response`, { text: '<b>x</b>' }).expect(400);
    await A.a.put(`/reviews/${rev.a2}/response`, { text: 'y'.repeat(501) }).expect(400);
    // another salon's owner: the review does not exist for them
    await B.a.put(`/reviews/${rev.a2}/response`, { text: 'Not my review' }).expect(404);
    await B.a.del(`/reviews/${rev.a2}/response`).expect(404);
    // staff and customers have no such route
    await h.http().put(`/api/v1/salons/mine/reviews/${rev.a2}/response`).set(bearer(ali.access)).send({ text: 'hi' }).expect(403);
    await h.http().put(`/api/v1/salons/mine/reviews/${rev.a2}/response`).set(bearer(c2.access)).send({ text: 'hi' }).expect(403);
    await A.a.del(`/reviews/${rev.a2}/response`).expect(204);
    await A.a.del(`/reviews/${rev.a2}/response`).expect(204); // idempotent
    expect((await pub(`/${A.salonId}/reviews`).expect(200)).body.data.items.find((x: { id: string }) => x.id === rev.a2).response).toBeNull();
    const audit = await aq(`SELECT action FROM audit_logs WHERE target_id = $1 AND action LIKE 'review.response%' ORDER BY created_at`, [rev.a2]);
    expect(audit.rows.map((x) => x.action)).toEqual(['review.response_create', 'review.response_update', 'review.response_delete']);
  });

  // ------------------------------------------------------------------ staff
  it('staff: sees reviews about their own work only', async () => {
    const r = (await h.http().get('/api/v1/staff/me/reviews').set(bearer(ali.access)).expect(200)).body.data;
    expect(r.summary).toMatchObject({ count: 1, average: 4 }); // only a1 carries a staff rating for Ali
    expect(r.items.map((x: { id: string }) => x.id).sort()).toEqual([rev.a1, rev.a5].sort());
    expect(r.items.some((x: { id: string }) => x.id === rev.a2)).toBe(false); // Ahmed's review
    for (const item of r.items) expect(Object.keys(item).sort()).toEqual(['authorName', 'comment', 'createdAt', 'id', 'salonRating', 'services', 'staffRating', 'visitAt']);
    expect(JSON.stringify(r)).not.toContain(c1.id);
    await h.http().get('/api/v1/staff/me/reviews').set(bearer(A.o.access)).expect(403);
    await h.http().get('/api/v1/staff/me/reviews').set(bearer(c1.access)).expect(403);
    await h.http().get('/api/v1/staff/me/reviews?staffId=' + A.staff.Ahmed).set(bearer(ali.access)).expect(400);
  });

  // ------------------------------------------------------------------ reports and moderation
  it('owner reports a review; one open report per review; the platform sees it', async () => {
    await A.a.post(`/reviews/${rev.a2}/report`, { reason: 'OTHER' }).expect(400); // "other" needs details
    await A.a.post(`/reviews/${rev.a2}/report`, { reason: 'RUDE' }).expect(400);
    await B.a.post(`/reviews/${rev.a2}/report`, { reason: 'SPAM' }).expect(404); // not their review
    const rep = (await A.a.post(`/reviews/${rev.a2}/report`, { reason: 'FAKE', details: 'This person never visited us.' }).expect(201)).body.data;
    expect(rep).toMatchObject({ reviewId: rev.a2, reason: 'FAKE', status: 'OPEN' });
    expect((await A.a.post(`/reviews/${rev.a2}/report`, { reason: 'SPAM' }).expect(409)).body.error.details.reason).toBe('ALREADY_REPORTED');
    expect((await A.a.get('/reviews').expect(200)).body.data.items.find((x: { id: string }) => x.id === rev.a2).reported).toBe(true);
    expect((await A.a.get('/review-reports').expect(200)).body.data.items).toHaveLength(1);
    expect((await B.a.get('/review-reports').expect(200)).body.data.items).toHaveLength(0);

    const queue = (await adm(support.token).get('/reports').expect(200)).body.data;
    expect(queue.total).toBe(1);
    expect(queue.items[0]).toMatchObject({ reviewId: rev.a2, reason: 'FAKE', status: 'OPEN', salonName: 'Review Salon A', review: { authorName: 'Rev T.', salonRating: 4 } });
    expect((await adm(support.token).get('/overview').expect(200)).body.data).toMatchObject({ openReports: 1, hidden: 0 });
    expect((await adm(support.token).get('?reported=true').expect(200)).body.data.items.map((x: { id: string }) => x.id)).toEqual([rev.a2]);
    // the report is kept in the open state until a Super Admin decides
    queue.items[0].id && (rev.report = queue.items[0].id);
  });

  it('moderation permissions: Support can read but not act; Finance, owners, staff and customers are refused', async () => {
    await adm(support.token).get('').expect(200);
    await adm(support.token).post(`/${rev.a2}/hide`, { reason: 'Because I said so' }).expect(403);
    await adm(support.token).post(`/reports/${rev.report}/resolve`, { action: 'DISMISS' }).expect(403);
    await adm(finance.token).get('').expect(403);
    await adm(A.o.access).get('').expect(403);
    await adm(ali.access).post(`/${rev.a2}/restore`).expect(403);
    await adm(c1.access).get('/reports').expect(403);
    await h.http().get('/api/v1/admin/reviews').expect(401);
  });

  it('hide: needs a reason, removes the review from public, owner and the counters; the author still sees why; restore brings it back', async () => {
    await adm(superAdmin.token).post(`/${rev.a2}/hide`, {}).expect(400);
    await adm(superAdmin.token).post(`/${rev.a2}/hide`, { reason: 'x' }).expect(400);
    await adm(superAdmin.token).post(`/${rev.a2}/hide`, { reason: 'Contains <b>markup</b>' }).expect(400);
    const hidden = (await adm(superAdmin.token).post(`/${rev.a2}/hide`, { reason: 'Review is not about this salon.' }).expect(200)).body.data;
    expect(hidden).toMatchObject({ status: 'HIDDEN', hiddenReason: 'Review is not about this salon.' });
    expect((await adm(superAdmin.token).post(`/${rev.a2}/hide`, { reason: 'Again please' }).expect(409)).body.error.details.reason).toBe('ALREADY_HIDDEN');

    expect(await statsOf(A.salonId)).toEqual({ count: 2, avg: 4.5 }); // 5 and 4 remain; the hidden 4 is gone from the counters
    expect(await truth(A.salonId)).toEqual({ count: 2, avg: 4.5 });
    const publicNow = (await pub(`/${A.salonId}/reviews`).expect(200)).body.data;
    expect(publicNow.summary).toMatchObject({ count: 2, average: 4.5 });
    expect(publicNow.items.some((x: { id: string }) => x.id === rev.a2)).toBe(false);
    expect((await A.a.get('/reviews').expect(200)).body.data.items.some((x: { id: string }) => x.id === rev.a2)).toBe(false);
    await A.a.put(`/reviews/${rev.a2}/response`, { text: 'Trying to answer a hidden review' }).expect(404);
    await A.a.post(`/reviews/${rev.a2}/report`, { reason: 'SPAM' }).expect(404);
    const mine = (await cust(c2.access).get(`/reviews/${rev.a2}`).expect(200)).body.data;
    expect(mine).toMatchObject({ status: 'HIDDEN', hiddenReason: 'Review is not about this salon.', canEdit: false });
    expect((await cust(c2.access).patch(`/reviews/${rev.a2}`, { salonRating: 5 }).expect(409)).body.error.details.reason).toBe('HIDDEN');
    expect((await adm(support.token).get('?status=HIDDEN').expect(200)).body.data.items.map((x: { id: string }) => x.id)).toEqual([rev.a2]);

    await adm(superAdmin.token).post(`/${rev.a1}/restore`).expect(409); // not hidden
    const back = (await adm(superAdmin.token).post(`/${rev.a2}/restore`).expect(200)).body.data;
    expect(back).toMatchObject({ status: 'PUBLISHED', hiddenReason: null });
    expect(await statsOf(A.salonId)).toEqual({ count: 3, avg: 4.33 });
    expect(await truth(A.salonId)).toEqual({ count: 3, avg: 4.33 });

    const audit = await aq(`SELECT action, metadata FROM audit_logs WHERE target_id = $1 AND action IN ('review.hide', 'review.restore') ORDER BY created_at`, [rev.a2]);
    expect(audit.rows.map((x) => x.action)).toEqual(['review.hide', 'review.restore']);
    expect(JSON.stringify(audit.rows)).not.toContain('Better than I first thought'); // review text never enters the audit log
  });

  it('resolve a report: HIDE_REVIEW hides and marks it actioned; a resolved report cannot be resolved again; DISMISS keeps the review', async () => {
    const dismissed = (await adm(superAdmin.token).post(`/reports/${rev.report}/resolve`, { action: 'DISMISS', note: 'Looks genuine.' }).expect(200)).body.data;
    expect(dismissed).toEqual({ id: rev.report, status: 'DISMISSED' });
    expect((await adm(superAdmin.token).post(`/reports/${rev.report}/resolve`, { action: 'DISMISS' }).expect(409)).body.error.details.reason).toBe('ALREADY_RESOLVED');
    expect((await pub(`/${A.salonId}/reviews`).expect(200)).body.data.items.some((x: { id: string }) => x.id === rev.a2)).toBe(true);
    const mineNow = (await A.a.get('/review-reports').expect(200)).body.data.items[0];
    expect(mineNow).toMatchObject({ status: 'DISMISSED', resolutionNote: 'Looks genuine.' });

    // the owner can report again once the first report is closed; this time the platform agrees
    const second = (await A.a.post(`/reviews/${rev.a2}/report`, { reason: 'OFFENSIVE' }).expect(201)).body.data;
    const done = (await adm(superAdmin.token).post(`/reports/${second.id}/resolve`, { action: 'HIDE_REVIEW', note: 'Offensive language.' }).expect(200)).body.data;
    expect(done.status).toBe('ACTIONED');
    expect((await adm(superAdmin.token).get(`?status=HIDDEN`).expect(200)).body.data.items[0]).toMatchObject({ id: rev.a2, hiddenReason: 'Offensive language.' });
    expect(await statsOf(A.salonId)).toEqual({ count: 2, avg: 4.5 });
    await adm(superAdmin.token).post(`/${rev.a2}/restore`).expect(200);
    expect(await statsOf(A.salonId)).toEqual(await truth(A.salonId));
    await adm(superAdmin.token).post('/reports/00000000-0000-4000-8000-000000000000/resolve', { action: 'DISMISS' }).expect(404);
    await adm(superAdmin.token).post(`/reports/${second.id}/resolve`, { action: 'ERASE' }).expect(400);
  });

  // ------------------------------------------------------------------ favourites
  it('favourites: add (idempotent), list with rating, remove (idempotent), private to the customer', async () => {
    await cust(c1.access).put(`/favourites/${A.salonId}`).expect(200);
    await cust(c1.access).put(`/favourites/${A.salonId}`).expect(200);
    await cust(c1.access).put(`/favourites/${B.salonId}`).expect(200);
    const list = (await cust(c1.access).get('/favourites').expect(200)).body.data;
    expect(list.total).toBe(2);
    expect(list.items.map((x: { name: string }) => x.name)).toEqual(['Review Salon B', 'Review Salon A']); // newest first
    expect(list.items.find((x: { salonId: string }) => x.salonId === A.salonId)).toMatchObject({ rating: 4.33, ratingCount: 3, city: A.city });
    expect(list.items[0].coverUrl).toMatch(/^(https?|memory):\/\//);
    expect((await cust(c2.access).get('/favourites').expect(200)).body.data.total).toBe(0);
    await cust(c1.access).del(`/favourites/${B.salonId}`).expect(204);
    await cust(c1.access).del(`/favourites/${B.salonId}`).expect(204);
    expect((await cust(c1.access).get('/favourites').expect(200)).body.data.items.map((x: { salonId: string }) => x.salonId)).toEqual([A.salonId]);
    await cust(c1.access).put('/favourites/00000000-0000-4000-8000-000000000000').expect(404);
    await cust(c1.access).put('/favourites/not-a-uuid').expect(400);
  });

  it('favourites: a salon that is suspended is hidden from the list and cannot be added; it returns with the salon', async () => {
    await h.http().post(`/api/v1/admin/salons/${A.salonId}/suspend`).set(bearer(superAdmin.token)).send({ reason: 'Favourites visibility test' }).expect(200);
    expect((await cust(c1.access).get('/favourites').expect(200)).body.data.total).toBe(0);
    await cust(c2.access).put(`/favourites/${A.salonId}`).expect(404);
    await h.http().post(`/api/v1/admin/salons/${A.salonId}/reactivate`).set(bearer(superAdmin.token)).expect(200);
    expect((await cust(c1.access).get('/favourites').expect(200)).body.data.total).toBe(1);
    await cust(c1.access).del(`/favourites/${A.salonId}`).expect(204);
  });

  it('favourites cap: the 201st salon is refused by the database rule', async () => {
    await aq('ALTER TABLE customer_favourites NO FORCE ROW LEVEL SECURITY');
    await aq('ALTER TABLE customer_favourites DROP CONSTRAINT IF EXISTS customer_favourites_salon_fkey');
    try {
      await aq(`DELETE FROM customer_favourites WHERE customer_user_id = $1`, [c3.id]);
      await aq(`INSERT INTO customer_favourites (customer_user_id, salon_id) SELECT $1, gen_random_uuid() FROM generate_series(1, 200)`, [c3.id]);
      await expect(asApp({ user: c3.id }, (c) => c.query('INSERT INTO customer_favourites (customer_user_id, salon_id) VALUES ($1, $2)', [c3.id, A.salonId]))).rejects.toThrow(/at most 200/);
      // the API maps the same rule to a clear 409
      expect((await cust(c3.access).put(`/favourites/${A.salonId}`).expect(409)).body.error.details.reason).toBe('LIMIT');
    } finally {
      await aq(`DELETE FROM customer_favourites WHERE customer_user_id = $1`, [c3.id]);
      await aq('ALTER TABLE customer_favourites ADD CONSTRAINT customer_favourites_salon_fkey FOREIGN KEY (salon_id) REFERENCES salons(id) ON DELETE CASCADE ON UPDATE CASCADE');
      await aq('ALTER TABLE customer_favourites FORCE ROW LEVEL SECURITY');
    }
  });

  // ------------------------------------------------------------------ customer history (owner)
  it('owner: customer list with visits, spending, cancellations; sorting; search; own salon only', async () => {
    const r = (await A.a.get('/customers?sort=spent').expect(200)).body.data;
    expect(r.currency).toBe('PKR');
    expect(r.total).toBe(3);
    expect(r.items.map((x: { name: string; visits: number; totalSpent: string }) => [x.name, x.visits, x.totalSpent])).toEqual([
      ['Rev Three', 2, '600.00'], ['Rev Two', 1, '500.00'], ['Rev One', 1, '450.00'],
    ]);
    const one = r.items.find((x: { name: string }) => x.name === 'Rev One');
    expect(one).toMatchObject({ cancelled: 1, noShows: 0, upcoming: 0, customerId: c1.id });
    expect(one.lastVisitAt).not.toBeNull();
    expect((await A.a.get('/customers?q=two').expect(200)).body.data.items.map((x: { name: string }) => x.name)).toEqual(['Rev Two']);
    expect((await A.a.get('/customers?q=%25').expect(200)).body.data.total).toBe(0); // wildcard is literal text
    expect((await A.a.get('/customers?sort=visits').expect(200)).body.data.items[0].name).toBe('Rev Three');
    expect((await B.a.get('/customers').expect(200)).body.data.items.map((x: { name: string }) => x.name)).toEqual(['Rev One']); // only who visited B
    await A.a.get('/customers?sort=loyalty').expect(400);
  });

  it('owner: one customer\'s history at this salon, with their review; other salons\' customers do not exist', async () => {
    const r = (await A.a.get(`/customers/${c1.id}`).expect(200)).body.data;
    expect(r).toMatchObject({ name: 'Rev One', visits: 1, cancelled: 1, totalSpent: '450.00' });
    expect(r.history.map((x: { status: string }) => x.status).sort()).toEqual(['CANCELLED', 'COMPLETED']);
    const done = r.history.find((x: { status: string }) => x.status === 'COMPLETED');
    expect(done).toMatchObject({ staffName: 'Ali', totalPrice: '450.00', services: ['Haircut', 'Beard Trim'] });
    expect(r.reviews.map((x: { id: string }) => x.id)).toEqual([rev.a1]);
    expect(JSON.stringify(r.history)).not.toContain('Salon B');
    // c2 never visited salon B
    await B.a.get(`/customers/${c2.id}`).expect(404);
    await B.a.get('/customers/not-a-uuid').expect(400);
    // B only sees its own history of c1
    const b = (await B.a.get(`/customers/${c1.id}`).expect(200)).body.data;
    expect(b).toMatchObject({ visits: 1, totalSpent: '300.00', cancelled: 0 });
    expect(b.reviews.map((x: { id: string }) => x.id)).toEqual([rev.b1]);
    await h.http().get('/api/v1/salons/mine/customers').set(bearer(ali.access)).expect(403);
    await h.http().get('/api/v1/salons/mine/customers').set(bearer(c1.access)).expect(403);
    await h.http().get('/api/v1/salons/mine/customers').expect(401);
  });

  // ------------------------------------------------------------------ database rules (the API is not the only line of defence)
  it('database: a customer cannot review somebody else\'s visit, a second time, or an unfinished visit', async () => {
    const ins = (c: PoolClient, who: string, apptId: string, salonId: string, staffId: string) =>
      c.query(`INSERT INTO reviews (salon_id, appointment_id, customer_user_id, staff_id, author_name, salon_rating) VALUES ($1, $2, $3, $4, 'X', 5)`, [salonId, apptId, who, staffId]);
    // c2 writes a review row in the name of c1 for c1's visit
    await expect(asApp({ user: c2.id }, (c) => ins(c, c1.id, appt.a3, A.salonId, A.staff.Ali))).rejects.toThrow(/row-level security|only the customer|appointment not found/);
    // c2 writes a review in their own name for c1's visit
    await expect(asApp({ user: c2.id }, (c) => ins(c, c2.id, appt.a3, A.salonId, A.staff.Ali))).rejects.toThrow();
    // the same visit twice
    await expect(asApp({ user: c1.id }, (c) => ins(c, c1.id, appt.a1, A.salonId, A.staff.Ali))).rejects.toMatchObject({ code: '23505' });
    // a cancelled visit
    await expect(asApp({ user: c1.id }, (c) => ins(c, c1.id, appt.a3, A.salonId, A.staff.Ali))).rejects.toThrow(/completed/);
    // wrong salon / staff for the visit
    await expect(asApp({ user: c3.id }, (c) => ins(c, c3.id, appt.a5, B.salonId, B.staff.Ali))).rejects.toThrow();
    await expect(asApp({ user: c3.id }, (c) => ins(c, c3.id, appt.a5, A.salonId, A.staff.Ahmed))).rejects.toThrow();
    // too old (40 days)
    await expect(asApp({ user: c3.id }, (c) => ins(c, c3.id, appt.a4, A.salonId, A.staff.Ali))).rejects.toThrow(/30 days/);
    // a review born hidden or with a response
    await expect(asApp({ user: c3.id }, (c) => c.query(`INSERT INTO reviews (salon_id, appointment_id, customer_user_id, staff_id, author_name, salon_rating, owner_response, owner_response_at, owner_response_by)
      VALUES ($1, $2, $3, $4, 'X', 5, 'hi', now(), $3)`, [A.salonId, appt.a4, c3.id, A.staff.Ali]))).rejects.toThrow();
  });

  it('database: who may change which column of a review', async () => {
    const upd = (c: PoolClient, set: string, id = rev.a1) => c.query(`UPDATE reviews SET ${set} WHERE id = $1`, [id]);
    const ownerCtx = { user: A.ownerId, salon: A.salonId };
    // the owner can never change a rating or a comment
    await expect(asApp(ownerCtx, (c) => upd(c, 'salon_rating = 1'))).rejects.toThrow(/only the author/);
    await expect(asApp(ownerCtx, (c) => upd(c, `comment = 'edited by owner'`))).rejects.toThrow(/only the author/);
    // an administrator can never change a rating or a comment
    await expect(asApp({ user: superAdmin.id, admin: true }, (c) => upd(c, 'salon_rating = 1'))).rejects.toThrow(/only the author/);
    // two kinds of change in one statement
    await expect(asApp(ownerCtx, (c) => upd(c, `owner_response = 'x', owner_response_by = '${A.ownerId}', status = 'HIDDEN', hidden_reason = 'abc', hidden_by = '${A.ownerId}', hidden_at = now()`))).rejects.toThrow();
    // the owner cannot hide a review; a customer cannot answer a review
    await expect(asApp(ownerCtx, (c) => upd(c, `status = 'HIDDEN', hidden_reason = 'abc', hidden_by = '${A.ownerId}', hidden_at = now()`))).rejects.toThrow(/administrator/);
    await expect(asApp({ user: c1.id }, (c) => upd(c, `owner_response = 'self praise', owner_response_by = '${c1.id}', owner_response_at = now()`))).rejects.toThrow();
    // another salon's owner cannot answer (the row is not even visible to them)
    const r = await asApp({ user: B.ownerId, salon: B.salonId }, (c) => upd(c, `owner_response = 'hi', owner_response_by = '${B.ownerId}', owner_response_at = now()`));
    expect(r.rowCount).toBe(0);
    // identity columns never change
    await expect(asApp({ user: c1.id }, (c) => upd(c, `customer_user_id = '${c2.id}'`))).rejects.toThrow();
    await expect(asApp({ user: c1.id }, (c) => upd(c, `author_name = 'Somebody Else'`))).rejects.toThrow();
    // the response must be recorded under the signed-in owner
    await expect(asApp(ownerCtx, (c) => upd(c, `owner_response = 'hi', owner_response_by = '${c1.id}', owner_response_at = now()`))).rejects.toThrow();
  });

  it('database: nothing is ever deleted and the counters cannot be written by the runtime role', async () => {
    await expect(asApp({ user: c1.id }, (c) => c.query('DELETE FROM reviews WHERE id = $1', [rev.a1]))).rejects.toThrow(/permission denied/);
    await expect(asApp({ user: superAdmin.id, admin: true }, (c) => c.query('DELETE FROM review_reports'))).rejects.toThrow(/permission denied/);
    await expect(asApp({ user: c1.id }, (c) => c.query('UPDATE review_services SET rating = 1'))).rejects.toThrow(/permission denied/);
    await expect(asApp({ user: c1.id }, (c) => c.query('DELETE FROM review_services'))).rejects.toThrow(/permission denied/);
    await expect(asApp({ user: c1.id }, (c) => c.query('UPDATE salon_rating_stats SET star_5 = 999'))).rejects.toThrow(/permission denied/);
    await expect(asApp({ user: c1.id }, (c) => c.query('INSERT INTO salon_rating_stats (salon_id, star_5) VALUES ($1, 5)', [B.salonId]))).rejects.toThrow(/permission denied/);
    await expect(asApp({ user: c1.id }, (c) => c.query('DELETE FROM staff_rating_stats'))).rejects.toThrow(/permission denied/);
    await expect(asApp({ user: c1.id }, (c) => c.query('TRUNCATE reviews'))).rejects.toThrow(/permission denied/);
    // unauthenticated insert of a review: no policy matches
    await expect(asApp({}, (c) => c.query(`INSERT INTO reviews (salon_id, appointment_id, customer_user_id, staff_id, author_name, salon_rating) VALUES ($1, $2, $3, $4, 'X', 5)`, [A.salonId, appt.a1, c1.id, A.staff.Ali]))).rejects.toThrow();
  });

  it('database: row visibility per context (fail closed)', async () => {
    const count = async (ctx: Parameters<typeof asApp>[0], table: string, where = 'true') =>
      Number((await asApp(ctx, (c) => c.query(`SELECT count(*) FROM ${table} WHERE ${where}`))).rows[0].count);
    // no context at all: nothing
    expect(await count({}, 'reviews')).toBe(0);
    expect(await count({}, 'review_reports')).toBe(0);
    expect(await count({}, 'customer_favourites')).toBe(0);
    expect(await count({}, 'salon_rating_stats')).toBe(0);
    // salon B's owner sees B's reviews only
    expect(await count({ user: B.ownerId, salon: B.salonId }, 'reviews')).toBe(1);
    expect(await count({ user: B.ownerId, salon: B.salonId }, 'reviews', `salon_id = '${A.salonId}'`)).toBe(0);
    expect(await count({ user: B.ownerId, salon: B.salonId }, 'salon_rating_stats', `salon_id = '${A.salonId}'`)).toBe(0);
    // a salon owner cannot read another salon even when they name it in the context (they do not own it)
    expect(await count({ user: B.ownerId, salon: A.salonId }, 'reviews')).toBe(0);
    // a customer sees their own reviews (public published ones only inside the public context)
    expect(await count({ user: c3.id }, 'reviews')).toBe(1);
    const published = Number((await aq(`SELECT count(*) FROM reviews r JOIN salons s ON s.id = r.salon_id WHERE r.status = 'PUBLISHED' AND s.status = 'APPROVED'`)).rows[0].count);
    expect(await count({ user: c3.id, publicRead: true }, 'reviews')).toBe(published); // own + every published review of an approved salon, nothing else
    // the public context sees only PUBLISHED reviews
    await aq(`UPDATE reviews SET status = 'HIDDEN', hidden_reason = 'visibility check', hidden_by = $2, hidden_at = now() WHERE id = $1`, [rev.a5, superAdmin.id]).catch(async () => {
      await aq('ALTER TABLE reviews DISABLE TRIGGER reviews_guard_trg');
      await aq(`UPDATE reviews SET status = 'HIDDEN', hidden_reason = 'visibility check', hidden_by = $2, hidden_at = now() WHERE id = $1`, [rev.a5, superAdmin.id]);
      await aq('ALTER TABLE reviews ENABLE TRIGGER reviews_guard_trg');
    });
    expect(await count({ publicRead: true }, 'reviews', `id = '${rev.a5}'`)).toBe(0);
    expect(await count({ publicRead: true }, 'reviews', `id = '${rev.a1}'`)).toBe(1);
    expect(await count({ publicRead: true }, 'review_reports')).toBe(0);
    expect(await count({ publicRead: true }, 'customer_favourites')).toBe(0);
    await aq('ALTER TABLE reviews DISABLE TRIGGER reviews_guard_trg');
    await aq(`UPDATE reviews SET status = 'PUBLISHED', hidden_reason = NULL, hidden_by = NULL, hidden_at = NULL WHERE id = $1`, [rev.a5]);
    await aq('ALTER TABLE reviews ENABLE TRIGGER reviews_guard_trg');
    expect(await statsOf(A.salonId)).toEqual(await truth(A.salonId));
  });

  it('database: favourites are private to the customer (owners and administrators have no policy)', async () => {
    await cust(c3.access).put(`/favourites/${A.salonId}`).expect(200);
    const count = async (ctx: Parameters<typeof asApp>[0]) => Number((await asApp(ctx, (c) => c.query('SELECT count(*) FROM customer_favourites'))).rows[0].count);
    expect(await count({ user: c3.id })).toBe(1);
    expect(await count({ user: c2.id })).toBe(0);
    expect(await count({ user: A.ownerId, salon: A.salonId })).toBe(0);
    expect(await count({ user: superAdmin.id, admin: true })).toBe(0);
    // nobody can add a favourite in another customer's name
    await expect(asApp({ user: c2.id }, (c) => c.query('INSERT INTO customer_favourites (customer_user_id, salon_id) VALUES ($1, $2)', [c3.id, B.salonId]))).rejects.toThrow(/row-level security/);
    await cust(c3.access).del(`/favourites/${A.salonId}`).expect(204);
  });

  it('counters stay exactly equal to the published reviews after every kind of change', async () => {
    for (const s of [A.salonId, B.salonId]) expect(await statsOf(s)).toEqual(await truth(s));
    const staff = await aq(`SELECT t.staff_id, t.review_count, t.rating_avg,
                                   (SELECT count(*) FROM reviews r WHERE r.staff_id = t.staff_id AND r.status = 'PUBLISHED' AND r.staff_rating IS NOT NULL) AS n,
                                   (SELECT round(avg(r.staff_rating)::numeric, 2) FROM reviews r WHERE r.staff_id = t.staff_id AND r.status = 'PUBLISHED' AND r.staff_rating IS NOT NULL) AS avg
                            FROM staff_rating_stats t WHERE t.salon_id = ANY($1::uuid[])`, [[A.salonId, B.salonId]]);
    expect(staff.rowCount).toBeGreaterThan(0);
    for (const r of staff.rows) {
      expect(Number(r.review_count)).toBe(Number(r.n));
      expect(r.rating_avg === null ? null : Number(r.rating_avg)).toBe(r.avg === null ? null : Number(r.avg));
    }
  });

  it('two requests racing to review the same visit create exactly one review', async () => {
    const extra = await seed(A, { staff: 'Ali', status: 'COMPLETED', daysAgo: 4, customerId: c2.id, lines: [withIds(A, Haircut(300))] });
    const results = await Promise.all([1, 2, 3, 4].map(() => cust(c2.access).post('/reviews', { appointmentId: extra, salonRating: 5 })));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(3);
    expect(Number((await aq('SELECT count(*) FROM reviews WHERE appointment_id = $1', [extra])).rows[0].count)).toBe(1);
    expect(await statsOf(A.salonId)).toEqual(await truth(A.salonId));
  });
});
