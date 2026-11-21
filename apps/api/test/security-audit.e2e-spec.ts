import { RequestMethod } from '@nestjs/common';
import { Harness, createHarness, dbEnabled } from './support/harness';

const d = dbEnabled ? describe : describe.skip;

/**
 * Phase 15 security audit as code. These are STRUCTURAL tests: they read the real database catalogue and the real route table,
 * so a table, function or route added in a later phase cannot silently skip the rules.
 */
d('Phase 15: security audit (real PostgreSQL)', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(async () => {
    await h.close();
  });
  const q = async (sql: string, params: unknown[] = []) => (await h.admin.query(sql, params)).rows;

  describe('database', () => {
    it('the runtime role cannot bypass Row-Level Security', async () => {
      const [r] = await q(`SELECT rolsuper, rolbypassrls, rolcreaterole, rolcreatedb FROM pg_roles WHERE rolname = 'salon_app'`);
      expect(r).toEqual({ rolsuper: false, rolbypassrls: false, rolcreaterole: false, rolcreatedb: false });
    });

    it('every table in public has Row-Level Security enabled (second wall), except PostGIS spatial_ref_sys and _prisma_migrations', async () => {
      const rows = await q(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity ORDER BY 1`);
      expect(rows.map((r) => r.relname).filter((t) => t !== 'spatial_ref_sys' && t !== '_prisma_migrations')).toEqual([]);
    });

    it('every salon-owned table (column salon_id) has FORCED RLS and at least one policy', async () => {
      // audit_logs: salon_id is a label on an append-only log, protected by grants + policies instead.
      // *_rating_stats: written only by SECURITY DEFINER triggers (risk R14-7), so they are ENABLED but not FORCED.
      const allow = new Set(['audit_logs', 'salon_rating_stats', 'staff_rating_stats']);
      const rows = await q(`SELECT c.relname, c.relforcerowsecurity AS forced, (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r'
          AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'salon_id' AND NOT a.attisdropped)`);
      expect(rows.length).toBeGreaterThan(25);
      const bad = rows.filter((r) => !allow.has(r.relname) && (!r.forced || r.policies < 1)).map((r) => r.relname);
      expect(bad).toEqual([]);
    });

    it('the Supabase Data API roles and PUBLIC hold no privilege on any table or sequence', async () => {
      const rows = await q(`SELECT grantee, table_name FROM information_schema.role_table_grants
        WHERE table_schema = 'public' AND grantee IN ('anon', 'authenticated', 'PUBLIC') LIMIT 5`);
      expect(rows).toEqual([]);
    });

    it('the runtime role has no TRUNCATE / TRIGGER / REFERENCES anywhere and cannot change the audit log', async () => {
      const bad = await q(`SELECT table_name, privilege_type FROM information_schema.role_table_grants
        WHERE table_schema = 'public' AND grantee = 'salon_app' AND privilege_type IN ('TRUNCATE', 'TRIGGER', 'REFERENCES')`);
      expect(bad).toEqual([]);
      const audit = await q(`SELECT privilege_type FROM information_schema.role_table_grants WHERE table_schema = 'public' AND grantee = 'salon_app' AND table_name = 'audit_logs' ORDER BY 1`);
      expect(audit.map((r) => r.privilege_type)).toEqual(['INSERT', 'SELECT']);
    });

    it('every SECURITY DEFINER function pins its search_path and is not executable by PUBLIC', async () => {
      const rows = await q(`SELECT p.proname,
          COALESCE(array_to_string(p.proconfig, ','), '') LIKE '%search_path=%' AS pinned,
          (p.proacl IS NULL OR EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE')) AS public_exec
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.prosecdef`);
      expect(rows.length).toBeGreaterThanOrEqual(5);
      expect(rows.filter((r) => !r.pinned).map((r) => r.proname)).toEqual([]);
      expect(rows.filter((r) => r.public_exec).map((r) => r.proname)).toEqual([]);
    });

    it('every foreign key has a leading index, except columns that only record WHO acted (listed on purpose)', async () => {
      const rows = await q(`SELECT c.conrelid::regclass::text AS tbl, a.attname AS col
        FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
        WHERE c.contype = 'f' AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = c.conrelid AND i.indkey[0] = c.conkey[1])`);
      const whoActed = (r: { tbl: string; col: string }) =>
        /_by$/.test(r.col) || ['appointment_notes.author_user_id', 'appointment_status_history.actor_user_id', 'staff_invitations.accepted_user_id', 'invoices.promotion_id'].includes(`${r.tbl}.${r.col}`);
      expect(rows.filter((r) => !whoActed(r)).map((r) => `${r.tbl}.${r.col}`)).toEqual([]);
    });

    it('platform_settings: readable by the runtime role, writable only in a Super Admin context', async () => {
      const { Pool } = await import('pg');
      const app = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1 });
      try {
        const c = await app.connect();
        try {
          await c.query('BEGIN');
          expect((await c.query('SELECT count(*)::int AS n FROM platform_settings')).rows[0].n).toBeGreaterThanOrEqual(0);
          // a stranger and a platform-admin FLAG without a stored SUPER_ADMIN user both fail
          await c.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
          const r = await c.query(`UPDATE platform_settings SET value = value`);
          expect(r.rowCount).toBe(0);
          await expect(c.query(`INSERT INTO platform_settings(key, value) VALUES ('evil', '{}'::jsonb)`)).rejects.toThrow(/row-level security/);
        } finally {
          await c.query('ROLLBACK');
          c.release();
        }
      } finally {
        await app.end();
      }
    });
  });

  describe('HTTP surface', () => {
    it('sets hardened headers on every answer and hides the framework', async () => {
      const r = await h.http().get('/api/v1/health').expect(200);
      expect(r.headers['x-content-type-options']).toBe('nosniff');
      expect(r.headers['x-powered-by']).toBeUndefined();
      expect(r.headers['cache-control']).toBe('no-store');
      expect(r.headers['content-security-policy']).toContain("default-src 'none'");
      expect(r.headers['permissions-policy']).toContain('geolocation=()');
      expect(r.headers['referrer-policy']).toBe('no-referrer');
    });

    it('unknown routes and malformed JSON answer in the error envelope, never with a stack trace', async () => {
      const nf = await h.http().get('/api/v1/no/such/route').expect(404);
      expect(nf.body.error).toMatchObject({ code: 'NOT_FOUND' });
      expect(typeof nf.body.error.requestId).toBe('string');
      const bad = await h.http().post('/api/v1/auth/login').set('Content-Type', 'application/json').send('{"email": ').expect(400);
      expect(bad.body.error.code).toBe('VALIDATION_FAILED');
      expect(JSON.stringify([nf.body, bad.body])).not.toMatch(/\bat\s.+\.(ts|js):\d+|node_modules|SyntaxError/);
    });

    it('refuses an oversized JSON body (413) in the error envelope', async () => {
      const r = await h.http().post('/api/v1/auth/login').send({ email: 'a@b.test', password: 'x'.repeat(300_000) }).expect(413);
      expect(r.body.error.code).toBe('PAYLOAD_TOO_LARGE');
    });

    it('CORS: only the allow-listed origin is answered', async () => {
      const ok = await h.http().get('/api/v1/health').set('Origin', 'https://admin.example.test');
      expect(ok.headers['access-control-allow-origin']).toBe('https://admin.example.test');
      const evil = await h.http().get('/api/v1/health').set('Origin', 'https://evil.example');
      expect(evil.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('server limits are applied (slow-loris protection)', () => {
      const server = h.app.getHttpServer();
      expect(server.requestTimeout).toBeGreaterThan(0);
      expect(server.headersTimeout).toBeGreaterThan(0);
    });

    it('EVERY private route answers 401 without credentials (default deny, whatever the method)', async () => {
      const { ModulesContainer } = await import('@nestjs/core');
      const { IS_PUBLIC } = await import('../src/common/auth/decorators');
      const verbs: Record<number, 'get' | 'post' | 'put' | 'delete' | 'patch'> = {
        [RequestMethod.GET]: 'get', [RequestMethod.POST]: 'post', [RequestMethod.PUT]: 'put', [RequestMethod.DELETE]: 'delete', [RequestMethod.PATCH]: 'patch',
      };
      const uuid = '11111111-1111-4111-8111-111111111111';
      const routes: Array<{ verb: 'get' | 'post' | 'put' | 'delete' | 'patch'; path: string }> = [];
      for (const mod of h.app.get(ModulesContainer).values()) {
        for (const w of mod.controllers.values()) {
          const proto = w.metatype?.prototype as Record<string, unknown> | undefined;
          if (!proto) continue;
          const base = String(Reflect.getMetadata('path', w.metatype!) ?? '');
          for (const name of Object.getOwnPropertyNames(proto)) {
            const fn = proto[name];
            if (typeof fn !== 'function' || name === 'constructor') continue;
            const method = Reflect.getMetadata('method', fn);
            if (method === undefined) continue;
            const isPublic = Reflect.getMetadata(IS_PUBLIC, fn) === true || Reflect.getMetadata(IS_PUBLIC, w.metatype!) === true;
            if (isPublic) continue;
            const path = `/api/v1/${base}/${String(Reflect.getMetadata('path', fn))}`.replace(/\/+/g, '/').replace(/:[A-Za-z]+/g, uuid);
            routes.push({ verb: verbs[method as number] ?? 'get', path });
          }
        }
      }
      expect(routes.length).toBeGreaterThan(100);
      const failures: string[] = [];
      for (const r of routes) {
        const res = await h.http()[r.verb](r.path);
        if (res.status !== 401) failures.push(`${r.verb.toUpperCase()} ${r.path} -> ${res.status}`);
      }
      expect(failures).toEqual([]);
    });

    it('a forged, expired or junk bearer token is a plain 401, never a 500', async () => {
      for (const t of ['junk', 'eyJhbGciOiJub25lIn0.eyJzdWIiOiJ4In0.', 'a.b.c']) {
        const r = await h.http().get('/api/v1/notifications/preferences').set('Authorization', `Bearer ${t}`);
        expect(r.status).toBe(401);
      }
    });
  });
});
