# Phase 3: Salon registration and Super Admin approval

## What it does
- A SALON_OWNER registers **one salon**, edits it while it is a draft, uploads documents (CNIC front/back, optional licence) and photos (cover, gallery), then submits it.
- A submitted salon is **locked** (API and database) and shows in the Super Admin review queue with a pending badge.
- Super Admin approves or rejects (rejection needs a reason of at least 10 characters). The owner is e-mailed. A rejected salon can be corrected and resubmitted; every submission is kept as history.
- Super Admin can suspend and reactivate an approved salon.
- Only **APPROVED** salons are reachable from the public endpoints. Documents are never public.

## Status flow
`DRAFT -> PENDING -> APPROVED <-> SUSPENDED`, and `PENDING -> REJECTED -> (edit) -> PENDING`.
The same transitions are enforced by the API **and** by the `salons_guard` database trigger.

## API (all under /api/v1; success `{ data }`, errors `{ error }`)
Owner (role SALON_OWNER; the salon is always derived from the session, never from the request):
| Method | Path | Purpose |
|---|---|---|
| POST | /salons | create the draft (one per owner, 409 otherwise) |
| GET | /salons/mine | salon + files + requirement checklist + `canEdit` / `canSubmit` + last decision |
| PATCH | /salons/mine | edit profile (DRAFT/REJECTED only) |
| POST | /salons/mine/files | multipart: `kind` (DOCUMENT/PHOTO), `docType`, `file` |
| GET | /salons/mine/files/:id/url | short-lived signed URL |
| DELETE | /salons/mine/files/:id | remove a file (DRAFT/REJECTED only) |
| POST | /salons/mine/submit | validates requirements, creates the application, notifies admins |

Admin (permissions in `common/auth/permissions.ts`):
| Method | Path | Permission |
|---|---|---|
| GET | /admin/salons?status&q&city&page&pageSize | salons.read |
| GET | /admin/salons/stats | salons.read |
| GET | /admin/salons/:id | salons.read |
| GET | /admin/salons/:id/files/:fileId/url | salons.read (photos); **salons.documents_read** for documents (audited) |
| POST | /admin/salons/:id/approve | salons.review |
| POST | /admin/salons/:id/reject `{reason}` | salons.review |
| POST | /admin/salons/:id/suspend `{reason}` / reactivate | salons.manage_status |

Public (no login): `GET /public/salons`, `GET /public/salons/:id` (approved only; search/nearby/ratings come in Phase 7).

SUPER_ADMIN has every permission; SUPPORT gets `salons.read` (can see applications and photos, cannot open identity documents, cannot decide); FINANCE gets none.

## Upload pipeline
1. multer (memory storage, size/parts/fields capped while streaming, no async `fileFilter`): R1 closed.
2. Type decided from **magic bytes** (JPEG, PNG, WebP; PDF for documents only). SVG, GIF, HTML, executables are refused (415).
3. Images are fully decoded and **re-encoded to WebP** (EXIF/GPS and appended payloads removed, auto-rotated, max 2400 px, 40 MP decompression-bomb limit, min 200 px).
4. Stored under a server-generated key `salons/<salonId>/<uuid>.<ext>` in the private bucket; only metadata is returned to clients.
5. Single-slot types (CNIC front/back, licence, cover) are replaced on re-upload; gallery max 12, other documents max 5.

## Data model (migration `20261110000000_salons_phase3`)
`salons` (tenant root), `salon_applications` (one row per submission, with a frozen snapshot), `salon_files`.
All three have `ENABLE` + `FORCE ROW LEVEL SECURITY`. Public reads use the policy `public_read_approved` / `public_read_photos`, which only match inside a `TenantDb.withPublicRead` transaction. The migration also keeps Supabase's `anon`/`authenticated` roles revoked, and the runtime role cannot hard-delete applications or files.

Required documents and minimum photos are read from `platform_settings` key `salon_application` (JSON), default `CNIC_FRONT`, `CNIC_BACK` and 1 photo. Example (Supabase SQL Editor):
```sql
INSERT INTO platform_settings (key, value) VALUES ('salon_application', '{"requiredDocuments":["CNIC_FRONT","CNIC_BACK","BUSINESS_LICENSE"],"minPhotos":2}')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
```
(Check the column names of `platform_settings` in `prisma/schema` first; a settings screen comes with the platform-settings work.)

## Install, migrate, test (Windows)
```powershell
cd apps\api
npm install                       # adds sharp, @types/multer, multer override
npx prisma generate
npx prisma migrate deploy         # uses DIRECT_URL; applies 20261110000000_salons_phase3
npm test                          # unit tests
npm run test:e2e                  # needs TEST_DATABASE_URL and TEST_ADMIN_DATABASE_URL (see docs/PHASE1.md)
cd ..\admin-web
npm install
npm run typecheck ; npm test ; npm run build
cd ..\business_app
flutter pub get ; flutter analyze ; flutter test
```
CMD: use `&&` instead of `;`. Do **not** run `prisma migrate dev` against Supabase (it cannot see the hand-written triggers/policies).

### Storage setup
Follow "Storage (Phase 3)" in `docs/SUPABASE.md`, then set `STORAGE_DRIVER=supabase` plus the three `SUPABASE_*` variables. While `STORAGE_DRIVER=memory` uploads work but vanish on restart (development only; production refuses it).

### Mobile permissions (after `flutter create`)
- iOS `ios/Runner/Info.plist`: `NSCameraUsageDescription`, `NSPhotoLibraryUsageDescription` (short sentences explaining CNIC/salon photos).
- Android: no extra permission for the gallery picker; camera works through the system camera app.

## Verify manually
1. Register an owner (business app, "Register my salon"), e-mail verify, sign in, create the salon.
2. Upload CNIC front/back and a cover photo; try a `.svg` renamed to `.jpg` through the API: expect 415.
3. Submit. The salon is locked; the admin (MFA enrolled) sees a badge on **Salons**.
4. Admin web > Salons > Pending > open the salon > view a document (a dialog with a signed link) > Approve.
5. `GET /api/v1/public/salons` now lists it; before approval or after suspension it does not.
6. Reject with a reason, check the owner screen shows it, fix, resubmit (submission #2 in history).

## Not in this phase (by design)
Push/FCM notifications (Phase 10: admins get an in-app badge and an e-mail now), salon profile management after approval, services, staff (Phase 4-5), city/nearby search and ratings (Phase 7), the permanent salon URL/QR (Phase 11), PDF upload from the mobile app (images only).
