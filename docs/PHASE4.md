# Phase 4: salon profile management, dynamic catalogue and pricing

## What it does
- A live (APPROVED) salon keeps working: the owner can edit the profile, opening hours and salon photos. Identity documents, status and review fields stay locked. PENDING (under review) and SUSPENDED salons are fully locked (API and database).
- Opening hours: one entry per weekday (ISO 1 = Monday ... 7 = Sunday), same-day intervals.
- **Categories are owner-defined** (never hardcoded): name, description, picture, display order, active/inactive. Unique name per salon (case-insensitive). A category with services cannot be deleted.
- **Services**: name, category, description, duration (5-480 min), picture, active/inactive, assigned staff.
- **Pricing mode per service**
  - `FIXED`: one salon-wide price. Assigned staff carry no price.
  - `STAFF_BASED`: no salon-wide price; every assigned staff member has their own (Ali 300, Ahmed 500, Usman 400).
  - Switching mode is atomic and never keeps stale prices (see "Pricing rules").
- **Minimal staff roster** (decision, risk R25): owners add staff by name (no login yet) and may add themselves once (`self: true`). Invitations, accounts, permissions and schedules are Phase 5, on the same table.
- Public (no login): `GET /public/salons/:id/catalog` shows only ACTIVE categories/services/staff of APPROVED salons, with the exact price of each staff member. A service appears only while at least one active staff member performs it. `GET /public/salons/:id` now also returns `openingHours` (`null` until the owner has entered hours).

Money is `NUMERIC(10,2)` in the database and a decimal string (`"300.00"`) in API responses. Requests send a JSON number with at most two decimals (0 to 1,000,000).

## API (all under /api/v1; success `{ data }`, errors `{ error }`)
Owner, role SALON_OWNER. The salon is ALWAYS derived from the session; no endpoint accepts a salon id.

| Method | Path | Purpose |
|---|---|---|
| GET | /salons/mine/catalog | categories with services and assignments, staff, limits, `canEdit` |
| POST | /salons/mine/categories | `{name, description?, isActive?}` |
| PATCH | /salons/mine/categories/:id | partial; `description: null` clears |
| PUT | /salons/mine/categories/order | `{ids: [...]}` must list EVERY category once |
| DELETE | /salons/mine/categories/:id | 409 while it has services |
| PUT / DELETE | /salons/mine/categories/:id/image | multipart field `file` (re-encoded to WebP) |
| GET | /salons/mine/categories/:id/image/url | short-lived signed URL |
| POST | /salons/mine/services | `{categoryId, name, description?, durationMinutes, pricing:{mode, price?}, staff?:[{staffId, price?}], isActive?}` |
| PATCH | /salons/mine/services/:id | partial; sending `staff` REPLACES the assignment list |
| DELETE | /salons/mine/services/:id | soft delete (history keeps working) |
| PUT / DELETE / GET | /salons/mine/services/:id/image(/url) | as for categories |
| POST / PATCH / DELETE | /salons/mine/staff(/:id) | `{displayName}` or `{self: true}`; `{isActive}` |
| GET / PUT | /salons/mine/opening-hours | `{days:[{weekday, closed, opensAt?, closesAt?}] x 7}` |
| PATCH | /salons/mine | now also allowed while APPROVED |
| POST / DELETE | /salons/mine/files | PHOTOS now also allowed while APPROVED; documents are not |

Public: `GET /public/salons/:id/catalog`.

## Pricing rules (one place: `catalog.types.ts`, `planPricing`; repeated by the database)
- FIXED needs a price; STAFF_BASED forbids one. FIXED assignments carry no price; STAFF_BASED assignments always do.
- FIXED to STAFF_BASED with existing assignments: send the staff list with a price for each (400 otherwise).
- STAFF_BASED to FIXED: send the new price; staff prices are cleared, assignments stay.
- Database walls: CHECK constraints on `services` and `staff_services`; `staff_services` copies `pricing_mode` and is tied to the service by a composite foreign key with `ON UPDATE NO ACTION`, so a mode can never change under existing assignments. The API therefore deletes assignments, updates the service and re-inserts them in ONE transaction.
- Confirmed bookings (Phase 8) must store price and duration SNAPSHOTS; later price changes never rewrite history.

## Tenant isolation
`salon_opening_hours`, `staff_profiles`, `service_categories`, `services`, `staff_services` all have `ENABLE` + `FORCE ROW LEVEL SECURITY` and the `tenant_isolation` policy, plus `public_read_approved` policies that only match inside `TenantDb.withPublicRead`. Cross-salon references are impossible at database level (composite foreign keys on `(salon_id, id)`). Categories, services and staff are soft-deleted; the runtime role cannot hard-delete them. Supabase `anon`/`authenticated` stay revoked.

## Data model (migration `20261111000000_catalog_phase4`)
Also: `salon_files` accepts `PHOTO/CATALOG` (category/service pictures, never counted as salon photos), `salons_guard()` and `salon_files_guard()` are replaced (R21 closed). The migration never edits an applied migration.

## Install, migrate, test (Windows)
```powershell
cd apps\api
npm install
npx prisma generate
npx prisma migrate deploy         # applies 20261111000000_catalog_phase4 (uses DIRECT_URL)
npm test                          # unit tests (pricing rules, opening hours, ...)
npm run test:e2e                  # needs TEST_DATABASE_URL and TEST_ADMIN_DATABASE_URL (see docs/PHASE1.md)
cd ..\business_app
flutter pub get ; flutter analyze ; flutter test
```
CMD: use `&&` instead of `;`. No new environment variables. Do not run `prisma migrate dev` against Supabase.

## Verify manually
1. Sign in to business_app as an owner; open **Services, staff and hours** (visible once the salon is no longer a draft).
2. Staff tab: add "Ali", "Ahmed" and "I also perform services". Services tab: add category "Hair", service "Haircut", pricing "Price per staff", assign Ali Rs 300, Ahmed Rs 500.
3. `GET /api/v1/public/salons/<id>/catalog` (no token) shows Haircut Rs 300 - 500 with each staff price once the salon is approved; before approval it is 404.
4. Switch Haircut to "Same price" (Rs 400): staff prices disappear, assignments remain. Switch back: the app asks for prices again.
5. Super Admin suspends the salon: the owner can still read the catalogue, every edit returns 409 and the public catalogue is 404.

## Not in this phase
Staff invitations/accounts/permissions/schedules (Phase 5), subscription billing counts (Phase 6), search and price comparison across salons (Phase 7), booking snapshots (Phase 8). Super Admin catalogue view in admin-web is not included.
