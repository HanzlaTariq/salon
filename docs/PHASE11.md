# Phase 11: Salon link, QR code and PDF poster

## 1. Objective
Every approved salon gets ONE permanent link and QR code. The owner can view it, download the image (PNG or SVG), print or save a one-page
PDF poster, and share the link. Scanning the code opens the salon: inside the customer app it opens the salon profile directly, with a phone
camera it opens a small web page with the salon details, store buttons and the code.

## 2. Architecture (short)
```
 salon becomes APPROVED ──trigger──> salon_qr_codes (salon_id, code)      code = 10 random characters, created once, never changes
 owner app ── GET /salons/mine/qr, /qr/image, /qr/poster ──> link = <PUBLIC_LINK_BASE_URL>/s/<code>  -> PNG / SVG / PDF
 phone camera ──> GET /s/<code> (HTML landing page)            customer app ──> GET /api/v1/public/qr/<code> (JSON) -> existing public salon endpoints
```
* **The code is the permanent part.** The QR only encodes `<base>/s/<code>`. Editing the salon name, address or hours never changes it. It is random
  (31-character alphabet without look-alikes, 10 characters) and unrelated to the salon name or id.
* **Created by the database** when a salon becomes APPROVED (trigger; existing approved salons are backfilled by the migration). The trigger can never block
  an approval. The owner's first request creates the code if it is missing (audit `salon.qr_created`).
* **Permanent in the database**: the trigger refuses any change, the runtime role has no UPDATE/DELETE, a code exists only for an approved salon. RLS: a salon
  sees its own row; public reads see rows of APPROVED salons only.
* **Public answers never leak state**: unknown, malformed, draft, suspended and unlisted codes all return the same 404. Reactivating a suspended salon brings
  the same code back.
* **Owner only**: `Roles('SALON_OWNER')`; the salon always comes from the verified session, never from the request.
* **Poster**: server-side PDF (`pdfkit`, built-in fonts, vector QR so it prints sharp at any size), A4 or A5, light (for printing) or dark (for screens). Contents:
  platform name, salon name, type, area and city, QR code, "Scan to Book Your Appointment", three steps, address, phone, the short link.
* **Landing page** at `/s/<code>` (outside `/api/v1`): server-rendered HTML, everything escaped, no script, strict CSP of its own, optional Android/iOS store buttons.

## 3. Folder structure of what changes
```
apps/api
  prisma/schema/qr.prisma                                   NEW
  prisma/schema/salon.prisma                                UPDATED (+qrCode relation)
  prisma/schema/migrations/20261118000000_qr_phase11/       NEW
  src/modules/qr/                                           NEW (types, render, poster, landing, repository, service, controllers, module, dto, 4 specs)
  src/config/env.ts                                         UPDATED (+PUBLIC_LINK_BASE_URL, APP_STORE_URL_*, BRAND_NAME)
  src/bootstrap.ts                                          UPDATED (s/:code outside the API prefix)
  src/app.module.ts                                         UPDATED (+QrModule)
  test/qr.e2e-spec.ts                                       NEW
apps/business_app/lib/qr/                                   NEW (QR and poster screen)
apps/customer_app/lib/discovery/                            NEW qr_models.dart, scan_salon_screen.dart; UPDATED api and home screen
```
The full NEW / UPDATED list is in `PHASE11_CHANGES.txt`.

## 4. Environment variables (backend, `apps/api/.env`)
| Name | What | How to get it |
|---|---|---|
| `PUBLIC_LINK_BASE_URL` | Printed in every QR code as `<base>/s/<code>`. **https in production.** | Your final public domain, e.g. `https://book.yourdomain.pk`. Local: `http://localhost:3000` |
| `APP_STORE_URL_ANDROID` / `APP_STORE_URL_IOS` | Optional store buttons on the scan page (https only) | Play Console / App Store Connect listing URLs. Leave unset until the apps are published |
| `BRAND_NAME` | Platform name on posters and the scan page (default `Salon Platform`) | Your brand |

No secrets. **Choose `PUBLIC_LINK_BASE_URL` before owners print posters** (risk R107).

## 5. Commands (PowerShell; CMD is the same)
```
cd apps\api
npm install
npx prisma migrate deploy
npx prisma validate
npm test
npm run test:e2e
cd ..\..\apps\customer_app ; flutter pub get ; flutter analyze ; flutter test
cd ..\business_app ; flutter pub get ; flutter analyze ; flutter test
```
Migration on Supabase: `prisma migrate deploy` uses `DIRECT_URL` as before. The migration backfills a code for every already-approved salon.

## 6. API
| Route | Who | Answer |
|---|---|---|
| `GET /api/v1/salons/mine/qr` | owner | `{ data: { code, link, salonName, posterSizes, posterThemes } }`; 409 until approved (message says why; also while suspended) |
| `GET /api/v1/salons/mine/qr/image?format=png|svg&size=256..2048&download=1` | owner | the image (binary) |
| `GET /api/v1/salons/mine/qr/poster?size=A4|A5&theme=light|dark&download=1` | owner | one-page PDF (binary) |
| `GET /api/v1/public/qr/:code` | anyone | `{ data: { code, salonId, name, salonType, city, area } }`, else 404 |
| `GET /s/:code` | anyone | HTML page (200) or "not available" page (404) |

## 7. How to verify manually
1. Apply the migration, start the API with the default `.env` (`PUBLIC_LINK_BASE_URL=http://localhost:3000`).
2. Approve a salon (admin-web). Sign in as its owner in Swagger/Postman: `GET /api/v1/salons/mine/qr` returns the link. Open `/api/v1/salons/mine/qr/poster` with the owner token and check the PDF.
3. Open the link in a browser: the salon page appears. Edit the salon name in the owner app, reload: new name, same link.
4. Suspend the salon in admin-web: the page and `/public/qr/<code>` show "not available"; reactivate: same link works again.
5. Business app (approved salon): **QR code and poster** shows the code, copy / share work, **Print, save or share poster** opens the system sheet.
6. Customer app: tap the QR icon in the top bar, scan the poster (or type the code) and the salon profile opens. Deny the camera permission: typing the code still works.
7. Print the A4 poster and scan it from about 1 metre with two different phones.

## 8. Completed, incomplete, risky
Completed: permanent code (trigger, backfill, immutability, RLS), QR PNG/SVG, PDF poster (A4/A5, light/dark), landing page, public resolve, owner and customer Flutter screens, 17 e2e + 19 unit tests, risk register R106 to R120.
Not done on purpose: App Links / Universal Links (Phase 16), Urdu poster text (R109), scan counter (R112), admin-web QR screen (R119), code rotation (R113).
Risky until you verify: Prisma validate / migrate with the real engine, Flutter compile, real printer and camera (R106), final domain (R107).
