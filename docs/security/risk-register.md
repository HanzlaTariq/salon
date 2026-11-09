# Security risk register

Updated: 2026-11-08 (Phase 1). Source: `npm audit --omit=dev`, 6 "high" findings, no non-breaking fix available.

| ID | Finding | Exposure in this codebase today | Decision / action | Status |
|----|---------|--------------------------------|-------------------|--------|
| R1 | `multer` (via `@nestjs/platform-express`): DoS via pending async `fileFilter` after request teardown | No upload endpoints exist yet. Becomes relevant in Phase 3 (uploads). | Upgrade `@nestjs/platform-express` to a release that pulls multer >= 2.5.0 before Phase 3; do not use async `fileFilter`; enforce size caps. | **Open, must close before Phase 3** |
| R2 | `deepmerge-ts` (via `@prisma/config` / `prisma` CLI) stack exhaustion on recursive objects | Prisma CLI config loading only; not reachable from request data. | Upgrade Prisma when a patched release is available; re-run audit each phase. | Open, low exposure |
| R3 | `zod` < 4.6.6 memory exhaustion on oversized constrained collections | Zod validates **environment variables only** (trusted, operator-controlled). Request validation uses class-validator. | If zod is later used on request bodies, upgrade to 4.x first (breaking API changes; plan migration). | Open, not reachable |
| R4 | `react-router` / `react-router-dom` 6.x: open redirect via backslash in `<Link>`/`useNavigate`; SSR `deserializeErrors` injection | App is client-only (no SSR). No navigation to user-supplied URLs exists yet. Fix requires v7 (breaking). | Never pass untrusted input to `navigate()`/`<Link to>`; migrate to React Router 7 before Phase 2 ships login redirects (`?next=` must be validated against an allowlist of internal paths). | **Mitigated in Phase 2** (login `?next=` validated by `safeInternalPath`, unit-tested; no other navigation uses untrusted input). Upgrade to v7 still planned. |

Resolved in Phase 1: vitest (critical, dev-only) upgraded to 5.x.

No phase may be called production-ready while R1 is open and uploads are enabled.

## Added in Phase 2

| ID | Finding | Exposure | Decision / action | Status |
|----|---------|----------|-------------------|--------|
| R5 | Rate-limit counters are in-memory per API instance (`@nestjs/throttler` default store) | With more than one API instance the effective limit multiplies. Account lockout is stored in PostgreSQL, so credential-stuffing against one account is still capped. | Phase 2b: Redis-backed store (`REDIS_URL`, required in production by env validation). If Redis is unreachable the request falls back to the in-memory store and a warning is logged (availability over strictness). | **Mitigated in Phase 2b** (unit-tested with a Redis stand-in; verify against a real Redis in staging) |
| R6 | Refresh-token reuse has no grace window | A client that retries a refresh after a network drop (server rotated, response lost) is logged out. | Mobile client must serialise refresh calls (single-flight). Revisit if support tickets show it. | Accepted |
| R7 | Phone numbers are stored but NOT verified | No SMS provider chosen. Phone must not be used as an identity or login factor yet. | Phase 2b did not pick a provider and sends no SMS. Phone stays unverified and is not used for login. Decision still needed (Twilio vs Pakistani gateway) before phone verification. | Open (decision) |
| R8 | No breached-password (HIBP) check; small built-in common-password list | Users can pick passwords that appear in breach corpora but are not in the small list. | Phase 2b: HIBP range API check on register, reset and change (only a 5-char SHA-1 prefix is sent). Fails open by default (`HIBP_FAIL_CLOSED=false`). | **Mitigated in Phase 2b** |
| R9 | Auth SQL is hand-written (`$queryRaw`) and was verified against real PostgreSQL through a test adapter, not through the Prisma engine | Prisma type mapping (uuid/timestamptz/enum casts) could differ subtly. All params carry explicit casts. | Run `npm run test:e2e` locally with the real Prisma client (leave `TEST_PRISMA_ADAPTER` unset). | Verify on your machine |
| R10 | `platform_admin` RLS flag is true for SUPPORT and FINANCE as well | Broad at DB level; narrowed at API level by permissions. | Split into per-role DB policies when finance/support tables exist (Phase 6+). | Open |

## Added in Phase 2b

| ID | Finding | Exposure | Decision / action | Status |
|----|---------|----------|-------------------|--------|
| R11 | E-mail verification and password-reset links point to `WEB_APP_URL` (the admin web app today) | Customers and owners who register from mobile would open an admin-hosted page. Not a security hole, but a poor and confusing flow for a public product. | Decide on a public web domain (or universal/app links) for `/verify-email` and `/reset-password` before public launch. | Open (decision) |
| R12 | Flutter code written in Phase 2b was not compiled or analysed in the build environment (no Flutter SDK there) | A compile or analyzer error may exist until you run the checks in `docs/PHASE2B.md`. | Run `flutter pub get`, `flutter analyze` and `flutter test` in `packages/flutter_core`, then in each app. Fix and report anything found. | Open, verify on your machine |
| R13 | Admin invite flow for SUPPORT/FINANCE conflicts with the rule "platform accounts are created only by CLI, never by an API" | Building an invite API would add an account-creation path to HTTP, which the project rules forbid without your approval. | Not implemented in Phase 2b. Recommended: keep CLI-only creation (`npm run admin:create`) and add a role flag. Your decision is needed to change the rule. | Open (decision) |
| R14 | Phase 2b e2e tests (`npm run test:e2e`) were not executed in the build environment (no Prisma engine download and no PostgreSQL there) | Real-engine behaviour is still unverified; this continues R9. | Run `npm run test:e2e` locally against a Postgres with `TEST_DATABASE_URL` and `TEST_ADMIN_DATABASE_URL`. Redis-related tests run in-memory unless `REDIS_URL` is set. | Open, verify on your machine |
| R15 | `apps/business_app` platform folders (android/ios) are not in the zip | None at runtime; Flutter generates them. | Generate them with `flutter create` as described in `apps/business_app/README.md`. | Accepted (setup step) |

