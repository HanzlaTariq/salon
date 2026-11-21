# Phase 15: Security audit, performance, backups, operations

Scope (from the master prompt): security audit, multi-tenant isolation tests, query / index optimisation, rate limiting, image
optimisation, caching, logging, backup strategy and restore drill, error monitoring. No Flutter or admin-web code changed in this phase.

## 1. What changed and why

| Area | Change | Risks closed |
|---|---|---|
| Database | Migration `20261122000000_hardening_phase15`: RLS as a second wall on 7 tables that had none (`users`, `auth_sessions`, `auth_tokens`, `refresh_tokens`, `mfa_recovery_codes`, `audit_logs`, `platform_settings`); `platform_settings` writable by SUPER_ADMIN only; 8 foreign-key indexes; two `SECURITY DEFINER` maintenance functions | R53 |
| Retention | `maintenance_purge()` deletes dead tokens, ended sessions, finished invitations (90 d), offline ledger rows (90 d). The runtime role still cannot delete from `sync_operations` / `staff_invitations`; the age limit is also inside the RLS policy | R34, R130 |
| Storage | Reconciliation finds files in the private bucket that no row points to (default: report only). Safety rules: min age 24 h, never a referenced key, nothing deleted if over half of a bucket (20+ files) looks orphaned, max 200 per run, complete listing required | R19, R29 |
| Caching | `PublicUrlSigner`: public image URLs are signed once and reused for half of their lifetime (single flight, 2000 entries). Responses now report the guaranteed lifetime (`imageUrlTtlSec`, `photoUrlTtlSec`). Private files (documents, receipts) are never cached | R26 |
| Rate limiting | `UserAwareThrottlerGuard`: signed-in requests are limited per USER (token verified), others per IP. Fixes unfair blocking behind carrier NAT | (new) |
| Errors | Body-parser errors (oversized / broken body) returned 500; now 413 / 400 in the error envelope (found by the new tests) | (new) |
| Monitoring | Sentry-compatible reporter without an SDK, scrubbed events, flood protection; structured `security.denied` log events (401 / 403 / 429); `http.slow` warnings; process-level handlers | (new) |
| HTTP hardening | `Cache-Control: no-store` and `Permissions-Policy` on every answer unless a route sets its own; request / header timeouts | (new) |
| Images | Max edge 1600 px (was 2400), WebP quality 80; storage objects now cacheable for 1 h (keys are never reused) | (partly R26) |
| Backups | `infra/backup`: encrypted dump (bash + PowerShell), restore drill with verification, GitHub Actions daily job, storage backup CLI | (new) |
| Tests | `security-audit`, `rate-limit-user`, `maintenance` e2e suites; unit specs for cache, planner, reporter, storage backup | |

## 2. Findings of the audit (and what was done)

1. 8 tables had no RLS. Fixed for 7 (policy `TO salon_app` reproduces today's access). `spatial_ref_sys` belongs to PostGIS and is not exposed (R56).
2. Unindexed foreign keys on hot paths. 8 indexes added. Columns that only record who acted (`created_by` ...) stay unindexed on purpose; the audit test lists them, so a new foreign key must get an index or be added to that list consciously.
3. A body larger than 100 kB answered 500 and was logged as a server error. Fixed.
4. Backups with `FORCE ROW LEVEL SECURITY`: a dump by a role without BYPASSRLS fails ("query would be affected by row-level security policy"). It fails safe, but it means the backup role must be Supabase's `postgres`. Documented in `docs/BACKUP.md`.
5. `npm audit --omit=dev`: 5 high findings, unchanged and not reachable from request data (prisma CLI config, `effect` via Prisma, `zod` on environment variables only). See the risk register (R2, R3, R15-6).

## 3. New environment variables

See `apps/api/.env.example`: `MAINTENANCE_WORKER_ENABLED`, `MAINTENANCE_CRON_SECRET`, `MAINTENANCE_DELETE_ORPHANS`, `MAINTENANCE_ORPHAN_MIN_AGE_HOURS`, `SENTRY_DSN`, `APP_RELEASE`, `SLOW_REQUEST_MS`, `REQUEST_TIMEOUT_MS`. All optional; the defaults are safe.

## 4. Install, migrate, test (Windows)

```powershell
cd apps\api
npm install
npx prisma validate
npx prisma migrate deploy          # uses DIRECT_URL (session pooler); applies 20261122000000_hardening_phase15
npm run typecheck
npm test
npm run test:e2e                   # WITHOUT TEST_PRISMA_ADAPTER (real Prisma engine)
```
CMD users: same commands; to set a variable use `set NAME=value` instead of `$env:NAME='value'`.

New scripts: `npm run maintenance:run`, `npm run storage:backup` (needs `BACKUP_DIR`).

## 5. Manual verification

1. `npx prisma migrate deploy` succeeds. In the Supabase SQL editor: `SELECT relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND NOT c.relrowsecurity;` returns only `spatial_ref_sys`.
2. Log in as Super Admin, change the free-trial days in the platform settings: it must still work (the write policy checks the stored SUPER_ADMIN role).
3. `npm run maintenance:run` prints counts. Read `storage.orphans` once, look at what it would delete, and only then set `MAINTENANCE_DELETE_ORPHANS=true`.
4. Open any public salon page twice within a minute: the image URL is identical (cached), and `imageUrlTtlSec` is half of `SIGNED_URL_TTL_SEC`.
5. Backup and restore drill: follow `docs/BACKUP.md` section 4 once, now, before you have real customers.
6. Set `SENTRY_DSN` in a staging environment and trigger an error (for example stop the database and call a private route): the event must arrive with no e-mail address or token inside.
7. Serverless hosting (Vercel): set `MAINTENANCE_WORKER_ENABLED=false`, set `MAINTENANCE_CRON_SECRET`, and call `POST /api/v1/internal/maintenance/run` with header `x-cron-secret` from a daily cron.

## 6. What is NOT done (honest list)

* Prisma engine: `prisma generate` / `validate` / `migrate deploy` could not run in the build environment. The migration was applied with `psql` and every test ran through the node-postgres adapter. Run section 4 on your machine.
* The SQL of this phase was tested on PostgreSQL 16 + PostGIS 3.4, not on a real Supabase project (storage list API, `postgres` BYPASSRLS behaviour, PostgreSQL 17 client).
* Sentry reporting, the Supabase storage `list` / `get` calls, the GitHub workflow and the PowerShell scripts were written but not run against the real services.
* Image thumbnails (a small variant for search cards) are NOT built: they need a schema change and a backfill of existing images. Planned for Phase 16 if you want them.
* Open DB-level exposures R44, R51, R52, R64, R79 are unchanged (see the risk register: each needs a billing or booking redesign, not a policy tweak).
* No SQLCipher for the offline database (R125) and no admin-web or Flutter changes.
* Slow-query logging at the Prisma level was not added (cannot be verified without the engine); use `infra/db/slow-queries.sql` and the HTTP-level `http.slow` event.
* This phase is not production-ready until the checks in section 4 and the restore drill pass on your machine.
