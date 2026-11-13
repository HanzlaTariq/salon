-- Phase 7: customer discovery (city / nearby search, filters, sorting, availability preview).
-- Everything here is additive. No existing table is altered; no applied migration is edited.
--
-- 1) PostGIS (distance on the WGS-84 spheroid) -- installed in the `extensions` schema (Supabase convention), never in
--    `public`, so `spatial_ref_sys` is NOT exposed through the Supabase Data API. A DB where PostGIS is already enabled
--    (local docker image, or enabled from the dashboard) is left as is.
-- 2) discovery_distance_m(): the ONLY place PostGIS is called. SECURITY DEFINER + fixed search_path, so the runtime role
--    `salon_app` needs no access to the `extensions` schema. It handles numbers only (no table access).
-- 3) salon_is_listed(): the single public-visibility rule (APPROVED is checked by the caller):
--      * salon has a subscription row  -> listed only while ACTIVE or in GRACE (same rule as billing `isOperational`)
--      * salon never subscribed        -> listed during the free trial (platform setting discovery.trialDays, counted
--        from approval, Asia/Karachi calendar days)
--    Phase 8 (booking) must call the same function.
-- 4) Public-read RLS policies (they match ONLY inside TenantDb.withPublicRead, app.public_read = 'true') for the tables
--    the availability preview and the listing rule need.

SET search_path = public, extensions;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'postgis') THEN
    CREATE SCHEMA IF NOT EXISTS extensions;
    CREATE EXTENSION postgis WITH SCHEMA extensions;
  END IF;
END
$$;

-- ---------------------------------------------------------------------------------------------
-- Distance in metres between a stored salon point and a search point (NULL when the salon has no coordinates).
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION discovery_distance_m(salon_lat numeric, salon_lng numeric, search_lat double precision, search_lng double precision)
RETURNS double precision
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
  SELECT CASE
    WHEN salon_lat IS NULL OR salon_lng IS NULL OR search_lat IS NULL OR search_lng IS NULL THEN NULL
    ELSE ST_Distance(
      ST_SetSRID(ST_MakePoint(salon_lng::double precision, salon_lat::double precision), 4326)::geography,
      ST_SetSRID(ST_MakePoint(search_lng, search_lat), 4326)::geography
    )
  END
$$;

-- ---------------------------------------------------------------------------------------------
-- Public listing rule (see header). SECURITY INVOKER: the caller's RLS context applies.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION salon_is_listed(p_salon_id uuid, p_approved_at timestamptz, p_trial_days integer, p_today date)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM salon_subscriptions ss WHERE ss.salon_id = p_salon_id)
      THEN EXISTS (
        SELECT 1 FROM salon_subscriptions ss
        WHERE ss.salon_id = p_salon_id AND ss.status = 'ACTIVE' AND p_today < ss.period_end + ss.period_grace_days::integer
      )
    ELSE p_approved_at IS NOT NULL
      AND ((p_approved_at AT TIME ZONE 'Asia/Karachi')::date + GREATEST(p_trial_days, 0)) > p_today
  END
$$;

-- ---------------------------------------------------------------------------------------------
-- Public-read policies (SELECT only, approved salons only, active staff only).
-- ---------------------------------------------------------------------------------------------
CREATE POLICY "public_read_approved" ON "staff_working_hours" FOR SELECT
  USING (app_public_read()
         AND EXISTS (SELECT 1 FROM "salons" s WHERE s."id" = "staff_working_hours"."salon_id" AND s."status" = 'APPROVED')
         AND EXISTS (SELECT 1 FROM "staff_profiles" p WHERE p."id" = "staff_working_hours"."staff_id" AND p."salon_id" = "staff_working_hours"."salon_id"
                     AND p."is_active" AND p."deleted_at" IS NULL));

CREATE POLICY "public_read_approved" ON "staff_breaks" FOR SELECT
  USING (app_public_read()
         AND EXISTS (SELECT 1 FROM "salons" s WHERE s."id" = "staff_breaks"."salon_id" AND s."status" = 'APPROVED')
         AND EXISTS (SELECT 1 FROM "staff_profiles" p WHERE p."id" = "staff_breaks"."staff_id" AND p."salon_id" = "staff_breaks"."salon_id"
                     AND p."is_active" AND p."deleted_at" IS NULL));

-- Only APPROVED leave blocks a day. The reason text is private: the API selects dates only.
CREATE POLICY "public_read_approved" ON "staff_leaves" FOR SELECT
  USING (app_public_read() AND "status" = 'APPROVED'
         AND EXISTS (SELECT 1 FROM "salons" s WHERE s."id" = "staff_leaves"."salon_id" AND s."status" = 'APPROVED')
         AND EXISTS (SELECT 1 FROM "staff_profiles" p WHERE p."id" = "staff_leaves"."staff_id" AND p."salon_id" = "staff_leaves"."salon_id"
                     AND p."is_active" AND p."deleted_at" IS NULL));

-- Needed by salon_is_listed() in the public context. The API never returns prices or staff counts from this table.
CREATE POLICY "public_listing_read" ON "salon_subscriptions" FOR SELECT
  USING (app_public_read() AND EXISTS (SELECT 1 FROM "salons" s WHERE s."id" = "salon_subscriptions"."salon_id" AND s."status" = 'APPROVED'));

-- ---------------------------------------------------------------------------------------------
-- Indexes (search is read-heavy). The salon-name trigram index already exists (Phase 3). The partial btree serves the
-- bounding-box prefilter of nearby search; the services trigram index serves service-name search.
-- ---------------------------------------------------------------------------------------------
CREATE INDEX "salons_city_area_lower_idx" ON "salons" (lower("city"), lower("area")) WHERE "status" = 'APPROVED';
CREATE INDEX "salons_geo_idx" ON "salons" ("latitude", "longitude") WHERE "status" = 'APPROVED' AND "latitude" IS NOT NULL AND "longitude" IS NOT NULL;
CREATE INDEX "services_name_trgm_idx" ON "services" USING gin ("name" gin_trgm_ops) WHERE "is_active" AND "deleted_at" IS NULL;

-- ---------------------------------------------------------------------------------------------
-- Grants and Supabase Data API lock-down for the new functions.
-- ---------------------------------------------------------------------------------------------
DO $$
BEGIN
  REVOKE ALL ON FUNCTION discovery_distance_m(numeric, numeric, double precision, double precision) FROM PUBLIC;
  REVOKE ALL ON FUNCTION salon_is_listed(uuid, timestamptz, integer, date) FROM PUBLIC;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'salon_app') THEN
    GRANT EXECUTE ON FUNCTION discovery_distance_m(numeric, numeric, double precision, double precision) TO salon_app;
    GRANT EXECUTE ON FUNCTION salon_is_listed(uuid, timestamptz, integer, date) TO salon_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON FUNCTION discovery_distance_m(numeric, numeric, double precision, double precision) FROM anon;
    REVOKE ALL ON FUNCTION salon_is_listed(uuid, timestamptz, integer, date) FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON FUNCTION discovery_distance_m(numeric, numeric, double precision, double precision) FROM authenticated;
    REVOKE ALL ON FUNCTION salon_is_listed(uuid, timestamptz, integer, date) FROM authenticated;
  END IF;
END
$$;
