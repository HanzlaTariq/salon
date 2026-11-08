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

```bash
# 1. Services (Postgres+PostGIS, Redis)
docker compose -f infra/docker-compose.yml up -d

# 2. API
cd apps/api
cp .env.example .env
npm install
npx prisma generate
# migrations run as the privileged migrator role:
DATABASE_URL="$(grep MIGRATION_DATABASE_URL .env | cut -d= -f2-)" npx prisma migrate deploy
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
