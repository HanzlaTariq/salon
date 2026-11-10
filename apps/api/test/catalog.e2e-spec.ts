import { Pool, PoolClient } from 'pg';
import sharp from 'sharp';
import { hotp, base32Decode, timeStep } from '../src/modules/auth/totp';
import { MemoryObjectStorage, ObjectStorage } from '../src/common/storage/object-storage';
import {
  Harness, bearer, createHarness, createPlatformUser, dbEnabled, loginMobile, registerAndVerify,
} from './support/harness';

const d = dbEnabled ? describe : describe.skip;
if (!dbEnabled) {
  // eslint-disable-next-line no-console
  console.warn('SKIPPED catalog e2e: set TEST_DATABASE_URL (salon_app) and TEST_ADMIN_DATABASE_URL (salon_migrator).');
}

const totp = (secretB32: string, h: Harness) => hotp(base32Decode(secretB32), timeStep(h.clock.now().getTime()));
const png = (color = '#c07840') => sharp({ create: { width: 600, height: 400, channels: 3, background: color } }).png().toBuffer();
const SALON = { name: 'Glow Studio', salonType: 'UNISEX', city: 'Lahore', area: 'Gulberg', addressLine: '12 Main Boulevard, Gulberg III', phone: '0300 1234567' };
const WEEK = [1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, closed: false, opensAt: '10:00', closesAt: '21:00' })).concat([{ weekday: 7, closed: true } as never]);

