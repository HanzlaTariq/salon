-- Phase 14: reviews, ratings, moderation and favourite salons.
-- Additive: no earlier migration is edited. Hand-written SQL is the source of truth for CHECK constraints, guard triggers,
-- RLS policies and grants (Prisma cannot express them).
--
-- What this migration adds:
--   * reviews            one review per COMPLETED appointment, written by that customer only (salon rating, optional staff rating,
--                        optional comment). The salon owner can add ONE public response; the Super Admin can hide / restore a review.
--   * review_services    optional rating per service of that appointment (only services that were really performed).
--   * review_reports     the salon owner reports a review; the Super Admin resolves the report (dismiss, or hide the review).
--   * salon_rating_stats / staff_rating_stats
--                        star counters kept by a trigger from PUBLISHED reviews only (hidden reviews never count). The average and the
--                        count are GENERATED from the counters, so they cannot drift. Used by discovery cards and sorting.
--   * customer_favourites  a customer's favourite salons (private to that customer).
--
-- Who may do what is enforced here (RLS + guard triggers) AND in the API. Every rule below must hold even for a buggy API:
--   customer : create a review for an own COMPLETED appointment (max 30 days after completion), edit rating/comment for 7 days.
--   owner    : read reviews of the own salon; set / remove the public response; report a review. Never edit a rating or comment.
--   staff    : read reviews that name them (own rows only).
--   admin    : hide / restore a review (with a reason), resolve reports. Never edit a rating or comment.
--   public   : only PUBLISHED reviews of APPROVED salons.

-- ---------------------------------------------------------------------------------------------
-- 1) Reviews
-- ---------------------------------------------------------------------------------------------
CREATE TABLE "reviews" (
    "id"                 UUID NOT NULL DEFAULT gen_random_uuid(),
    "salon_id"           UUID NOT NULL,
    "appointment_id"     UUID NOT NULL,
    "customer_user_id"   UUID NOT NULL,
    "staff_id"           UUID NOT NULL,
    -- Snapshot such as "Sara K.": other people never read the users table.
    "author_name"        VARCHAR(60) NOT NULL,
    "salon_rating"       SMALLINT NOT NULL,
    "staff_rating"       SMALLINT,
    "comment"            VARCHAR(1000),
    "status"             VARCHAR(10) NOT NULL DEFAULT 'PUBLISHED',
    "hidden_reason"      VARCHAR(300),
    "hidden_by"          UUID,
    "hidden_at"          TIMESTAMPTZ(6),
    "owner_response"     VARCHAR(500),
    "owner_response_at"  TIMESTAMPTZ(6),
    "owner_response_by"  UUID,
    "edited_at"          TIMESTAMPTZ(6),
    "created_at"         TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at"         TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "reviews_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "reviews_salon_rating_range" CHECK ("salon_rating" BETWEEN 1 AND 5),
    CONSTRAINT "reviews_staff_rating_range" CHECK ("staff_rating" IS NULL OR "staff_rating" BETWEEN 1 AND 5),
    CONSTRAINT "reviews_comment_len" CHECK ("comment" IS NULL OR char_length(btrim("comment")) BETWEEN 1 AND 1000),
    CONSTRAINT "reviews_author_len" CHECK (char_length(btrim("author_name")) BETWEEN 1 AND 60),
    CONSTRAINT "reviews_status_known" CHECK ("status" IN ('PUBLISHED', 'HIDDEN')),
    CONSTRAINT "reviews_hidden_consistent" CHECK (
      ("status" = 'HIDDEN') = ("hidden_reason" IS NOT NULL AND "hidden_by" IS NOT NULL AND "hidden_at" IS NOT NULL)
    ),
    CONSTRAINT "reviews_hidden_reason_len" CHECK ("hidden_reason" IS NULL OR char_length(btrim("hidden_reason")) BETWEEN 3 AND 300),
    CONSTRAINT "reviews_response_consistent" CHECK (
      ("owner_response" IS NULL) = ("owner_response_at" IS NULL) AND ("owner_response" IS NULL) = ("owner_response_by" IS NULL)
    ),
    CONSTRAINT "reviews_response_len" CHECK ("owner_response" IS NULL OR char_length(btrim("owner_response")) BETWEEN 1 AND 500)
);

