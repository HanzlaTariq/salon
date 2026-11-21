# Environment reference

Where each file lives (production): `infra/deploy/.env` (compose), `.env.api` (API), `.env.migrate` (owner role, migrations only). All git-ignored; only `*.example` files are committed.
`npm run preflight` (inside the `cli` container) checks the API file and prints variable NAMES only, never values.

## API (`.env.api`, validated at boot by `src/config/env.ts`, extra production checks by `src/config/preflight.ts`)

| Variable | Production value | How to get it / note |
|---|---|---|
| `NODE_ENV` | `production` | |
| `PORT` | `3000` | Caddy expects 3000 |
| `LOG_LEVEL` | `info` | |
| `DATABASE_URL` | Supabase **transaction pooler** (port 6543), user `salon_app.<ref>`, `?pgbouncer=true&connection_limit=5&sslmode=require` | Dashboard > Connect. URL-encode special characters in the password. Never the `postgres` user |
| `DIRECT_URL` | **leave out** | Only `.env.migrate` has it. The image mirrors `DATABASE_URL` when it is absent |
| `CORS_ORIGINS` | `https://admin.<domain>` | Comma-separated, https only, no `*` |
| `WEB_APP_URL` | `https://admin.<domain>` | E-mail links (verify, reset, invitation) point here (risk R11 / R31) |
| `PUBLIC_LINK_BASE_URL` | `https://api.<domain>` | Printed in QR codes. Final domain only |
| `TRUST_PROXY_HOPS` | `1` | Caddy is one proxy |
| `COOKIE_SECURE` | `true` | |
| `JWT_ACCESS_SECRET` | 48 random bytes, base64url | `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`. Rotating it signs everybody out |
| `ACCESS_TOKEN_TTL_SEC`, `REFRESH_TOKEN_TTL_DAYS`, `SESSION_MAX_DAYS` | defaults (900 / 30 / 90) | |
| `MFA_ENCRYPTION_KEY` | base64 of 32 random bytes | **Back it up offline.** Lost key = every MFA secret unreadable |
| `REQUIRE_ADMIN_MFA` | `true` | |
| `ARGON2_MEMORY_KIB` / `ARGON2_TIME_COST` / `ARGON2_PARALLELISM` | `19456` / `2` / `1` or higher | Below these the preflight fails |
| `LOGIN_MAX_ATTEMPTS`, `LOGIN_LOCKOUT_MINUTES` | defaults (5 / 15) | |
| `HIBP_CHECK_ENABLED`, `HIBP_FAIL_CLOSED` | `true`, `false` | Breached-password check |
| `REDIS_URL` | set by compose | `redis://:<REDIS_PASSWORD>@redis:6379` |
| `RATE_LIMIT_TTL_MS`, `RATE_LIMIT_MAX` | defaults (60000 / 300) | |
| `MAIL_TRANSPORT` | `smtp` | |
| `MAIL_FROM`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_SECURE` | from your mail provider | Use a domain you control (SPF/DKIM/DMARC) or mails land in spam |
| `STORAGE_DRIVER` | `supabase` | |
| `SUPABASE_URL` | `https://<ref>.supabase.co` | |
| `SUPABASE_SERVICE_ROLE_KEY` | secret key | Dashboard > Project Settings > API Keys. **Backend only.** Rotate if it ever leaks |
| `SUPABASE_STORAGE_BUCKET` | `salon-private` | Bucket must be PRIVATE |
| `UPLOAD_MAX_BYTES`, `SIGNED_URL_TTL_SEC` | defaults (5 MiB / 300) | Caddy allows 12 MB bodies |
| `PUSH_DRIVER` | `fcm` | |
| `FCM_SERVICE_ACCOUNT_B64` | base64 of the Firebase service-account JSON | `docs/PHASE10.md` |
| `NOTIFICATIONS_WORKER_ENABLED`, `NOTIFICATIONS_TICK_SECONDS`, `NOTIFICATIONS_CRON_SECRET` | `true`, `15`, optional | Exactly one process must run the worker |
| `MAINTENANCE_WORKER_ENABLED`, `MAINTENANCE_CRON_SECRET`, `MAINTENANCE_DELETE_ORPHANS`, `MAINTENANCE_ORPHAN_MIN_AGE_HOURS` | `true`, optional, `false`, `24` | Turn deletion on only after reading one report (`docs/PHASE15.md`) |
| `SENTRY_DSN`, `APP_RELEASE` | optional but recommended | |
| `SLOW_REQUEST_MS`, `REQUEST_TIMEOUT_MS` | `1500`, `30000` | |
| `APP_STORE_URL_ANDROID`, `APP_STORE_URL_IOS`, `BRAND_NAME` | set after publishing | Store buttons on the QR landing page |
| `ENABLE_SWAGGER` | leave out | Ignored in production |

## Migrations (`.env.migrate`)
`DIRECT_URL` and `DATABASE_URL`: same value, owner role `postgres.<ref>` through the **session pooler** (port 5432; the direct host is IPv6-only).

## Compose (`infra/deploy/.env`)
`API_DOMAIN`, `ADMIN_DOMAIN`, `ACME_EMAIL`, `REDIS_PASSWORD` (letters and digits only), `RELEASE` (image tag).

## Admin web
No runtime variables. `VITE_API_URL` stays empty so the browser calls `/api` on its own origin (set it only when you host the admin web somewhere that cannot forward `/api`; then `CORS_ORIGINS` must list that origin and the cookie needs `SameSite` review).

## Mobile apps (build time, `--dart-define`)
`API_BASE_URL=https://api.<domain>/api/v1`. A release build refuses to start with anything but https (`AuthConfig.assertReleaseReady`).
Signing: `android/key.properties` + keystore (git-ignored), see `docs/RELEASE_MOBILE.md`.

## GitHub Actions
Secrets: `BACKUP_DATABASE_URL`, `BACKUP_AGE_RECIPIENT` (backups), `ANDROID_KEYSTORE_B64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_PASSWORD`, `ANDROID_KEY_ALIAS` (Android release). Variable: `API_BASE_URL`.
