# Phase 10: Notifications (push + in-app history)

## 1. Objective
Tell the right person the right thing at the right time: booking confirmations and cancellations, reminders 30/20/10 minutes before and at the
appointment time, early-availability offers, customer arrival updates, delay notices, completed / no-show, salon approval, payment decisions,
subscription expiry, staff joined and schedule changes. Every notification is also kept in an in-app inbox, in English or Urdu.

## 2. Architecture (short)
```
 business action ──(same DB transaction)──> TRIGGER ──> notification_events  (outbox: ids only, no names, no text)
 sweepers (reminders, subscription) ───────────────────> notification_events
                                                            │  claimed with FOR UPDATE SKIP LOCKED
                                                            ▼
                      WORKER: planner (who? from verified rows) -> preferences + language -> notifications (inbox)
                              -> FCM push (outside any DB transaction) -> notification_deliveries (per device) -> retry / done
```
* **Outbox + triggers**: booking, billing and salon services were NOT touched. If the business transaction rolls back, no notification exists.
  If a trigger fails it only logs a PostgreSQL WARNING; it can never block a booking.
* **Recipients are never taken from a request or from the event row.** The planner re-reads the facts, so a stale event (cancelled, moved, taken
  back, renewed) sends nothing. The person who caused a fact is not told about it; suspended accounts and signed-out phones get no push.
* **Idempotent and retry-safe**: inbox row unique per (person, event); delivery unique per (notification, device); only PENDING deliveries are
  retried (30 s, 2 min, 10 min, 30 min, 2 h, then given up). Two workers at once produce one message.
* **No new npm package**: FCM HTTP v1 is called with `fetch` + `jose` (service-account JWT).
* **Worker**: a loop inside the API (`NOTIFICATIONS_WORKER_ENABLED=true`, every 15 s) or a cron calling `POST /api/v1/internal/notifications/tick`.

## 3. What is sent to whom
| Fact | Customer | Owner / staff member |
|---|---|---|
| Booking created online | Booking confirmed | New booking |
| Cancelled | Cancelled by the salon (only if the salon cancelled) | Appointment cancelled (not to whoever did it) |
| Moved by the customer | none | Appointment rescheduled |
| 30 / 20 / 10 min before, at the time | Reminder / "Please leave for the salon" (each can be switched off) | none |
| Early offer sent / answered | "Your stylist is available earlier. Would you like to come now?" | Customer is coming earlier / keeps the time |
| Customer reports on the way / late | none | Customer is on the way / will be late |
| Day runs late (new estimate saved) | New estimate next to the booked time (throttled) | none |
| Completed / no-show | Service completed / marked as missed | none |
| Salon approved, rejected, suspended, reactivated | none | Owner only |
| Payment verified, rejected, more information | none | Owner only (invoice number + reviewer reason) |
| Subscription ends in 7 / 3 / 1 days, ended | none | Owner only |
| Invitation accepted | none | Owner |
| Hours, breaks or leave changed | none | The staff member (not when they did it themselves) |

Switches per person: push on/off, language (en / ur), bookings, reminders, queue updates, team, and which reminders (30/20/10/at the time).
Salon approval, payments and subscription notices have no switch.

## 4. API (all under `/api/v1`, customers, owners and staff only)
| Method and path | Purpose |
|---|---|
| `POST /devices` `{token, platform: ANDROID\|IOS, app: CUSTOMER\|BUSINESS, appVersion?}` | register or refresh this phone |
| `DELETE /devices` `{token}` | stop pushes to this phone (204) |
| `GET /notifications?limit&cursor&unread=true` | inbox page `{items, nextCursor, unreadCount}` |
| `GET /notifications/unread-count`, `POST /notifications/:id/read`, `POST /notifications/read-all` | read state |
| `GET /notifications/preferences`, `PUT /notifications/preferences` | the switches above |
| `POST /internal/notifications/tick` (header `x-cron-secret`) | one worker round, for cron hosting; 404 unless `NOTIFICATIONS_CRON_SECRET` is set |

## 5. Files
See `PHASE10_CHANGES.txt`. Database: `prisma/schema/migrations/20261117000000_notifications_phase10` (new tables `notification_events`,
`notifications`, `device_tokens`, `notification_preferences`, `notification_deliveries`, triggers, RLS, grants).

## 6. Setup
### 6.1 Backend
```powershell
cd apps\api
npx prisma migrate deploy        # uses DIRECT_URL (applies the Phase 10 migration)
npx prisma validate
npm test
npm run test:e2e                 # needs TEST_DATABASE_URL + TEST_ADMIN_DATABASE_URL, see docs/PHASE2.md
```
CMD: same commands. Environment (names only; see `.env.example`): `PUSH_DRIVER` (`log` in development, `fcm` in production),
`FCM_SERVICE_ACCOUNT_B64`, `NOTIFICATIONS_WORKER_ENABLED`, `NOTIFICATIONS_TICK_SECONDS`, `NOTIFICATIONS_CRON_SECRET`.

### 6.2 Firebase (once)
1. Firebase console: create a project, add an **Android app** for each Flutter app (customer and business package names) and download `google-services.json`
   into `apps/<app>/android/app/`. Add an **iOS app** and put `GoogleService-Info.plist` into `apps/<app>/ios/Runner/`.
2. iOS: upload your APNs authentication key in Firebase (Project settings > Cloud Messaging) and enable Push Notifications + Background Modes (remote
   notifications) in Xcode.
3. Android: add the Google services Gradle plugin as in the FlutterFire setup (`com.google.gms.google-services`), or run `flutterfire configure`.
   `business_app` has no `android/` or `ios/` folder in git yet; create it with `flutter create .` first.
4. Service account for the **backend**: Project settings > Service accounts > Generate new private key. Base64 it and put it in `FCM_SERVICE_ACCOUNT_B64`
   (backend environment only; never in Flutter, admin-web or git):
   PowerShell `[Convert]::ToBase64String([IO.File]::ReadAllBytes("firebase-key.json"))`.
5. `flutter pub get` in `packages/flutter_core` and both apps. Without the Firebase files the apps still run (inbox only, no push).

## 7. Manual verification
1. Backend with `PUSH_DRIVER=log`: sign in on the customer app, book a slot. Within ~15 s the bell shows 1 and the inbox has "Booking confirmed"; the
   API log shows `[dev push] type=BOOKING_CONFIRMED`. The owner's bell shows "New booking".
2. Settings screen: switch language to اردو, book again: the new notification is Urdu.
3. Switch "Appointment reminders" so only "At the time" stays on; book a slot 35 minutes ahead: one reminder at the time.
4. With Firebase configured and `PUSH_DRIVER=fcm`: put the app in the background, book from a second phone or Postman: the system notification appears;
   tapping it opens the app, and the bell opens the inbox; tapping the entry opens the booking.
5. Sign out on a phone (or "sign out everywhere") and book: that phone gets no push.
6. Stop the API for 2 minutes during a booking, start it again: the notification is delivered (outbox), a reminder that is more than 5 minutes late is not.

## 8. Done and not done
Done: everything in section 3, preferences, Urdu + English texts, inbox, device registry, FCM client, retries, throttles, retention purge, worker and cron,
RLS and tests (215 unit, 191 e2e on a fresh database). Not done / risky: see `docs/security/risk-register.md` R89 to R105. In short: **no real push was
sent and the Flutter code was not compiled in the build environment**; platform admins get no push; estimates are still only recalculated when someone
reads the queue; Urdu texts need a native review; hosting for the worker is decided in Phase 16.
