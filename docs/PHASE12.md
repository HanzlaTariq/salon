# Phase 12: offline-first (owner and staff app)

## Objective
Salon owners and staff keep working when the internet drops. The app shows the day's appointments from a SQLite database on the phone;
start / complete / no-show, notes and walk-ins are saved on the phone and sent to the server when a connection exists. The server stays the authority.

## Decisions (short)
* **One door, same rules.** `POST /api/v1/sync/push` replays each offline operation through the SAME `QueueService` methods as the online endpoints. Permissions, state machine, grace periods, slot rules, RLS and database triggers are identical. Nothing in booking, billing or notifications was rewritten.
* **At most once, enforced in PostgreSQL.** Every operation has a client UUID. The ledger `sync_operations` has a unique `(salon_id, user_id, operation_id)` and its row is written in the SAME transaction as the change. A retry, a lost answer or two parallel requests can never apply it twice. A replay answers exactly what the first call answered.
* **Refusals are final, hiccups are not.** A business refusal (4xx) is stored and shown to the person under "Needs attention". A technical failure answers `RETRY`, is not stored, and the rest of the batch is not attempted (a later change must never be refused for good because an earlier one hit a timeout).
* **When did it really happen?** The phone sends `createdAt`. The server records it clamped to `[now - 48 h, now]` (never the future) and judges the rules at that moment (a lying phone can only make a rule stricter for itself). The ledger keeps both the claim and the recorded time.
* **Offline walk-ins are PROVISIONAL.** The phone shows "Time pending". The server places the walk-in at the earliest free time from the moment the person walked in (working hours, breaks, bookings), takes price and duration from the catalogue, and only then does it become a real appointment. Start/complete done offline on it are addressed by `refOperationId` and replayed in order. The database allows a walk-in to start up to 48 h back ONLY inside the sync transaction (`app.offline_sync` flag); everywhere else the Phase 9 ten-minute rule is unchanged.
* **Pull = the caller's own window.** Yesterday to a week ahead. Staff get only their own appointments and never a phone number; owners get the salon. A delta (`since`) is used between full refreshes (a full snapshot every 10 minutes, and whenever the cursor is missing, in the future or older than 7 days). Updates are found through `appointments.updated_at`, now set by the database clock (trigger).
* **Private on the phone.** One SQLite file per user, wiped on sign-out. Waiting operations are never sent under another account.

## API (all private, roles SALON_OWNER and SALON_STAFF; salon, user and staff always come from the session)
`POST /sync/push`  `{ deviceId, operations: [ { operationId, kind, createdAt, appointmentId | refOperationId, payload } ] }` (1 to 25 operations)
kinds: `APPT_START`, `APPT_COMPLETE`, `APPT_NO_SHOW {reason?}`, `WALK_IN_CREATE {customerName, phone?, serviceIds[], note?, staffId? (owner only)}`, `NOTE_ADD {body}`
-> `{ data: { serverTime, results: [ { operationId, status: APPLIED|REJECTED|RETRY, replayed, appointmentId, code, message } ] } }`

`GET /sync/pull?since=<serverTime>&catalog=true`
-> `{ data: { serverTime, mode: FULL|DELTA, window, truncated, appointments[], notes[], catalog? } }` (catalog = staff, their services and prices, grace period: what the offline forms need)

Rate limits: push 30/min, pull 60/min per IP. Errors keep the usual `{ error: { code, message, details?, requestId } }`.

## Files
See `PHASE12_CHANGES.txt`.

## Install and run (Windows)
```powershell
# 1) database (uses DIRECT_URL, the Supabase session pooler)
cd apps\api
npx prisma migrate deploy
npx prisma generate

# 2) API tests (real PostgreSQL, see docs/SUPABASE.md for the TEST_ variables)
npx jest src
$env:TEST_DATABASE_URL="postgresql://salon_app:...@localhost:5432/salon"
$env:TEST_ADMIN_DATABASE_URL="postgresql://salon_migrator:...@localhost:5432/salon"
npm run test:e2e

# 3) business app
cd ..\business_app
flutter pub get
dart run build_runner build --delete-conflicting-outputs   # generates lib/offline/app_database.g.dart (required, not in the zip)
flutter analyze
flutter test
```
CMD: use `set TEST_DATABASE_URL=...` instead of `$env:`. No new environment variables.

## Manual verification
1. Sign in as a staff member (with the walk-in permission) while online; open "Appointments (works offline)". The chip says Synced.
2. Turn on airplane mode. The chip says Offline; the list stays.
3. Start a service, complete it, add a note, add a walk-in ("Time pending", yellow). Each shows "waiting to sync".
4. Turn the network on. The chip goes Syncing, then Synced; the walk-in gets its real time; times of start/complete are the moments you tapped.
5. Online, cancel a booking as the customer; offline, start it as staff; reconnect: it appears under "Needs attention" with the reason; "Dismiss" removes it.
6. Sign out and sign in as someone else: the other account's data is gone.

## Completed
Ledger and replay, conflict handling, offline start/complete/no-show/notes/walk-ins, provisional walk-ins, delta pull, SQLite cache, status chip (Online, Offline, Syncing, Sync failed, Synced), needs-attention screen, wipe on sign-out.

## Not done / known limits
See R121 to R132 in `docs/security/risk-register.md`. The main ones: the Flutter code could not be compiled in the build environment; the app cannot cold-start offline (the existing sign-in restore needs the network); the SQLite file is not encrypted yet.
