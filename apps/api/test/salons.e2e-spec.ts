import { Pool, PoolClient } from 'pg';
import sharp from 'sharp';
import { hotp, base32Decode, timeStep } from '../src/modules/auth/totp';
import { MemoryObjectStorage, ObjectStorage } from '../src/common/storage/object-storage';
import {
  Harness, bearer, createHarness, createPlatformUser, dbEnabled, loginMobile, registerAndVerify, uniqueEmail,
} from './support/harness';

const d = dbEnabled ? describe : describe.skip;
if (!dbEnabled) {
  // eslint-disable-next-line no-console
  console.warn('SKIPPED salons e2e: set TEST_DATABASE_URL (salon_app) and TEST_ADMIN_DATABASE_URL (salon_migrator).');
}

const totp = (secretB32: string, h: Harness) => hotp(base32Decode(secretB32), timeStep(h.clock.now().getTime()));
const png = (color = '#c07840', w = 600, h = 400) =>
  sharp({ create: { width: w, height: h, channels: 3, background: color } }).png().toBuffer();
const SALON = {
  name: 'Glow Studio', salonType: 'LADIES', city: 'Lahore', area: 'Gulberg', addressLine: '12 Main Boulevard, Gulberg III',
  phone: '0300 1234567', description: 'Premium ladies salon',
};

