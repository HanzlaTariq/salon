# Phase 2: Authentication and Authorization

## Objective (simple language)
Let people register, verify their e-mail, sign in and out safely, and make the server decide what each
person may do. Everything is **default deny**: a new endpoint is private unless someone writes `@Public()` on it.

## Architecture decisions
| Topic | Decision | Why |
|---|---|---|
| Passwords | Argon2id (m=19456 KiB, t=2, p=1, env-tunable), 10–128 chars, common-password + name/e-mail checks | OWASP baseline; length cap stops hash-DoS |
| Access token | HS256 JWT, 15 min, claims = `sub` + `sid` only | Role/status are read from the DB on **every** request, so suspend / logout / password change act immediately |
| Refresh token | Opaque 256-bit, stored as SHA-256, **rotated on every use**; replay of an old one revokes the whole session | Detects stolen tokens |
| Web transport | Refresh token in `httpOnly; SameSite=Strict; Path=/api/v1/auth` cookie; access token only in JS memory | XSS cannot read either token after reload |
| Mobile transport | `X-Client-Type: mobile` → tokens in the JSON body (store in Keychain/Keystore) | Cookies are not a mobile concept |
| CSRF | Cookie requests need allow-listed `Origin` + `X-CSRF-Token` header (plus SameSite=Strict) | Header forces a CORS pre-flight foreign sites fail |
| Single use | Refresh tokens, e-mail/reset tokens, recovery codes, TOTP steps are consumed by **one atomic UPDATE** | Concurrent requests cannot both succeed (tested) |
| Account safety | 5 failures → 15 min lock (DB-backed), identical error for unknown user / wrong password / locked | No account enumeration, no lock oracle |
| MFA | TOTP (RFC 6238, verified against RFC vectors), AES-256-GCM-encrypted secret bound to the user id, replay-protected, 10 hashed recovery codes. **Mandatory** for SUPER_ADMIN/SUPPORT/FINANCE (`REQUIRE_ADMIN_MFA`), optional for owners | Required by your spec |
| Authorization | `@Roles()` + `@RequirePermissions()`; permission catalogue in `common/auth/permissions.ts` | One reviewable place |
| Platform accounts | Created **only** by CLI (`npm run admin:create`). No API can create or promote one | Privilege escalation impossible via HTTP |
| Audit | Append-only `audit_logs` (trigger blocks UPDATE/DELETE/TRUNCATE even for the table owner; app role has no UPDATE/DELETE grant). Admin status change + its audit row commit in one transaction | Immutable trail |
| Verification | E-mail now. Phone/SMS is **not** verified yet (needs a provider decision, see R7) | |

Roles at account level: `SUPER_ADMIN, SUPPORT, FINANCE, SALON_OWNER, SALON_STAFF, CUSTOMER`. Manager / Receptionist are
per-salon memberships and arrive in Phase 3/5 (never read from the client). `toTenantContext(user)` already builds the
tenant scope from the verified user.

### Permission matrix (Phase 2 scope)
| Permission | SUPER_ADMIN | SUPPORT | FINANCE | others |
|---|---|---|---|---|
| `users.read` | ✔ | ✔ | – | – |
| `users.manage_status` | ✔ | – | – | – |
| `audit.read` | ✔ | – | – | – |

## Endpoints (all under `/api/v1`)
Public: `POST auth/register`, `auth/verify-email`, `auth/resend-verification`, `auth/login`, `auth/refresh`, `auth/logout`,
`auth/forgot-password`, `auth/reset-password`, `GET health`, `health/ready`.
Authenticated: `GET auth/me`, `GET auth/sessions`, `DELETE auth/sessions/:id`, `POST auth/logout-all`,
`auth/change-password`, `auth/mfa/setup|enable|disable`.
Admin: `GET admin/users`, `PATCH admin/users/:id/status`, `GET admin/audit-logs`.
Errors always use `{ error: { code, message, details?, requestId } }`; new codes: `INVALID_CREDENTIALS, MFA_REQUIRED,
MFA_ENROLLMENT_REQUIRED, ACCOUNT_SUSPENDED, EMAIL_NOT_VERIFIED, TOKEN_INVALID, CSRF_REJECTED`. Swagger (dev): `/docs`.

## Files
See `PHASE2_CHANGES.txt` in the zip (NEW vs UPDATED list). Folder shape:
```
apps/api/src/common/auth/        roles, permissions, decorators, AuthenticatedUser, toTenantContext
apps/api/src/common/util/        clock.ts, phone.ts
apps/api/src/modules/auth/       controller, service, repository(SQL), guards, token/password/totp/mfa-crypto, mail/, dto/
apps/api/src/modules/audit/      append-only audit writer + GET admin/audit-logs
apps/api/src/modules/admin-users/ list + suspend/reactivate
apps/api/src/cli/create-admin.ts
apps/api/prisma/schema/auth.prisma + migrations/20261109000000_auth_foundation
apps/api/test/                   auth.e2e-spec.ts, auth-rate-limit.e2e-spec.ts, support/
apps/admin-web/src/features/{auth,security,users}, lib/{session,api,safe-path}.ts
```

