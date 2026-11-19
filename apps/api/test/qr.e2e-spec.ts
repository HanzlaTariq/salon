import jsQR from 'jsqr';
import { Pool, PoolClient } from 'pg';
import sharp from 'sharp';
import { hotp, base32Decode, timeStep } from '../src/modules/auth/totp';
import {
  Harness, bearer, createHarness, createPlatformUser, dbEnabled, loginMobile, registerAndVerify,
} from './support/harness';

const d = dbEnabled ? describe : describe.skip;
if (!dbEnabled) {
  // eslint-disable-next-line no-console
  console.warn('SKIPPED qr e2e: set TEST_DATABASE_URL (salon_app) and TEST_ADMIN_DATABASE_URL (salon_migrator).');
}

const totp = (secretB32: string, h: Harness) => hotp(base32Decode(secretB32), timeStep(h.clock.now().getTime()));
const png = (color = '#c07840') => sharp({ create: { width: 600, height: 400, channels: 3, background: color } }).png().toBuffer();
const SALON = { name: 'Glow Studio', salonType: 'LADIES', city: 'Lahore', area: 'Gulberg', addressLine: '12 Main Boulevard, Gulberg III', phone: '0300 1234567' };
const CODE = /^[a-hj-km-np-z2-9]{10}$/;
const BASE = 'http://localhost:3000'; // PUBLIC_LINK_BASE_URL default

