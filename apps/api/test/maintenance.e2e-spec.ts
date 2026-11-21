import sharp from 'sharp';
import type { Harness } from './support/harness';
import { MemoryObjectStorage, ObjectStorage } from '../src/common/storage/object-storage';
import { ENV, Env } from '../src/config/env';

const SECRET = 'maintenance-secret-'.padEnd(40, 'm');
// parseEnv() runs when AppModule is imported, so the secret must exist before the harness is loaded.
process.env.MAINTENANCE_CRON_SECRET = SECRET;

import { dbEnabled } from './support/harness';
const d = dbEnabled ? describe : describe.skip;

const png = () => sharp({ create: { width: 600, height: 400, channels: 3, background: '#aa7744' } }).png().toBuffer();
const SALON = { name: 'Glow Studio', salonType: 'LADIES', city: 'Lahore', area: 'Gulberg', addressLine: '12 Main Boulevard, Gulberg III', phone: '0300 1234567', description: 'Premium ladies salon' };

d('Phase 15: maintenance (retention purge + storage reconciliation) on real PostgreSQL', () => {
  let h: Harness;
  let storage: MemoryObjectStorage;
  let env: Env;
  let H: typeof import('./support/harness');

  beforeAll(async () => {
    H = await import('./support/harness');
    h = await H.createHarness();
    storage = h.app.get(ObjectStorage) as MemoryObjectStorage;
    env = h.app.get(ENV);
  });
  afterAll(async () => {
    await h.close();
  });

  const run = (secret?: string) => {
    const r = h.http().post('/api/v1/internal/maintenance/run');
    return secret ? r.set('x-cron-secret', secret) : r;
  };
  const q = async (sql: string, params: unknown[] = []) => (await h.admin.query(sql, params)).rows;

  describe('the cron endpoint', () => {
    it('refuses a missing or wrong secret and answers with counts only for the right one', async () => {
      await run().expect(401);
      await run('wrong-secret').expect(401);
      const ok = await run(SECRET).expect(200);
      expect(Object.keys(ok.body.data.purged).sort()).toEqual(['authTokens', 'refreshTokens', 'sessions', 'staffInvitations', 'syncOperations']);
      expect(typeof ok.body.data.storage.orphans).toBe('number');
      expect(JSON.stringify(ok.body)).not.toMatch(/salons\//);
    });
  });

  describe('retention purge', () => {
    it('removes dead tokens and long-ended sessions but keeps live ones', async () => {
      const u = await H.registerAndVerify(h);
      const [{ id: userId }] = await q('SELECT id FROM users WHERE email = $1', [u.email]);
      const old = "now() - interval '40 days'";
      const [oldSession] = await q(`INSERT INTO auth_sessions (user_id, expires_at, revoked_at, revoked_reason) VALUES ($1, ${old}, ${old}, 'LOGOUT') RETURNING id`, [userId]);
      const [liveSession] = await q(`INSERT INTO auth_sessions (user_id, expires_at) VALUES ($1, now() + interval '10 days') RETURNING id`, [userId]);
      const [recentlyRevoked] = await q(`INSERT INTO auth_sessions (user_id, expires_at, revoked_at, revoked_reason) VALUES ($1, now() + interval '10 days', now() - interval '2 days', 'LOGOUT') RETURNING id`, [userId]);
      await q(`INSERT INTO refresh_tokens (session_id, token_hash, expires_at) VALUES ($1, md5(random()::text), ${old})`, [oldSession.id]);
      await q(`INSERT INTO auth_tokens (user_id, type, token_hash, expires_at) VALUES ($1, 'PASSWORD_RESET', md5('old' || random()::text), now() - interval '10 days')`, [userId]);
      const [freshToken] = await q(`INSERT INTO auth_tokens (user_id, type, token_hash, expires_at) VALUES ($1, 'PASSWORD_RESET', md5('new' || random()::text), now() + interval '1 hour') RETURNING id`, [userId]);

      const report = (await run(SECRET).expect(200)).body.data;
      expect(report.purged.sessions).toBeGreaterThanOrEqual(1);
      expect(report.purged.authTokens).toBeGreaterThanOrEqual(1);

      expect(await q('SELECT 1 FROM auth_sessions WHERE id = $1', [oldSession.id])).toHaveLength(0);
      expect(await q('SELECT 1 FROM refresh_tokens WHERE session_id = $1', [oldSession.id])).toHaveLength(0); // cascaded
      expect(await q('SELECT 1 FROM auth_sessions WHERE id = ANY($1::uuid[])', [[liveSession.id, recentlyRevoked.id]])).toHaveLength(2);
      expect(await q('SELECT 1 FROM auth_tokens WHERE id = $1', [freshToken.id])).toHaveLength(1);
    });

    it('the database itself limits the purge: the runtime role cannot delete history directly, the function only deletes old rows', async () => {
      const { Pool } = await import('pg');
      const app = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1 });
      try {
        await expect(app.query('DELETE FROM sync_operations')).rejects.toThrow(/permission denied/);
        await expect(app.query('DELETE FROM staff_invitations')).rejects.toThrow(/permission denied/);
        await expect(app.query('UPDATE audit_logs SET action = action')).rejects.toThrow(/permission denied/);
        // calling the function as the runtime role is allowed and returns counts
        const r = await app.query('SELECT maintenance_purge() AS r');
        expect(r.rows[0].r).toHaveProperty('syncOperations');
        // more than 500 keys are refused
        await expect(app.query('SELECT maintenance_keys_in_use($1::text[])', [Array.from({ length: 501 }, (_, i) => `k${i}`)])).rejects.toThrow(/at most 500/);
      } finally {
        await app.end();
      }
    });
  });

  describe('storage reconciliation', () => {
    const hoursAgo = (n: number) => new Date(Date.now() - n * 3_600_000);

    it('never touches a referenced file or a young file; reports orphans; deletes them only when enabled', async () => {
      // a REAL referenced file, created through the normal upload flow
      const owner = await H.registerAndVerify(h, { accountType: 'SALON_OWNER' });
      const access = (await H.loginMobile(h, owner.email, owner.password)).body.data.accessToken as string;
      await h.http().post('/api/v1/salons').set(H.bearer(access)).send(SALON).expect(201);
      await h.http().post('/api/v1/salons/mine/files').set(H.bearer(access)).field('kind', 'PHOTO').field('docType', 'COVER').attach('file', await png(), 'c.png').expect(201);
      // salon_files has FORCED RLS: even the owner role needs a platform-admin context to read it
      const c = await h.admin.connect();
      let referenced: string;
      try {
        await c.query('BEGIN');
        await c.query(`SELECT set_config('app.is_platform_admin','true',true)`);
        referenced = (await c.query(`SELECT storage_key FROM salon_files ORDER BY created_at DESC LIMIT 1`)).rows[0].storage_key;
        await c.query('COMMIT');
      } finally {
        c.release();
      }
      expect(storage.objects.has(referenced)).toBe(true);

      storage.objects.get(referenced)!.createdAt = hoursAgo(100);
      await storage.put('salons/orphan/old-orphan.webp', Buffer.from('x'), 'image/webp');
      storage.objects.get('salons/orphan/old-orphan.webp')!.createdAt = hoursAgo(100);
      await storage.put('salons/orphan/young-orphan.webp', Buffer.from('x'), 'image/webp');

      // 1) report-only (default)
      env.MAINTENANCE_DELETE_ORPHANS = false;
      const first = (await run(SECRET).expect(200)).body.data.storage;
      expect(first.orphans).toBeGreaterThanOrEqual(1);
      expect(first.removed).toBe(0);
      expect(first.skippedReason).toBe('REPORT_ONLY');
      expect(storage.objects.has('salons/orphan/old-orphan.webp')).toBe(true);

      // 2) deletion enabled
      env.MAINTENANCE_DELETE_ORPHANS = true;
      try {
        const second = (await run(SECRET).expect(200)).body.data.storage;
        expect(second.removed).toBeGreaterThanOrEqual(1);
        expect(storage.objects.has('salons/orphan/old-orphan.webp')).toBe(false); // old orphan gone
        expect(storage.objects.has('salons/orphan/young-orphan.webp')).toBe(true); // too young: an upload may still be saving
        expect(storage.objects.has(referenced)).toBe(true); // referenced: never deleted
      } finally {
        env.MAINTENANCE_DELETE_ORPHANS = false;
      }
    });

    it('refuses to delete when most of a real-sized bucket looks orphaned (wrong database)', async () => {
      for (let i = 0; i < 30; i += 1) {
        const key = `salons/mass/${i}.webp`;
        await storage.put(key, Buffer.from('x'), 'image/webp');
        storage.objects.get(key)!.createdAt = hoursAgo(100);
      }
      env.MAINTENANCE_DELETE_ORPHANS = true;
      try {
        const r = (await run(SECRET).expect(200)).body.data.storage;
        expect(r.skippedReason).toBe('TOO_MANY_ORPHANS');
        expect(r.removed).toBe(0);
        expect(storage.objects.has('salons/mass/0.webp')).toBe(true);
      } finally {
        env.MAINTENANCE_DELETE_ORPHANS = false;
      }
    });
  });
});