d('Phase 4: profile, hours, categories, services, pricing, staff (real PostgreSQL)', () => {
  let h: Harness;
  let appPool: Pool; // salon_app (RLS enforced)
  let storage: MemoryObjectStorage;

  beforeAll(async () => {
    h = await createHarness();
    storage = h.app.get(ObjectStorage) as MemoryObjectStorage;
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
  const failsWith = async (c: PoolClient, sql: string, params: unknown[] = []): Promise<string> => {
    await c.query('SAVEPOINT s');
    try {
      await c.query(sql, params);
    } catch (e) {
      await c.query('ROLLBACK TO SAVEPOINT s');
      return (e as { code?: string }).code ?? 'ERR';
    }
    return 'OK';
  };
  async function owner() {
    const u = await registerAndVerify(h, { accountType: 'SALON_OWNER', fullName: 'Owner Person' });
    const access = (await loginMobile(h, u.email, u.password)).body.data.accessToken as string;
    const id = (await aq('SELECT id FROM users WHERE email=$1', [u.email])).rows[0].id as string;
    return { ...u, access, id };
  }
  async function platformAdmin() {
    const u = await createPlatformUser(h, 'SUPER_ADMIN');
    const access = (await loginMobile(h, u.email, u.password)).body.data.accessToken as string;
    const setup = (await h.http().post('/api/v1/auth/mfa/setup').set(bearer(access)).send({ password: u.password }).expect(200)).body.data;
    await h.http().post('/api/v1/auth/mfa/enable').set(bearer(access)).send({ code: totp(setup.secret, h) }).expect(200);
    return { ...u, access };
  }
  const upload = (token: string, kind: string, docType: string, buf: Buffer) =>
    h.http().post('/api/v1/salons/mine/files').set(bearer(token)).field('kind', kind).field('docType', docType).attach('file', buf, 'x.png');
  const api = (t: string) => ({
    get: (p: string) => h.http().get(`/api/v1/salons/mine${p}`).set(bearer(t)),
    post: (p: string, b?: object) => h.http().post(`/api/v1/salons/mine${p}`).set(bearer(t)).send(b ?? {}),
    patch: (p: string, b: object) => h.http().patch(`/api/v1/salons/mine${p}`).set(bearer(t)).send(b),
    put: (p: string, b: object) => h.http().put(`/api/v1/salons/mine${p}`).set(bearer(t)).send(b),
    del: (p: string) => h.http().delete(`/api/v1/salons/mine${p}`).set(bearer(t)),
  });

  /** Owner with a DRAFT salon (catalogue can be prepared before approval). */
  async function draftOwner() {
    const o = await owner();
    const salonId = (await h.http().post('/api/v1/salons').set(bearer(o.access)).send(SALON).expect(201)).body.data.salon.id as string;
    return { o, salonId, a: api(o.access) };
  }
  async function approve(o: { access: string }, salonId: string) {
    await upload(o.access, 'DOCUMENT', 'CNIC_FRONT', await png()).expect(201);
    await upload(o.access, 'DOCUMENT', 'CNIC_BACK', await png()).expect(201);
    await upload(o.access, 'PHOTO', 'COVER', await png()).expect(201);
    await h.http().post('/api/v1/salons/mine/submit').set(bearer(o.access)).expect(200);
    const sa = await platformAdmin();
    await h.http().post(`/api/v1/admin/salons/${salonId}/approve`).set(bearer(sa.access)).expect(200);
  }
  async function category(a: ReturnType<typeof api>, name = 'Hair') {
    return (await a.post('/categories', { name }).expect(201)).body.data.id as string;
  }
  async function staff(a: ReturnType<typeof api>, displayName: string) {
    return (await a.post('/staff', { displayName }).expect(201)).body.data.id as string;
  }

  // ------------------------------------------------------------------ authorization
  it('requires authentication and the SALON_OWNER role; no salon yet gives 404', async () => {
    await h.http().get('/api/v1/salons/mine/catalog').expect(401);
    const c = await registerAndVerify(h, { accountType: 'CUSTOMER' });
    const ct = (await loginMobile(h, c.email, c.password)).body.data.accessToken as string;
    await api(ct).get('/catalog').expect(403);
    await api(ct).post('/categories', { name: 'Hair' }).expect(403);
    const o = await owner();
    await api(o.access).get('/catalog').expect(404);
  });

  // ------------------------------------------------------------------ categories
  describe('categories', () => {
    it('are owner-defined: create, rename, deactivate, unique name (case-insensitive), clear description', async () => {
      const { a } = await draftOwner();
      const id = await category(a, 'Hair Coloring');
      await a.post('/categories', { name: 'hair coloring' }).expect(409);
      const r = await a.patch(`/categories/${id}`, { name: 'Colour', description: 'All colour work', isActive: false }).expect(200);
      expect(r.body.data).toMatchObject({ name: 'Colour', description: 'All colour work', isActive: false });
      expect((await a.patch(`/categories/${id}`, { description: null }).expect(200)).body.data.description).toBeNull();
      await a.patch(`/categories/${id}`, { salonId: 'x' }).expect(400); // mass assignment
      await a.post('/categories', { name: '<script>' }).expect(400);
    });

    it('reorder needs the complete id list; display order is persisted', async () => {
      const { a } = await draftOwner();
      const [x, y, z] = [await category(a, 'Alpha'), await category(a, 'Beta'), await category(a, 'Gamma')];
      await a.put('/categories/order', { ids: [z, x] }).expect(400);
      await a.put('/categories/order', { ids: [z, z, x] }).expect(400);
      const r = await a.put('/categories/order', { ids: [z, x, y] }).expect(200);
      expect(r.body.data.categories.map((c: { id: string }) => c.id)).toEqual([z, x, y]);
    });

    it('cannot be deleted while it has services; deleting frees the name', async () => {
      const { a } = await draftOwner();
      const id = await category(a, 'Hair');
      const svc = (await a.post('/services', { categoryId: id, name: 'Haircut', durationMinutes: 30, pricing: { mode: 'FIXED', price: 300 } }).expect(201)).body.data.id;
      await a.del(`/categories/${id}`).expect(409);
      await a.del(`/services/${svc}`).expect(204);
      await a.del(`/categories/${id}`).expect(204);
      await a.post('/categories', { name: 'Hair' }).expect(201);
    });
  });

  // ------------------------------------------------------------------ pricing modes
  describe('services and pricing', () => {
    it('FIXED: one salon-wide price, duration, snapshot-friendly decimal strings', async () => {
      const { a } = await draftOwner();
      const cat = await category(a);
      const r = await a.post('/services', { categoryId: cat, name: 'Haircut', durationMinutes: 45, pricing: { mode: 'FIXED', price: 299.5 } }).expect(201);
      expect(r.body.data).toMatchObject({ pricingMode: 'FIXED', price: '299.50', durationMinutes: 45, staff: [] });
      await a.post('/services', { categoryId: cat, name: 'haircut', durationMinutes: 45, pricing: { mode: 'FIXED', price: 1 } }).expect(409);
      await a.post('/services', { categoryId: cat, name: 'Free', durationMinutes: 4, pricing: { mode: 'FIXED', price: 1 } }).expect(400); // < 5 min
      await a.post('/services', { categoryId: cat, name: 'Free', durationMinutes: 30, pricing: { mode: 'FIXED' } }).expect(400); // price required
      await a.post('/services', { categoryId: cat, name: 'Free', durationMinutes: 30, pricing: { mode: 'FIXED', price: -1 } }).expect(400);
      await a.post('/services', { categoryId: cat, name: 'Free', durationMinutes: 30, pricing: { mode: 'FIXED', price: 10.123 } }).expect(400);
    });

    it('STAFF_BASED: Ali 300, Ahmed 500, Usman 400 for the same service; prices never leak into FIXED', async () => {
      const { a } = await draftOwner();
      const cat = await category(a);
      const [ali, ahmed, usman] = [await staff(a, 'Ali'), await staff(a, 'Ahmed'), await staff(a, 'Usman')];
      await a.post('/services', { categoryId: cat, name: 'Haircut', durationMinutes: 30, pricing: { mode: 'STAFF_BASED' }, staff: [{ staffId: ali }] }).expect(400); // price missing
      await a.post('/services', { categoryId: cat, name: 'Haircut', durationMinutes: 30, pricing: { mode: 'STAFF_BASED', price: 100 } }).expect(400);
      await a.post('/services', { categoryId: cat, name: 'Haircut', durationMinutes: 30, pricing: { mode: 'FIXED', price: 100 }, staff: [{ staffId: ali, price: 5 }] }).expect(400);
      const r = await a.post('/services', {
        categoryId: cat, name: 'Haircut', durationMinutes: 30, pricing: { mode: 'STAFF_BASED' },
        staff: [{ staffId: ali, price: 300 }, { staffId: ahmed, price: 500 }, { staffId: usman, price: 400 }],
      }).expect(201);
      expect(r.body.data.price).toBeNull();
      expect(r.body.data.staff).toEqual(expect.arrayContaining([{ staffId: ali, price: '300.00' }, { staffId: ahmed, price: '500.00' }, { staffId: usman, price: '400.00' }]));
      await a.post('/services', { categoryId: cat, name: 'Beard', durationMinutes: 20, pricing: { mode: 'FIXED', price: 150 }, staff: [{ staffId: ali }, { staffId: ali }] }).expect(400);
    });

    it('switching the pricing mode is atomic and never keeps stale prices', async () => {
      const { a } = await draftOwner();
      const cat = await category(a);
      const [ali, ahmed] = [await staff(a, 'Ali'), await staff(a, 'Ahmed')];
      const id = (await a.post('/services', { categoryId: cat, name: 'Facial', durationMinutes: 60, pricing: { mode: 'FIXED', price: 1000 }, staff: [{ staffId: ali }, { staffId: ahmed }] }).expect(201)).body.data.id;
      await a.patch(`/services/${id}`, { pricing: { mode: 'STAFF_BASED' } }).expect(400); // needs the priced staff list
      const sw = await a.patch(`/services/${id}`, { pricing: { mode: 'STAFF_BASED' }, staff: [{ staffId: ali, price: 900 }, { staffId: ahmed, price: 1200 }] }).expect(200);
      expect(sw.body.data).toMatchObject({ pricingMode: 'STAFF_BASED', price: null });
      await a.patch(`/services/${id}`, { pricing: { mode: 'FIXED' } }).expect(400); // needs a price
      const back = await a.patch(`/services/${id}`, { pricing: { mode: 'FIXED', price: 1100 } }).expect(200);
      expect(back.body.data.price).toBe('1100.00');
      expect(back.body.data.staff.every((s: { price: string | null }) => s.price === null)).toBe(true);
      expect(back.body.data.staff).toHaveLength(2);
      const rows = (await aq('SELECT pricing_mode, price FROM staff_services WHERE service_id=$1', [id])).rows;
      expect(rows.every((r) => r.pricing_mode === 'FIXED' && r.price === null)).toBe(true);
    });

    it('partial updates keep what is not sent; staff list replaces assignments; deactivate/delete services', async () => {
      const { a } = await draftOwner();
      const cat = await category(a);
      const ali = await staff(a, 'Ali');
      const id = (await a.post('/services', { categoryId: cat, name: 'Manicure', durationMinutes: 40, pricing: { mode: 'FIXED', price: 500 }, staff: [{ staffId: ali }] }).expect(201)).body.data.id;
      const r = await a.patch(`/services/${id}`, { durationMinutes: 50, isActive: false }).expect(200);
      expect(r.body.data).toMatchObject({ durationMinutes: 50, isActive: false, price: '500.00', name: 'Manicure' });
      expect(r.body.data.staff).toHaveLength(1);
      expect((await a.patch(`/services/${id}`, { staff: [] }).expect(200)).body.data.staff).toHaveLength(0);
      const cat2 = await category(a, 'Nails');
      expect((await a.patch(`/services/${id}`, { categoryId: cat2 }).expect(200)).body.data.categoryId).toBe(cat2);
      await a.del(`/services/${id}`).expect(204);
      await a.patch(`/services/${id}`, { name: 'Zombie' }).expect(404);
      expect((await a.get('/catalog').expect(200)).body.data.categories.flatMap((c: { services: unknown[] }) => c.services)).toHaveLength(0);
    });

    it('staff roster: owner can add themselves once; deleting staff removes their assignments', async () => {
      const { o, a } = await draftOwner();
      const self = await a.post('/staff', { self: true }).expect(201);
      expect(self.body.data).toMatchObject({ isOwner: true, displayName: 'Owner Person' });
      await a.post('/staff', { self: true }).expect(409);
      await a.post('/staff', {}).expect(400);
      const cat = await category(a);
      const ali = await staff(a, 'Ali');
      const svc = (await a.post('/services', { categoryId: cat, name: 'Cut', durationMinutes: 30, pricing: { mode: 'FIXED', price: 100 }, staff: [{ staffId: ali }, { staffId: self.body.data.id }] }).expect(201)).body.data.id;
      await a.patch(`/staff/${ali}`, { isActive: false, displayName: 'Ali K' }).expect(200);
      await a.del(`/staff/${ali}`).expect(204);
      const cat2 = (await a.get('/catalog').expect(200)).body.data;
      expect(cat2.staff.map((s: { id: string }) => s.id)).not.toContain(ali);
      expect(cat2.categories[0].services.find((s: { id: string }) => s.id === svc).staff).toHaveLength(1);
      expect(o.id).toBeTruthy();
    });
  });

  // ------------------------------------------------------------------ tenant isolation
  describe('tenant isolation', () => {
    it('another salon owner cannot read or touch any catalogue id (IDOR/BOLA): always 404', async () => {
      const A = await draftOwner();
      const B = await draftOwner();
      const cat = await category(A.a);
      const st = await staff(A.a, 'Ali');
      const svc = (await A.a.post('/services', { categoryId: cat, name: 'Cut', durationMinutes: 30, pricing: { mode: 'STAFF_BASED' }, staff: [{ staffId: st, price: 100 }] }).expect(201)).body.data.id;
      await B.a.patch(`/categories/${cat}`, { name: 'Hacked' }).expect(404);
      await B.a.del(`/categories/${cat}`).expect(404);
      await B.a.patch(`/services/${svc}`, { name: 'Hacked' }).expect(404);
      await B.a.del(`/services/${svc}`).expect(404);
      await B.a.patch(`/staff/${st}`, { displayName: 'Hacked' }).expect(404);
      await B.a.del(`/staff/${st}`).expect(404);
      await B.a.get(`/categories/${cat}/image/url`).expect(404);
      // B cannot put A's category or staff into B's service
      const bcat = await category(B.a);
      await B.a.post('/services', { categoryId: cat, name: 'X', durationMinutes: 30, pricing: { mode: 'FIXED', price: 1 } }).expect(404);
      await B.a.post('/services', { categoryId: bcat, name: 'X', durationMinutes: 30, pricing: { mode: 'STAFF_BASED' }, staff: [{ staffId: st, price: 1 }] }).expect(404);
      const mine = (await B.a.get('/catalog').expect(200)).body.data;
      expect(JSON.stringify(mine)).not.toContain(cat);
      expect(JSON.stringify(mine)).not.toContain(svc);
      expect((await aq('SELECT name FROM service_categories WHERE id=$1', [cat])).rows[0].name).toBe('Hair');
    });

    it('RLS: no context sees nothing; one salon cannot read or write another salon\'s rows; composite FKs refuse cross-salon links', async () => {
      const A = await draftOwner();
      const B = await draftOwner();
      const cat = await category(A.a);
      const st = await staff(A.a, 'Ali');
      await A.a.post('/services', { categoryId: cat, name: 'Cut', durationMinutes: 30, pricing: { mode: 'FIXED', price: 10 }, staff: [{ staffId: st }] }).expect(201);
      for (const t of ['service_categories', 'services', 'staff_profiles', 'staff_services']) {
        await asApp({}, async (c) => expect((await c.query(`SELECT 1 FROM ${t}`)).rowCount).toBe(0));
        await asApp({ user: B.o.id, salon: B.salonId }, async (c) => expect((await c.query(`SELECT 1 FROM ${t} WHERE salon_id=$1`, [A.salonId])).rowCount).toBe(0));
        await asApp({ user: A.o.id, salon: A.salonId }, async (c) => expect((await c.query(`SELECT 1 FROM ${t} WHERE salon_id=$1`, [A.salonId])).rowCount).toBeGreaterThan(0));
      }
      await asApp({ user: B.o.id, salon: B.salonId }, async (c) => {
        expect(await failsWith(c, `INSERT INTO service_categories (salon_id, name) VALUES ($1, 'Evil')`, [A.salonId])).toBe('42501');
        expect((await c.query(`UPDATE service_categories SET name='x' WHERE salon_id=$1`, [A.salonId])).rowCount).toBe(0);
      });
      // B's own service pointing at A's category / staff: foreign key violation (23503) even for a platform admin context
      const bcat = await category(B.a);
      await asApp({ user: B.o.id, salon: B.salonId }, async (c) => {
        expect(await failsWith(c, `INSERT INTO services (salon_id, category_id, name, duration_minutes, base_price) VALUES ($1, (SELECT id FROM service_categories WHERE salon_id=$2 LIMIT 1), 'x', 30, 1)`, [B.salonId, A.salonId])).not.toBe('OK');
      });
      const bsvc = (await B.a.post('/services', { categoryId: bcat, name: 'Own', durationMinutes: 30, pricing: { mode: 'FIXED', price: 1 } }).expect(201)).body.data.id;
      await asApp({ user: B.o.id, admin: true, salon: B.salonId }, async (c) => {
        expect(await failsWith(c, `INSERT INTO staff_services (salon_id, service_id, staff_id, pricing_mode) VALUES ($1,$2,$3,'FIXED')`, [B.salonId, bsvc, st])).toBe('23503');
      });
    });

    it('database CHECKs: FIXED without price, STAFF_BASED with price, staff price on FIXED, bad duration; mode cannot change under assignments', async () => {
      const { o, salonId, a } = await draftOwner();
      const cat = await category(a);
      const st = await staff(a, 'Ali');
      const svc = (await a.post('/services', { categoryId: cat, name: 'Cut', durationMinutes: 30, pricing: { mode: 'FIXED', price: 10 }, staff: [{ staffId: st }] }).expect(201)).body.data.id;
      await asApp({ user: o.id, salon: salonId }, async (c) => {
        expect(await failsWith(c, `INSERT INTO services (salon_id, category_id, name, duration_minutes, pricing_mode) VALUES ($1,$2,'a1',30,'FIXED')`, [salonId, cat])).toBe('23514');
        expect(await failsWith(c, `INSERT INTO services (salon_id, category_id, name, duration_minutes, pricing_mode, base_price) VALUES ($1,$2,'a2',30,'STAFF_BASED',5)`, [salonId, cat])).toBe('23514');
        expect(await failsWith(c, `INSERT INTO services (salon_id, category_id, name, duration_minutes, base_price) VALUES ($1,$2,'a3',2000,5)`, [salonId, cat])).toBe('23514');
        expect(await failsWith(c, `UPDATE staff_services SET price=5 WHERE service_id=$1`, [svc])).toBe('23514');
        expect(await failsWith(c, `UPDATE services SET pricing_mode='STAFF_BASED', base_price=NULL WHERE id=$1`, [svc])).toBe('23503');
        expect(await failsWith(c, `DELETE FROM services WHERE id=$1`, [svc])).toBe('42501'); // soft delete only
        expect(await failsWith(c, `DELETE FROM staff_profiles WHERE id=$1`, [st])).toBe('42501');
      });
    });
  });

  // ------------------------------------------------------------------ editable statuses
  describe('who may edit when', () => {
    it('PENDING and SUSPENDED salons are locked; APPROVED stays editable (profile, hours, photos, catalogue)', async () => {
      const { o, salonId, a } = await draftOwner();
      const cat = await category(a);
      await upload(o.access, 'DOCUMENT', 'CNIC_FRONT', await png()).expect(201);
      await upload(o.access, 'DOCUMENT', 'CNIC_BACK', await png()).expect(201);
      await upload(o.access, 'PHOTO', 'COVER', await png()).expect(201);
      await h.http().post('/api/v1/salons/mine/submit').set(bearer(o.access)).expect(200);
      await a.post('/categories', { name: 'Late' }).expect(409);
      await a.patch(`/categories/${cat}`, { name: 'Late' }).expect(409);
      await a.put('/opening-hours', { days: WEEK }).expect(409);
      expect((await a.get('/catalog').expect(200)).body.data.canEdit).toBe(false); // reading still works

      const sa = await platformAdmin();
      await h.http().post(`/api/v1/admin/salons/${salonId}/approve`).set(bearer(sa.access)).expect(200);
      expect((await a.post('/categories', { name: 'Live' }).expect(201)).body.data.name).toBe('Live');
      await a.patch('', { description: 'Now live' }).expect(200);
      await upload(o.access, 'PHOTO', 'GALLERY', await png('#445566')).expect(201);
      await upload(o.access, 'DOCUMENT', 'CNIC_FRONT', await png()).expect(409);
      const mine = (await a.get('').expect(200)).body.data;
      expect(mine.canEditProfile).toBe(true);
      expect(mine.canEdit).toBe(false);

      await h.http().post(`/api/v1/admin/salons/${salonId}/suspend`).set(bearer(sa.access)).send({ reason: 'Policy check in progress' }).expect(200);
      await a.post('/categories', { name: 'Suspended' }).expect(409);
      await a.put('/opening-hours', { days: WEEK }).expect(409);
      await a.patch('', { description: 'nope' }).expect(409);
      await upload(o.access, 'PHOTO', 'GALLERY', await png('#112233')).expect(409);
    });

    it('the database refuses what the API refuses (owner edits while pending / document changes while approved)', async () => {
      const { o, salonId } = await draftOwner();
      await approve(o, salonId);
      await asApp({ user: o.id, salon: salonId }, async (c) => {
        expect(await failsWith(c, `UPDATE salons SET description='ok while live' WHERE id=$1`, [salonId])).toBe('OK');
        expect(await failsWith(c, `UPDATE salons SET status='SUSPENDED', suspended_reason='x' WHERE id=$1`, [salonId])).toBe('42501');
        expect(await failsWith(c, `UPDATE salons SET approved_by=NULL WHERE id=$1`, [salonId])).toBe('42501');
        expect(await failsWith(c, `UPDATE salon_files SET deleted_at=now() WHERE salon_id=$1 AND kind='DOCUMENT'`, [salonId])).toBe('42501');
        expect(await failsWith(c, `UPDATE salon_files SET deleted_at=now() WHERE salon_id=$1 AND doc_type='COVER'`, [salonId])).toBe('OK');
      });
    });
  });

  // ------------------------------------------------------------------ opening hours
  describe('opening hours', () => {
    it('validates the full week, persists it, and reports unconfigured salons honestly', async () => {
      const { a } = await draftOwner();
      const before = (await a.get('/opening-hours').expect(200)).body.data;
      expect(before.configured).toBe(false);
      expect(before.days).toHaveLength(7);
      await a.put('/opening-hours', { days: WEEK.slice(0, 6) }).expect(400);
      await a.put('/opening-hours', { days: [...WEEK.slice(0, 6), { weekday: 7, closed: false, opensAt: '22:00', closesAt: '02:00' }] }).expect(400);
      await a.put('/opening-hours', { days: [...WEEK.slice(0, 6), { weekday: 6, closed: true }] }).expect(400); // duplicate weekday
      const r = await a.put('/opening-hours', { days: WEEK }).expect(200);
      expect(r.body.data.configured).toBe(true);
      expect(r.body.data.days[0]).toEqual({ weekday: 1, closed: false, opensAt: '10:00', closesAt: '21:00' });
      expect(r.body.data.days[6]).toEqual({ weekday: 7, closed: true, opensAt: null, closesAt: null });
      await a.put('/opening-hours', { days: WEEK.map((d) => ({ ...d, extra: 1 })) }).expect(400);
    });
  });

  // ------------------------------------------------------------------ images
  describe('catalogue images', () => {
    it('set, replace (old object deleted), remove; counted separately from salon photos', async () => {
      const { a, o } = await draftOwner();
      const cat = await category(a);
      const put = (buf: Buffer) => h.http().put(`/api/v1/salons/mine/categories/${cat}/image`).set(bearer(o.access)).attach('file', buf, 'c.png');
      const first = await put(await png('#aa0000')).expect(200);
      const objectsAfterFirst = storage.objects.size;
      const second = await put(await png('#00aa00')).expect(200);
      expect(second.body.data.imageFileId).not.toBe(first.body.data.imageFileId);
      expect(storage.objects.size).toBe(objectsAfterFirst); // replaced, not accumulated
      const url = await a.get(`/categories/${cat}/image/url`).expect(200);
      expect(url.body.data.url).toContain('memory://private/salons/');
      const files = (await a.get('').expect(200)).body.data.files as Array<{ docType: string }>;
      expect(files.some((f) => f.docType === 'CATALOG')).toBe(false); // not a salon photo
      expect((await a.get('').expect(200)).body.data.requirements.missing.photos).toBe(1);
      await h.http().put(`/api/v1/salons/mine/categories/${cat}/image`).set(bearer(o.access)).attach('file', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'x.svg').expect(415);
      await h.http().put(`/api/v1/salons/mine/categories/${cat}/image`).set(bearer(o.access)).expect(400);
      // the generic file endpoint cannot be used to delete a catalogue image
      await h.http().delete(`/api/v1/salons/mine/files/${second.body.data.imageFileId}`).set(bearer(o.access)).expect(404);
      await a.del(`/categories/${cat}/image`).expect(204);
      await a.get(`/categories/${cat}/image/url`).expect(404);
    });
  });

  // ------------------------------------------------------------------ public visibility
  describe('public catalogue', () => {
    it('is hidden before approval, shows only active categories/services/staff, exact staff prices, and never owner data', async () => {
      const { o, salonId, a } = await draftOwner();
      const hair = await category(a, 'Hair');
      const hidden = await category(a, 'Hidden');
      const [ali, ahmed, gone] = [await staff(a, 'Ali'), await staff(a, 'Ahmed'), await staff(a, 'Gone')];
      await a.post('/services', { categoryId: hair, name: 'Haircut', durationMinutes: 30, pricing: { mode: 'STAFF_BASED' }, staff: [{ staffId: ali, price: 300 }, { staffId: ahmed, price: 500 }, { staffId: gone, price: 100 }] }).expect(201);
      await a.post('/services', { categoryId: hair, name: 'Beard', durationMinutes: 20, pricing: { mode: 'FIXED', price: 150 }, staff: [{ staffId: ali }] }).expect(201);
      await a.post('/services', { categoryId: hair, name: 'Nobody does this', durationMinutes: 20, pricing: { mode: 'FIXED', price: 1 } }).expect(201);
      await a.post('/services', { categoryId: hair, name: 'Disabled', durationMinutes: 20, pricing: { mode: 'FIXED', price: 1 }, staff: [{ staffId: ali }], isActive: false }).expect(201);
      await a.post('/services', { categoryId: hidden, name: 'In hidden category', durationMinutes: 20, pricing: { mode: 'FIXED', price: 1 }, staff: [{ staffId: ali }] }).expect(201);
      await a.patch(`/categories/${hidden}`, { isActive: false }).expect(200);
      await a.patch(`/staff/${gone}`, { isActive: false }).expect(200);

      await h.http().get(`/api/v1/public/salons/${salonId}/catalog`).expect(404); // draft
      await approve(o, salonId);

      const res = await h.http().get(`/api/v1/public/salons/${salonId}/catalog`).expect(200);
      const cats = res.body.data.categories;
      expect(cats.map((c: { name: string }) => c.name)).toEqual(['Hair']);
      const services = cats[0].services as Array<{ name: string; priceFrom: string; priceTo: string; staff: Array<{ name: string; price: string }> }>;
      expect(services.map((s) => s.name).sort()).toEqual(['Beard', 'Haircut']);
      const cut = services.find((s) => s.name === 'Haircut')!;
      expect(cut).toMatchObject({ priceFrom: '300.00', priceTo: '500.00' });
      expect(cut.staff.map((s) => [s.name, s.price])).toEqual([['Ahmed', '500.00'], ['Ali', '300.00']]);
      expect(services.find((s) => s.name === 'Beard')!.staff).toEqual([expect.objectContaining({ name: 'Ali', price: '150.00' })]);
      const dump = JSON.stringify(res.body);
      expect(dump).not.toContain(o.email);
      expect(dump).not.toContain('Gone');
      expect(dump).not.toMatch(/userId|ownerUserId|salonId/);

      const detail = await h.http().get(`/api/v1/public/salons/${salonId}`).expect(200);
      expect(detail.body.data.openingHours).toBeNull(); // not configured yet
      await a.put('/opening-hours', { days: WEEK }).expect(200);
      const d2 = await h.http().get(`/api/v1/public/salons/${salonId}`).expect(200);
      expect(d2.body.data.openingHours).toHaveLength(7);

      const sa = await platformAdmin();
      await h.http().post(`/api/v1/admin/salons/${salonId}/suspend`).set(bearer(sa.access)).send({ reason: 'Under investigation' }).expect(200);
      await h.http().get(`/api/v1/public/salons/${salonId}/catalog`).expect(404); // suspended salons vanish
    });

    it('public-read transactions never see unapproved catalogue rows and cannot write', async () => {
      const pending = await draftOwner();
      await category(pending.a, 'Secret');
      await asApp({ publicRead: true }, async (c) => {
        expect((await c.query(`SELECT 1 FROM service_categories WHERE salon_id=$1`, [pending.salonId])).rowCount).toBe(0);
        expect(await failsWith(c, `INSERT INTO service_categories (salon_id, name) VALUES ($1,'x')`, [pending.salonId])).toBe('42501');
      });
    });
  });

  // ------------------------------------------------------------------ concurrency & audit
  it('concurrent duplicate category creation yields exactly one row (409 for the rest)', async () => {
    const { a } = await draftOwner();
    const results = await Promise.all([1, 2, 3].map(() => a.post('/categories', { name: 'Race' })));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(2);
  });

  it('writes audit records without leaking secrets', async () => {
    const { o, salonId, a } = await draftOwner();
    const cat = await category(a, 'Audited');
    await a.patch(`/categories/${cat}`, { name: 'Audited 2' }).expect(200);
    const rows = (await aq(`SELECT action, actor_user_id FROM audit_logs WHERE salon_id=$1 AND action LIKE 'catalog.%'`, [salonId])).rows;
    expect(rows.map((r) => r.action).sort()).toEqual(['catalog.category_created', 'catalog.category_updated']);
    expect(rows.every((r) => r.actor_user_id === o.id)).toBe(true);
  });
});
