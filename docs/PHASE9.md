# Phase 9: Staff queue and appointment workflow

## Objective
Staff and owners run the day from the app: start a service, complete it, call the next customer, mark a no-show (only after the
salon's grace period), add walk-ins, and let customers know about delays. Customers tell the salon "I'm on my way / I'll be late",
see the salon's updated estimate, and can accept an offer to come earlier. Every rule is checked by the server and, where it matters,
again by PostgreSQL (triggers, Row-Level Security, constraints).

## Decisions (please read)
- **Three different times, never mixed (section 10):** `startsAt` = what the customer booked (never changed without the customer's
  consent); `estimate` = the salon's forecast when the day runs late (`estimated_starts_at`); `customerEta` = what the customer says
  (`customer_eta_at`, written only by the customer). Both the app and the API always show the booked time next to the forecast.
- **How the forecast works:** a service in progress is expected to take its booked duration from when it ACTUALLY started (late start = late
  end; if the time passed it is assumed to end now). Each waiting customer starts no earlier than: booked time, when the staff member
  is free (plus buffer), the customer's own ETA, and not in the past. The estimate is published only from a 5-minute shift (judged
  before rounding) and sits on the 5-minute grid. It is saved (with an `ETA_CHANGED` history row) whenever staff or owner reads the
  queue or acts. See R74.
- **`DELAYED` status is not written.** A delay is the estimate (shown as "Delayed"). Tell me if you want a stored status (R76).
- **Nothing is automatic:** start, complete, next, no-show are always an explicit tap. **No-show** is allowed only after
  `max(booked time, customer ETA) + grace` (salon policy `noShowGraceMinutes`, 5 to 120 in steps of 5, default 15).
- **Next customer never completes silently:** while a service runs, `POST .../queue/next` answers `409 CURRENT_IN_PROGRESS`
  (with both customer names). The app asks "Complete X and start Y?" and only then sends `completeCurrent: true`. Completing and
  starting happen in one transaction (both or neither).
- **One service at a time per staff member** (partial unique index). A service cannot be started more than 60 minutes before its time.
- **Walk-ins** are appointments without a customer account (`source = WALK_IN`, name and optional phone). They get the EARLIEST free
  time of the chosen staff member today from the same slot engine as online bookings (hours, breaks, leave, buffer, bookings, a
  service running late) and the same no-double-booking constraint, so a booked customer is never displaced. Price and duration come
  from the catalogue (staff-specific price); nobody types a price (R82). Staff need the owner's `walk_ins.create` permission; the owner
  can always add. `Idempotency-Key` makes retries safe. Staff never see a customer phone number; the owner does.
- **Early availability offer:** staff (or owner) ask; nothing moves until the CUSTOMER accepts. The offer expires at the offered time.
  Accepting moves the booking only if the time is still free (slot engine, then the exclusion constraint), does NOT count as a
  reschedule (trigger-verified) and stores "I'm coming in N minutes" as the customer's ETA. Declining keeps the original time with no
  penalty. The earlier time is not reserved while the offer is open (R77).
- **Customer arrival report:** "on my way" (minutes optional) or "I'll be late" (minutes required); quick choices 5/10/15/20/30 or any
  1 to 120. Allowed from 3 hours before to 4 hours after the booked time, at most 10 reports (R80).
- **Who can do what:** staff act only on THEIR OWN appointments (a colleague's or another salon's answers 404). The owner acts on all
  staff of their own salon. The salon and the staff id always come from the session.
- No push notifications yet (Phase 10): the apps poll every 20 s while a queue / booking screen is open (R75).

## Database (migration `20261116000000_queue_phase9`, additive)
- `appointments`: `customer_user_id` now nullable; `walk_in_name`, `walk_in_phone`, `started_at`, `completed_at`, `no_show_at`,
  `estimated_starts_at`, `eta_updated_at`, `arrival_state`, `customer_eta_at`, `arrival_updated_at`, `arrival_updates`; CHECK constraints
  (online vs walk-in, progress vs status, estimate later than start, arrival state); unique index one IN_PROGRESS per staff; walk-in
  idempotency index.
- `appointment_early_offers` (new, RLS + FORCE, no DELETE for the runtime role, guard trigger).
- `salon_booking_policies.no_show_grace_minutes`.
- History: more event kinds; `created_at` default is now `clock_timestamp()` so events written in one transaction keep their order.
- `appointments_guard()` rewritten: the customer owns the arrival columns, the salon owns progress and estimate, only the customer can
  move a booking, an accepted early offer may move it earlier without counting as a reschedule.
- RLS: `staff_own_update` (own appointments, never to CANCELLED), `staff_walk_in_insert` (+ lines), `staff_insert` (history) and the
  offer policies.

