# Security risk register

Updated: 2026-11-08 (Phase 1). Source: `npm audit --omit=dev`, 6 "high" findings, no non-breaking fix available.

| ID | Finding | Exposure in this codebase today | Decision / action | Status |
|----|---------|--------------------------------|-------------------|--------|
| R1 | `multer` (via `@nestjs/platform-express`): DoS via pending async `fileFilter` after request teardown | No upload endpoints exist yet. Becomes relevant in Phase 3 (uploads). | Upgrade `@nestjs/platform-express` to a release that pulls multer >= 2.5.0 before Phase 3; do not use async `fileFilter`; enforce size caps. | **CLOSED in Phase 3**: `overrides: { multer: ^2.5.0 }` in `apps/api/package.json` (resolved 2.5.0, `npm ls multer` shows "overridden"); no async `fileFilter`; size/parts/fields capped; memory storage only. |
| R2 | `deepmerge-ts` (via `@prisma/config` / `prisma` CLI) stack exhaustion on recursive objects | Prisma CLI config loading only; not reachable from request data. | Upgrade Prisma when a patched release is available; re-run audit each phase. | Open, low exposure |
| R3 | `zod` < 4.6.6 memory exhaustion on oversized constrained collections | Zod validates **environment variables only** (trusted, operator-controlled). Request validation uses class-validator. | If zod is later used on request bodies, upgrade to 4.x first (breaking API changes; plan migration). | Open, not reachable |
| R4 | `react-router` / `react-router-dom` 6.x: open redirect via backslash in `<Link>`/`useNavigate`; SSR `deserializeErrors` injection | App is client-only (no SSR). No navigation to user-supplied URLs exists yet. Fix requires v7 (breaking). | Never pass untrusted input to `navigate()`/`<Link to>`; migrate to React Router 7 before Phase 2 ships login redirects (`?next=` must be validated against an allowlist of internal paths). | **Mitigated in Phase 2** (login `?next=` validated by `safeInternalPath`, unit-tested; no other navigation uses untrusted input). Upgrade to v7 still planned. |

Resolved in Phase 1: vitest (critical, dev-only) upgraded to 5.x.

R1 is closed (Phase 3). Re-check `npm ls multer` after every `@nestjs/platform-express` upgrade.

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

## Added in Phase 3

| ID | Finding | Exposure | Decision / action | Status |
|----|---------|----------|-------------------|--------|
| R16 | Uploaded **PDF** documents are stored as received (images are fully re-encoded to WebP, PDFs cannot be) | A malicious PDF could reach a reviewer. The active-content heuristic (`/JavaScript`, `/Launch`, `/OpenAction`, `/EmbeddedFile`, ...) only blocks the obvious; object streams can hide it. | Mitigations: PDFs are accepted for DOCUMENT slots only; stored in a private bucket; served only to Super Admins via a short-lived signed URL with `download=` (never rendered inline); mobile app uploads images only. Optional hardening: malware scan (ClamAV) or rasterise PDFs server-side. | Accepted, monitor |
| R17 | `sharp`/libvips parse untrusted images | Image-decoder bugs are the main risk of any upload feature. | Pinned `sharp@^0.35.5` (audit clean at release), 40 MP pixel cap, only JPEG/PNG/WebP accepted (no SVG/GIF/HEIC/TIFF), `failOn: error`. Re-run `npm audit` every phase. | Mitigated |
| R18 | Supabase Storage bucket must be created PRIVATE by you | If the bucket is made public, every document URL becomes world-readable. | Create it with "Public bucket" OFF (see `docs/PHASE3.md`). Keys are random UUID paths and the API only hands out signed URLs, but the bucket setting is the real wall. Check it after creating. | Open, verify on your machine |
| R19 | Orphaned storage objects if the API crashes between "upload to storage" and "insert DB row" (or a post-commit delete fails) | Wasted storage; a private, unreferenced object is not reachable by anyone. | Failures are cleaned up inline and logged. A periodic reconciliation job (list bucket vs `salon_files`) belongs to Phase 15. | Accepted until Phase 15 |
| R20 | `app_is_platform_admin()` is also true for SUPPORT (continues R10) | The `salons_guard` trigger lets any platform-admin context approve/suspend at database level. API permissions (`salons.review`, `salons.manage_status`, `salons.documents_read`) are the narrowing layer and are tested (SUPPORT gets 403). | Per-role DB policies in Phase 6+. | Open (continues R10) |
| R21 | Owner can hold one salon only; owner edit lock is also enforced in the DB for APPROVED/SUSPENDED | Phase 4 (profile management of approved salons) must relax `salons_guard()` with a new migration. | Documented in `docs/PHASE3.md`; never edit the applied migration. | Planned |
| R22 | New owner/admin screens (Flutter `business_app`) were not compiled or analysed here (no Flutter SDK) | Possible analyzer error (continues R12). | Run `flutter pub get && flutter analyze && flutter test` in `apps/business_app`; add iOS/Android picker permissions (see `docs/PHASE3.md`). | Open, verify on your machine |
| R23 | Phase 3 e2e tests were executed here against real PostgreSQL 16 through the pg test adapter, **not** the Prisma engine (no engine download) | Same caveat as R9/R14 for the new raw SQL (explicit casts on every parameter). | Run `npm run test:e2e` on your machine without `TEST_PRISMA_ADAPTER`, and `npx prisma migrate deploy`. | Open, verify on your machine |

