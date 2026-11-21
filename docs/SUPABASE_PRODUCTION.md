# Supabase for production

Verify current plan limits and prices on supabase.com/pricing before you decide; they change.

## 1. Why not stay on Free
The Free plan has no automated backups and can pause after inactivity (a paused database means a dead product). A paying business should be on a paid plan: daily backups at minimum; **PITR** (point-in-time recovery, a paid add-on) lets you restore to the minute before a mistake.
Until you upgrade, the encrypted `pg_dump` schedule in `docs/BACKUP.md` is mandatory.

## 2. Create the production project
1. New project, strong database password, region close to the API server (Tokyo is fine, check latency from your server).
2. SQL Editor: edit the password in `infra/supabase/01-roles.sql`, run it (creates `salon_app`).
3. Settings > API: **disable the Data API**. Never use the anon key anywhere. The `service_role` key goes only into `.env.api` on the server.
4. Extensions (Database > Extensions): `btree_gist`, `pg_trgm`, `pgcrypto`, `postgis`.
5. Storage: bucket `salon-private`, **Public bucket OFF**, no policies for `anon` / `authenticated`.
6. Fill `.env.migrate` (session pooler 5432, `postgres.<ref>`) and run `docker compose ... run --rm migrate`.
7. Verify (SQL Editor, as `postgres`):
   ```sql
   select rolname, rolbypassrls, rolsuper from pg_roles where rolname = 'salon_app';   -- both false
   select count(*) from information_schema.role_table_grants where grantee in ('anon','authenticated') and table_schema = 'public';   -- 0
   ```

## 3. Sizing and connections
* Runtime pool: `connection_limit=5` per API instance through the transaction pooler (port 6543). One API instance + one CLI run fits any plan.
* Move to a larger compute size when `docs/PERFORMANCE.md` queries (`infra/db/slow-queries.sql`) show sustained CPU or memory pressure, not before.
* Read `pg_stat_statements` monthly (Supabase Dashboard > Query Performance).

## 4. Backups and restore
* Paid plan: enable daily backups and PITR in Dashboard > Database > Backups.
* Keep the own encrypted dumps as well (different failure domain). Restore drill every month (`infra/backup/restore-drill.sh`).
* Storage objects are NOT in a database backup: `npm run storage:backup` (see `docs/BACKUP.md`).

## 5. Moving from the Free project to the production project
1. Maintenance window; stop the API (`docker compose ... stop api`).
2. `infra/backup/backup.sh` on the old project; restore into the new one as in `docs/BACKUP.md` (the restore drill is the same procedure).
3. Copy the storage bucket (`storage:backup` then upload to the new bucket) and check a few signed URLs.
4. Update `DATABASE_URL`, `.env.migrate`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`; run `preflight`, `migrate` (it must report nothing to apply), start, smoke test.
5. Rotate the old project's keys, keep it read-only for two weeks, then delete it.
