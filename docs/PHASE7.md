# Phase 7: Customer discovery

## Objective
Customers can find salons by city, area, name, service, price, staff, date/time and (optionally) distance, compare the exact price of every staff member, and preview free times. Public, read-only, no sign-in needed for the API.

## Decisions
- **Listing rule (your decision, R42):** a newly approved salon is visible for a free trial (**Super Admin setting, default 14 days**, counted in Asia/Karachi calendar days from approval). After that it is visible only while its subscription is ACTIVE or in GRACE. A salon that has ever had a subscription never gets the trial back; an expired or suspended subscription is not rescued by the trial. `trialDays = 0` means no trial.
- One rule, one place: SQL function `salon_is_listed()` (migration `20261114000000_discovery_phase7`). The search, the old `GET /public/salons`, salon detail and catalogue all use it. **Phase 8 must call it for bookings.** The owner's billing summary now has `listing: { listed, reason, trialEndsOn }` so an owner knows whether customers can find the salon.
- **PostGIS** is installed in the `extensions` schema (never `public`, so nothing leaks through the Supabase Data API). The runtime role only calls the `SECURITY DEFINER` function `discovery_distance_m()`. Nearby search = bounding box on an index, then exact spheroid distance.
- **Location is optional.** Sent only when the customer taps "Near me", rounded to about 110 m in the app, used for that request, never stored. The API log now strips every query string. If permission is denied, city and area search work unchanged.
- **Honest data only:** `rating` is `null` (reviews come in Phase 14). Sorts offered: `nearest`, `price_low`, `newest`, `name`. "Highest rating", "most popular", "earliest available" need Phases 14 and 8 and are rejected with 400 instead of faked.
- Availability is a **preview** from salon hours, staff hours, breaks and approved leave. The engine (`freeSpans`) already accepts busy intervals: Phase 8 adds appointments and buffer. Nothing here confirms a time.

## API (all under `/api/v1`)
| Method and path | Who | Purpose |
|---|---|---|
| `GET /public/discovery/options` | public | Cities with areas and salon counts, sorts, radius limits |
| `GET /public/discovery/salons` | public | Search. Query: `q city area type service staff minPrice maxPrice date time lat lng radiusKm sort page pageSize` |
| `GET /public/discovery/salons/:id/availability?date=&serviceIds=a,b[&staffId=]` | public | Staff who perform ALL chosen services, exact total per staff (cheapest first), free start times |
| `GET /admin/discovery/settings` | `billing.read` | Trial length |
| `PUT /admin/discovery/settings` `{ "trialDays": 0-90 }` | Super Admin | Change trial length (audited as `discovery.settings_updated`) |

Rules enforced on the server: `lat` and `lng` together, `radiusKm` and `sort=nearest` need a location, `time` needs `date`, `date` within today + 13 days, page size at most 30, unknown parameters rejected, text up to 80 characters without `<>`/control characters. Search cards contain no phone, e-mail or owner data.

## Files
See `PHASE7_CHANGES.txt`. Admin-web: new "Free trial in public search" card on the Billing settings page. Customer app: discovery home (search, city and area, Near me, filters), salon profile with staff price comparison, availability preview.

## Setup
1. **Supabase:** Dashboard > Database > Extensions > enable `postgis`, schema `extensions`. (The migration also tries `CREATE EXTENSION postgis WITH SCHEMA extensions` if it is missing.) Local docker already has PostGIS.
2. Migrate (uses `DIRECT_URL`):
   - PowerShell / CMD: `cd apps\api` then `npx prisma migrate deploy`
3. API checks: `npm test` and `npm run test:e2e` (without `TEST_PRISMA_ADAPTER`).
4. Admin web: `cd apps\admin-web` then `npm test`.
5. Customer app:
   - `cd apps\customer_app`
   - `flutter pub get`, `flutter analyze`, `flutter test`
   - `flutter run --dart-define=API_BASE_URL=http://10.0.2.2:3000/api/v1` (emulator; use your PC's LAN IP on a phone)
No new environment variables.

## Manual verification
1. Approve a salon that has services, staff with working hours. Open the customer app: it appears under its city, with "From Rs. ..." and "Next: Today/Tomorrow at ...".
2. Tap **Near me** and allow: distances appear and the nearest salon is first. Deny permission: a note appears and city search still works.
3. Open a salon, tick two services: "See times and prices" lists only staff who do both, cheapest first, with free times; a break hour is never offered.
4. Admin web > Billing settings > set the trial to 0: the trial-only salon disappears from the app; set it back to 14.
5. As that salon's owner, Billing summary shows `listing.reason` (`TRIAL`, `SUBSCRIPTION`, `TRIAL_ENDED`, ...).

## Tests run here
- API unit: 149 passed. API e2e (PostgreSQL 16 + PostGIS 3.4, pg adapter): 15 new discovery tests + all earlier suites passed (see final numbers in the delivery message).
- Covered: city/area/type/q/price/service/staff filters, exact staff-based prices, nearby distance and radius, location validation, date/time filter with breaks and leave, availability totals and slots, cross-salon IDOR attempts, pagination caps, unknown params, SQL-fragment input, RLS (public context reads APPROVED salons only, never pending leave, cannot write), PostGIS not in `public`, trial and subscription lifecycle with a moving clock, Super Admin only setting, audit.
- Admin-web: type-check, 31 tests, production build. Flutter: **not compiled** (no SDK here); pure-Dart tests are provided.

## Not done / risky
See `docs/security/risk-register.md` R51-R61 (public-read policies on subscriptions and leave, `platform_settings` without RLS, preview ignores bookings until Phase 8, sorts waiting for Phases 8 and 14, PostGIS on real Supabase unverified, Flutter and Prisma engine unverified). **Phase 7 is not production-ready until you run the checks in "Setup" on your machine.** Phase 8 has not been started.