## Install & run
```bash
# repo root: start Postgres/Redis (creates salon_migrator / salon_app roles)
docker compose -f infra/docker-compose.yml up -d

cd apps/api
npm install                     # new deps: @node-rs/argon2, jose@5, cookie-parser, nodemailer (+ dev: pg, ts-node)
cp .env.example .env            # then set JWT_ACCESS_SECRET and MFA_ENCRYPTION_KEY (commands are in the file)
npx prisma generate
DATABASE_URL="$(grep MIGRATION_DATABASE_URL .env | cut -d= -f2-)" npx prisma migrate deploy
npm run start:dev

# create your first Super Admin (nothing hard-coded; run once, then clear the variable)
ADMIN_EMAIL=you@example.com ADMIN_NAME="Your Name" ADMIN_PASSWORD='a long unique passphrase' npm run admin:create

cd ../admin-web && npm install && npm run dev      # http://localhost:5173
```
Environment variables: see the Phase 2 block in `apps/api/.env.example` (every value validated at boot; production refuses
`COOKIE_SECURE=false`, http links, console mail, or `REQUIRE_ADMIN_MFA=false`).

## Tests
```bash
cd apps/api
npm test                         # unit: env, TOTP vectors, crypto, JWT, Argon2, password policy, phone
# Security e2e needs a real DB (migrations applied, roles from infra/postgres/init):
export TEST_DATABASE_URL='postgresql://salon_app:salon_app_dev_pw@localhost:5432/salon'
export TEST_ADMIN_DATABASE_URL='postgresql://salon_migrator:salon_migrator_dev_pw@localhost:5432/salon'
npm run test:e2e                 # 48 tests; without the two variables the DB suites are SKIPPED (and say so)
cd ../admin-web && npm test      # 29 tests incl. redirect-safety + refresh single-flight
```

## Manual verification
1. `admin:create`, open `/login`, sign in → you are forced to **Security** → scan QR → enter code → save recovery codes.
2. Sign out, sign in again → code prompt. Reuse the same code within 30 s → rejected.
3. `curl -X POST localhost:3000/api/v1/auth/register -H 'content-type: application/json' -d '{"email":"a@b.com","password":"violet-Harbor-lamp-91","fullName":"Test User","accountType":"CUSTOMER"}'` → 202; the API log prints the dev mail line; the link is in `ConsoleMailer` (use SMTP / MailHog to see it).
4. Users page → suspend the test user → their tokens stop working on the next request.
5. `?next=//evil.com` on `/login` → after login you land on `/`.

## Security release gate for this phase
Passing (automated, real PostgreSQL): registration privilege-escalation, enumeration resistance, lockout, token rotation
and reuse detection, concurrent-refresh race, CSRF rejection, logout/suspension immediacy, MFA (enrol, replay, recovery
single-use, mandatory for admins), RBAC 401/403, no-IDOR on sessions, audit immutability for the app role, secrets never in
audit rows or responses, SQL-injection inertness, route inventory (only intended routes are public), rate limits.

**Not claimed:** this is not "fully secure". See `docs/security/risk-register.md` R5–R10, plus:
- Tests ran against a node-postgres adapter, not the Prisma engine (sandbox could not download it) → run `npm run test:e2e` locally with the real client (R9).
- No cross-tenant tests yet: there are no salon-owned tables until Phase 3 (the harness and `TenantContext` are ready).
- No Flutter auth screens/clients yet (see below). No external penetration test, no ASVS review yet (planned Phase 15).
- `npm audit` still reports the 6 Phase 1 findings (R1–R3). R1 (multer) **must be closed before Phase 3 uploads**.

## Completed
Registration, e-mail verification, login, logout, logout-all, refresh rotation, password reset/change, sessions list/revoke,
TOTP MFA + recovery codes, RBAC + permissions, account status management with audit, immutable audit log, CLI super-admin,
admin-web login / forgot / reset / verify / security / users pages with protected routes.

## Not done (needs your decision or comes next)
- **Flutter** secure-storage auth client + login/register screens (`apps/customer_app`, `business_app`): not written, because I cannot compile Flutter here and Phase 1 Flutter code is still unanalysed. Say "Phase 2b" and I will add it.
- **Phone/SMS verification**: pick a provider (Twilio, a Pakistani gateway, …).
- Admin management UI (#18) and creating SUPPORT/FINANCE accounts: add in Phase 3 once salon approval screens exist (needs an invite flow).
- Redis-backed rate limiting (R5), HIBP password check (R8).
