# Deployment guide (production)

Target layout (one Linux server, Docker): **Caddy** (HTTPS, admin web) → **API** (NestJS) → **Redis**, and **Supabase** for PostgreSQL + private Storage.
Nothing else is exposed: only ports 80 and 443 of the server are open. Redis and the API have no public port.

```
phones ──► https://api.<domain>   ─┐
browser ─► https://admin.<domain>  ├─► Caddy ──► api:3000 ──► Redis (internal)
          (static files + /api)   ─┘                     └─► Supabase (pooler 6543, Storage)
```

Why this shape: the admin panel calls `/api` on its own origin, so the refresh cookie is first-party and no CORS exception is needed for it.
The mobile apps and the salon QR pages use `api.<domain>`.

## 1. Before you start

| Need | Notes |
|---|---|
| A Linux server | Ubuntu 24.04 LTS, 2 vCPU / 2 GB RAM minimum (Argon2id and image re-encoding need memory). Pick a region near your users and near Supabase (your project is in Tokyo: Singapore is a good middle). Ports 80, 443 (and 443/udp) open; SSH by key only |
| Two DNS names | `api.<domain>` and `admin.<domain>`, both A records to the server's IPv4, set BEFORE the first start |
| Supabase project | Production project, ideally a paid plan (`docs/SUPABASE_PRODUCTION.md`). Roles script run, bucket created, Data API disabled (`docs/SUPABASE.md`) |
| SMTP account | Required in production (verification and password-reset mail) |
| Firebase project | Push notifications (`docs/PHASE10.md`). Service-account JSON → base64 |
| Docker Engine + Compose v2 | `curl -fsSL https://get.docker.com \| sh` |

**Decide the domain now.** `PUBLIC_LINK_BASE_URL` is printed into every QR poster; changing it later makes printed posters stale (Phase 11).

## 2. Put the code on the server

```bash
git clone <your private repo> /opt/salon && cd /opt/salon/infra/deploy
cp .env.example .env
cp .env.api.example .env.api
cp .env.migrate.example .env.migrate
chmod 600 .env .env.api .env.migrate
```

Fill the three files (variable by variable: `docs/ENVIRONMENT.md`). Generate secrets on the server or your PC, never reuse the development ones:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"   # JWT_ACCESS_SECRET, and each *_CRON_SECRET
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"      # MFA_ENCRYPTION_KEY (keep an OFFLINE copy)
openssl rand -hex 24                                                              # REDIS_PASSWORD
```

## 3. Check, migrate, start

```bash
cd /opt/salon/infra/deploy
docker compose -f docker-compose.prod.yml build
docker compose -f docker-compose.prod.yml run --rm cli npm run preflight      # must end with "Preflight passed"
docker compose -f docker-compose.prod.yml run --rm migrate                    # prisma migrate deploy (owner role, once per release)
docker compose -f docker-compose.prod.yml up -d
docker compose -f docker-compose.prod.yml ps                                  # api must become "healthy"
```

Create the first Super Admin (platform accounts are created only from the command line, never by an API):

```bash
docker compose -f docker-compose.prod.yml run --rm -e ADMIN_EMAIL=you@yourdomain.com -e ADMIN_NAME="Your Name" -e ADMIN_PASSWORD='long unique passphrase' cli npm run admin:create
```
Then sign in at `https://admin.<domain>` and enrol MFA (mandatory for platform accounts). Clear the passphrase from your shell history.

## 4. Smoke test

```bash
./infra/deploy/smoke-test.sh https://api.<domain> https://admin.<domain>
```
Windows: `.\infra\deploy\smoke-test.ps1 -Api https://api.<domain> -Admin https://admin.<domain>`.
It checks health and readiness, 401 on private routes, Swagger hidden, HSTS / nosniff / no-store, CORS refusing foreign origins, admin web + SPA fallback + CSP + frame protection, and the HTTP → HTTPS redirect. Fix every `FAIL` before announcing anything.

## 5. Updating (every release)

```bash
cd /opt/salon && git pull
cd infra/deploy
export RELEASE=$(git rev-parse --short HEAD)            # image tag, so the previous one stays available
docker compose -f docker-compose.prod.yml build
docker compose -f docker-compose.prod.yml run --rm cli npm run preflight
docker compose -f docker-compose.prod.yml run --rm migrate
docker compose -f docker-compose.prod.yml up -d
./smoke-test.sh https://api.<domain> https://admin.<domain>
```
Take a database backup first when a release has a migration (`docs/BACKUP.md`).

**Rollback:** migrations only add (forward-only). Start the previous image tag (`RELEASE=<old> docker compose ... up -d`); old code runs on the new schema. If a migration itself was wrong, restore from backup into a scratch database first (`docs/BACKUP.md`) and decide.

## 6. Operating

* Logs: `docker compose -f docker-compose.prod.yml logs -f api` (JSON). Ship them to a log service and set the alerts in `docs/OPERATIONS.md`.
* The API container runs the notification worker (reminders every 15 s) and the maintenance loop. Run **one** API instance. For more instances, set both workers to `false` on all but one, or use the cron endpoints (`NOTIFICATIONS_CRON_SECRET`, `MAINTENANCE_CRON_SECRET`).
* Server updates: `apt update && apt upgrade` monthly, reboot when asked; Docker restarts the stack (`restart: unless-stopped`).
* Firewall: `ufw allow 22,80,443/tcp && ufw allow 443/udp && ufw enable`.
* Certificates renew automatically (Caddy). Volumes `caddy_data` and `redisdata` hold state: do not delete them.

## 7. Other hosting (Render, Railway, Fly.io, ...)

The same images work anywhere that runs Docker: build `apps/api/Dockerfile` (target `runtime`) and set the variables from `.env.api.example`. Notes: `TRUST_PROXY_HOPS=1` (one platform proxy), run `prisma migrate deploy` as a release command using the `tools` target and `.env.migrate` values, and deploy the admin web as static files with a rewrite of `/api/*` to the API and every other path to `index.html` (copy the headers from `infra/deploy/Caddyfile`). Then `PUBLIC_LINK_BASE_URL` and `CORS_ORIGINS` follow your chosen domains.
