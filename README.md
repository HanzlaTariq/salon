# Salon Platform (monorepo)

```
apps/api              NestJS backend (Phase 1: foundation done)
apps/admin-web        React admin (Vite + Tailwind)
apps/customer_app     Flutter customer app  (create with flutter create)
apps/business_app     Flutter owner+staff   (create with flutter create)
packages/design-tokens  tokens.json (source of truth)
packages/flutter_core   shared Flutter theme + state widgets
infra                 docker-compose + Postgres role bootstrap
```

## Backend quick start

> **Database = Supabase.** Follow `docs/SUPABASE.md` (roles script: `infra/supabase/01-roles.sql`). The docker steps below are only for local/CI Postgres.

```bash
# 1. Services (Postgres+PostGIS, Redis)
docker compose -f infra/docker-compose.yml up -d

# 2. API
cd apps/api
cp .env.example .env
npm install
npx prisma generate
# migrations run as the privileged migrator role:
npx prisma migrate deploy   # uses DIRECT_URL from .env
npm run start:dev
```

Verify: `curl localhost:3000/api/v1/health` and `curl localhost:3000/api/v1/health/ready`.
Swagger (dev only): http://localhost:3000/docs

## Tests

```bash
cd apps/api
npm test            # unit
npm run test:e2e    # security + API-convention tests
npm run typecheck && npm run build
```

## Flutter

```bash
cd apps/customer_app   # created via: flutter create --org com.yourorg --project-name customer_app apps/customer_app
# in pubspec.yaml add:
#   flutter_core:
#     path: ../../packages/flutter_core
# then in main.dart: theme: AppTheme.light(), darkTheme: AppTheme.dark()
```
Requires Flutter >= 3.27.

## Phase 2 (authentication)
See `docs/PHASE2.md` for setup (`MFA_ENCRYPTION_KEY`, `JWT_ACCESS_SECRET`, `npm run admin:create`) and tests.

## Phase 16 (deployment and release)
* Production deployment (Docker + Caddy + Redis, Supabase as database): `docs/DEPLOYMENT.md`; all variables: `docs/ENVIRONMENT.md`; go-live list: `docs/PRODUCTION_CHECKLIST.md`.
* Check the production environment before each deploy: `docker compose -f infra/deploy/docker-compose.prod.yml run --rm cli npm run preflight`; after: `infra/deploy/smoke-test.sh` (or `.ps1`).
* Android and iOS release builds: `docs/RELEASE_MOBILE.md` (`node tool/prepare-mobile-release.mjs customer|business`).
* Paid Supabase plan, PITR and moving from the Free project: `docs/SUPABASE_PRODUCTION.md`. Summary and verification: `docs/PHASE16.md`.