d('Phase 3: salon registration, review, uploads, public visibility (real PostgreSQL)', () => {
  let h: Harness;
  let storage: MemoryObjectStorage;
  let appPool: Pool; // connects as salon_app (RLS enforced), for direct-SQL isolation tests

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
  /** Direct SQL for assertions. The owner role is ALSO subject to FORCE ROW LEVEL SECURITY, so act as platform admin. */
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
  async function owner() {
    const u = await registerAndVerify(h, { accountType: 'SALON_OWNER', fullName: 'Owner Person' });
    const access = (await loginMobile(h, u.email, u.password)).body.data.accessToken as string;
    const id = (await aq('SELECT id FROM users WHERE email=$1', [u.email])).rows[0].id as string;
    return { ...u, access, id };
  }
  async function customer() {
    const u = await registerAndVerify(h, { accountType: 'CUSTOMER' });
    return { ...u, access: (await loginMobile(h, u.email, u.password)).body.data.accessToken as string };
  }
  async function platform(role: 'SUPER_ADMIN' | 'SUPPORT') {
    const u = await createPlatformUser(h, role);
    const access = (await loginMobile(h, u.email, u.password)).body.data.accessToken as string;
    const setup = (await h.http().post('/api/v1/auth/mfa/setup').set(bearer(access)).send({ password: u.password }).expect(200)).body.data;
    await h.http().post('/api/v1/auth/mfa/enable').set(bearer(access)).send({ code: totp(setup.secret, h) }).expect(200);
    return { ...u, access };
  }
  const upload = (token: string, kind: string, docType: string, buf: Buffer, name = 'scan.png') =>
    h.http().post('/api/v1/salons/mine/files').set(bearer(token)).field('kind', kind).field('docType', docType).attach('file', buf, name);

  async function completeApplication(o: { access: string }) {
    await h.http().post('/api/v1/salons').set(bearer(o.access)).send(SALON).expect(201);
    await upload(o.access, 'DOCUMENT', 'CNIC_FRONT', await png('#111111')).expect(201);
    await upload(o.access, 'DOCUMENT', 'CNIC_BACK', await png('#222222')).expect(201);
    await upload(o.access, 'PHOTO', 'COVER', await png('#333333')).expect(201);
  }
  async function pendingSalon() {
    const o = await owner();
    await completeApplication(o);
    await h.http().post('/api/v1/salons/mine/submit').set(bearer(o.access)).expect(200);
    const id = (await h.http().get('/api/v1/salons/mine').set(bearer(o.access)).expect(200)).body.data.salon.id as string;
    return { o, id };
  }

  /** Runs SQL as salon_app inside a transaction with the given tenant GUCs (what TenantDb does). */
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

  // ------------------------------------------------------------------ authorization & mass assignment
  describe('who may register a salon', () => {
    it('requires authentication and the SALON_OWNER role', async () => {
      await h.http().post('/api/v1/salons').send(SALON).expect(401);
      await h.http().get('/api/v1/salons/mine').expect(401);
      const c = await customer();
      await h.http().post('/api/v1/salons').set(bearer(c.access)).send(SALON).expect(403);
      await h.http().get('/api/v1/salons/mine').set(bearer(c.access)).expect(403);
      const a = await platform('SUPPORT');
      await h.http().post('/api/v1/salons').set(bearer(a.access)).send(SALON).expect(403);
    });

    it('creates a DRAFT salon owned by the caller and normalises the phone number', async () => {
      const o = await owner();
      const res = await h.http().post('/api/v1/salons').set(bearer(o.access)).send(SALON).expect(201);
      const s = res.body.data.salon;
      expect(s.status).toBe('DRAFT');
      expect(s.phone).toBe('+923001234567');
      expect((await aq('SELECT owner_user_id FROM salons WHERE id=$1', [s.id])).rows[0].owner_user_id).toBe(o.id);
      expect(res.body.data.canSubmit).toBe(false);
      expect(res.body.data.requirements.missing.documents).toEqual(['CNIC_FRONT', 'CNIC_BACK']);
    });

    it('allows only one salon per owner (409), even under concurrent requests', async () => {
      const o = await owner();
      const results = await Promise.all([1, 2, 3].map(() => h.http().post('/api/v1/salons').set(bearer(o.access)).send(SALON)));
      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
      expect(results.filter((r) => r.status === 409)).toHaveLength(2);
      expect((await aq('SELECT count(*)::int n FROM salons WHERE owner_user_id=$1', [o.id])).rows[0].n).toBe(1);
    });

    it('rejects mass assignment: status, ownerUserId, approval fields and unknown keys', async () => {
      const o = await owner();
      for (const extra of [{ status: 'APPROVED' }, { ownerUserId: '00000000-0000-4000-8000-000000000000' }, { approvedAt: new Date().toISOString() }, { id: '00000000-0000-4000-8000-000000000000' }]) {
        await h.http().post('/api/v1/salons').set(bearer(o.access)).send({ ...SALON, ...extra }).expect(400);
      }
      await h.http().post('/api/v1/salons').set(bearer(o.access)).send(SALON).expect(201);
      await h.http().patch('/api/v1/salons/mine').set(bearer(o.access)).send({ status: 'APPROVED' }).expect(400);
      await h.http().patch('/api/v1/salons/mine').set(bearer(o.access)).send({ rejectionReason: 'x' }).expect(400);
    });

    it('validates input: HTML/control characters, bad phone, half a coordinate pair', async () => {
      const o = await owner();
      await h.http().post('/api/v1/salons').set(bearer(o.access)).send({ ...SALON, name: '<script>alert(1)</script>' }).expect(400);
      await h.http().post('/api/v1/salons').set(bearer(o.access)).send({ ...SALON, phone: '12345' }).expect(400);
      await h.http().post('/api/v1/salons').set(bearer(o.access)).send({ ...SALON, salonType: 'CATS' }).expect(400);
      await h.http().post('/api/v1/salons').set(bearer(o.access)).send({ ...SALON, latitude: 31.5 }).expect(400);
      await h.http().post('/api/v1/salons').set(bearer(o.access)).send({ ...SALON, latitude: 123, longitude: 74 }).expect(400);
      expect((await aq('SELECT count(*)::int n FROM salons WHERE owner_user_id=$1', [o.id])).rows[0].n).toBe(0);
    });

    it('lets the owner edit a draft; null cannot erase required fields', async () => {
      const o = await owner();
      await h.http().post('/api/v1/salons').set(bearer(o.access)).send(SALON).expect(201);
      const r = await h.http().patch('/api/v1/salons/mine').set(bearer(o.access)).send({ name: 'Glow Studio 2', description: null, latitude: 31.5, longitude: 74.3 }).expect(200);
      expect(r.body.data.salon.name).toBe('Glow Studio 2');
      expect(r.body.data.salon.description).toBeNull();
      const n = await h.http().patch('/api/v1/salons/mine').set(bearer(o.access)).send({ name: null, phone: null }).expect(200);
      expect(n.body.data.salon.name).toBe('Glow Studio 2');
      expect(n.body.data.salon.phone).toBe('+923001234567');
    });
  });

  // ------------------------------------------------------------------ uploads
  describe('file uploads', () => {
    it('stores a re-encoded WebP under a server-generated key in private storage; metadata never leaks the key', async () => {
      const o = await owner();
      await h.http().post('/api/v1/salons').set(bearer(o.access)).send(SALON).expect(201);
      const jpg = await sharp({ create: { width: 800, height: 600, channels: 3, background: '#808080' } }).jpeg().withExif({ IFD0: { Copyright: 'gps-marker-xyz' } }).toBuffer();
      const res = await upload(o.access, 'DOCUMENT', 'CNIC_FRONT', jpg, '../../etc/passwd<script>.jpg').expect(201);
      const f = res.body.data;
      expect(f.contentType).toBe('image/webp');
      expect(JSON.stringify(f)).not.toMatch(/storage|salons\//i);
      const row = (await aq('SELECT * FROM salon_files WHERE id=$1', [f.id])).rows[0];
      expect(row.storage_key).toMatch(/^salons\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.webp$/);
      expect(row.storage_key).not.toContain('passwd');
      expect(row.original_name).not.toMatch(/[<>/]/);
      const obj = storage.objects.get(row.storage_key)!;
      expect(obj.contentType).toBe('image/webp');
      expect(obj.body.toString('latin1')).not.toContain('gps-marker-xyz');
    });

    it('rejects SVG/HTML/GIF/text disguised as images, bad kind/type combos and missing files', async () => {
      const o = await owner();
      await h.http().post('/api/v1/salons').set(bearer(o.access)).send(SALON).expect(201);
      const before = storage.objects.size;
      const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"><script>alert(1)</script></svg>');
      expect((await upload(o.access, 'PHOTO', 'COVER', svg, 'cover.png')).status).toBe(415);
      expect((await upload(o.access, 'PHOTO', 'COVER', Buffer.from('<html>not an image at all</html>'), 'cover.jpg')).status).toBe(415);
      expect((await upload(o.access, 'DOCUMENT', 'CNIC_FRONT', Buffer.from('MZ' + 'x'.repeat(200)), 'cnic.png')).status).toBe(415);
      // PDFs are documents only
      const pdf = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF');
      expect((await upload(o.access, 'PHOTO', 'GALLERY', pdf, 'x.pdf')).status).toBe(415);
      expect((await upload(o.access, 'DOCUMENT', 'BUSINESS_LICENSE', pdf, 'licence.pdf')).status).toBe(201);
      const evilPdf = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/OpenAction<</S/JavaScript/JS(app.alert(1))>>>>endobj');
      expect((await upload(o.access, 'DOCUMENT', 'OTHER_DOCUMENT', evilPdf, 'x.pdf')).status).toBe(400);
      // kind/docType mismatch and bad enums
      expect((await upload(o.access, 'DOCUMENT', 'COVER', await png())).status).toBe(400);
      expect((await upload(o.access, 'PHOTO', 'CNIC_FRONT', await png())).status).toBe(400);
      expect((await upload(o.access, 'PHOTO', 'WHATEVER', await png())).status).toBe(400);
      await h.http().post('/api/v1/salons/mine/files').set(bearer(o.access)).field('kind', 'PHOTO').field('docType', 'COVER').expect(400);
      // nothing but the one valid PDF was stored
      expect(storage.objects.size - before).toBe(1);
    });

    it('enforces the size limit while streaming (413) and stores nothing', async () => {
      const o = await owner();
      await h.http().post('/api/v1/salons').set(bearer(o.access)).send(SALON).expect(201);
      const before = storage.objects.size;
      const big = Buffer.concat([await png(), Buffer.alloc(6 * 1024 * 1024, 7)]);
      const r = await upload(o.access, 'PHOTO', 'GALLERY', big);
      expect(r.status).toBe(413);
      expect(r.body.error.code).toBe('PAYLOAD_TOO_LARGE');
      expect(storage.objects.size).toBe(before);
    });

    it('replaces single-slot files (old object removed) and caps repeatable slots', async () => {
      const o = await owner();
      await h.http().post('/api/v1/salons').set(bearer(o.access)).send(SALON).expect(201);
      const first = (await upload(o.access, 'PHOTO', 'COVER', await png('#aa0000')).expect(201)).body.data.id;
      const firstKey = (await aq('SELECT storage_key FROM salon_files WHERE id=$1', [first])).rows[0].storage_key;
      await upload(o.access, 'PHOTO', 'COVER', await png('#00aa00')).expect(201);
      expect(storage.objects.has(firstKey)).toBe(false);
      const files = (await h.http().get('/api/v1/salons/mine').set(bearer(o.access)).expect(200)).body.data.files;
      expect(files.filter((f: any) => f.docType === 'COVER')).toHaveLength(1);
      const tiny = await png('#0000aa', 300, 300);
      for (let i = 0; i < 12; i++) await upload(o.access, 'PHOTO', 'GALLERY', tiny).expect(201);
      expect((await upload(o.access, 'PHOTO', 'GALLERY', tiny)).status).toBe(409);
    });

    it('deletes files (soft delete + object removed) and signs short-lived URLs only for the owner', async () => {
      const o = await owner();
      const other = await owner();
      await h.http().post('/api/v1/salons').set(bearer(o.access)).send(SALON).expect(201);
      const id = (await upload(o.access, 'PHOTO', 'GALLERY', await png()).expect(201)).body.data.id;
      const url = await h.http().get(`/api/v1/salons/mine/files/${id}/url`).set(bearer(o.access)).expect(200);
      expect(url.body.data.expiresInSec).toBeLessThanOrEqual(300);
      // another owner: IDOR attempts all look like 404 / "no salon"
      await h.http().get(`/api/v1/salons/mine/files/${id}/url`).set(bearer(other.access)).expect(404);
      await h.http().post('/api/v1/salons').set(bearer(other.access)).send(SALON).expect(201);
      await h.http().get(`/api/v1/salons/mine/files/${id}/url`).set(bearer(other.access)).expect(404);
      await h.http().delete(`/api/v1/salons/mine/files/${id}`).set(bearer(other.access)).expect(404);
      const key = (await aq('SELECT storage_key FROM salon_files WHERE id=$1', [id])).rows[0].storage_key;
      await h.http().delete(`/api/v1/salons/mine/files/${id}`).set(bearer(o.access)).expect(204);
      expect(storage.objects.has(key)).toBe(false);
      expect((await aq('SELECT deleted_at FROM salon_files WHERE id=$1', [id])).rows[0].deleted_at).not.toBeNull();
      await h.http().get(`/api/v1/salons/mine/files/${id}/url`).set(bearer(o.access)).expect(404);
    });
  });

  // ------------------------------------------------------------------ submit & review
  describe('submission and review workflow', () => {
    it('refuses an incomplete application and says exactly what is missing', async () => {
      const o = await owner();
      await h.http().post('/api/v1/salons').set(bearer(o.access)).send(SALON).expect(201);
      await upload(o.access, 'DOCUMENT', 'CNIC_FRONT', await png()).expect(201);
      const r = await h.http().post('/api/v1/salons/mine/submit').set(bearer(o.access)).expect(400);
      expect(r.body.error.details.missing).toEqual({ documents: ['CNIC_BACK'], photos: 1 });
      expect((await aq('SELECT status FROM salons WHERE owner_user_id=$1', [o.id])).rows[0].status).toBe('DRAFT');
    });

    it('submits, locks the salon for editing, and notifies active super admins', async () => {
      const sa = await platform('SUPER_ADMIN');
      h.mailer.outbox.length = 0;
      const { o, id } = await pendingSalon();
      const row = (await aq('SELECT status, submitted_at FROM salons WHERE id=$1', [id])).rows[0];
      expect(row.status).toBe('PENDING');
      expect(row.submitted_at).not.toBeNull();
      const app = (await aq('SELECT * FROM salon_applications WHERE salon_id=$1', [id])).rows;
      expect(app).toHaveLength(1);
      expect(app[0].submission_no).toBe(1);
      expect(app[0].snapshot.fileIds).toHaveLength(3);
      expect(h.mailer.outbox.some((m) => m.to === sa.email && m.subject.includes('New salon application'))).toBe(true);
      // locked while pending
      await h.http().patch('/api/v1/salons/mine').set(bearer(o.access)).send({ name: 'Sneaky Edit' }).expect(409);
      expect((await upload(o.access, 'PHOTO', 'GALLERY', await png())).status).toBe(409);
      const fileId = (await h.http().get('/api/v1/salons/mine').set(bearer(o.access))).body.data.files[0].id;
      await h.http().delete(`/api/v1/salons/mine/files/${fileId}`).set(bearer(o.access)).expect(409);
      await h.http().post('/api/v1/salons/mine/submit').set(bearer(o.access)).expect(409);
    });

    it('approve: only SUPER_ADMIN; owner is told; salon becomes public; audit trail written', async () => {
      const { o, id } = await pendingSalon();
      const support = await platform('SUPPORT');
      const sa = await platform('SUPER_ADMIN');
      await h.http().post(`/api/v1/admin/salons/${id}/approve`).expect(401);
      await h.http().post(`/api/v1/admin/salons/${id}/approve`).set(bearer(o.access)).expect(403); // the owner cannot approve their own salon
      await h.http().post(`/api/v1/admin/salons/${id}/approve`).set(bearer(support.access)).expect(403);
      expect((await aq('SELECT status FROM salons WHERE id=$1', [id])).rows[0].status).toBe('PENDING');
      await h.http().get(`/api/v1/public/salons/${id}`).expect(404); // not public before approval

      h.mailer.outbox.length = 0;
      const res = await h.http().post(`/api/v1/admin/salons/${id}/approve`).set(bearer(sa.access)).expect(200);
      expect(res.body.data.salon.status).toBe('APPROVED');
      expect(h.mailer.outbox.some((m) => m.to === o.email && m.subject.includes('approved'))).toBe(true);
      const row = (await aq('SELECT approved_by, approved_at FROM salons WHERE id=$1', [id])).rows[0];
      expect(row.approved_by).toBe(sa.id);
      expect((await aq(`SELECT status FROM salon_applications WHERE salon_id=$1`, [id])).rows[0].status).toBe('APPROVED');
      const audit = (await aq(`SELECT actor_user_id FROM audit_logs WHERE action='salon.approved' AND target_id=$1`, [id])).rows;
      expect(audit).toHaveLength(1);
      expect(audit[0].actor_user_id).toBe(sa.id);
      // approving twice is a conflict, not a silent no-op
      await h.http().post(`/api/v1/admin/salons/${id}/approve`).set(bearer(sa.access)).expect(409);
      // an approved salon is locked for the owner as well (profile management arrives in Phase 4)
      await h.http().patch('/api/v1/salons/mine').set(bearer(o.access)).send({ name: 'Renamed' }).expect(409);
    });

    it('reject requires a reason, shows it to the owner, and allows correction + resubmission', async () => {
      const { o, id } = await pendingSalon();
      const sa = await platform('SUPER_ADMIN');
      await h.http().post(`/api/v1/admin/salons/${id}/reject`).set(bearer(sa.access)).send({}).expect(400);
      await h.http().post(`/api/v1/admin/salons/${id}/reject`).set(bearer(sa.access)).send({ reason: 'short' }).expect(400);
      h.mailer.outbox.length = 0;
      await h.http().post(`/api/v1/admin/salons/${id}/reject`).set(bearer(sa.access)).send({ reason: 'CNIC photo is blurry, please re-upload.' }).expect(200);
      expect(h.mailer.outbox.some((m) => m.to === o.email && m.text.includes('CNIC photo is blurry'))).toBe(true);
      const mine = (await h.http().get('/api/v1/salons/mine').set(bearer(o.access)).expect(200)).body.data;
      expect(mine.salon.status).toBe('REJECTED');
      expect(mine.salon.rejectionReason).toContain('blurry');
      expect(mine.canEdit).toBe(true);
      expect(mine.latestApplication.decisionReason).toContain('blurry');
      await h.http().get(`/api/v1/public/salons/${id}`).expect(404);
      // fix and resubmit
      await upload(o.access, 'DOCUMENT', 'CNIC_FRONT', await png('#555555')).expect(201);
      await h.http().patch('/api/v1/salons/mine').set(bearer(o.access)).send({ description: 'Updated description' }).expect(200);
      await h.http().post('/api/v1/salons/mine/submit').set(bearer(o.access)).expect(200);
      const apps = (await aq('SELECT submission_no, status FROM salon_applications WHERE salon_id=$1 ORDER BY submission_no', [id])).rows;
      expect(apps).toEqual([{ submission_no: 1, status: 'REJECTED' }, { submission_no: 2, status: 'SUBMITTED' }]);
      await h.http().post(`/api/v1/admin/salons/${id}/approve`).set(bearer(sa.access)).expect(200);
    });

    it('concurrent approve + reject: exactly one decision wins', async () => {
      const { id } = await pendingSalon();
      const sa = await platform('SUPER_ADMIN');
      const [a, r] = await Promise.all([
        h.http().post(`/api/v1/admin/salons/${id}/approve`).set(bearer(sa.access)),
        h.http().post(`/api/v1/admin/salons/${id}/reject`).set(bearer(sa.access)).send({ reason: 'Incomplete information given.' }),
      ]);
      expect([a.status, r.status].sort()).toEqual([200, 409]);
    });

    it('suspend hides the salon from the public; reactivate restores it; both need SALONS_MANAGE_STATUS', async () => {
      const { id } = await pendingSalon();
      const sa = await platform('SUPER_ADMIN');
      const support = await platform('SUPPORT');
      await h.http().post(`/api/v1/admin/salons/${id}/suspend`).set(bearer(sa.access)).send({ reason: 'Not approved yet' }).expect(409);
      await h.http().post(`/api/v1/admin/salons/${id}/approve`).set(bearer(sa.access)).expect(200);
      await h.http().get(`/api/v1/public/salons/${id}`).expect(200);
      await h.http().post(`/api/v1/admin/salons/${id}/suspend`).set(bearer(support.access)).send({ reason: 'Customer complaints' }).expect(403);
      await h.http().post(`/api/v1/admin/salons/${id}/suspend`).set(bearer(sa.access)).send({}).expect(400);
      await h.http().post(`/api/v1/admin/salons/${id}/suspend`).set(bearer(sa.access)).send({ reason: 'Customer complaints' }).expect(200);
      await h.http().get(`/api/v1/public/salons/${id}`).expect(404);
      const list = await h.http().get('/api/v1/public/salons?pageSize=50').expect(200);
      expect(list.body.data.items.find((s: any) => s.id === id)).toBeUndefined();
      await h.http().post(`/api/v1/admin/salons/${id}/reactivate`).set(bearer(sa.access)).expect(200);
      await h.http().get(`/api/v1/public/salons/${id}`).expect(200);
    });
  });

  // ------------------------------------------------------------------ admin read access
  describe('admin review screens', () => {
    it('SUPPORT can read applications and photos but NOT identity documents; SUPER_ADMIN can and it is audited', async () => {
      const { o, id } = await pendingSalon();
      const support = await platform('SUPPORT');
      const sa = await platform('SUPER_ADMIN');
      const detail = (await h.http().get(`/api/v1/admin/salons/${id}`).set(bearer(support.access)).expect(200)).body.data;
      expect(detail.owner.email).toBe(o.email);
      expect(detail.canViewDocuments).toBe(false);
      expect(JSON.stringify(detail)).not.toMatch(/storage_key|storageKey|salons\/[0-9a-f-]{36}\//);
      const doc = detail.files.find((f: any) => f.kind === 'DOCUMENT');
      const photo = detail.files.find((f: any) => f.kind === 'PHOTO');
      await h.http().get(`/api/v1/admin/salons/${id}/files/${doc.id}/url`).set(bearer(support.access)).expect(403);
      await h.http().get(`/api/v1/admin/salons/${id}/files/${photo.id}/url`).set(bearer(support.access)).expect(200);
      const ok = await h.http().get(`/api/v1/admin/salons/${id}/files/${doc.id}/url`).set(bearer(sa.access)).expect(200);
      expect(ok.body.data.url).toContain('memory://private/');
      expect((await aq(`SELECT count(*)::int n FROM audit_logs WHERE action='salon.document_viewed' AND target_id=$1`, [doc.id])).rows[0].n).toBe(1);
      // owners and customers cannot use the admin API at all
      await h.http().get(`/api/v1/admin/salons/${id}`).set(bearer(o.access)).expect(403);
      await h.http().get('/api/v1/admin/salons').set(bearer(o.access)).expect(403);
    });

    it('lists with filters, hides drafts, and reports pending counts', async () => {
      const draftOwner = await owner();
      await h.http().post('/api/v1/salons').set(bearer(draftOwner.access)).send({ ...SALON, name: 'Zzz Draft Only Salon' }).expect(201);
      const { id } = await pendingSalon();
      const sa = await platform('SUPER_ADMIN');
      const list = (await h.http().get('/api/v1/admin/salons?status=PENDING&pageSize=100').set(bearer(sa.access)).expect(200)).body.data;
      expect(list.items.some((s: any) => s.id === id)).toBe(true);
      expect(list.items.every((s: any) => s.status === 'PENDING')).toBe(true);
      const q = (await h.http().get('/api/v1/admin/salons?q=Zzz%20Draft').set(bearer(sa.access)).expect(200)).body.data;
      expect(q.items).toHaveLength(0); // drafts are private to their owner
      const wild = (await h.http().get('/api/v1/admin/salons?q=%25').set(bearer(sa.access)).expect(200)).body.data;
      expect(wild.total).toBe(0); // LIKE wildcards are escaped
      await h.http().get('/api/v1/admin/salons?status=DRAFT').set(bearer(sa.access)).expect(400);
      await h.http().get('/api/v1/admin/salons?pageSize=1000').set(bearer(sa.access)).expect(400);
      const stats = (await h.http().get('/api/v1/admin/salons/stats').set(bearer(sa.access)).expect(200)).body.data;
      expect(stats.pending).toBeGreaterThanOrEqual(1);
      await h.http().get('/api/v1/admin/salons/not-a-uuid').set(bearer(sa.access)).expect(400);
    });
  });

  // ------------------------------------------------------------------ public visibility
  describe('public visibility', () => {
    it('shows only approved salons, only safe fields, photos via signed URLs and never documents', async () => {
      const { o, id } = await pendingSalon();
      const sa = await platform('SUPER_ADMIN');
      expect((await h.http().get('/api/v1/public/salons?pageSize=50')).body.data.items.some((s: any) => s.id === id)).toBe(false);
      await h.http().post(`/api/v1/admin/salons/${id}/approve`).set(bearer(sa.access)).expect(200);
      const detail = (await h.http().get(`/api/v1/public/salons/${id}`).expect(200)).body.data;
      expect(detail.name).toBe('Glow Studio');
      expect(detail.photos).toHaveLength(1);
      expect(detail.photos[0].url).toContain('memory://private/');
      const text = JSON.stringify(detail);
      expect(text).not.toMatch(/ownerUserId|owner_user_id|contactEmail|rejection|approvedBy|CNIC|storageKey|email/i);
      expect(text).not.toContain(o.email);
      const list = (await h.http().get('/api/v1/public/salons?city=lahore&type=LADIES&pageSize=50').expect(200)).body.data;
      expect(list.items.some((s: any) => s.id === id)).toBe(true);
      expect(list.items.every((s: any) => s.city.toLowerCase() === 'lahore')).toBe(true);
      await h.http().get('/api/v1/public/salons?pageSize=500').expect(400);
      await h.http().get('/api/v1/public/salons?type=CATS').expect(400);
      await h.http().get('/api/v1/public/salons/not-a-uuid').expect(400);
    });
  });

  // ------------------------------------------------------------------ database-level isolation (RLS + guard triggers)
  describe('PostgreSQL row-level security and guard triggers (as the runtime role)', () => {
    it('cross-tenant: an owner sees and touches only their own salon, files and applications', async () => {
      const a = await pendingSalon();
      const b = await pendingSalon();
      const aUser = a.o.id;
      const bUser = b.o.id;
      await asApp({ user: bUser, salon: b.id }, async (c) => {
        expect((await c.query('SELECT id FROM salons')).rows.map((r) => r.id)).toEqual([b.id]);
        expect((await c.query('SELECT DISTINCT salon_id FROM salon_files')).rows.map((r) => r.salon_id)).toEqual([b.id]);
        expect((await c.query('SELECT DISTINCT salon_id FROM salon_applications')).rows.map((r) => r.salon_id)).toEqual([b.id]);
        expect((await c.query('UPDATE salons SET name=$1 WHERE id=$2', ['hijack', a.id])).rowCount).toBe(0);
        expect((await c.query('UPDATE salon_files SET deleted_at=now() WHERE salon_id=$1', [a.id])).rowCount).toBe(0);
        expect(await failsWith(c, `INSERT INTO salon_files (salon_id,kind,doc_type,storage_key,content_type,size_bytes,sha256,uploaded_by) VALUES ($1,'PHOTO','GALLERY','k/x','image/webp',10,repeat('a',64),$2)`, [a.id, bUser])).not.toBe('OK');
        expect(await failsWith(c, `INSERT INTO salons (owner_user_id,name,salon_type,city,area,address_line,phone) VALUES ($1,'Mine?','MEN','x','y','zzzzz','+923001111111')`, [aUser])).not.toBe('OK');
      });
      // owner A context pointed at B's salon id: salon_id mismatch => nothing visible
      await asApp({ user: aUser, salon: a.id }, async (c) => {
        expect((await c.query('SELECT 1 FROM salon_files WHERE salon_id=$1', [b.id])).rowCount).toBe(0);
      });
    });

    it('fails closed: no tenant context means no rows, and writes are refused', async () => {
      await pendingSalon();
      await asApp({}, async (c) => {
        expect((await c.query('SELECT 1 FROM salons')).rowCount).toBe(0);
        expect((await c.query('SELECT 1 FROM salon_files')).rowCount).toBe(0);
        expect((await c.query('SELECT 1 FROM salon_applications')).rowCount).toBe(0);
        expect(await failsWith(c, `UPDATE salons SET name='x'`)).toBe('OK'); // updates zero rows, never errors, never changes data
        expect((await c.query(`SELECT 1 FROM salons WHERE name='x'`)).rowCount).toBe(0);
      });
    });

    it('the database itself refuses an owner approving, re-owning or editing a salon under review', async () => {
      const { o, id } = await pendingSalon();
      await asApp({ user: o.id, salon: id }, async (c) => {
        expect(await failsWith(c, `UPDATE salons SET status='APPROVED' WHERE id=$1`, [id])).toBe('42501');
        expect(await failsWith(c, `UPDATE salons SET approved_at=now() WHERE id=$1`, [id])).toBe('42501');
        expect(await failsWith(c, `UPDATE salons SET name='edit while pending' WHERE id=$1`, [id])).toBe('42501');
        expect(await failsWith(c, `UPDATE salons SET owner_user_id=$2 WHERE id=$1`, [id, o.id])).not.toBe('OK');
        expect(await failsWith(c, `UPDATE salon_files SET deleted_at=now() WHERE salon_id=$1`, [id])).toBe('42501');
      });
      const draft = await owner();
      await h.http().post('/api/v1/salons').set(bearer(draft.access)).send(SALON).expect(201);
      const did = (await aq('SELECT id FROM salons WHERE owner_user_id=$1', [draft.id])).rows[0].id;
      await asApp({ user: draft.id, salon: did }, async (c) => {
        expect(await failsWith(c, `UPDATE salons SET status='REJECTED', rejection_reason='x' WHERE id=$1`, [did])).toBe('42501');
        expect(await failsWith(c, `UPDATE salons SET status='SUSPENDED', suspended_reason='x' WHERE id=$1`, [did])).toBe('42501');
        expect(await failsWith(c, `INSERT INTO salons (owner_user_id,name,salon_type,city,area,address_line,phone,status) VALUES (gen_random_uuid(),'x','MEN','x','y','zzzzz','+923001111111','APPROVED')`)).not.toBe('OK');
      });
    });

    it('public-read transactions see approved salons and their photos only, never documents or other statuses', async () => {
      const pend = await pendingSalon();
      const appr = await pendingSalon();
      const sa = await platform('SUPER_ADMIN');
      await h.http().post(`/api/v1/admin/salons/${appr.id}/approve`).set(bearer(sa.access)).expect(200);
      await asApp({ publicRead: true }, async (c) => {
        const ids = (await c.query('SELECT id FROM salons')).rows.map((r) => r.id);
        expect(ids).toContain(appr.id);
        expect(ids).not.toContain(pend.id);
        const files = (await c.query('SELECT kind, salon_id FROM salon_files')).rows;
        expect(files.length).toBeGreaterThan(0);
        expect(files.every((f) => f.kind === 'PHOTO' && f.salon_id !== pend.id)).toBe(true);
        expect((await c.query('SELECT 1 FROM salon_applications')).rowCount).toBe(0);
        expect((await c.query(`UPDATE salons SET name='x' WHERE id=$1`, [appr.id])).rowCount).toBe(0);
      });
      await asApp({}, async (c) => {
        expect((await c.query('SELECT 1 FROM salons WHERE id=$1', [appr.id])).rowCount).toBe(0); // flag not set => invisible
      });
    });

    it('the runtime role cannot hard-delete applications or files', async () => {
      const { o, id } = await pendingSalon();
      await asApp({ user: o.id, salon: id, admin: true }, async (c) => {
        expect(await failsWith(c, 'DELETE FROM salon_applications WHERE salon_id=$1', [id])).toBe('42501');
        expect(await failsWith(c, 'DELETE FROM salon_files WHERE salon_id=$1', [id])).toBe('42501');
      });
    });
  });
});