d('Phase 11: salon link, QR code, poster, landing page (real PostgreSQL)', () => {
  let h: Harness;
  let appPool: Pool; // salon_app (RLS enforced)
  let admin: { id: string; access: string };

  beforeAll(async () => {
    h = await createHarness();
    appPool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 2 });
    const u = await createPlatformUser(h, 'SUPER_ADMIN');
    const access = (await loginMobile(h, u.email, u.password)).body.data.accessToken as string;
    const setup = (await h.http().post('/api/v1/auth/mfa/setup').set(bearer(access)).send({ password: u.password }).expect(200)).body.data;
    await h.http().post('/api/v1/auth/mfa/enable').set(bearer(access)).send({ code: totp(setup.secret, h) }).expect(200);
    admin = { id: u.id, access };
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
    return { ...u, access };
  }
  const upload = (token: string, kind: string, docType: string, buf: Buffer) =>
    h.http().post('/api/v1/salons/mine/files').set(bearer(token)).field('kind', kind).field('docType', docType).attach('file', buf, 'x.png');
  async function draftSalon(over: Record<string, unknown> = {}) {
    const o = await owner();
    const salonId = (await h.http().post('/api/v1/salons').set(bearer(o.access)).send({ ...SALON, ...over }).expect(201)).body.data.salon.id as string;
    return { o, salonId };
  }
  async function approvedSalon(over: Record<string, unknown> = {}) {
    const s = await draftSalon(over);
    await upload(s.o.access, 'DOCUMENT', 'CNIC_FRONT', await png()).expect(201);
    await upload(s.o.access, 'DOCUMENT', 'CNIC_BACK', await png()).expect(201);
    await upload(s.o.access, 'PHOTO', 'COVER', await png()).expect(201);
    await h.http().post('/api/v1/salons/mine/submit').set(bearer(s.o.access)).expect(200);
    await h.http().post(`/api/v1/admin/salons/${s.salonId}/approve`).set(bearer(admin.access)).expect(200);
    return s;
  }
  const qr = (token: string) => h.http().get('/api/v1/salons/mine/qr').set(bearer(token));
  const binary = (req: ReturnType<ReturnType<Harness['http']>['get']>) =>
    req.buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
  async function decode(buf: Buffer): Promise<string | null> {
    const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    return jsQR(new Uint8ClampedArray(data), info.width, info.height)?.data ?? null;
  }

  // ------------------------------------------------------------------ creation and permanence
  describe('the permanent code', () => {
    it('is created by the database when the salon is approved, and is unique per salon', async () => {
      const a = await approvedSalon();
      const b = await approvedSalon();
      const rows = (await aq('SELECT salon_id, code FROM salon_qr_codes WHERE salon_id = ANY($1::uuid[])', [[a.salonId, b.salonId]])).rows;
      expect(rows).toHaveLength(2);
      for (const r of rows) expect(r.code).toMatch(CODE);
      expect(new Set(rows.map((r) => r.code)).size).toBe(2);
    });

    it('an unapproved salon has no code and the API says why (409); no salon at all is 404', async () => {
      const s = await draftSalon();
      const r = await qr(s.o.access).expect(409);
      expect(r.body.error.message).toMatch(/approved/i);
      expect((await aq('SELECT 1 FROM salon_qr_codes WHERE salon_id=$1', [s.salonId])).rowCount).toBe(0);
      const noSalon = await owner();
      await qr(noSalon.access).expect(404);
    });

    it('the link never changes: not on profile edits, not on suspend and reactivate', async () => {
      const s = await approvedSalon();
      const first = (await qr(s.o.access).expect(200)).body.data;
      expect(first.code).toMatch(CODE);
      expect(first.link).toBe(`${BASE}/s/${first.code}`);
      expect(first.salonName).toBe('Glow Studio');

      await h.http().patch('/api/v1/salons/mine').set(bearer(s.o.access)).send({ name: 'Glow Studio Reborn', area: 'DHA', addressLine: '99 New Road' }).expect(200);
      const renamed = (await qr(s.o.access).expect(200)).body.data;
      expect(renamed.code).toBe(first.code);
      expect(renamed.salonName).toBe('Glow Studio Reborn');

      await h.http().post(`/api/v1/admin/salons/${s.salonId}/suspend`).set(bearer(admin.access)).send({ reason: 'Policy check' }).expect(200);
      const suspended = await qr(s.o.access).expect(409);
      expect(suspended.body.error.message).toMatch(/suspended/i);
      await h.http().post(`/api/v1/admin/salons/${s.salonId}/reactivate`).set(bearer(admin.access)).expect(200);
      expect((await qr(s.o.access).expect(200)).body.data.code).toBe(first.code);
    });

    it('the owner request creates the code when the trigger could not (self-healing), once, with an audit record', async () => {
      const s = await approvedSalon();
      await aq('DELETE FROM salon_qr_codes WHERE salon_id=$1', [s.salonId]);
      const a = (await qr(s.o.access).expect(200)).body.data;
      const b = (await qr(s.o.access).expect(200)).body.data;
      expect(a.code).toMatch(CODE);
      expect(b.code).toBe(a.code);
      const audit = await aq(`SELECT 1 FROM audit_logs WHERE action='salon.qr_created' AND salon_id=$1`, [s.salonId]);
      expect(audit.rowCount).toBe(1);
    });
  });

  // ------------------------------------------------------------------ image and poster
  describe('owner downloads', () => {
    it('PNG decodes to the salon link; size and download options work; bad options are refused', async () => {
      const s = await approvedSalon();
      const info = (await qr(s.o.access).expect(200)).body.data;
      const res = await binary(h.http().get('/api/v1/salons/mine/qr/image?size=512&download=1').set(bearer(s.o.access))).expect(200);
      expect(res.headers['content-type']).toBe('image/png');
      expect(res.headers['content-disposition']).toMatch(/^attachment; filename="glow-studio-qr\.png"$/);
      expect((await sharp(res.body).metadata()).width).toBe(512);
      expect(await decode(res.body)).toBe(info.link);
      const inline = await binary(h.http().get('/api/v1/salons/mine/qr/image').set(bearer(s.o.access))).expect(200);
      expect(inline.headers['content-disposition']).toMatch(/^inline/);

      for (const bad of ['size=10', 'size=99999', 'size=abc', 'format=gif', 'format=png;ls', 'x=1']) {
        await h.http().get(`/api/v1/salons/mine/qr/image?${bad}`).set(bearer(s.o.access)).expect(400);
      }
    }, 30_000); // renders and decodes 512 / 1024 px PNGs: CPU-heavy, slower than jest's 5 s default on small CI machines

    it('SVG is served with the right type', async () => {
      const s = await approvedSalon();
      const r = await binary(h.http().get('/api/v1/salons/mine/qr/image?format=svg').set(bearer(s.o.access))).expect(200);
      expect(r.headers['content-type']).toMatch(/^image\/svg\+xml/);
      expect((r.body as Buffer).toString('utf8')).toContain('<svg');
      expect(r.headers['cache-control']).toMatch(/no-store/);
    });

    it('the poster is a one-page PDF in A4 or A5, light or dark; invalid options are refused', async () => {
      const s = await approvedSalon();
      const a4 = await binary(h.http().get('/api/v1/salons/mine/qr/poster?download=1').set(bearer(s.o.access))).expect(200);
      expect(a4.headers['content-type']).toBe('application/pdf');
      expect(a4.headers['content-disposition']).toBe('attachment; filename="glow-studio-poster-a4.pdf"');
      expect(a4.body.subarray(0, 5).toString()).toBe('%PDF-');
      expect(Math.round(Number(/\/MediaBox \[0 0 ([\d.]+) /.exec(a4.body.toString('latin1'))![1]))).toBe(595);
      const a5 = await binary(h.http().get('/api/v1/salons/mine/qr/poster?size=A5&theme=dark').set(bearer(s.o.access))).expect(200);
      expect(Math.round(Number(/\/MediaBox \[0 0 ([\d.]+) /.exec(a5.body.toString('latin1'))![1]))).toBe(420);
      for (const bad of ['size=A3', 'theme=neon', 'size=A4;x']) {
        await h.http().get(`/api/v1/salons/mine/qr/poster?${bad}`).set(bearer(s.o.access)).expect(400);
      }
    });

    it('a salon with an Urdu name still gets a poster (never a 500)', async () => {
      const s = await approvedSalon({ name: 'سیلون نور', area: 'گلبرگ' });
      const r = await binary(h.http().get('/api/v1/salons/mine/qr/poster').set(bearer(s.o.access))).expect(200);
      expect(r.body.subarray(0, 5).toString()).toBe('%PDF-');
    });

    it('an unapproved salon gets no image and no poster (409)', async () => {
      const s = await draftSalon();
      await h.http().get('/api/v1/salons/mine/qr/image').set(bearer(s.o.access)).expect(409);
      await h.http().get('/api/v1/salons/mine/qr/poster').set(bearer(s.o.access)).expect(409);
    });
  });

  // ------------------------------------------------------------------ access control and isolation
  describe('access control and tenant isolation', () => {
    it('needs a signed-in SALON_OWNER (401 / 403) and takes no salon id from the client', async () => {
      await h.http().get('/api/v1/salons/mine/qr').expect(401);
      await h.http().get('/api/v1/salons/mine/qr/poster').expect(401);
      const cust = await registerAndVerify(h, { accountType: 'CUSTOMER' });
      const ct = (await loginMobile(h, cust.email, cust.password)).body.data.accessToken as string;
      await qr(ct).expect(403);
      await h.http().get('/api/v1/salons/mine/qr/poster').set(bearer(ct)).expect(403);
      await h.http().get('/api/v1/salons/mine/qr/image').set(bearer(admin.access)).expect(403);
    });

    it('each owner only ever gets their own code; a salon id sent by the client is ignored', async () => {
      const a = await approvedSalon();
      const b = await approvedSalon();
      const ca = (await qr(a.o.access).expect(200)).body.data.code;
      const cb = (await qr(b.o.access).expect(200)).body.data.code;
      expect(ca).not.toBe(cb);
      const forged = await h.http().get(`/api/v1/salons/mine/qr?salonId=${b.salonId}`).set(bearer(a.o.access)).expect(200);
      expect(forged.body.data.code).toBe(ca);
      const forgedImage = await binary(h.http().get(`/api/v1/salons/mine/qr/image?salonId=${b.salonId}`).set(bearer(a.o.access)));
      expect(forgedImage.status).toBe(400); // unknown query fields are refused where a query DTO exists
    });

    it('database: RLS limits reads, and the runtime role can neither update nor delete a code', async () => {
      const a = await approvedSalon();
      const b = await approvedSalon();
      const ca = (await aq('SELECT code FROM salon_qr_codes WHERE salon_id=$1', [a.salonId])).rows[0].code;
      // no context: nothing
      await asApp({}, async (c) => expect((await c.query('SELECT * FROM salon_qr_codes')).rowCount).toBe(0));
      // salon B sees only B
      await asApp({ salon: b.salonId }, async (c) => {
        const r = await c.query('SELECT salon_id FROM salon_qr_codes');
        expect(r.rows.map((x) => x.salon_id)).toEqual([b.salonId]);
        expect(await failsWith(c, `INSERT INTO salon_qr_codes (salon_id, code) VALUES ($1, 'abcdefghjk')`, [a.salonId])).toBe('42501');
        expect(await failsWith(c, 'UPDATE salon_qr_codes SET code=$1', ['abcdefghjk'])).toBe('42501');
        expect(await failsWith(c, 'DELETE FROM salon_qr_codes')).toBe('42501');
      });
      // public context reads approved rows only
      await asApp({ publicRead: true }, async (c) => {
        expect((await c.query('SELECT 1 FROM salon_qr_codes WHERE code=$1', [ca])).rowCount).toBe(1);
        expect(await failsWith(c, `INSERT INTO salon_qr_codes (salon_id, code) VALUES ($1, 'abcdefghjk')`, [a.salonId])).not.toBe('OK');
      });
    });

    it('database: a code is permanent even for a platform admin, has a strict format, and exists only for approved salons', async () => {
      const a = await approvedSalon();
      const draft = await draftSalon();
      const c1 = await h.admin.connect();
      try {
        await c1.query('BEGIN');
        await c1.query(`SELECT set_config('app.is_platform_admin','true',true)`);
        expect(await failsWith(c1, 'UPDATE salon_qr_codes SET code=$1 WHERE salon_id=$2', ['abcdefghjk', a.salonId])).toBe('42501');
        expect(await failsWith(c1, 'UPDATE salon_qr_codes SET salon_id=$1 WHERE salon_id=$2', [draft.salonId, a.salonId])).toBe('42501');
        expect(await failsWith(c1, `INSERT INTO salon_qr_codes (salon_id, code) VALUES ($1, 'abcdefghjk')`, [draft.salonId])).toBe('42501');
        const bad = await draftSalon();
        for (const code of ['ABCDEFGHJK', 'abcdefghi0', 'abc', 'abcdefghjkm']) {
          expect(await failsWith(c1, `INSERT INTO salon_qr_codes (salon_id, code) VALUES ($1, $2)`, [bad.salonId, code])).not.toBe('OK');
        }
        await c1.query('ROLLBACK');
      } finally {
        c1.release();
      }
    });
  });

  // ------------------------------------------------------------------ public side
  describe('scanning a code', () => {
    it('JSON resolve returns only what a customer needs; case and spaces do not matter', async () => {
      const s = await approvedSalon();
      const { code } = (await qr(s.o.access).expect(200)).body.data;
      const r = await h.http().get(`/api/v1/public/qr/${code.toUpperCase()}`).expect(200);
      expect(r.body.data).toEqual({ code, salonId: s.salonId, name: 'Glow Studio', salonType: 'LADIES', city: 'Lahore', area: 'Gulberg' });
      expect(JSON.stringify(r.body)).not.toMatch(/owner|email|phone|0300/i);
    });

    it('unknown, malformed, injected, draft and suspended all answer the same 404', async () => {
      const s = await approvedSalon();
      const { code } = (await qr(s.o.access).expect(200)).body.data;
      const answers: string[] = [];
      for (const bad of ['abcdefghjk', 'x', "abcdefghj';--", '%00', 'a'.repeat(300), '..%2f..%2fetc']) {
        const r = await h.http().get(`/api/v1/public/qr/${bad}`);
        expect([404]).toContain(r.status);
        answers.push(JSON.stringify({ c: r.body.error.code, m: r.body.error.message }));
      }
      await h.http().post(`/api/v1/admin/salons/${s.salonId}/suspend`).set(bearer(admin.access)).send({ reason: 'Check' }).expect(200);
      const sus = await h.http().get(`/api/v1/public/qr/${code}`).expect(404);
      answers.push(JSON.stringify({ c: sus.body.error.code, m: sus.body.error.message }));
      expect(new Set(answers).size).toBe(1);
      await h.http().post(`/api/v1/admin/salons/${s.salonId}/reactivate`).set(bearer(admin.access)).expect(200);
      await h.http().get(`/api/v1/public/qr/${code}`).expect(200);
    });

    it('the landing page (address printed in the QR) is HTML at /s/<code> with a strict CSP and escaped content', async () => {
      const s = await approvedSalon({ name: 'Glow "Studio" & Spa', addressLine: "Plot 5, Ali's Road" });
      const { code } = (await qr(s.o.access).expect(200)).body.data;
      const r = await h.http().get(`/s/${code}`).expect(200);
      expect(r.headers['content-type']).toMatch(/^text\/html/);
      expect(r.headers['content-security-policy']).toContain("default-src 'none'");
      expect(r.headers['content-security-policy']).not.toMatch(/script-src/);
      expect(r.headers['set-cookie']).toBeUndefined();
      expect(r.text).toContain('Glow &quot;Studio&quot; &amp; Spa');
      expect(r.text).toContain('Plot 5, Ali&#39;s Road');
      expect(r.text).not.toMatch(/<script/i);
      expect(r.text).toContain(code);
      expect(r.text).not.toMatch(/0300|owner/i);

      const missing = await h.http().get('/s/abcdefghjk').expect(404);
      expect(missing.text).toContain('not available');
      await h.http().get('/s/not-a-code').expect(404);
      // the API prefix does not serve the landing page
      await h.http().get(`/api/v1/s/${code}`).expect(404);
    });

    it('rate limiting applies to the public endpoints (route metadata)', async () => {
      const { PublicQrController, SalonLandingController } = await import('../src/modules/qr/qr.controllers');
      for (const [cls, fn] of [[PublicQrController, 'resolve'], [SalonLandingController, 'landing']] as const) {
        const keys = Reflect.getMetadataKeys((cls.prototype as unknown as Record<string, object>)[fn]);
        expect(keys.some((k) => String(k).startsWith('THROTTLER:LIMIT'))).toBe(true);
      }
    });
  });
});
