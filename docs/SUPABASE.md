# Supabase setup (replaces local Postgres)

Supabase = managed PostgreSQL, so Prisma, the raw SQL, RLS policies and `set_config(...)` tenancy keep working unchanged.
Only the connection setup changed.

## 1. Supabase project
Create a project. Dashboard > **Connect** gives you the host / project ref / region.
Also: Settings > API > consider **disabling the Data API** (this app never uses it).

## 2. Create the runtime role (once)
Edit the password in `infra/supabase/01-roles.sql`, then run it in **SQL Editor**.

## 3. Env (`apps/api/.env`)
Copy `.env.example`, fill `DATABASE_URL` (pooler **6543**, `?pgbouncer=true`, user `salon_app.<ref>`) and
`DIRECT_URL` (user `postgres.<ref>`, port **5432**). URL-encode special characters in passwords (`@` -> `%40`).

## 4. Migrate + run
```bash
cd apps/api
npm install
npx prisma generate
npx prisma migrate deploy      # uses DIRECT_URL
npm run start:dev
curl localhost:3000/api/v1/health/ready
ADMIN_EMAIL=you@example.com ADMIN_NAME="Your Name" ADMIN_PASSWORD='long passphrase' npm run admin:create
```

## Notes
- Do not point `DATABASE_URL` at the `postgres` user: it bypasses RLS.
- Migration port 5432 on `db.<ref>.supabase.co` is IPv6-only; on IPv4 networks use the pooler session-mode URL.
- Tests/CI still use the local docker Postgres (`infra/docker-compose.yml`); nothing changes there.
- Hosting the API (Railway/Render/VPS): set the same env vars there, `COOKIE_SECURE=true`, `MAIL_TRANSPORT=smtp`.

## Storage (Phase 3)

1. Dashboard > Storage > New bucket: name `salon-private`, **Public bucket OFF**. (Never make it public: it holds CNIC photos.)
2. Do not add any Storage policies for `anon`/`authenticated`: only the backend, using the `service_role` key, touches the bucket.
3. In `apps/api/.env` set `STORAGE_DRIVER=supabase`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_STORAGE_BUCKET`.
4. The key lives only in the backend environment. If it is ever pasted anywhere, rotate it (Project Settings > API Keys).
5. Free plan: 1 GB storage and a per-file limit apply; images are re-encoded to WebP (typically 50-300 KB) so this lasts a long time.

