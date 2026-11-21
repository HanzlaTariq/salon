# Production checklist

Tick every line on the real production setup. Items marked **GATE** must pass before real customers or salons use the product.
A phase is not "production ready" until its security tests pass (master rule): run the suites below against a COPY of production, never the live database.

## A. Tests and CI
- [ ] **GATE** `npm test` and `npm run test:e2e` pass in `apps/api` on your machine against real PostgreSQL **with the Prisma engine** (no `TEST_PRISMA_ADAPTER`). Earlier phases could only be run through the node-postgres adapter (R9, R14, R23, R30)
- [ ] **GATE** `npm run typecheck && npm run build` in `apps/api`; `npm run typecheck && npm test && npm run build` in `apps/admin-web`
- [ ] **GATE** `flutter analyze` and `flutter test` in `packages/flutter_core`, `apps/customer_app`, `apps/business_app` (never compiled by the assistant: R12, R22, R14-9)
- [ ] CI is green on `main` (including the new `deploy-artifacts` and `mobile-release-script` jobs); `npm audit --omit=dev` reviewed (R15-6)
- [ ] `docs/security/ASVS-checklist.md` reviewed; every "No" has an owner and a date

## B. Supabase
- [ ] **GATE** Production project on a paid plan with daily backups (PITR recommended); `docs/SUPABASE_PRODUCTION.md` steps 2.1 to 2.7 done
- [ ] **GATE** `salon_app` has `rolbypassrls = false`; the two verification queries in that document return the expected values
- [ ] Storage bucket `salon-private` is PRIVATE (R18); Data API disabled
- [ ] Own encrypted backup job green, **restore drill done on a scratch database** and timed (`docs/BACKUP.md`); `age.key` stored offline
- [ ] `MFA_ENCRYPTION_KEY` and all secrets backed up in a password manager (not in the repo)

## C. Server and API
- [ ] **GATE** `npm run preflight` passes (0 errors); warnings read and accepted
- [ ] **GATE** `smoke-test.sh` / `smoke-test.ps1` passes against the real domains
- [ ] Only ports 22 (key only), 80, 443 open; automatic security updates or a monthly patch day
- [ ] `docker compose ps`: api healthy; one API instance (workers); logs flowing to your log service; alerts from `docs/OPERATIONS.md` configured
- [ ] Sentry (or compatible) DSN set and one test error received
- [ ] Super Admin created through the CLI; MFA enrolled; a second break-glass admin with its own MFA (store recovery codes offline)
- [ ] SMTP: send a real registration mail to Gmail and to a Pakistani provider; check SPF / DKIM / DMARC pass
- [ ] Firebase: `PUSH_DRIVER=fcm`; a push arrives on a real Android and a real iPhone (`docs/PHASE10.md` section 6)
- [ ] Platform settings in admin web: subscription prices, payment instructions (JazzCash / Easypaisa / bank), grace periods, supported cities (nothing is hardcoded)

## D. Money and trust
- [ ] A test salon walks the whole path: register, documents, approval, catalogue, staff, subscription invoice, receipt upload, Finance approves, subscription active. Nothing shows as paid before verification
- [ ] Billing rule for mid-cycle staff changes was chosen by you (master section 5.9) and matches what the product does

## E. Apps
- [ ] Application ids confirmed (permanent) and `tool/prepare-mobile-release.mjs` run for both apps
- [ ] Signed Android bundles built with the production `API_BASE_URL`; keystores backed up twice
- [ ] Real-device checks in `docs/RELEASE_MOBILE.md` section 5; Play Console and App Store listings, privacy policy, data-safety / privacy labels, reviewer demo account

## F. Legal and policy (outside the code)
- [ ] Privacy policy and terms of use published (the apps hold personal data and CNIC document photos; state retention from `docs/PHASE15.md`)
- [ ] Data subject requests: how a customer or salon asks to delete their data (risk R16-9)
- [ ] SMS / phone verification: still not built (R7). Phone numbers are NOT verified and are not a login factor
- [ ] Open product decisions from the risk register that touch launch: R11 / R31 (e-mail links open the admin domain), R13 (SUPPORT / FINANCE invites), R24, R33, R38

## G. After launch
- [ ] Day 1: watch `security.denied`, `http.slow`, errors, `maintenance.done`; Week 1: first monthly restore drill booked
- [ ] `MAINTENANCE_DELETE_ORPHANS` stays `false` until you have read one report