-- ONE review per appointment (a customer can never review the same visit twice).
CREATE UNIQUE INDEX "reviews_appointment_key" ON "reviews"("appointment_id");
CREATE UNIQUE INDEX "reviews_salon_id_id_key" ON "reviews"("salon_id", "id");
CREATE INDEX "reviews_salon_status_idx" ON "reviews"("salon_id", "status", "created_at" DESC);
CREATE INDEX "reviews_customer_idx" ON "reviews"("customer_user_id", "created_at" DESC);
CREATE INDEX "reviews_staff_idx" ON "reviews"("staff_id", "created_at" DESC) WHERE "status" = 'PUBLISHED';
CREATE INDEX "reviews_unanswered_idx" ON "reviews"("salon_id", "created_at" DESC) WHERE "status" = 'PUBLISHED' AND "owner_response" IS NULL;
CREATE INDEX "reviews_hidden_idx" ON "reviews"("created_at" DESC) WHERE "status" = 'HIDDEN';

ALTER TABLE "reviews"
  ADD CONSTRAINT "reviews_salon_fkey" FOREIGN KEY ("salon_id") REFERENCES "salons"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "reviews_appointment_fkey" FOREIGN KEY ("salon_id", "appointment_id") REFERENCES "appointments"("salon_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "reviews_customer_fkey" FOREIGN KEY ("customer_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "reviews_staff_fkey" FOREIGN KEY ("salon_id", "staff_id") REFERENCES "staff_profiles"("salon_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "reviews_hidden_by_fkey" FOREIGN KEY ("hidden_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "reviews_response_by_fkey" FOREIGN KEY ("owner_response_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------------------------
-- 2) Review guard: the business rules the database repeats for every writer
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION reviews_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  uid uuid := app_current_user_id();
  is_admin boolean := app_is_platform_admin();
  appt RECORD;
  changed_customer boolean;
  changed_response boolean;
  changed_moderation boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT a.status::text AS status, a.customer_user_id, a.salon_id, a.staff_id, a.completed_at
      INTO appt FROM "appointments" a WHERE a.id = NEW.appointment_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'appointment not found' USING ERRCODE = 'check_violation';
    END IF;
    IF uid IS NULL OR NEW.customer_user_id <> uid OR appt.customer_user_id IS DISTINCT FROM uid THEN
      RAISE EXCEPTION 'only the customer of an appointment can review it' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF appt.status <> 'COMPLETED' OR appt.completed_at IS NULL THEN
      RAISE EXCEPTION 'only a completed appointment can be reviewed' USING ERRCODE = 'check_violation';
    END IF;
    IF appt.salon_id <> NEW.salon_id OR appt.staff_id <> NEW.staff_id THEN
      RAISE EXCEPTION 'review does not match the appointment' USING ERRCODE = 'check_violation';
    END IF;
    IF now() - appt.completed_at > interval '30 days' THEN
      RAISE EXCEPTION 'the review period of 30 days after the visit has ended' USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM "salons" s WHERE s.id = NEW.salon_id AND s.owner_user_id = NEW.customer_user_id) THEN
      RAISE EXCEPTION 'a salon owner cannot review their own salon' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.status <> 'PUBLISHED' OR NEW.hidden_reason IS NOT NULL OR NEW.owner_response IS NOT NULL OR NEW.edited_at IS NOT NULL THEN
      RAISE EXCEPTION 'a new review must be published without moderation or response data' USING ERRCODE = 'check_violation';
    END IF;
    NEW.created_at := clock_timestamp();
    NEW.updated_at := NEW.created_at;
    RETURN NEW;
  END IF;

  -- UPDATE
  IF NEW.id <> OLD.id OR NEW.salon_id <> OLD.salon_id OR NEW.appointment_id <> OLD.appointment_id OR NEW.customer_user_id <> OLD.customer_user_id
     OR NEW.staff_id <> OLD.staff_id OR NEW.author_name <> OLD.author_name OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'review identity fields cannot be changed' USING ERRCODE = 'check_violation';
  END IF;

  changed_customer := NEW.salon_rating <> OLD.salon_rating OR NEW.staff_rating IS DISTINCT FROM OLD.staff_rating OR NEW.comment IS DISTINCT FROM OLD.comment;
  changed_response := NEW.owner_response IS DISTINCT FROM OLD.owner_response;
  changed_moderation := NEW.status <> OLD.status;

  IF (changed_customer::int + changed_response::int + changed_moderation::int) > 1 THEN
    RAISE EXCEPTION 'only one kind of change is allowed at a time' USING ERRCODE = 'check_violation';
  END IF;

  IF changed_customer THEN
    IF is_admin OR uid IS NULL OR uid <> OLD.customer_user_id THEN
      RAISE EXCEPTION 'only the author can change a rating or comment' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF OLD.status <> 'PUBLISHED' THEN
      RAISE EXCEPTION 'a hidden review cannot be edited' USING ERRCODE = 'check_violation';
    END IF;
    IF now() - OLD.created_at > interval '7 days' THEN
      RAISE EXCEPTION 'a review can only be edited within 7 days' USING ERRCODE = 'check_violation';
    END IF;
    NEW.edited_at := clock_timestamp();
  ELSIF changed_response THEN
    IF uid IS NULL OR NOT app_owns_salon(OLD.salon_id) THEN
      RAISE EXCEPTION 'only the salon owner can respond to a review' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF OLD.status <> 'PUBLISHED' THEN
      RAISE EXCEPTION 'a hidden review cannot be answered' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.owner_response IS NOT NULL THEN
      IF NEW.owner_response_by IS DISTINCT FROM uid THEN
        RAISE EXCEPTION 'the response must be recorded under the signed-in owner' USING ERRCODE = 'check_violation';
      END IF;
      NEW.owner_response_at := clock_timestamp();
    END IF;
  ELSIF changed_moderation THEN
    IF NOT is_admin OR uid IS NULL THEN
      RAISE EXCEPTION 'only a platform administrator can hide or restore a review' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW.status = 'HIDDEN' THEN
      IF NEW.hidden_by IS DISTINCT FROM uid THEN
        RAISE EXCEPTION 'the moderator must be the signed-in administrator' USING ERRCODE = 'check_violation';
      END IF;
      NEW.hidden_at := clock_timestamp();
    END IF;
  ELSE
    -- Nothing meaningful changed: the hidden / response columns must not move either.
    IF NEW.hidden_reason IS DISTINCT FROM OLD.hidden_reason OR NEW.hidden_by IS DISTINCT FROM OLD.hidden_by OR NEW.hidden_at IS DISTINCT FROM OLD.hidden_at
       OR NEW.owner_response_at IS DISTINCT FROM OLD.owner_response_at OR NEW.owner_response_by IS DISTINCT FROM OLD.owner_response_by
       OR NEW.edited_at IS DISTINCT FROM OLD.edited_at THEN
      RAISE EXCEPTION 'those review fields are managed by the system' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;
CREATE TRIGGER "reviews_guard_trg" BEFORE INSERT OR UPDATE ON "reviews"
  FOR EACH ROW EXECUTE FUNCTION reviews_guard();

-- ---------------------------------------------------------------------------------------------
-- 3) Rating stats (star counters). Maintained ONLY by the trigger below; the runtime role cannot write them.
--    The average and the count are generated from the counters. A hidden review is removed from the counters.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE "salon_rating_stats" (
    "salon_id"     UUID NOT NULL,
    "star_1"       INTEGER NOT NULL DEFAULT 0,
    "star_2"       INTEGER NOT NULL DEFAULT 0,
    "star_3"       INTEGER NOT NULL DEFAULT 0,
    "star_4"       INTEGER NOT NULL DEFAULT 0,
    "star_5"       INTEGER NOT NULL DEFAULT 0,
    "review_count" INTEGER GENERATED ALWAYS AS ("star_1" + "star_2" + "star_3" + "star_4" + "star_5") STORED,
    "rating_avg"   NUMERIC(3,2) GENERATED ALWAYS AS (
      CASE WHEN ("star_1" + "star_2" + "star_3" + "star_4" + "star_5") = 0 THEN NULL
           ELSE round(("star_1" + 2 * "star_2" + 3 * "star_3" + 4 * "star_4" + 5 * "star_5")::numeric
                      / ("star_1" + "star_2" + "star_3" + "star_4" + "star_5"), 2) END) STORED,
    "updated_at"   TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "salon_rating_stats_pkey" PRIMARY KEY ("salon_id"),
    CONSTRAINT "salon_rating_stats_non_negative" CHECK ("star_1" >= 0 AND "star_2" >= 0 AND "star_3" >= 0 AND "star_4" >= 0 AND "star_5" >= 0),
    CONSTRAINT "salon_rating_stats_salon_fkey" FOREIGN KEY ("salon_id") REFERENCES "salons"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "salon_rating_stats_rank_idx" ON "salon_rating_stats"("rating_avg" DESC, "review_count" DESC);

CREATE TABLE "staff_rating_stats" (
    "staff_id"     UUID NOT NULL,
    "salon_id"     UUID NOT NULL,
    "star_1"       INTEGER NOT NULL DEFAULT 0,
    "star_2"       INTEGER NOT NULL DEFAULT 0,
    "star_3"       INTEGER NOT NULL DEFAULT 0,
    "star_4"       INTEGER NOT NULL DEFAULT 0,
    "star_5"       INTEGER NOT NULL DEFAULT 0,
    "review_count" INTEGER GENERATED ALWAYS AS ("star_1" + "star_2" + "star_3" + "star_4" + "star_5") STORED,
    "rating_avg"   NUMERIC(3,2) GENERATED ALWAYS AS (
      CASE WHEN ("star_1" + "star_2" + "star_3" + "star_4" + "star_5") = 0 THEN NULL
           ELSE round(("star_1" + 2 * "star_2" + 3 * "star_3" + 4 * "star_4" + 5 * "star_5")::numeric
                      / ("star_1" + "star_2" + "star_3" + "star_4" + "star_5"), 2) END) STORED,
    "updated_at"   TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "staff_rating_stats_pkey" PRIMARY KEY ("staff_id"),
    CONSTRAINT "staff_rating_stats_non_negative" CHECK ("star_1" >= 0 AND "star_2" >= 0 AND "star_3" >= 0 AND "star_4" >= 0 AND "star_5" >= 0),
    CONSTRAINT "staff_rating_stats_staff_fkey" FOREIGN KEY ("salon_id", "staff_id") REFERENCES "staff_profiles"("salon_id", "id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "staff_rating_stats_salon_idx" ON "staff_rating_stats"("salon_id");

-- SECURITY DEFINER (owner = the migration role, which is not subject to the non-FORCED row security of the two stats tables):
-- it only ever ADDS or REMOVES one star on the counters of the review's own salon / staff, from the trigger's NEW / OLD row.
CREATE OR REPLACE FUNCTION review_stats_apply(p_salon uuid, p_staff uuid, p_salon_rating int, p_staff_rating int, p_delta int) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO "salon_rating_stats" AS s ("salon_id", "star_1", "star_2", "star_3", "star_4", "star_5")
  VALUES (p_salon, (p_salon_rating = 1)::int * greatest(p_delta, 0), (p_salon_rating = 2)::int * greatest(p_delta, 0), (p_salon_rating = 3)::int * greatest(p_delta, 0),
          (p_salon_rating = 4)::int * greatest(p_delta, 0), (p_salon_rating = 5)::int * greatest(p_delta, 0))
  ON CONFLICT ("salon_id") DO UPDATE SET
    "star_1" = s."star_1" + (p_salon_rating = 1)::int * p_delta, "star_2" = s."star_2" + (p_salon_rating = 2)::int * p_delta,
    "star_3" = s."star_3" + (p_salon_rating = 3)::int * p_delta, "star_4" = s."star_4" + (p_salon_rating = 4)::int * p_delta,
    "star_5" = s."star_5" + (p_salon_rating = 5)::int * p_delta, "updated_at" = clock_timestamp();
  IF p_staff_rating IS NOT NULL THEN
    INSERT INTO "staff_rating_stats" AS t ("staff_id", "salon_id", "star_1", "star_2", "star_3", "star_4", "star_5")
    VALUES (p_staff, p_salon, (p_staff_rating = 1)::int * greatest(p_delta, 0), (p_staff_rating = 2)::int * greatest(p_delta, 0), (p_staff_rating = 3)::int * greatest(p_delta, 0),
            (p_staff_rating = 4)::int * greatest(p_delta, 0), (p_staff_rating = 5)::int * greatest(p_delta, 0))
    ON CONFLICT ("staff_id") DO UPDATE SET
      "star_1" = t."star_1" + (p_staff_rating = 1)::int * p_delta, "star_2" = t."star_2" + (p_staff_rating = 2)::int * p_delta,
      "star_3" = t."star_3" + (p_staff_rating = 3)::int * p_delta, "star_4" = t."star_4" + (p_staff_rating = 4)::int * p_delta,
      "star_5" = t."star_5" + (p_staff_rating = 5)::int * p_delta, "updated_at" = clock_timestamp();
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION reviews_stats_trg() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.status = NEW.status AND OLD.salon_rating = NEW.salon_rating AND OLD.staff_rating IS NOT DISTINCT FROM NEW.staff_rating THEN
      RETURN NULL;
    END IF;
    IF OLD.status = 'PUBLISHED' THEN
      PERFORM review_stats_apply(OLD.salon_id, OLD.staff_id, OLD.salon_rating, OLD.staff_rating, -1);
    END IF;
  END IF;
  IF NEW.status = 'PUBLISHED' THEN
    PERFORM review_stats_apply(NEW.salon_id, NEW.staff_id, NEW.salon_rating, NEW.staff_rating, 1);
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER "reviews_stats_after" AFTER INSERT OR UPDATE ON "reviews"
  FOR EACH ROW EXECUTE FUNCTION reviews_stats_trg();

-- ---------------------------------------------------------------------------------------------
-- 4) Service ratings (optional, one row per rated service of the reviewed appointment)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE "review_services" (
    "id"           UUID NOT NULL DEFAULT gen_random_uuid(),
    "salon_id"     UUID NOT NULL,
    "review_id"    UUID NOT NULL,
    "service_id"   UUID NOT NULL,
    "service_name" VARCHAR(120) NOT NULL,
    "rating"       SMALLINT NOT NULL,
    "created_at"   TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "review_services_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "review_services_rating_range" CHECK ("rating" BETWEEN 1 AND 5)
);
CREATE UNIQUE INDEX "review_services_unique" ON "review_services"("review_id", "service_id");
CREATE INDEX "review_services_salon_idx" ON "review_services"("salon_id", "review_id");
ALTER TABLE "review_services"
  ADD CONSTRAINT "review_services_review_fkey" FOREIGN KEY ("salon_id", "review_id") REFERENCES "reviews"("salon_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Only a service that was really performed in that appointment can be rated, and the name is taken from the booking snapshot.
CREATE OR REPLACE FUNCTION review_services_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  line RECORD;
BEGIN
  SELECT s.service_name INTO line
    FROM "appointment_services" s JOIN "reviews" r ON r.appointment_id = s.appointment_id AND r.salon_id = s.salon_id
   WHERE r.id = NEW.review_id AND s.service_id = NEW.service_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'that service was not part of the reviewed appointment' USING ERRCODE = 'check_violation';
  END IF;
  NEW.service_name := line.service_name;
  -- distinct per row so the services of one review keep the order they were rated in
  NEW.created_at := clock_timestamp();
  RETURN NEW;
END;
$$;
CREATE TRIGGER "review_services_guard_trg" BEFORE INSERT ON "review_services"
  FOR EACH ROW EXECUTE FUNCTION review_services_guard();

-- ---------------------------------------------------------------------------------------------
-- 5) Reports (the salon asks the platform to look at a review)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE "review_reports" (
    "id"              UUID NOT NULL DEFAULT gen_random_uuid(),
    "salon_id"        UUID NOT NULL,
    "review_id"       UUID NOT NULL,
    "reported_by"     UUID NOT NULL,
    "reason"          VARCHAR(12) NOT NULL,
    "details"         VARCHAR(500),
    "status"          VARCHAR(10) NOT NULL DEFAULT 'OPEN',
    "resolved_by"     UUID,
    "resolved_at"     TIMESTAMPTZ(6),
    "resolution_note" VARCHAR(300),
    "created_at"      TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "review_reports_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "review_reports_reason_known" CHECK ("reason" IN ('OFFENSIVE', 'SPAM', 'FAKE', 'PRIVATE_INFO', 'OTHER')),
    CONSTRAINT "review_reports_other_needs_details" CHECK ("reason" <> 'OTHER' OR "details" IS NOT NULL),
    CONSTRAINT "review_reports_details_len" CHECK ("details" IS NULL OR char_length(btrim("details")) BETWEEN 3 AND 500),
    CONSTRAINT "review_reports_status_known" CHECK ("status" IN ('OPEN', 'DISMISSED', 'ACTIONED')),
    CONSTRAINT "review_reports_resolved_consistent" CHECK (("status" = 'OPEN') = ("resolved_by" IS NULL AND "resolved_at" IS NULL)),
    CONSTRAINT "review_reports_note_len" CHECK ("resolution_note" IS NULL OR char_length(btrim("resolution_note")) BETWEEN 1 AND 300)
);
-- At most one OPEN report per review (a second click or a retry never creates a second one).
CREATE UNIQUE INDEX "review_reports_one_open" ON "review_reports"("review_id") WHERE "status" = 'OPEN';
CREATE INDEX "review_reports_status_idx" ON "review_reports"("status", "created_at");
CREATE INDEX "review_reports_salon_idx" ON "review_reports"("salon_id", "created_at" DESC);
ALTER TABLE "review_reports"
  ADD CONSTRAINT "review_reports_review_fkey" FOREIGN KEY ("salon_id", "review_id") REFERENCES "reviews"("salon_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "review_reports_reporter_fkey" FOREIGN KEY ("reported_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "review_reports_resolver_fkey" FOREIGN KEY ("resolved_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION review_reports_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  uid uuid := app_current_user_id();
  rv_status text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF uid IS NULL OR NEW.reported_by <> uid OR NOT app_owns_salon(NEW.salon_id) THEN
      RAISE EXCEPTION 'only the salon owner can report a review of the salon' USING ERRCODE = 'insufficient_privilege';
    END IF;
    SELECT r.status INTO rv_status FROM "reviews" r WHERE r.id = NEW.review_id AND r.salon_id = NEW.salon_id;
    IF rv_status IS DISTINCT FROM 'PUBLISHED' THEN
      RAISE EXCEPTION 'only a published review can be reported' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.status <> 'OPEN' THEN
      RAISE EXCEPTION 'a new report must be open' USING ERRCODE = 'check_violation';
    END IF;
    NEW.created_at := clock_timestamp();
    RETURN NEW;
  END IF;

  IF NEW.id <> OLD.id OR NEW.salon_id <> OLD.salon_id OR NEW.review_id <> OLD.review_id OR NEW.reported_by <> OLD.reported_by
     OR NEW.reason <> OLD.reason OR NEW.details IS DISTINCT FROM OLD.details OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'report content cannot be changed' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT app_is_platform_admin() OR uid IS NULL THEN
    RAISE EXCEPTION 'only a platform administrator can resolve a report' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status <> 'OPEN' THEN
    RAISE EXCEPTION 'a resolved report cannot be changed' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status NOT IN ('DISMISSED', 'ACTIONED') OR NEW.resolved_by IS DISTINCT FROM uid THEN
    RAISE EXCEPTION 'a report is resolved as DISMISSED or ACTIONED by the signed-in administrator' USING ERRCODE = 'check_violation';
  END IF;
  NEW.resolved_at := clock_timestamp();
  RETURN NEW;
END;
$$;
CREATE TRIGGER "review_reports_guard_trg" BEFORE INSERT OR UPDATE ON "review_reports"
  FOR EACH ROW EXECUTE FUNCTION review_reports_guard();

-- ---------------------------------------------------------------------------------------------
-- 6) Favourite salons (private to the customer: no policy for owners, staff or admins)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE "customer_favourites" (
    "customer_user_id" UUID NOT NULL,
    "salon_id"         UUID NOT NULL,
    "created_at"       TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "customer_favourites_pkey" PRIMARY KEY ("customer_user_id", "salon_id"),
    CONSTRAINT "customer_favourites_customer_fkey" FOREIGN KEY ("customer_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "customer_favourites_salon_fkey" FOREIGN KEY ("salon_id") REFERENCES "salons"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "customer_favourites_recent_idx" ON "customer_favourites"("customer_user_id", "created_at" DESC);

CREATE OR REPLACE FUNCTION customer_favourites_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT count(*) FROM "customer_favourites" f WHERE f.customer_user_id = NEW.customer_user_id) >= 200 THEN
    RAISE EXCEPTION 'a customer can have at most 200 favourite salons' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "customer_favourites_guard_trg" BEFORE INSERT ON "customer_favourites"
  FOR EACH ROW EXECUTE FUNCTION customer_favourites_guard();

-- ---------------------------------------------------------------------------------------------
-- 7) Row-Level Security
-- ---------------------------------------------------------------------------------------------
ALTER TABLE "reviews" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "reviews" FORCE ROW LEVEL SECURITY;
CREATE POLICY "customer_own_read" ON "reviews" FOR SELECT
  USING ("customer_user_id" = app_current_user_id());
CREATE POLICY "customer_own_insert" ON "reviews" FOR INSERT
  WITH CHECK ("customer_user_id" = app_current_user_id());
CREATE POLICY "customer_own_update" ON "reviews" FOR UPDATE
  USING ("customer_user_id" = app_current_user_id()) WITH CHECK ("customer_user_id" = app_current_user_id());
CREATE POLICY "owner_read" ON "reviews" FOR SELECT
  USING ("salon_id" = app_current_salon_id() AND app_owns_salon("salon_id"));
CREATE POLICY "owner_respond" ON "reviews" FOR UPDATE
  USING ("salon_id" = app_current_salon_id() AND app_owns_salon("salon_id"))
  WITH CHECK ("salon_id" = app_current_salon_id() AND app_owns_salon("salon_id"));
CREATE POLICY "staff_own_read" ON "reviews" FOR SELECT
  USING ("salon_id" = app_current_salon_id() AND app_is_own_staff("staff_id"));
CREATE POLICY "admin_read" ON "reviews" FOR SELECT
  USING (app_is_platform_admin());
CREATE POLICY "admin_moderate" ON "reviews" FOR UPDATE
  USING (app_is_platform_admin()) WITH CHECK (app_is_platform_admin());
CREATE POLICY "public_read_published" ON "reviews" FOR SELECT
  USING (app_public_read() AND "status" = 'PUBLISHED'
         AND EXISTS (SELECT 1 FROM "salons" s WHERE s."id" = "reviews"."salon_id" AND s."status" = 'APPROVED'));

ALTER TABLE "review_services" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "review_services" FORCE ROW LEVEL SECURITY;
CREATE POLICY "customer_own_read" ON "review_services" FOR SELECT
  USING (EXISTS (SELECT 1 FROM "reviews" r WHERE r."id" = "review_services"."review_id" AND r."customer_user_id" = app_current_user_id()));
CREATE POLICY "customer_own_insert" ON "review_services" FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM "reviews" r WHERE r."id" = "review_services"."review_id" AND r."salon_id" = "review_services"."salon_id"
                        AND r."customer_user_id" = app_current_user_id()));
CREATE POLICY "owner_read" ON "review_services" FOR SELECT
  USING ("salon_id" = app_current_salon_id() AND app_owns_salon("salon_id"));
CREATE POLICY "staff_own_read" ON "review_services" FOR SELECT
  USING ("salon_id" = app_current_salon_id()
         AND EXISTS (SELECT 1 FROM "reviews" r WHERE r."id" = "review_services"."review_id" AND app_is_own_staff(r."staff_id")));
CREATE POLICY "admin_read" ON "review_services" FOR SELECT
  USING (app_is_platform_admin());
-- The EXISTS on reviews runs under the reviews policies, so a public reader only gets rows of PUBLISHED reviews of APPROVED salons.
CREATE POLICY "public_read_published" ON "review_services" FOR SELECT
  USING (app_public_read() AND EXISTS (SELECT 1 FROM "reviews" r WHERE r."id" = "review_services"."review_id" AND r."status" = 'PUBLISHED'));

ALTER TABLE "review_reports" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "review_reports" FORCE ROW LEVEL SECURITY;
CREATE POLICY "owner_read" ON "review_reports" FOR SELECT
  USING ("salon_id" = app_current_salon_id() AND app_owns_salon("salon_id"));
CREATE POLICY "owner_insert" ON "review_reports" FOR INSERT
  WITH CHECK ("salon_id" = app_current_salon_id() AND app_owns_salon("salon_id") AND "reported_by" = app_current_user_id());
CREATE POLICY "admin_read" ON "review_reports" FOR SELECT
  USING (app_is_platform_admin());
CREATE POLICY "admin_resolve" ON "review_reports" FOR UPDATE
  USING (app_is_platform_admin()) WITH CHECK (app_is_platform_admin());

-- Stats tables: row security is ENABLED but deliberately NOT forced, so the SECURITY DEFINER trigger (running as the table owner) is the only
-- writer. The runtime role gets SELECT only (grants below) and sees rows of approved salons, its own salon, or its own staff row.
ALTER TABLE "salon_rating_stats" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public_read" ON "salon_rating_stats" FOR SELECT
  USING (app_public_read() AND EXISTS (SELECT 1 FROM "salons" s WHERE s."id" = "salon_rating_stats"."salon_id" AND s."status" = 'APPROVED'));
CREATE POLICY "owner_read" ON "salon_rating_stats" FOR SELECT
  USING ("salon_id" = app_current_salon_id() AND app_owns_salon("salon_id"));
CREATE POLICY "admin_read" ON "salon_rating_stats" FOR SELECT
  USING (app_is_platform_admin());

ALTER TABLE "staff_rating_stats" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public_read" ON "staff_rating_stats" FOR SELECT
  USING (app_public_read() AND EXISTS (SELECT 1 FROM "salons" s WHERE s."id" = "staff_rating_stats"."salon_id" AND s."status" = 'APPROVED'));
CREATE POLICY "owner_read" ON "staff_rating_stats" FOR SELECT
  USING ("salon_id" = app_current_salon_id() AND app_owns_salon("salon_id"));
CREATE POLICY "staff_own_read" ON "staff_rating_stats" FOR SELECT
  USING ("salon_id" = app_current_salon_id() AND app_is_own_staff("staff_id"));
CREATE POLICY "admin_read" ON "staff_rating_stats" FOR SELECT
  USING (app_is_platform_admin());

ALTER TABLE "customer_favourites" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "customer_favourites" FORCE ROW LEVEL SECURITY;
CREATE POLICY "customer_own_read" ON "customer_favourites" FOR SELECT
  USING ("customer_user_id" = app_current_user_id());
CREATE POLICY "customer_own_insert" ON "customer_favourites" FOR INSERT
  WITH CHECK ("customer_user_id" = app_current_user_id()
              AND EXISTS (SELECT 1 FROM "salons" s WHERE s."id" = "customer_favourites"."salon_id" AND s."status" = 'APPROVED'));
CREATE POLICY "customer_own_delete" ON "customer_favourites" FOR DELETE
  USING ("customer_user_id" = app_current_user_id());

-- ---------------------------------------------------------------------------------------------
-- 8) Grants. Reviews, service ratings and reports are never deleted by the runtime role (moderation hides, it does not erase).
--    Stats are read-only for the runtime role. The Supabase Data API stays shut for every new table and function.
-- ---------------------------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'salon_app') THEN
    REVOKE DELETE, TRUNCATE ON "reviews" FROM salon_app;
    REVOKE UPDATE, DELETE, TRUNCATE ON "review_services" FROM salon_app;
    REVOKE DELETE, TRUNCATE ON "review_reports" FROM salon_app;
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON "salon_rating_stats" FROM salon_app;
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON "staff_rating_stats" FROM salon_app;
    REVOKE UPDATE, TRUNCATE ON "customer_favourites" FROM salon_app;
    REVOKE ALL ON FUNCTION reviews_guard(), review_services_guard(), review_reports_guard(), customer_favourites_guard(),
                           review_stats_apply(uuid, uuid, int, int, int), reviews_stats_trg() FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION reviews_guard(), review_services_guard(), review_reports_guard(), customer_favourites_guard(),
                              reviews_stats_trg() TO salon_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON "reviews", "review_services", "review_reports", "salon_rating_stats", "staff_rating_stats", "customer_favourites" FROM anon;
    REVOKE ALL ON FUNCTION reviews_guard(), review_services_guard(), review_reports_guard(), customer_favourites_guard(),
                           review_stats_apply(uuid, uuid, int, int, int), reviews_stats_trg() FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON "reviews", "review_services", "review_reports", "salon_rating_stats", "staff_rating_stats", "customer_favourites" FROM authenticated;
    REVOKE ALL ON FUNCTION reviews_guard(), review_services_guard(), review_reports_guard(), customer_favourites_guard(),
                           review_stats_apply(uuid, uuid, int, int, int), reviews_stats_trg() FROM authenticated;
  END IF;
END
$$;
