# Phase 5: staff management

## What it does
- **Team roster**: the owner adds team members (name, bio, performs services, permissions). `self: true` adds the owner as one performing member (one per salon).
- **Invitations**: the owner invites a team member by e-mail. The link is single use, valid 72 hours, and only its SHA-256 is stored. Re-sending revokes the previous link. The invitee sets a name and password and gets a verified `SALON_STAFF` account linked to their profile.
- **Own dashboard for staff**: a staff account sees only its own profile, working hours, breaks and upcoming leave. Colleagues are never returned.
- **Working hours**: one entry per weekday. A working day must sit inside the salon's opening hours; a closed salon day cannot be rostered.
- **Breaks**: recurring per weekday (max 5 per day, no overlaps, inside working hours). Owner always can edit; staff can edit own breaks only with `schedule.manage_own`.
- **Leave**: whole days, inclusive, max 90 days. Owner-recorded leave is APPROVED at once. Staff requests (with `schedule.manage_own`) are PENDING until the owner approves or rejects. PENDING and APPROVED periods cannot overlap (database exclusion constraint).
- **Permissions** (granted per member): `walk_ins.create` (used by Phase 9), `schedule.manage_own`.
- **Activation**: deactivating a member ends their sessions at once and removes them from billing. The owner profile cannot be deactivated or removed.
- **Billing basis** (Phase 6 charges it): only ACTIVE members who PERFORM services are billable. An owner who works counts once. An owner who only manages is not billable. The list endpoint returns the summary.

## Access model
- Owner: full access to their own salon's team (API, plus RLS on the four new tables).
- Staff: own rows only in `staff_working_hours`, `staff_breaks`, `staff_leaves` (RLS). `staff_invitations` is invisible to staff.
- Invitation holder: one invitation row, found by the token hash set per transaction (`app.invite_token_hash`). Without the token nothing is visible.
- Salon status: owner writes need `PROFILE_EDITABLE` (DRAFT, REJECTED, APPROVED). Staff endpoints and invitation accept need an APPROVED salon.

## API (under /api/v1)
Owner (role SALON_OWNER). The salon is always derived from the session.

| Method | Path | Purpose |
|---|---|---|
| GET | /salons/mine/team | roster, billing summary, limits, canEdit |
| POST | /salons/mine/team | `{self?, displayName?, bio?, performsServices?, permissions?}` |
| GET | /salons/mine/team/:id | member, 7 weekday hours, breaks, upcoming leave |
| PATCH | /salons/mine/team/:id | `{displayName?, bio?, performsServices?, permissions?, isActive?}`; deactivation revokes sessions |
| DELETE | /salons/mine/team/:id | soft delete (204); owner profile refused |
| POST | /salons/mine/team/:id/invitation | `{email}`; sends the invitation e-mail |
| DELETE | /salons/mine/team/invitations/:inviteId | revoke a pending invitation (204) |
| PUT | /salons/mine/team/:id/working-hours | `{days: [7 items]}`; checked against salon hours and existing breaks |
| PUT | /salons/mine/team/:id/breaks | `{breaks: [{weekday, startsAt, endsAt, label?}]}` (replaces all) |
| POST | /salons/mine/team/:id/leaves | `{startsOn, endsOn, reason?}`, APPROVED |
| DELETE | /salons/mine/team/:id/leaves/:leaveId | cancel pending or approved leave (204) |
| PATCH | /salons/mine/team/leaves/:leaveId | `{decision: APPROVE \| REJECT}` for a PENDING request |

Staff (role SALON_STAFF):

| Method | Path | Purpose |
|---|---|---|
| GET | /staff/me | own profile, salon, hours, breaks, upcoming leave |
| PUT | /staff/me/breaks | needs `schedule.manage_own` |
| POST | /staff/me/leaves | request leave (PENDING), needs `schedule.manage_own`, from today |
| DELETE | /staff/me/leaves/:leaveId | withdraw own PENDING request only (409 otherwise) |

Public (no login, rate limited, token in the JSON body only):

| Method | Path | Purpose |
|---|---|---|
| POST | /public/staff-invitations/preview | `{token}` → salon name, first name, masked e-mail, expiry |
| POST | /public/staff-invitations/accept | `{token, fullName, password}` → 201 `{status: ACCEPTED, email}` |

Errors use the usual shape `{ error: { code, message, details?, requestId } }`. Invalid, expired, used, or wrong tokens all return the same message.

## Database (migration `20261112000000_staff_phase5`)
- `staff_profiles`: + `performs_services`, `bio`, `granted_permissions` (CHECK: known keys only), owner must stay active.
- New: `staff_invitations`, `staff_working_hours`, `staff_breaks`, `staff_leaves`. Composite foreign keys to `staff_profiles(salon_id, id)`.
- Exclusion constraints: no overlapping breaks per staff and weekday; no overlapping PENDING/APPROVED leave per staff.
- RLS on all four tables (`FORCE`), owner/staff/invitation policies as described above. Helpers `app_owns_salon`, `app_is_own_staff`, `app_has_own_staff_permission`, `app_invite_token_hash`.
- Runtime role `salon_app` cannot DELETE invitations or leave rows. Anon and authenticated (Supabase Data API) have no access.

## Commands
Run from `apps/api`. Windows PowerShell and CMD use the same commands except for env var syntax (shown in the second column).

| Step | Command | Env var (PowerShell / CMD) |
|---|---|---|
| Install | `npm install` | - |
| Client | `npx prisma generate` | - |
| Migrate | `npx prisma migrate deploy` | DIRECT_URL must be set (see docs/PHASE1.md / docs/SUPABASE.md) |
| Unit tests | `npm test` | - |
| E2E tests | `npm run test:e2e` | `$env:TEST_DATABASE_URL="..."` / `set TEST_DATABASE_URL=...` (also TEST_ADMIN_DATABASE_URL) |

Flutter (`apps/business_app`): `flutter pub get`, `flutter analyze`, `flutter test`.

## Manual check (after the API runs)
1. As owner: create a member, set `Edit hours` (Mon-Sat inside 10:00-21:00), send an invitation to a test e-mail.
2. Open the invitation mail link, or call `POST /public/staff-invitations/preview`, then `accept` with a strong password.
3. Log in as the staff member: `GET /staff/me` shows only their own data.
4. Owner grants `schedule.manage_own`; staff requests leave; owner approves it; a second overlapping request is refused with 409.
5. Owner deactivates the member: the staff session stops working (401) and the billable count drops.

## Known gaps (see docs/security/risk-register.md R31-R41)
- Invitation link points to `WEB_APP_URL/accept-invitation`. No page or app deep link exists yet (R11, Phase 2b).
- Staff mobile accept screen not built yet; the API is complete and tested.
- `staff_profiles` RLS is still salon-wide (colleague display name and flags are visible at DB level to staff; app layer hides them).
- Existing account e-mail blocks an invitation (409). Decision open.
- No special dates, split shifts, or overnight hours (slot engine in Phase 8).
