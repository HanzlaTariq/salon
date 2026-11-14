# Phase 8: Appointment booking engine

## Objective
A signed-in customer books one or more services with one staff member at a time the server proves free. Nobody can double-book a staff member, even when two customers tap at the same moment. The salon owner sees and cancels bookings and sets the booking rules.

## Decisions (please read)
- **Bookings are CONFIRMED immediately** when the server accepts the slot (no owner approval). `PENDING` exists in the database for offline-created bookings (Phase 12). Tell me if you want an approval mode.
- **One staff member per booking** performs all chosen services, back to back (same as the Phase 7 price comparison). Total price and duration are the sums.
- **Authority against double booking = the database.** `appointments_no_double_booking` is a PostgreSQL `EXCLUDE USING gist (staff_id =, tstzrange(starts_at, blocked_until) &&)` over active statuses. The API slot engine is a convenience; if two requests race, the loser gets `409 SLOT_TAKEN`.
- **Buffer:** the salon's buffer after each appointment is stored on the booking (`buffer_minutes`, `blocked_until`) and counts as busy time on both sides.
- **Snapshots:** price, duration, service names, staff and salon names are copied at booking time and frozen by a trigger. A later price change never alters a booking.
- **Consent:** only the customer can move an appointment (a trigger refuses any other actor). The salon can only cancel, with a reason the customer sees. Customers cancel and move themselves within the salon policy.
- **Salon policy (owner, `PUT /salons/mine/booking-policy`)**, defaults when never saved: buffer 0, minimum notice 30 min, window 14 days, cancel cutoff 120 min, move cutoff 120 min, max 2 moves. Ranges: buffer 0 to 60 (step 5), notice 0 to 1440, window 1 to 60, cutoffs 0 to 10080, moves 0 to 5.
- **Same listing rule as search:** only an APPROVED salon that passes `salon_is_listed()` can be booked. Existing bookings can still be cancelled.
- **Retries are safe:** send `Idempotency-Key` (8 to 64 chars). The same request returns the same booking; the same key with a different request is `409`.
- **Anti-hoarding:** at most 3 open bookings per customer per salon and 10 overall.
- Availability (`GET /public/discovery/.../availability`) and search cards now subtract real appointments, the buffer and the minimum notice, and honour the salon's booking window. The response shape is unchanged.

## API (all under `/api/v1`)
| Method and path | Who | Purpose |
|---|---|---|
| `POST /bookings` | CUSTOMER | Body `{ salonId, staffId, serviceIds[], date, time, note? }` (+ header `Idempotency-Key`). Flow A (staff first) and flow B (service first, pick a staff member from the price comparison) both end here |
| `GET /bookings?scope=upcoming\|past\|all&page&pageSize` | CUSTOMER | Own bookings |
| `GET /bookings/:id` | CUSTOMER | Own booking with history, `canCancel`, `canReschedule`, deadlines |
| `POST /bookings/:id/cancel` | CUSTOMER | Optional `{ reason }`; refused after the cutoff (`CANCEL_CUTOFF`) |
| `POST /bookings/:id/reschedule` | CUSTOMER | `{ date, time }`, same staff and services; limits `RESCHEDULE_LIMIT` / `RESCHEDULE_CUTOFF` |
| `GET /public/salons/:id/booking-policy` | public | Rules shown before booking |
| `GET /salons/mine/bookings?from&to&staffId&status` | SALON_OWNER | Calendar (Karachi dates, max 31 days, default today). Customer name and phone |
| `GET /salons/mine/bookings/:id` | SALON_OWNER | One booking with history |
| `POST /salons/mine/bookings/:id/cancel` | SALON_OWNER | `{ reason }` (3 to 300 chars) |
| `GET` / `PUT /salons/mine/booking-policy` | SALON_OWNER | Rules; every change is audited (`booking.policy_updated`) |
| `GET /staff/me/bookings?from&to` | SALON_STAFF | Own appointments only, customer name without phone |

Errors keep the standard shape. New situations: `409 SLOT_TAKEN` (time gone), `409 CONFLICT` with `details.rule` = `ACTIVE_LIMIT`, `CANCEL_CUTOFF`, `RESCHEDULE_CUTOFF`, `RESCHEDULE_LIMIT`, `STATUS`.

## Database (migration `20261115000000_booking_phase8`)
New: `salon_booking_policies`, `appointments`, `appointment_services` (lines), `appointment_status_history` (append-only), enum `appointment_status`. Triggers: `appointments_guard` (snapshots frozen, status state machine, only the customer moves a time, no past start), lines only addable in the creating transaction, totals must equal the lines (checked at commit). RLS on all four tables (customer own, owner own salon, staff own appointments, admin read, public busy spans only). Runtime role cannot DELETE appointments or UPDATE lines and history. Data API stays closed. Prisma models live in `prisma/schema/booking.prisma`.

## Files
See `PHASE8_CHANGES.txt`. Customer app: book from the availability screen (tap a time, confirm), My bookings (Upcoming / Past), booking detail with Cancel and Change time. Business-app screens for owner and staff come with Phase 9 (R71).

## Environment variables
None new.

## Install and test (PowerShell or CMD, from the project root)
```
cd apps\api
npx prisma migrate deploy
npx prisma generate
npm run build
npm test
npm run test:e2e
cd ..\customer_app
flutter pub get
flutter analyze
flutter test
```
Never run the e2e tests against the production Supabase project (use `TEST_DATABASE_URL` / `TEST_ADMIN_DATABASE_URL`).

## Verify manually
1. Owner: `PUT /salons/mine/booking-policy` with `bufferMinutes: 10`.
2. Customer A: availability for a service, then `POST /bookings`. Customer B: same staff and time gives `409 SLOT_TAKEN`; availability no longer lists the slot.
3. A: `GET /bookings`, cancel, B can now book that time.
4. Owner: `GET /salons/mine/bookings` shows customer name and phone; staff sees only their own.

## Done / not done
Done: staff-first and service-first booking, multiple services, real availability, buffer, notice, window, cancel, reschedule, status history, idempotency, owner calendar and policy, customer screens.
Not done (later phases): start / complete / next customer, no-show, walk-ins, ETA and delay, early offers (Phase 9); notifications (Phase 10); owner and staff screens (Phase 9); sort by earliest available. **Risks R62 to R72 in `docs/security/risk-register.md`. Nothing was executed against PostgreSQL or Flutter here (R62): run the commands above first.**
