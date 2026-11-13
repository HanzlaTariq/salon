import { Pool, PoolClient } from 'pg';
import sharp from 'sharp';
import { hotp, base32Decode, timeStep } from '../src/modules/auth/totp';
import { todayKarachi } from '../src/modules/billing/billing.types';
import { addDaysIso, isoWeekday } from '../src/modules/discovery/discovery.types';
import { Harness, bearer, createHarness, createPlatformUser, dbEnabled, loginMobile, registerAndVerify } from './support/harness';

const d = dbEnabled ? describe : describe.skip;
if (!dbEnabled) {
  // eslint-disable-next-line no-console
  console.warn('SKIPPED discovery e2e: set TEST_DATABASE_URL (salon_app) and TEST_ADMIN_DATABASE_URL (salon_migrator).');
}

type Role = 'SUPER_ADMIN' | 'SUPPORT' | 'FINANCE';
const DAY = 24 * 3_600_000;
const totp = (secretB32: string, h: Harness) => hotp(base32Decode(secretB32), timeStep(h.clock.now().getTime()));
const png = () => sharp({ create: { width: 600, height: 400, channels: 3, background: '#c07840' } }).png().toBuffer();
const WEEK = [1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, closed: false, opensAt: '10:00', closesAt: '21:00' })).concat([{ weekday: 7, closed: true } as never]);
/** Staff: Monday-Friday 10:00-18:00, Saturday and Sunday off. */
const STAFF_WEEK = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, off: false, startsAt: '10:00', endsAt: '18:00' })).concat([{ weekday: 6, off: true }, { weekday: 7, off: true }] as never[]);
const LAHORE = { lat: 31.5204, lng: 74.3587 };

let cityCounter = 0;
const uniqueCity = () => `Testville${Date.now().toString(36)}${cityCounter++}`;

