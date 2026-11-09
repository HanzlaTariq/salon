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
| R5 | Rate-limit counters are in-memory per API instance (`@nestjs/throttler` default store) | With more than one API instance the effective limit multiplies. Account lockout is stored in PostgreSQL, so credential-stuffing against one account is still capped. | Move the throttler store to Redis (already in docker-compose) before running >1 instance. | Open, before horizontal scaling |
| R6 | Refresh-token reuse has no grace window | A client that retries a refresh after a network drop (server rotated, response lost) is logged out. | Mobile client must serialise refresh calls (single-flight). Revisit if support tickets show it. | Accepted |
| R7 | Phone numbers are stored but NOT verified | No SMS provider chosen. Phone must not be used as an identity or login factor yet. | Decision needed (SMS provider) before any phone-based feature. | Open (decision) |
| R8 | No breached-password (HIBP) check; small built-in common-password list | Users can pick passwords that appear in breach corpora but are not in the small list. | Optional k-anonymity HIBP check later (needs outbound HTTPS). | Open, low |
| R9 | Auth SQL is hand-written (`$queryRaw`) and was verified against real PostgreSQL through a test adapter, not through the Prisma engine | Prisma type mapping (uuid/timestamptz/enum casts) could differ subtly. All params carry explicit casts. | Run `npm run test:e2e` locally with the real Prisma client (leave `TEST_PRISMA_ADAPTER` unset). | Verify on your machine |
| R10 | `platform_admin` RLS flag is true for SUPPORT and FINANCE as well | Broad at DB level; narrowed at API level by permissions. | Split into per-role DB policies when finance/support tables exist (Phase 6+). | Open |

