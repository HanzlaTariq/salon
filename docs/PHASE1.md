# Phase 1: what exists and how to verify

## Delivered
- **API (apps/api)**: NestJS, fail-fast env validation (zod), global error envelope with requestId, pino logging with credential redaction, helmet CSP/HSTS, strict CORS allowlist, global rate limit, whitelist validation (unknown fields rejected), health + readiness, Swagger (dev only).
- **Database**: Prisma multi-file schema, init migration (btree_gist, pg_trgm, pgcrypto, platform_settings), tenancy-helper migration (`app_current_salon_id()` etc. + RLS policy template), docker-compose (Postgres+PostGIS, Redis), least-privilege roles (`salon_migrator`, `salon_app`).
- **Tenancy skeleton**: `TenantContext` + `TenantDb.withTenant()` sets transaction-local `app.*` settings; fails closed on malformed ids.
- **Admin web (apps/admin-web)**: Vite + React + TS + Tailwind, design tokens, responsive shell (sidebar / drawer), components (Button, Card, Input, StatusBadge, Skeleton, EmptyState, ErrorState, ConfirmDialog, ResponsiveTable), API client with error envelope, overview page calling the real API, design-system reference page.
- **Flutter (packages/flutter_core)**: tokens, light/dark theme, loading/empty/error views.
- **CI**: typecheck, tests, build, audit (critical gate), flutter analyze, gitleaks.

## Not done / needs your machine
- `prisma generate` + `migrate deploy` were NOT run in the build sandbox (engine download blocked). Run them locally (see README).
- Flutter code was written but NOT compiled/analyzed. Run `flutter analyze` in `packages/flutter_core`.
- Flutter apps (`customer_app`, `business_app`) are not created here; create them with `flutter create` and depend on `flutter_core` (README).
- RLS cannot be tested against real tables until Phase 2+ creates them; the helper functions and policy template are in place.
- Open risks: see `docs/security/risk-register.md` (R1 multer before Phase 3, R4 react-router before Phase 2).

## Verify
```
cd apps/api && npm test && npm run test:e2e && npm run build      # 7 unit + 8 e2e
cd apps/admin-web && npm test && npm run build                    # 4 tests
```