## API (under `/api/v1`)
| Method and path | Who | Purpose |
|---|---|---|
| `GET /staff/me/queue` | STAFF | Own lane: `current`, `waiting[]` (with `position`, `delayMinutes`, `estimate`, `customerEta`, `noShow`, `earlyOffer`), `overdue[]`, `freeAt`, `earlyOfferCandidate`, `today` counts |
| `GET /salons/mine/queue?staffId` | OWNER | All lanes, or one |
| `GET /staff/me/queue/services`, `GET /salons/mine/queue/services?staffId` | STAFF / OWNER | Services (with that staff member's price) for the walk-in form |
| `POST .../appointments/:id/start` / `complete` / `no-show` | STAFF (own) / OWNER | `no-show` body `{ reason? }`; refusals: `TOO_EARLY`, `ALREADY_IN_PROGRESS`, `STATUS`, `NO_SHOW_GRACE` |
| `POST .../queue/next` | STAFF / OWNER (`staffId`) | Body `{ completeCurrent? }`; `CURRENT_IN_PROGRESS`, `QUEUE_EMPTY`, `TOO_EARLY` |
| `POST .../walk-ins` | STAFF (`walk_ins.create`) / OWNER (`staffId`) | `{ customerName, phone?, serviceIds[], note? }` + `Idempotency-Key`; `NO_CAPACITY_TODAY`, `WALK_IN_LIMIT` |
| `POST .../appointments/:id/early-offer` (`{ time? }`), `DELETE` | STAFF (own) / OWNER | Send / withdraw an offer; `OFFER_PENDING`, `OFFER_LIMIT`, `NO_EARLIER_TIME`, `BAD_TIME`, `SLOT_BUSY`, `ONLY_TODAY`, `WALK_IN` |
| `GET /staff/me/bookings/:id` | STAFF (own) | One appointment with history (no phone) |
| `POST /bookings/:id/arrival` | CUSTOMER | `{ state: ON_THE_WAY\|RUNNING_LATE, etaMinutes? }` |
| `POST /bookings/:id/early-offer/accept` / `decline` | CUSTOMER | `{ offerId, etaMinutes? }`; `OFFER_EXPIRED`, `OFFER_CLOSED`, `SLOT_TAKEN` |
| `GET /bookings`, `GET /bookings/:id` | CUSTOMER | now also return `estimate`, `customerEta`, `earlyOffer`, `startedAt`, `completedAt` |
| `PUT /salons/mine/booking-policy` | OWNER | `noShowGraceMinutes` is optional (left out = unchanged) |

Success `{ data }`, errors `{ error: { code, message, details?, requestId } }` as always.

## Apps
- **business_app:** `lib/queue/` (live queue screen for owner and staff, walk-in form, API client, models). Owner: button "Live queue and
  walk-ins" on the salon home (approved salons). Staff: "Today's queue" on the staff home.
- **customer_app:** the booking detail screen shows the live status (delay forecast next to the booked time, what you told the salon,
  early offer with Come earlier / Keep my time, I'm on my way / I'll be late with the ETA picker) and refreshes every 20 s while open.

## Install, migrate, test
```bash
cd apps/api
npm ci
npx prisma validate
npx prisma migrate deploy          # uses DIRECT_URL (session pooler on Supabase)
npm test                            # unit tests (183)
npm run test:e2e                    # needs TEST_DATABASE_URL (salon_app) and TEST_ADMIN_DATABASE_URL (salon_migrator)
```
PowerShell: `$env:TEST_DATABASE_URL="postgresql://salon_app:...@localhost:5432/salon"` (same for `TEST_ADMIN_DATABASE_URL`).
CMD: `set TEST_DATABASE_URL=postgresql://salon_app:...@localhost:5432/salon`.
Flutter (both apps): `flutter pub get`, `flutter analyze`, `flutter test`.
No new environment variables. Never run the e2e tests against the production Supabase project.

## Verify by hand
1. Owner: approved salon with two staff and services. Customer books Ali at a time about 30 minutes from now.
2. Ali's app: "Today's queue" > Start. The customer's booking shows "Your service is in progress".
3. Let the service run past its end: the next customer's screen shows "about N minutes behind", with the booked time unchanged.
4. Press "Next customer" while a service runs: the confirmation question appears; Cancel changes nothing.
5. Customer: "I'll be late" 20 min. Staff: No-show stays disabled until the grace period after that ETA.
6. Walk-in: owner gives Ali the permission `walk_ins.create`, Ali adds a walk-in; it appears in the queue at the earliest free time.
7. Staff are free early: "Offer" > the customer sees "Come earlier / Keep my time".

## Completed
Start / complete / next customer (with warning), one service at a time, no-show with grace, walk-ins (permission, idempotent, same
slot rules), delay forecast with separate original / estimate / customer ETA, early offers (accept, decline, expire, stolen slot),
customer arrival report, owner and staff queue screens, customer live status, history of every event, RLS and trigger protection.

## Incomplete or risky (see `docs/security/risk-register.md`, R73 to R88)
Not compiled Flutter widgets (R73), no push notifications (R74, R75), no multi-day calendar / owner cancel / policy form screens (R88),
no offline queue (R87), walk-in discounts not supported (R82). **Do not call Phase 9 production-ready until R73 passes on your machine.**
