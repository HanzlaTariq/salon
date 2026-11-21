# Phase 14: reviews, ratings, customer history, favourites, moderation

## What it does
* A customer can review a **completed** visit (30 days after completion): salon stars (required), staff stars, a comment, and a star per service that was really performed. One review per visit. The author can edit for 7 days.
* The salon owner sees the reviews of the own salon (the customer shows only as "Sara K."), adds ONE public response (edit / remove), and can **report** a review to the platform.
* The Super Admin can **hide / restore** a review (reason required) and resolve reports (keep public / hide). Support can read the queue. Nobody edits what a customer wrote.
* Ratings feed discovery: the card shows the real average and count, and `sort=rating` is a new order. Hidden reviews never count.
* A staff member sees reviews about their own work only.
* A customer can keep **favourite salons** (private; max 200; only listed salons can be added).
* The owner gets a **customer list and per-customer history** at their own salon (visits, spend, cancellations, no-shows, the customer's reviews). Walk-ins without an account have no customer record and are not listed.

## Architecture decisions
* Rules live in the database too (`reviews_guard()` trigger): who may change which column, completed-visit check, 30/7 day windows, one review per visit, owner cannot review own salon. Row-Level Security (FORCE) on all new salon-owned tables.
* Rating counters (`salon_rating_stats`, `staff_rating_stats`) are star counters changed only by a SECURITY DEFINER trigger; the runtime role has SELECT only. Count and average are GENERATED columns, so they cannot drift (tests compare them with the real reviews after every kind of change).
* Reviews, service ratings and reports can never be deleted by the runtime role (moderation hides). Every owner / admin action writes an audit row (review text is never copied into the audit log).
* No salon id, staff id or customer id is accepted from a client anywhere: they come from the session or the appointment.

## API (all under /api/v1)
| Who | Route |
|---|---|
| Public | `GET public/discovery/salons/:id/reviews?sort=recent\|highest\|lowest&page&pageSize` |
| Customer | `GET customers/me/reviews`, `GET customers/me/reviews/pending`, `GET/PATCH customers/me/reviews/:id`, `POST customers/me/reviews` |
| Customer | `GET customers/me/favourites`, `PUT/DELETE customers/me/favourites/:salonId` |
| Owner | `GET salons/mine/reviews`, `GET salons/mine/reviews/summary`, `PUT/DELETE salons/mine/reviews/:id/response`, `POST salons/mine/reviews/:id/report`, `GET salons/mine/review-reports` |
| Owner | `GET salons/mine/customers`, `GET salons/mine/customers/:customerId` |
| Staff | `GET staff/me/reviews` |
| Admin | `GET admin/reviews` (+`/overview`, `/reports`) needs `reviews.read`; `POST admin/reviews/:id/hide`, `/:id/restore`, `/reports/:id/resolve` need `reviews.moderate` (Super Admin) |

## Not in this phase (on purpose)
* No push notification for "new review" or "owner responded" (needs new notification kinds in the Phase 10 constraint; planned for Phase 15/16).
* Customers cannot delete a review (moderation hides). No review photos.
* "Most popular" and "earliest available" sorts are still not offered.

## Commands
```powershell
cd apps\api
npx prisma migrate deploy            # applies 20261121000000_reviews_phase14
npm run test                          # unit tests
$env:TEST_DATABASE_URL="postgresql://salon_app:...@localhost:5432/salon"
$env:TEST_ADMIN_DATABASE_URL="postgresql://salon_migrator:...@localhost:5432/salon"
npm run test:e2e
cd ..\admin-web; npm test
cd ..\customer_app; flutter analyze; flutter test
cd ..\business_app; flutter analyze; flutter test
```
CMD: use `set NAME=value` instead of `$env:NAME="value"`.

## Manual check
1. Customer app: finish a booking as staff, then in the customer app open **Rate your visit** (or menu > My reviews > To review), post a review.
2. Owner app: Reviews and customers > respond, report. Admin web > Reviews > hide it; confirm the salon page and average change.
3. Customer app: menu > Favourite salons; heart on a salon page.
