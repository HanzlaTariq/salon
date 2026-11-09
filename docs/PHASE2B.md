# Phase 2b: mobile auth client, shared rate limits, breached-password check

## Objective (simple language)
Phase 2 built the server side of login. Phase 2b makes the **mobile apps** able to sign in and stay signed in
securely, moves rate-limit counters to Redis so they work with more than one server, and refuses passwords
found in known data breaches.

## What is done
| Area | Done | Notes |
|---|---|---|
| Redis rate limits (R5) | Yes | Shared counters through `REDIS_URL`. Redis down = in-memory fallback + warning. Required in production. |
| Breached-password check (R8) | Yes | HIBP range API on register, reset, change. Only a 5-char hash prefix is sent. Fail-open by default. |
| Flutter auth client | Yes | Keychain/Keystore refresh token, single-flight refresh, offline-safe restore. In `packages/flutter_core`. |
| Login / register screens | Yes | Shared by both apps. Shows verify-e-mail state and resend. Handles MFA code prompt. |
| Role gate in apps | Yes | Customer app: CUSTOMER only. Business app: SALON_OWNER and SALON_STAFF only. |
| business_app skeleton | Yes | Platform folders come from `flutter create` (see `apps/business_app/README.md`). |
| Phone / SMS verification | **No** | Provider not chosen (R7). No SMS is sent. Phone is not used to log in. |
| Admin UI to create SUPPORT/FINANCE | **No** | Conflicts with the CLI-only rule (R13). Waiting for your decision. |

## Architecture decisions
| Topic | Decision | Why |
|---|---|---|
| Refresh token on phone | Flutter Secure Storage (Keychain first-unlock-this-device; Android encrypted prefs). Access token only in memory | A stolen device backup or app dump does not contain a usable access token |
| Refresh concurrency | One in-flight refresh shared by every caller; the stored token is re-read inside it | Refresh tokens rotate. A second parallel refresh would replay a spent token and revoke the session (R6) |
| Offline start | A network error during restore keeps the stored token and shows a retry screen | Going offline must not log people out |
| Dead session | 401, suspended or unverified → token cleared, sign-in screen shown | Matches server revocation rules |
| Rate-limit store | Redis with `PEXPIRE NX` (fixed window) and a 2 s connect timeout; in-memory fallback on error | Shared budget across instances without taking the API down when Redis blips |
| HIBP | k-anonymity range API, `Add-Padding`, 2 s timeout, runs after local policy | Privacy: the password and most of its hash never leave the server |
| API base URL | `--dart-define=API_BASE_URL=...`, default `http://10.0.2.2:3000/api/v1` (Android emulator) | No hardcoded production URL in source |

## Folder changes
```
apps/api/
  src/common/rate-limit/          NEW  redis-throttler.storage.ts, throttler.config.ts, *.spec.ts
  src/modules/auth/breach-check.ts NEW  HIBP range check (pure)  + breach-check.spec.ts
  src/config/env.ts               UPD  REDIS_URL, HIBP_*, production requires REDIS_URL
  src/config/env.spec.ts          UPD  new cases; production fixture includes REDIS_URL
  src/app.module.ts               UPD  ThrottlerModule uses buildThrottlerOptions()
  src/modules/auth/auth.service.ts UPD HIBP check on register, reset, change
  test/support/harness.ts         UPD  HIBP off, Redis unset for e2e
  .env.example, package.json, package-lock.json   UPD (ioredis)
packages/flutter_core/
  lib/src/auth/*                  NEW  client, models, storage, repository, screens, gate
  test/auth_repository_test.dart  NEW  Dart unit tests (MockClient)
  pubspec.yaml, lib/flutter_core.dart, analysis_options.yaml   UPD/NEW
apps/customer_app/lib/main.dart   UPD  real sign-in flow (replaces Hello World)
apps/business_app/                NEW  pubspec, lib/main.dart, analysis_options.yaml, README.md
docs/security/risk-register.md    UPD  R5, R7, R8 status; R11-R15 added
docs/PHASE2B.md                   NEW  this file
```

## Setup (Windows)
PowerShell:
```powershell
cd apps\api
npm install
npx prisma generate
npm run typecheck
npm test                       # unit tests (no DB needed)
```
CMD:
```bat
cd apps\api
npm install
npx prisma generate
npm run typecheck
npm test
```

Environment (names only; values are yours to set, never commit them):
- `REDIS_URL`: a Redis instance. Local: `docker compose -f infra\docker-compose.yml up -d redis`, then `redis://localhost:6379`.
- `HIBP_CHECK_ENABLED`, `HIBP_FAIL_CLOSED`: optional, defaults are fine.

## Verify the API manually
1. Start the API with `REDIS_URL` set, then send 11 failed login requests within one minute from the same IP. The 11th should return 429 (login limit is 10 per minute).
2. Stop Redis and send the same requests. They should still work, and the API log should show a single fallback warning.
3. Register with a password that is known to be breached (check one at haveibeenpwned.com/Passwords) and that still passes the local rules (10+ characters, not in the common list). Expect 400 with the breach message. A strong unique password should return 202.

## Verify the Flutter side (on your machine)
PowerShell:
```powershell
cd packages\flutter_core
flutter pub get
flutter analyze
flutter test

cd ..\..\apps\customer_app
flutter pub get
flutter analyze
flutter run --dart-define=API_BASE_URL=http://10.0.2.2:3000/api/v1

cd ..\business_app
flutter create --platforms=android,ios --project-name salon_business --org com.yourorg .
flutter pub get
flutter analyze
flutter run --dart-define=API_BASE_URL=http://10.0.2.2:3000/api/v1
```
CMD:
```bat
cd packages\flutter_core
flutter pub get
flutter analyze
flutter test

cd ..\..\apps\customer_app
flutter pub get
flutter analyze
flutter run --dart-define=API_BASE_URL=http://10.0.2.2:3000/api/v1

cd ..\business_app
flutter create --platforms=android,ios --project-name salon_business --org com.yourorg .
flutter pub get
flutter analyze
flutter run --dart-define=API_BASE_URL=http://10.0.2.2:3000/api/v1
```

Manual checks:
- Register a SALON_OWNER from the business app. The verify-e-mail message appears. Sign in is blocked until you verify, and the resend button works.
- Sign in, close the app, reopen it. You should stay signed in without typing a password.
- Turn Wi-Fi off, reopen the app. You should see the "no internet" retry screen, not the sign-in form.
- Sign in with a CUSTOMER account in the business app. You should see the "not for your account type" screen.

## Security tests in this phase
- Unit: Redis store (fixed window, isolation per key, blocking, fallback), HIBP prefix-only request and parser (padding, CRLF, failure modes), env rules for REDIS_URL and HIBP.
- Dart: single-flight refresh under concurrency, retry after 401, dead session clears the token, offline keeps the token, logout works offline, error envelope parsing.
- E2E (existing, must run locally, R14): auth, rate-limit, route inventory, cross-session checks. Not executed in the build environment.

## Not done (needs your decision)
- R7 phone verification provider.
- R13 admin invite flow (rule conflict).
- R11 public verification-link domain.

## Next
Phase 3 (salon registration and approval) starts only after you confirm Phase 2b on your machine and close R12 and R14.