d('Phase 7: discovery - search, nearby, filters, availability preview, listing rule (real PostgreSQL)', () => {
  let h: Harness;
  let appPool: Pool;
  let superAdmin: { id: string; email: string; access: string };
  let finance: { id: string; email: string; access: string };
  let support: { id: string; email: string; access: string };

  beforeAll(async () => {
    h = await createHarness();
    appPool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 2 });
    superAdmin = await platformUser('SUPER_ADMIN');
    finance = await platformUser('FINANCE');
    support = await platformUser('SUPPORT');
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
  async function platformUser(role: Role) {
    const u = await createPlatformUser(h, role);
    const access = (await loginMobile(h, u.email, u.password)).body.data.accessToken as string;
    const setup = (await h.http().post('/api/v1/auth/mfa/setup').set(bearer(access)).send({ password: u.password }).expect(200)).body.data;
    await h.http().post('/api/v1/auth/mfa/enable').set(bearer(access)).send({ code: totp(setup.secret, h) }).expect(200);
    return { id: u.id, email: u.email, access };
  }
  async function owner() {
    const u = await registerAndVerify(h, { accountType: 'SALON_OWNER', fullName: 'Owner Person' });
    const access = (await loginMobile(h, u.email, u.password)).body.data.accessToken as string;
    return { ...u, access };
  }
  const upload = (token: string, kind: string, docType: string, buf: Buffer) =>
    h.http().post('/api/v1/salons/mine/files').set(bearer(token)).field('kind', kind).field('docType', docType).attach('file', buf, 'x.png');
  const mine = (t: string) => ({
    get: (p: string) => h.http().get(`/api/v1/salons/mine${p}`).set(bearer(t)),
    post: (p: string, b: object = {}) => h.http().post(`/api/v1/salons/mine${p}`).set(bearer(t)).send(b),
    put: (p: string, b: object) => h.http().put(`/api/v1/salons/mine${p}`).set(bearer(t)).send(b),
    patch: (p: string, b: object) => h.http().patch(`/api/v1/salons/mine${p}`).set(bearer(t)).send(b),
    del: (p: string) => h.http().delete(`/api/v1/salons/mine${p}`).set(bearer(t)),
  });
  const pub = (p: string) => h.http().get(`/api/v1/public/discovery${p}`);
  const search = (qs: string) => pub(`/salons?${qs}`);
  const today = () => todayKarachi(h.clock.now());
  /** The first Monday that is 1..7 days away: never today, so results do not depend on the time of day. */
  const nextMonday = () => {
    for (let i = 1; i <= 7; i += 1) if (isoWeekday(addDaysIso(today(), i)) === 1) return addDaysIso(today(), i);
    throw new Error('unreachable');
  };
  const names = (r: { body: { data: { items: Array<{ name: string }> } } }) => r.body.data.items.map((i) => i.name);

  interface Made { o: Awaited<ReturnType<typeof owner>>; salonId: string; staff: Record<string, string>; services: Record<string, string>; a: ReturnType<typeof mine> }
  /**
   * An APPROVED salon in `city`: hours Mon-Sat 10-21; staff work Mon-Fri 10-18 with a 13-14 break.
   * Services: Haircut (staff-based: Ali 300, Ahmed 500), Beard (fixed 150, Ali only), Facial (fixed 1000, Ahmed only).
   */
  async function listedSalon(opts: { name: string; city: string; area?: string; type?: string; coords?: { lat: number; lng: number } | null; approve?: boolean; services?: boolean }): Promise<Made> {
    const o = await owner();
    const a = mine(o.access);
    const body: Record<string, unknown> = {
      name: opts.name, salonType: opts.type ?? 'UNISEX', city: opts.city, area: opts.area ?? 'Central', addressLine: '12 Main Boulevard, Central', phone: '0300 1234567',
    };
    if (opts.coords) Object.assign(body, { latitude: opts.coords.lat, longitude: opts.coords.lng });
    const salonId = (await h.http().post('/api/v1/salons').set(bearer(o.access)).send(body).expect(201)).body.data.salon.id as string;
    await a.put('/opening-hours', { days: WEEK }).expect(200);
    const staff: Record<string, string> = {};
    const services: Record<string, string> = {};
    if (opts.services !== false) {
      for (const n of ['Ali', 'Ahmed']) {
        const id = (await a.post('/team', { displayName: n }).expect(201)).body.data.id as string;
        staff[n] = id;
        await a.put(`/team/${id}/working-hours`, { days: STAFF_WEEK }).expect(200);
        await a.put(`/team/${id}/breaks`, { breaks: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startsAt: '13:00', endsAt: '14:00' })) }).expect(200);
      }
      const hair = (await a.post('/categories', { name: 'Hair' }).expect(201)).body.data.id as string;
      const skin = (await a.post('/categories', { name: 'Skin' }).expect(201)).body.data.id as string;
      services.Haircut = (await a.post('/services', { categoryId: hair, name: 'Haircut', durationMinutes: 30, pricing: { mode: 'STAFF_BASED' }, staff: [{ staffId: staff.Ali, price: 300 }, { staffId: staff.Ahmed, price: 500 }] }).expect(201)).body.data.id;
      services.Beard = (await a.post('/services', { categoryId: hair, name: 'Beard Trim', durationMinutes: 15, pricing: { mode: 'FIXED', price: 150 }, staff: [{ staffId: staff.Ali }] }).expect(201)).body.data.id;
      services.Facial = (await a.post('/services', { categoryId: skin, name: 'Facial', durationMinutes: 60, pricing: { mode: 'FIXED', price: 1000 }, staff: [{ staffId: staff.Ahmed }] }).expect(201)).body.data.id;
    }
    if (opts.approve !== false) {
      await upload(o.access, 'DOCUMENT', 'CNIC_FRONT', await png()).expect(201);
      await upload(o.access, 'DOCUMENT', 'CNIC_BACK', await png()).expect(201);
      await upload(o.access, 'PHOTO', 'COVER', await png()).expect(201);
      await a.post('/submit').expect(200);
      await h.http().post(`/api/v1/admin/salons/${salonId}/approve`).set(bearer(superAdmin.access)).expect(200);
    }
    return { o, salonId, staff, services, a };
  }

  // ------------------------------------------------------------------ options
  it('options: only listed salons produce cities and areas; only truthful sort orders are offered', async () => {
    const city = uniqueCity();
    await listedSalon({ name: 'Opt One', city, area: 'Gulberg' });
    await listedSalon({ name: 'Opt Two', city, area: 'Gulberg' });
    await listedSalon({ name: 'Opt Three', city, area: 'DHA' });
    await listedSalon({ name: 'Opt Pending', city: `${city}-pending`, approve: false });
    const r = await pub('/options').expect(200);
    const c = r.body.data.cities.find((x: { city: string }) => x.city === city);
    expect(c.salons).toBe(3);
    expect(c.areas).toEqual(expect.arrayContaining([{ area: 'Gulberg', salons: 2 }, { area: 'DHA', salons: 1 }]));
    expect(r.body.data.cities.some((x: { city: string }) => x.city === `${city}-pending`)).toBe(false);
    expect(r.body.data.sorts).toEqual(['nearest', 'price_low', 'newest', 'name']);
    expect(r.body.data.sorts).not.toContain('rating');
    expect(r.body.data.radiusKm).toEqual({ default: 10, max: 100 });
  });

  // ------------------------------------------------------------------ city search
  it('city / area / type search is case-insensitive and returns only listed salons with a bookable service', async () => {
    const city = uniqueCity();
    await listedSalon({ name: 'Zara Studio', city, area: 'Gulberg', type: 'LADIES' });
    await listedSalon({ name: 'Alpha Barbers', city, area: 'Gulberg', type: 'MEN' });
    await listedSalon({ name: 'Mid Unisex', city, area: 'DHA', type: 'UNISEX' });
    await listedSalon({ name: 'Hidden Pending', city, approve: false });
    await listedSalon({ name: 'No Services', city, services: false });

    expect(names(await search(`city=${city.toUpperCase()}`).expect(200))).toEqual(['Alpha Barbers', 'Mid Unisex', 'Zara Studio']);
    expect(names(await search(`city=${city}&area=gulberg`).expect(200))).toEqual(['Alpha Barbers', 'Zara Studio']);
    expect(names(await search(`city=${city}&type=MEN`).expect(200))).toEqual(['Alpha Barbers']);
    expect(names(await search(`city=${city}&sort=name&pageSize=2`).expect(200))).toEqual(['Alpha Barbers', 'Mid Unisex']);
    const card = (await search(`city=${city}&type=LADIES`).expect(200)).body.data.items[0];
    expect(Object.keys(card).sort()).toEqual(['addressLine', 'area', 'city', 'coverUrl', 'distanceKm', 'id', 'name', 'nextAvailable', 'priceFrom', 'priceTo', 'rating', 'ratingCount', 'salonType', 'serviceCount']);
    expect(card).toMatchObject({ rating: null, ratingCount: 0, distanceKm: null, priceFrom: '150.00', priceTo: '1000.00', serviceCount: 3 });
    expect(card.coverUrl).toMatch(/^(https?|memory):\/\//); // memory:// = the in-memory test storage
  });

  it('q matches salon name, area or a service name; LIKE wildcards and SQL fragments are literal text', async () => {
    const city = uniqueCity();
    await listedSalon({ name: 'Rose Salon', city, area: 'Model Town' });
    await listedSalon({ name: 'Other Place', city, area: 'Johar' });
    expect(names(await search(`city=${city}&q=rose`).expect(200))).toEqual(['Rose Salon']);
    expect(names(await search(`city=${city}&q=model`).expect(200))).toEqual(['Rose Salon']);
    expect(names(await search(`city=${city}&q=facial`).expect(200))).toEqual(['Other Place', 'Rose Salon']);
    for (const evil of ['%', '_', "' OR 1=1 --", '"; DROP TABLE salons; --', '\\']) {
      const r = await search(`city=${city}&q=${encodeURIComponent(evil)}`).expect(200);
      expect(r.body.data.items).toEqual([]);
    }
    expect(Number((await aq('SELECT count(*) FROM salons')).rows[0].count)).toBeGreaterThan(0);
  });

  // ------------------------------------------------------------------ prices
  it('price range, service filter, staff filter and price sorting use the exact staff-based prices', async () => {
    const city = uniqueCity();
    await listedSalon({ name: 'Cheap Cuts', city });
    const dear = await listedSalon({ name: 'Dear Cuts', city });
    // Dear Cuts: Haircut becomes expensive (Ali 700, Ahmed 900), Beard is deleted, Facial is switched off.
    await dear.a.patch(`/services/${dear.services.Haircut}`, { staff: [{ staffId: dear.staff.Ali, price: 700 }, { staffId: dear.staff.Ahmed, price: 900 }] }).expect(200);
    await dear.a.del(`/services/${dear.services.Beard}`).expect(204);
    await dear.a.patch(`/services/${dear.services.Facial}`, { isActive: false }).expect(200);

    const all = await search(`city=${city}&sort=price_low`).expect(200);
    expect(names(all)).toEqual(['Cheap Cuts', 'Dear Cuts']);
    expect(all.body.data.items[0]).toMatchObject({ priceFrom: '150.00', priceTo: '1000.00' });
    expect(all.body.data.items[1]).toMatchObject({ priceFrom: '700.00', priceTo: '900.00', serviceCount: 1 });

    // service filter: the price shown is the price of the MATCHING service
    const hc = await search(`city=${city}&service=haircut&sort=price_low`).expect(200);
    expect(hc.body.data.items.map((i: { priceFrom: string; priceTo: string }) => [i.priceFrom, i.priceTo])).toEqual([['300.00', '500.00'], ['700.00', '900.00']]);
    expect(names(await search(`city=${city}&service=skin`).expect(200))).toEqual(['Cheap Cuts']); // category name matches too

    // the price window applies to individual staff prices
    expect(names(await search(`city=${city}&minPrice=600&maxPrice=1000`).expect(200))).toEqual(['Cheap Cuts', 'Dear Cuts']);
    expect(names(await search(`city=${city}&service=haircut&maxPrice=400`).expect(200))).toEqual(['Cheap Cuts']);
    expect(names(await search(`city=${city}&service=haircut&minPrice=950`).expect(200))).toEqual([]);
    expect(names(await search(`city=${city}&minPrice=5000`).expect(200))).toEqual([]);
    await search(`city=${city}&minPrice=500&maxPrice=100`).expect(400);
    await search(`city=${city}&minPrice=-1`).expect(400);
    // staff filter
    expect((await search(`city=${city}&staff=ahmed&service=haircut&sort=price_low`).expect(200)).body.data.items[0]).toMatchObject({ priceFrom: '500.00', priceTo: '500.00' });
    expect(names(await search(`city=${city}&staff=nobody`).expect(200))).toEqual([]);
  });

  // ------------------------------------------------------------------ nearby
  it('nearby: distance from PostGIS, radius filter, nearest sort; salons without coordinates only appear in city search', async () => {
    const city = uniqueCity();
    await listedSalon({ name: 'Here', city, coords: LAHORE });
    await listedSalon({ name: 'Five Km', city, coords: { lat: Number((LAHORE.lat + 0.045).toFixed(6)), lng: LAHORE.lng } }); // ~5.0 km north
    await listedSalon({ name: 'Thirty Km', city, coords: { lat: Number((LAHORE.lat + 0.27).toFixed(6)), lng: LAHORE.lng } }); // ~30 km north
    await listedSalon({ name: 'No Coordinates', city });

    const near = await search(`city=${city}&lat=${LAHORE.lat}&lng=${LAHORE.lng}`).expect(200);
    expect(names(near)).toEqual(['Here', 'Five Km', 'Thirty Km', 'No Coordinates']); // default sort = nearest, unknown distance last
    expect(near.body.data.sort).toBe('nearest');
    expect(near.body.data.locationUsed).toBe(true);
    const km = near.body.data.items.map((i: { distanceKm: number | null }) => i.distanceKm);
    expect(km[0]).toBe(0);
    expect(km[1]).toBeGreaterThan(4.9); expect(km[1]).toBeLessThan(5.1);
    expect(km[2]).toBeGreaterThan(29.5); expect(km[2]).toBeLessThan(30.5);
    expect(km[3]).toBeNull();

    expect(names(await search(`city=${city}&lat=${LAHORE.lat}&lng=${LAHORE.lng}&radiusKm=10`).expect(200))).toEqual(['Here', 'Five Km']);
    expect(names(await search(`city=${city}&lat=${LAHORE.lat}&lng=${LAHORE.lng}&radiusKm=4`).expect(200))).toEqual(['Here']);
    expect(names(await search(`city=${city}&lat=${LAHORE.lat}&lng=${LAHORE.lng}&radiusKm=40&sort=name`).expect(200))).toEqual(['Five Km', 'Here', 'Thirty Km']);

    // location permission denied: the same search works by city and shows no distances
    const noLoc = await search(`city=${city}`).expect(200);
    expect(noLoc.body.data.locationUsed).toBe(false);
    expect(noLoc.body.data.items.every((i: { distanceKm: unknown }) => i.distanceKm === null)).toBe(true);
    expect(names(noLoc)).toEqual(['Five Km', 'Here', 'No Coordinates', 'Thirty Km']);

    // a point search works without a city too
    const wide = await search(`lat=${LAHORE.lat}&lng=${LAHORE.lng}&radiusKm=1`).expect(200);
    expect(wide.body.data.items.some((i: { name: string }) => i.name === 'Here')).toBe(true);
  });

  it('location input is validated: both coordinates or none, valid ranges, radius and distance sort need a location', async () => {
    await search('lat=31.5').expect(400);
    await search('lng=74.3').expect(400);
    await search('lat=91&lng=74').expect(400);
    await search('lat=31&lng=181').expect(400);
    await search('lat=abc&lng=74').expect(400);
    await search('radiusKm=5').expect(400);
    await search('sort=nearest').expect(400);
    await search('lat=31.5&lng=74.3&radiusKm=101').expect(400);
    await search('lat=31.5&lng=74.3&radiusKm=0').expect(400);
    await search('lat=&lng=').expect(200); // empty form fields mean "not sent"
  });

  // ------------------------------------------------------------------ availability filter and card preview
  it('date/time filter uses salon hours, staff hours, breaks and approved leave; next available is on the card', async () => {
    const city = uniqueCity();
    const s = await listedSalon({ name: 'Open Late', city });
    const mon = nextMonday();
    const sun = addDaysIso(mon, 6);
    const sat = addDaysIso(mon, 5);

    expect(names(await search(`city=${city}&date=${mon}`).expect(200))).toEqual(['Open Late']);
    expect(names(await search(`city=${city}&date=${mon}&time=10:00`).expect(200))).toEqual(['Open Late']);
    expect(names(await search(`city=${city}&date=${mon}&time=17:30`).expect(200))).toEqual(['Open Late']); // the 15-minute beard ends at 17:45
    expect(names(await search(`city=${city}&date=${mon}&time=19:00`).expect(200))).toEqual([]); // staff left at 18:00
    expect(names(await search(`city=${city}&date=${mon}&time=09:00`).expect(200))).toEqual([]); // before opening
    expect(names(await search(`city=${city}&date=${mon}&time=13:00&service=facial`).expect(200))).toEqual([]); // 60-minute facial runs into the break
    expect(names(await search(`city=${city}&date=${mon}&time=14:00&service=facial`).expect(200))).toEqual(['Open Late']);
    expect(names(await search(`city=${city}&date=${sat}`).expect(200))).toEqual([]); // staff weekend
    expect(names(await search(`city=${city}&date=${sun}`).expect(200))).toEqual([]); // salon closed

    // approved leave for BOTH staff on that Monday removes the salon for that day only
    for (const id of Object.values(s.staff)) await s.a.post(`/team/${id}/leaves`, { startsOn: mon, endsOn: mon, reason: 'private reason' }).expect(201);
    expect(names(await search(`city=${city}&date=${mon}`).expect(200))).toEqual([]);
    expect(names(await search(`city=${city}&date=${addDaysIso(mon, 1)}`).expect(200))).toEqual(['Open Late']);

    const card = (await search(`city=${city}`).expect(200)).body.data.items[0];
    expect(card.nextAvailable.date >= today()).toBe(true);
    expect(card.nextAvailable.time).toMatch(/^\d\d:\d\d$/);
    expect(JSON.stringify(card)).not.toContain('private reason');
  });

  it('date and time are validated: real date, inside the 14-day window, time needs a date', async () => {
    await search(`date=${addDaysIso(today(), -1)}`).expect(400);
    await search(`date=${addDaysIso(today(), 14)}`).expect(400);
    await search('date=2026-02-30').expect(400);
    await search('date=16-11-2026').expect(400);
    await search('time=10:00').expect(400);
    await search(`date=${addDaysIso(today(), 1)}&time=24:00`).expect(400);
    await search(`date=${addDaysIso(today(), 13)}`).expect(200);
  });

  it('pagination is capped and consistent; unknown parameters are rejected', async () => {
    const city = uniqueCity();
    for (const n of ['P1', 'P2', 'P3']) await listedSalon({ name: `Page ${n}`, city });
    const p1 = await search(`city=${city}&sort=name&pageSize=2&page=1`).expect(200);
    const p2 = await search(`city=${city}&sort=name&pageSize=2&page=2`).expect(200);
    const p3 = await search(`city=${city}&sort=name&pageSize=2&page=3`).expect(200);
    expect([names(p1), names(p2), names(p3)]).toEqual([['Page P1', 'Page P2'], ['Page P3'], []]);
    expect([p1.body.data.hasMore, p2.body.data.hasMore, p3.body.data.hasMore]).toEqual([true, false, false]);
    expect([p1.body.data.total, p2.body.data.total, p3.body.data.total]).toEqual([3, 3, 3]);
    await search('pageSize=31').expect(400);
    await search('page=0').expect(400);
    await search('status=PENDING').expect(400); // mass-assignment style probe
    await search('sort=rating').expect(400); // not offered until reviews exist
    await search(`q=${'x'.repeat(81)}`).expect(400);
    await search('q=%3Cscript%3E').expect(400);
  });

  // ------------------------------------------------------------------ visibility
  it('pending, draft and suspended salons never appear; reactivation brings the salon back', async () => {
    const city = uniqueCity();
    const live = await listedSalon({ name: 'Live Salon', city });
    await listedSalon({ name: 'Draft Salon', city, approve: false });
    expect(names(await search(`city=${city}`).expect(200))).toEqual(['Live Salon']);
    await h.http().post(`/api/v1/admin/salons/${live.salonId}/suspend`).set(bearer(superAdmin.access)).send({ reason: 'Policy review in progress' }).expect(200);
    expect(names(await search(`city=${city}`).expect(200))).toEqual([]);
    await pub(`/salons/${live.salonId}/availability?date=${nextMonday()}&serviceIds=${live.services.Haircut}`).expect(404);
    await h.http().get(`/api/v1/public/salons/${live.salonId}`).expect(404);
    await h.http().post(`/api/v1/admin/salons/${live.salonId}/reactivate`).set(bearer(superAdmin.access)).send({}).expect(200);
    expect(names(await search(`city=${city}`).expect(200))).toEqual(['Live Salon']);
  });

  // ------------------------------------------------------------------ availability preview + price comparison
  it('availability: staff sorted by price, exact totals for several services, slots respect hours and the break', async () => {
    const s = await listedSalon({ name: 'Slot Salon', city: uniqueCity() });
    const mon = nextMonday();
    const base = `/salons/${s.salonId}/availability?date=${mon}`;

    const r = await pub(`${base}&serviceIds=${s.services.Haircut}`).expect(200);
    expect(r.body.data).toMatchObject({ date: mon, durationMinutes: 30, slotStepMinutes: 15, preview: true });
    expect(r.body.data.staff.map((x: { name: string; totalPrice: string }) => [x.name, x.totalPrice])).toEqual([['Ali', '300.00'], ['Ahmed', '500.00']]); // cheapest first
    const ali = r.body.data.staff[0].slots as string[];
    expect(ali[0]).toBe('10:00');
    expect(ali).toContain('12:30'); // 12:30-13:00 fits before the break
    expect(ali).not.toContain('12:45'); // would run into 13:00-14:00
    expect(ali).not.toContain('13:00');
    expect(ali).toContain('14:00');
    expect(ali[ali.length - 1]).toBe('17:30');

    // two services: only staff who perform BOTH; price and duration are summed exactly
    const both = await pub(`${base}&serviceIds=${s.services.Haircut},${s.services.Beard}`).expect(200);
    expect(both.body.data.durationMinutes).toBe(45);
    expect(both.body.data.staff).toHaveLength(1);
    expect(both.body.data.staff[0]).toMatchObject({ name: 'Ali', totalPrice: '450.00' });
    expect(both.body.data.staff[0].lines).toEqual(expect.arrayContaining([{ serviceId: s.services.Haircut, price: '300.00' }, { serviceId: s.services.Beard, price: '150.00' }]));
    const none = await pub(`${base}&serviceIds=${s.services.Beard},${s.services.Facial}`).expect(200); // nobody does both
    expect(none.body.data.staff).toEqual([]);

    // staff filter, weekend, leave
    const only = await pub(`${base}&serviceIds=${s.services.Haircut}&staffId=${s.staff.Ahmed}`).expect(200);
    expect(only.body.data.staff.map((x: { name: string }) => x.name)).toEqual(['Ahmed']);
    await pub(`${base}&serviceIds=${s.services.Beard}&staffId=${s.staff.Ahmed}`).expect(404);
    const sat = await pub(`/salons/${s.salonId}/availability?date=${addDaysIso(mon, 5)}&serviceIds=${s.services.Haircut}`).expect(200);
    expect(sat.body.data.staff.every((x: { slots: string[] }) => x.slots.length === 0)).toBe(true);
    await s.a.post(`/team/${s.staff.Ali}/leaves`, { startsOn: mon, endsOn: mon }).expect(201);
    const leave = await pub(`${base}&serviceIds=${s.services.Haircut}`).expect(200);
    expect(leave.body.data.staff.find((x: { name: string }) => x.name === 'Ali').slots).toEqual([]);
    expect(leave.body.data.staff.find((x: { name: string }) => x.name === 'Ahmed').slots.length).toBeGreaterThan(0);
  });

  it("availability validation and isolation: another salon's service, unknown ids, bad dates and bad ids are refused", async () => {
    const a = await listedSalon({ name: 'Salon A', city: uniqueCity() });
    const b = await listedSalon({ name: 'Salon B', city: uniqueCity() });
    const mon = nextMonday();
    await pub(`/salons/${a.salonId}/availability?date=${mon}&serviceIds=${b.services.Haircut}`).expect(404); // IDOR attempt
    await pub(`/salons/${a.salonId}/availability?date=${mon}&serviceIds=${a.services.Haircut},${b.services.Haircut}`).expect(404);
    await pub(`/salons/${a.salonId}/availability?date=${mon}&serviceIds=00000000-0000-4000-8000-000000000000`).expect(404);
    await pub(`/salons/00000000-0000-4000-8000-000000000000/availability?date=${mon}&serviceIds=${a.services.Haircut}`).expect(404);
    await pub(`/salons/not-a-uuid/availability?date=${mon}&serviceIds=${a.services.Haircut}`).expect(400);
    await pub(`/salons/${a.salonId}/availability?date=${mon}`).expect(400);
    await pub(`/salons/${a.salonId}/availability?date=${mon}&serviceIds=x`).expect(400);
    await pub(`/salons/${a.salonId}/availability?date=${mon}&serviceIds=${a.services.Haircut},${a.services.Haircut}`).expect(400);
    await pub(`/salons/${a.salonId}/availability?date=${addDaysIso(today(), -1)}&serviceIds=${a.services.Haircut}`).expect(400);
    await pub(`/salons/${a.salonId}/availability?date=${mon}&serviceIds=${a.services.Haircut}&extra=1`).expect(400);
    // an inactive service is never offered
    await a.a.patch(`/services/${a.services.Facial}`, { isActive: false }).expect(200);
    await pub(`/salons/${a.salonId}/availability?date=${mon}&serviceIds=${a.services.Facial}`).expect(404);
  });

  // ------------------------------------------------------------------ database-level isolation (RLS)
  it('RLS: public context sees schedules of APPROVED salons only, never pending leave, and can never write', async () => {
    const live = await listedSalon({ name: 'Rls Live', city: uniqueCity() });
    const draft = await listedSalon({ name: 'Rls Draft', city: uniqueCity(), approve: false });
    await live.a.post(`/team/${live.staff.Ali}/leaves`, { startsOn: nextMonday(), endsOn: nextMonday(), reason: 'secret' }).expect(201);
    await aq(`UPDATE staff_leaves SET status = 'PENDING' WHERE staff_id = $1`, [live.staff.Ali]);

    const count = (c: PoolClient, table: string, staff: string) => c.query(`SELECT count(*)::int AS n FROM ${table} WHERE staff_id = $1`, [staff]).then((r) => r.rows[0].n as number);
    await asApp({ publicRead: false }, async (c) => {
      expect(await count(c, 'staff_working_hours', live.staff.Ali)).toBe(0); // no context: fail closed
      expect(await count(c, 'staff_breaks', live.staff.Ali)).toBe(0);
    });
    await asApp({ publicRead: true }, async (c) => {
      expect(await count(c, 'staff_working_hours', live.staff.Ali)).toBe(7);
      expect(await count(c, 'staff_breaks', live.staff.Ali)).toBe(5);
      expect(await count(c, 'staff_leaves', live.staff.Ali)).toBe(0); // PENDING leave is not public
      expect(await count(c, 'staff_working_hours', draft.staff.Ali)).toBe(0); // unapproved salon
      expect(await count(c, 'staff_breaks', draft.staff.Ali)).toBe(0);
      expect((await c.query(`SELECT count(*)::int AS n FROM salon_subscriptions WHERE salon_id = $1`, [draft.salonId])).rows[0].n).toBe(0);
      expect((await c.query(`UPDATE staff_working_hours SET is_off = true WHERE staff_id = $1`, [live.staff.Ali])).rowCount).toBe(0);
      await c.query('SAVEPOINT s');
      await expect(c.query(`INSERT INTO staff_breaks (salon_id, staff_id, weekday, starts_minute, ends_minute) VALUES ($1,$2,1,600,610)`, [live.salonId, live.staff.Ali])).rejects.toBeDefined();
      await c.query('ROLLBACK TO SAVEPOINT s');
    });
    // another salon's owner cannot see this salon's schedule through the owner policies
    const other = await listedSalon({ name: 'Rls Other', city: uniqueCity(), approve: false });
    const otherOwnerId = (await aq('SELECT owner_user_id FROM salons WHERE id = $1', [other.salonId])).rows[0].owner_user_id as string;
    await asApp({ user: otherOwnerId, salon: other.salonId }, async (c) => {
      expect(await count(c, 'staff_working_hours', live.staff.Ali)).toBe(0);
    });
    // PostGIS sits in `extensions` on Supabase (our migration installs it there) or in `public` on the docker image used by
    // local dev and CI. Either way the Supabase API roles (when they exist) must have no access to its tables.
    const ext = (await aq(`SELECT n.nspname AS schema FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'postgis'`)).rows[0].schema as string;
    expect(['extensions', 'public']).toContain(ext);
    const apiRoles = await aq(`SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated')`);
    for (const r of apiRoles.rows) {
      const g = await aq(`SELECT count(*)::int AS n FROM information_schema.role_table_grants WHERE grantee = $1 AND table_name = 'spatial_ref_sys' AND privilege_type <> 'REFERENCES'`, [r.rolname]);
      expect(g.rows[0].n).toBe(0);
    }
    // the runtime role reaches PostGIS only through the wrapper function
    await asApp({}, async (c) => {
      expect((await c.query(`SELECT discovery_distance_m(31.5, 74.3, 31.5, 74.3) AS m`)).rows[0].m).toBe(0);
    });
  });

  // ------------------------------------------------------------------ Super Admin trial setting
  it('trial setting: default 14, Super Admin only, validated and audited', async () => {
    await h.http().get('/api/v1/admin/discovery/settings').expect(401);
    const o = await owner();
    await h.http().get('/api/v1/admin/discovery/settings').set(bearer(o.access)).expect(403);
    await h.http().get('/api/v1/admin/discovery/settings').set(bearer(finance.access)).expect(200);
    const sup = (await h.http().get('/api/v1/admin/discovery/settings').set(bearer(support.access)).expect(200)).body.data;
    expect(sup).toEqual({ trialDays: 14, defaultTrialDays: 14, maxTrialDays: 90 });
    const put = (t: string, b: object) => h.http().put('/api/v1/admin/discovery/settings').set(bearer(t)).send(b);
    await put(finance.access, { trialDays: 5 }).expect(403);
    await put(support.access, { trialDays: 5 }).expect(403);
    await put(o.access, { trialDays: 5 }).expect(403);
    for (const bad of [-1, 91, 1.5, '7', null]) await put(superAdmin.access, { trialDays: bad }).expect(400);
    await put(superAdmin.access, { trialDays: 7, role: 'x' }).expect(400);
    await put(superAdmin.access, { trialDays: 7 }).expect(200);
    try {
      expect((await h.http().get('/api/v1/admin/discovery/settings').set(bearer(superAdmin.access)).expect(200)).body.data.trialDays).toBe(7);
      const log = await aq(`SELECT metadata FROM audit_logs WHERE action = 'discovery.settings_updated' ORDER BY created_at DESC LIMIT 1`);
      expect(log.rows[0].metadata).toEqual({ trialDaysBefore: 14, trialDaysAfter: 7 });
    } finally {
      await put(superAdmin.access, { trialDays: 14 }).expect(200);
    }
  });

  // ------------------------------------------------------------------ trial + subscription (LAST: moves the fake clock)
  it('listing rule: free trial, then subscription required; complimentary grant relists, expiry and suspension hide again', async () => {
    const city = uniqueCity();
    const trial = await listedSalon({ name: 'Trial Salon', city });
    const paying = await listedSalon({ name: 'Paying Salon', city });
    const lapsed = await listedSalon({ name: 'Lapsed Salon', city });
    const sa = bearer(superAdmin.access);
    const grant = (id: string) => h.http().post(`/api/v1/admin/salons/${id}/subscription/grant`).set(sa).send({ cycle: 'MONTHLY', reason: 'Complimentary for tests' });
    await grant(paying.salonId).expect(200);
    await grant(lapsed.salonId).expect(200);

    const summary = (await mine(trial.o.access).get('/billing').expect(200)).body.data;
    expect(summary.listing).toMatchObject({ listed: true, reason: 'TRIAL' });
    expect(summary.listing.trialEndsOn >= today()).toBe(true);
    expect((await mine(paying.o.access).get('/billing').expect(200)).body.data.listing).toMatchObject({ listed: true, reason: 'SUBSCRIPTION', trialEndsOn: null });
    expect(names(await search(`city=${city}`).expect(200))).toEqual(['Lapsed Salon', 'Paying Salon', 'Trial Salon']);
    await h.http().get(`/api/v1/public/salons/${trial.salonId}`).expect(200);

    // the trial length is a Super Admin setting: 0 days = no free trial, only subscribed salons stay visible
    await h.http().put('/api/v1/admin/discovery/settings').set(sa).send({ trialDays: 0 }).expect(200);
    try {
      expect(names(await search(`city=${city}`).expect(200))).toEqual(['Lapsed Salon', 'Paying Salon']);
      expect((await mine(trial.o.access).get('/billing').expect(200)).body.data.listing).toMatchObject({ listed: false, reason: 'TRIAL_ENDED' });
    } finally {
      await h.http().put('/api/v1/admin/discovery/settings').set(sa).send({ trialDays: 14 }).expect(200);
    }
    expect(names(await search(`city=${city}`).expect(200))).toHaveLength(3);

    // a subscription suspended by the Super Admin hides the salon even though the period is still paid
    await h.http().post(`/api/v1/admin/salons/${lapsed.salonId}/subscription/suspend`).set(sa).send({ reason: 'Chargeback under review' }).expect(200);
    expect(names(await search(`city=${city}`).expect(200))).toEqual(['Paying Salon', 'Trial Salon']);
    expect((await mine(lapsed.o.access).get('/billing').expect(200)).body.data.listing).toMatchObject({ listed: false, reason: 'SUBSCRIPTION_SUSPENDED' });
    await h.http().post(`/api/v1/admin/salons/${lapsed.salonId}/subscription/reactivate`).set(sa).send({ reason: 'Review finished' }).expect(200);

    // day 15: the free trial is over. Subscribed salons stay (period + grace); the trial-only salon disappears everywhere.
    h.clock.advance(15 * DAY);
    expect(names(await search(`city=${city}`).expect(200))).toEqual(['Lapsed Salon', 'Paying Salon']);
    await h.http().get(`/api/v1/public/salons/${trial.salonId}`).expect(404);
    await h.http().get(`/api/v1/public/salons/${trial.salonId}/catalog`).expect(404);
    await pub(`/salons/${trial.salonId}/availability?date=${nextMonday()}&serviceIds=${trial.services.Haircut}`).expect(404);
    expect((await mine(trial.o.access).get('/billing').expect(200)).body.data.listing).toMatchObject({ listed: false, reason: 'TRIAL_ENDED' });

    // after the paid month plus 3 grace days everybody without a renewal is hidden: an expired subscription is NOT rescued by the trial
    h.clock.advance(20 * DAY); // day 35 > one month + 3 grace days
    expect(names(await search(`city=${city}`).expect(200))).toEqual([]);
    expect((await mine(paying.o.access).get('/billing').expect(200)).body.data.listing).toMatchObject({ listed: false, reason: 'SUBSCRIPTION_ENDED' });
    expect((await pub('/options').expect(200)).body.data.cities.some((c: { city: string }) => c.city === city)).toBe(false);
  });
});
