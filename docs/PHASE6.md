# Phase 6: Subscription and payment system

Owners pay the platform **per active, service-performing staff member**. Payments are **manual** (JazzCash, Easypaisa, bank transfer) and verified by Super Admin / Finance. There are no fake gateways: a payment is never shown as successful, and a subscription never starts, before a reviewer approves it.

## Agreed mid-period rule (your decision)
* **Staff added mid-period** -> one separate, prorated **top-up invoice** for the days left (at the period's locked price). The already-paid subscription is never changed silently.
* **Staff removed / deactivated mid-period** -> a **credit** for the unused days (rounded down), spent automatically on the **next invoice** (renewal or top-up).
* Whole calendar days (Asia/Karachi). Charges round half up to the paisa; credits round down. Today counts as a remaining day. Before a paid renewal's period starts, a change adjusts against the full new period.

## What was built
| Area | What |
|------|------|
| Prices | `subscription_plans`: immutable versions (monthly and yearly price per staff, grace days, renewal window). Current = latest with `effective_from <= now`. Nothing hardcoded; with no plan owners cannot subscribe. |
| Promotions | `subscription_promotions`: percentage discount (monthly / yearly / any, date range, on/off). The biggest active one is applied to each new first/renewal invoice and **snapshotted** on it. |
| Payment instructions | `payment_methods`: where owners send money; only Super Admin edits; owners see active ones only. |
| Subscription | `salon_subscriptions` (one per salon): cycle, period `[start, end)`, `covered_staff_count`, locked unit price/discount/grace. Phase is **derived** from dates: ACTIVE, GRACE, EXPIRED, SUSPENDED, NONE. |
| Invoices | `invoices`: INITIAL, RENEWAL, TOP_UP, COMPLIMENTARY. Staff count, unit price, discount, credit and total are immutable snapshots. At most one open main invoice and one open top-up per salon. |
| Payments | `payments`: PENDING, NEEDS_INFO, APPROVED, REJECTED. Transaction ID + receipt image + paid date + amount. One live payment per invoice; one live use per (method, transaction id) across all salons. |
| Credits | `salon_credits`: append-only ledger; balance can never go below zero. |
| History | `subscription_staff_snapshots`: billable staff count over time; invoices keep the count and charge. |
| Admin web | Payments queue + verification dialog, Subscriptions overview/list, per-salon detail (suspend, reactivate, complimentary grant, void invoice), Billing settings (price, promotions, payment instructions). |
| Business app | "Subscription and payments": status, team billed, plan quotes, invoice, payment instructions, receipt upload, answer reviewer questions, history. |

## Lifecycle
1. Owner (approved salon) opens **Subscription**, sees the quote (e.g. Rs. 300 x 2 staff = Rs. 600), chooses monthly/yearly -> INITIAL invoice (OPEN). Credit, if any, is spent first. A total of Rs. 0 (credit or 100% promotion) activates immediately.
2. Owner pays outside the app, then submits method, transaction ID, date and **receipt image** (amount must equal the invoice total). Payment = PENDING. The invoice stays OPEN.
3. Finance / Super Admin opens the receipt (audited), compares it with the statement and either **approves** (types the received amount: must equal the invoice total), **rejects** (reason) or **asks for more information** (owner answers, then it returns to PENDING).
4. Approval, in ONE transaction: payment APPROVED -> invoice PAID -> subscription ACTIVE for `[start, start + 1 month/year)` -> audit. A renewal paid early continues exactly at the old period end; after expiry it starts today.
5. Staff changes reconcile automatically (top-up or credit). A top-up that was paid after the period changed becomes credit (money is never lost).
6. Grace: after `period_end`, GRACE for `grace_days`, then EXPIRED. Renewal opens `renewal_notice_days` before expiry. Phase 7/8 will use `subscription.isOperational` (ACTIVE or GRACE); **nothing is enforced yet** (R42).

## API (all under `/api/v1`, `{ data }` / `{ error }` shapes unchanged)
Owner (`SALON_OWNER` only): `GET /salons/mine/billing`, `GET|POST /salons/mine/billing/invoices`, `POST .../invoices/:id/cancel`, `POST .../invoices/:id/payments` (multipart: `method, transactionId, claimedAmount, paidOn, senderName?, note?, receipt`), `GET /salons/mine/billing/payments`, `POST .../payments/:id/respond`, `GET .../payments/:id/receipt-url`.

Platform: `GET /admin/billing/overview` (`billing.read`); `GET|POST /admin/billing/plans`, `GET|POST|PATCH /admin/billing/promotions`, `GET|POST|PATCH /admin/billing/payment-methods` (read: `billing.read`; write: `billing.manage`); `GET /admin/payments`, `GET /admin/payments/:id`, `GET .../receipt-url`, `POST .../approve|reject|request-info` (`payments.review`); `GET /admin/subscriptions`, `GET /admin/salons/:id/subscription` (`billing.read`); `POST /admin/salons/:id/subscription/suspend|reactivate|grant`, `POST /admin/invoices/:id/void` (`subscriptions.manage`).

| Role | Permissions added |
|------|-------------------|
| SUPER_ADMIN | all four |
| FINANCE | `billing.read`, `payments.review` |
| SUPPORT | `billing.read` (no receipts, no payments) |

Money in JSON is always a **decimal string** (`"600.00"`); floats in requests are rejected.

## Security controls (enforced in the database, not only the API)
* `invoices_guard`: amounts immutable; PAID only with an APPROVED payment (or total 0) and only by Super Admin / Finance; VOID only if no live payment.
* `payments_guard`: only the signed-in user submits, amount must equal the invoice total, owners can only answer an information request, reviewers cannot edit what the owner submitted and must be themselves, approval amount must equal the invoice total, terminal states are final.
* `salon_subscriptions_guard`: a period can only grow when a PAID invoice for exactly that period exists; suspend/reactivate Super Admin only.
* Plans, credits and staff snapshots are append-only; invoices, payments and subscriptions are never deleted; `salon_app` has no DELETE on them.
* Reviewer role comes from `users` (`app_platform_role_in()`), so Support never writes billing data (partly closes R20).
* RLS on every salon table (`FORCE`): an owner sees only their own invoices, payments, credits and snapshots; fail closed with no context.
* Receipts: images only, magic-byte checked, re-encoded to WebP (EXIF stripped), private storage under `billing/<salonId>/<uuid>.webp`, signed short-lived URLs, orphan files removed on failure, every admin view audited.
* All sensitive actions are in the audit log: `billing.plan_created`, `billing.promotion_*`, `billing.payment_method_*`, `invoice.created|paid|voided`, `payment.submitted|info_requested|info_provided|approved|rejected|receipt_viewed`, `subscription.activated|renewed|topup_applied|suspended|reactivated|granted`, `credit.granted`.
* Rate limits: 10 per minute per IP on invoice creation, payment submission and answers.

## Install / run (Windows)
No new environment variables or dependencies. Receipts reuse the Phase 3 storage settings (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `STORAGE_BUCKET`; keep the bucket PRIVATE).

PowerShell:
```powershell
cd apps\api
npm install
npx prisma generate
npx prisma migrate deploy          # applies 20261113000000_billing_phase6 (needs DIRECT_URL)
npm test
$env:TEST_DATABASE_URL="postgresql://salon_app:...@localhost:5432/salon_test"
$env:TEST_ADMIN_DATABASE_URL="postgresql://salon_migrator:...@localhost:5432/salon_test"
npm run test:e2e
cd ..\admin-web ; npm install ; npm run typecheck ; npm test ; npm run build
cd ..\business_app ; flutter pub get ; flutter analyze ; flutter test
```
CMD: use `set TEST_DATABASE_URL=...` instead of `$env:`. Supabase: the migration only adds tables/functions in `public`; `anon`/`authenticated` grants are revoked inside it and default privileges already give `salon_app` DML + sequence usage.

## Manual verification
1. Admin web (Super Admin): **Billing settings** -> set Rs. 300 / Rs. 3000, grace 3, renewal 7 -> add a JazzCash method.
2. Business app (approved salon): **Team** -> add yourself (performs services) + one stylist -> **Subscription and payments** -> Monthly -> invoice Rs. 600.00 -> "I have paid" -> enter a transaction ID, attach a screenshot -> status "Waiting for verification" (still NOT active).
3. Admin web (Finance): **Payments** -> open it -> View receipt -> Approve (type 600). App pull-to-refresh: **Active**.
4. Add a third stylist: an extra **top-up invoice** appears (prorated). Remove one: a **credit** appears and is used on the next renewal invoice.
5. Try as Support: Payments is not in the menu and `/api/v1/admin/payments` returns 403.

## Not in this phase / incomplete
* Enforcement of expiry (Phase 7/8), reminders and scheduled jobs (Phase 10), payment gateways (none by design), partial payments and refunds (not supported), reports/analytics beyond the overview (Phase 13).
* Open decisions and residual risks: `docs/security/risk-register.md` R42 to R50.
