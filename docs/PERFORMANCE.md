# Performance notes (Phase 15)

Method: measure first, add an index only for a query that is slow or hot, and prove it with `EXPLAIN (ANALYZE, BUFFERS)`.

1. Run `infra/db/slow-queries.sql` in the Supabase SQL editor after a week of real traffic. Fix the top 3 of "total time" first.
2. Index rules in this project: every foreign key that is joined, cascaded or filtered by RLS has a leading index (enforced by `test/security-audit.e2e-spec.ts`); columns that only say who did something do not.
3. Indexes added in Phase 15: `appointment_early_offers(salon_id)`, `appointment_status_history(salon_id, created_at)`, `customer_favourites(salon_id)`, `notifications(event_id)`, `notification_deliveries(device_token_id)`, `device_tokens(session_id)`, `sync_operations(user_id)`, `invoices(plan_id)`. They are small tables today; they matter for cascades, session revocation and the notification worker as data grows.
4. Connection budget (Free / Nano, about 60 connections): `connection_limit=5` per API instance in `DATABASE_URL`; the notification worker and maintenance job use the same pool. Do not run more than 6 instances.
5. Caches: only public images (`PublicUrlSigner`, in memory per instance). Nothing that depends on the user is cached.
6. Images: 1600 px WebP quality 80 for new uploads. Existing images keep their old size.
7. Reports (R13-4): ranges are capped (366 days) and rate limited. If the Super Admin analytics page becomes slow, add a materialised monthly summary; do not add a cache keyed by user.
8. Slow requests are logged as `http.slow` (threshold `SLOW_REQUEST_MS`, default 1500 ms) with the route template, never the URL.
