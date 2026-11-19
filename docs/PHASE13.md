# Phase 13: Reports and analytics

## What it does
- **Salon owner** (business_app): Reports screen (revenue, expenses, net result, appointments, completion / cancellation / no-show rates, comparison with the previous period, revenue trend, staff-wise table, popular services, new vs returning customers) and an Expenses screen (add, edit, delete, categories, paging).
- **Staff** (business_app): "My performance": their own completed services, value, no-shows, trend and top services. Never expenses, colleagues or customers.
- **Super Admin / Support / Finance** (admin-web `/analytics`): salons by status, active staff, customers, owners, new registrations, subscription phases, MRR / annual run rate / verified revenue / pending payments, 12-month growth and revenue charts, booking counts, city-wise table.

## Definitions (shown in the apps)
- A day is a calendar day in Asia/Karachi. Ranges are inclusive dates (max 366 days; `to` may not be after today).
- An appointment belongs to the day of its **booked start**.
- **Salon revenue** = price snapshots of COMPLETED appointments. Cancelled, no-show and open appointments earn nothing. It is computed, never stored.
- Rates use resolved appointments (completed + cancelled + no-show).
- **Platform revenue** (subscriptions, verified payments) and **salon revenue** are never mixed. The platform sees booking counts only.
- Expense categories are a fixed list (rent, salaries, utilities, supplies, marketing, equipment, maintenance, taxes and fees, other). "Other" needs a description.

## API (all under /api/v1)
Owner (`SALON_OWNER`): `GET /salons/mine/reports/{summary|trend|staff|services|retention|expenses}?from&to` (trend also `group=day|week|month`, services `limit`), `GET|POST /salons/mine/expenses`, `PATCH|DELETE /salons/mine/expenses/:id` (POST accepts `Idempotency-Key`).
Staff (`SALON_STAFF`): `GET /staff/me/reports/performance?from&to&group`.
Platform (`analytics.read`): `GET /admin/analytics/{overview|cities}?from&to`, `GET /admin/analytics/trend?months`.
Errors keep the shape `{ error: { code, message, details?, requestId } }`; money is a decimal string.

## Security
Owner-only RLS on `salon_expenses`; salon from the session (no salon id in any URL); staff id from the signed-in profile; unknown query parameters rejected; soft delete + audit rows; idempotent create. See `docs/security/risk-register.md` (R13-x).

## Not in this phase (on purpose)
CSV / PDF export, result caching, offline reports (reports need the server), and manager / receptionist report permissions (those roles do not exist yet).
