-- Phase 4: salon profile management (approved salons), opening hours, dynamic categories and services,
-- fixed / staff-based pricing, a minimal staff roster and staff-service assignments.
-- Hand-written SQL is the source of truth for CHECK constraints, partial indexes, composite foreign keys,
-- RLS policies, guard triggers and grants (Prisma cannot express them). Apply with `prisma migrate deploy`.
-- This migration NEVER edits an earlier migration: it replaces functions/constraints that Phase 3 created.

-- ---------------------------------------------------------------------------------------------
-- 1) salon_files: catalogue images (category / service pictures) are PHOTO files of type CATALOG.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE "salon_files" DROP CONSTRAINT "salon_files_kind_type";
ALTER TABLE "salon_files" ADD CONSTRAINT "salon_files_kind_type" CHECK (
  ("kind" = 'DOCUMENT' AND "doc_type" IN ('CNIC_FRONT', 'CNIC_BACK', 'BUSINESS_LICENSE', 'OTHER_DOCUMENT'))
  OR ("kind" = 'PHOTO' AND "doc_type" IN ('COVER', 'GALLERY', 'CATALOG'))
);

-- Single-slot types are COVER and the four documents; GALLERY, OTHER_DOCUMENT and CATALOG may repeat.
DROP INDEX "salon_files_one_per_slot";
CREATE UNIQUE INDEX "salon_files_one_per_slot" ON "salon_files"("salon_id", "doc_type")
  WHERE "deleted_at" IS NULL AND "doc_type" NOT IN ('GALLERY', 'OTHER_DOCUMENT', 'CATALOG');

-- Target of composite foreign keys: a catalogue row can only point at a file of the SAME salon.
CREATE UNIQUE INDEX "salon_files_salon_id_id_key" ON "salon_files"("salon_id", "id");

-- ---------------------------------------------------------------------------------------------
-- 2) Guard triggers: R21. Owners may now edit the profile and the PHOTOS of an APPROVED salon.
--    Documents stay locked after submission. Status and review fields stay admin-only.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION salons_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  is_admin boolean := app_is_platform_admin();
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT is_admin AND (NEW.status <> 'DRAFT' OR NEW.submitted_at IS NOT NULL OR NEW.approved_at IS NOT NULL
        OR NEW.approved_by IS NOT NULL OR NEW.rejection_reason IS NOT NULL OR NEW.suspended_reason IS NOT NULL) THEN
      RAISE EXCEPTION 'a new salon must start as DRAFT' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.owner_user_id <> OLD.owner_user_id THEN
    RAISE EXCEPTION 'salon ownership cannot be changed' USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF is_admin THEN
      IF NOT ((OLD.status = 'PENDING'   AND NEW.status IN ('APPROVED', 'REJECTED'))
           OR (OLD.status = 'APPROVED'  AND NEW.status = 'SUSPENDED')
           OR (OLD.status = 'SUSPENDED' AND NEW.status = 'APPROVED')) THEN
        RAISE EXCEPTION 'illegal salon status transition % -> %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
      END IF;
    ELSE
      IF NOT (OLD.status IN ('DRAFT', 'REJECTED') AND NEW.status = 'PENDING') THEN
        RAISE EXCEPTION 'only a platform administrator can make this status change' USING ERRCODE = 'insufficient_privilege';
      END IF;
    END IF;
  ELSIF NOT is_admin THEN
    -- Not a status change: the owner may edit while the salon is a draft, was rejected, or is live (Phase 4).
    -- PENDING (under review) and SUSPENDED stay locked.
    IF OLD.status NOT IN ('DRAFT', 'REJECTED', 'APPROVED') THEN
      RAISE EXCEPTION 'salon cannot be edited in status %', OLD.status USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;

  IF NOT is_admin AND (NEW.approved_at IS DISTINCT FROM OLD.approved_at OR NEW.approved_by IS DISTINCT FROM OLD.approved_by
      OR NEW.rejection_reason IS DISTINCT FROM OLD.rejection_reason OR NEW.suspended_reason IS DISTINCT FROM OLD.suspended_reason) THEN
    RAISE EXCEPTION 'review fields can only be changed by a platform administrator' USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION salon_files_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  current_status "salon_status";
  target_salon uuid;
  touches_document boolean;
BEGIN
  IF app_is_platform_admin() THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF TG_OP = 'INSERT' THEN
    target_salon := NEW.salon_id;
    touches_document := (NEW.kind = 'DOCUMENT');
  ELSIF TG_OP = 'DELETE' THEN
    target_salon := OLD.salon_id;
    touches_document := (OLD.kind = 'DOCUMENT');
  ELSE
    target_salon := OLD.salon_id;
    touches_document := (OLD.kind = 'DOCUMENT' OR NEW.kind = 'DOCUMENT');
  END IF;

  SELECT s.status INTO current_status FROM salons s WHERE s.id = target_salon;
  IF current_status IS NULL
     OR (touches_document AND current_status NOT IN ('DRAFT', 'REJECTED'))
     OR (NOT touches_document AND current_status NOT IN ('DRAFT', 'REJECTED', 'APPROVED')) THEN
    RAISE EXCEPTION 'files cannot be changed while the salon is %', COALESCE(current_status::text, 'unknown')
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

-- ---------------------------------------------------------------------------------------------
-- 3) Opening hours: one row per weekday (ISO: 1 = Monday ... 7 = Sunday), minutes since midnight.
--    Same-day intervals only (closing time after opening time, 24:00 allowed); overnight hours are not modelled.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE "salon_opening_hours" (
    "salon_id" UUID NOT NULL,
    "weekday" SMALLINT NOT NULL,
    "is_closed" BOOLEAN NOT NULL DEFAULT false,
    "opens_minute" SMALLINT,
    "closes_minute" SMALLINT,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "salon_opening_hours_pkey" PRIMARY KEY ("salon_id", "weekday"),
    CONSTRAINT "salon_opening_hours_weekday" CHECK ("weekday" BETWEEN 1 AND 7),
    CONSTRAINT "salon_opening_hours_shape" CHECK (
      ("is_closed" AND "opens_minute" IS NULL AND "closes_minute" IS NULL)
      OR (NOT "is_closed" AND "opens_minute" BETWEEN 0 AND 1439 AND "closes_minute" BETWEEN 1 AND 1440 AND "closes_minute" > "opens_minute")
    )
);
ALTER TABLE "salon_opening_hours" ADD CONSTRAINT "salon_opening_hours_salon_id_fkey"
  FOREIGN KEY ("salon_id") REFERENCES "salons"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------------------------
-- 4) Staff roster (minimal). Phase 5 adds invitations, accounts, permissions, schedules on this table.
--    A profile may exist without a login (user_id NULL); the owner may add themselves (is_owner).
-- ---------------------------------------------------------------------------------------------
CREATE TABLE "staff_profiles" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "salon_id" UUID NOT NULL,
    "user_id" UUID,
    "display_name" VARCHAR(80) NOT NULL,
    "is_owner" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "staff_profiles_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "staff_profiles_name_len" CHECK (char_length(btrim("display_name")) >= 2),
    CONSTRAINT "staff_profiles_owner_has_user" CHECK (NOT "is_owner" OR "user_id" IS NOT NULL)
);
CREATE UNIQUE INDEX "staff_profiles_salon_id_id_key" ON "staff_profiles"("salon_id", "id");
-- An owner who also performs services is ONE staff member (billing rule): one owner profile per salon.
CREATE UNIQUE INDEX "staff_profiles_one_owner_per_salon" ON "staff_profiles"("salon_id") WHERE "is_owner" AND "deleted_at" IS NULL;
CREATE UNIQUE INDEX "staff_profiles_user_id_key" ON "staff_profiles"("user_id") WHERE "user_id" IS NOT NULL AND "deleted_at" IS NULL;
CREATE INDEX "staff_profiles_salon_id_idx" ON "staff_profiles"("salon_id") WHERE "deleted_at" IS NULL;
ALTER TABLE "staff_profiles" ADD CONSTRAINT "staff_profiles_salon_id_fkey"
  FOREIGN KEY ("salon_id") REFERENCES "salons"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "staff_profiles" ADD CONSTRAINT "staff_profiles_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------------------------
-- 5) Categories (owner-defined; never hardcoded) and services.
-- ---------------------------------------------------------------------------------------------
CREATE TYPE "service_pricing_mode" AS ENUM ('FIXED', 'STAFF_BASED');

CREATE TABLE "service_categories" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "salon_id" UUID NOT NULL,
    "name" VARCHAR(60) NOT NULL,
    "description" VARCHAR(300),
    "image_file_id" UUID,
    "display_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "service_categories_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "service_categories_name_len" CHECK (char_length(btrim("name")) >= 2),
    CONSTRAINT "service_categories_order_range" CHECK ("display_order" BETWEEN 0 AND 100000)
);
CREATE UNIQUE INDEX "service_categories_salon_id_id_key" ON "service_categories"("salon_id", "id");
CREATE UNIQUE INDEX "service_categories_name_key" ON "service_categories"("salon_id", lower("name")) WHERE "deleted_at" IS NULL;
CREATE INDEX "service_categories_salon_order_idx" ON "service_categories"("salon_id", "display_order") WHERE "deleted_at" IS NULL;
ALTER TABLE "service_categories" ADD CONSTRAINT "service_categories_salon_id_fkey"
  FOREIGN KEY ("salon_id") REFERENCES "salons"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "service_categories" ADD CONSTRAINT "service_categories_image_fkey"
  FOREIGN KEY ("salon_id", "image_file_id") REFERENCES "salon_files"("salon_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

CREATE TABLE "services" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "salon_id" UUID NOT NULL,
    "category_id" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "description" VARCHAR(500),
    "duration_minutes" INTEGER NOT NULL,
    "pricing_mode" "service_pricing_mode" NOT NULL DEFAULT 'FIXED',
    "base_price" NUMERIC(10,2),
    "image_file_id" UUID,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "services_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "services_name_len" CHECK (char_length(btrim("name")) >= 2),
    CONSTRAINT "services_duration_range" CHECK ("duration_minutes" BETWEEN 5 AND 480),
    -- FIXED: one salon-wide price. STAFF_BASED: no salon-wide price, every assignment carries its own.
    CONSTRAINT "services_price_matches_mode" CHECK (
      ("pricing_mode" = 'FIXED' AND "base_price" IS NOT NULL AND "base_price" BETWEEN 0 AND 1000000)
      OR ("pricing_mode" = 'STAFF_BASED' AND "base_price" IS NULL)
    )
);
CREATE UNIQUE INDEX "services_salon_id_id_key" ON "services"("salon_id", "id");
-- Needed as the target of staff_services' composite foreign key (keeps the mode in sync, see below).
CREATE UNIQUE INDEX "services_salon_id_id_mode_key" ON "services"("salon_id", "id", "pricing_mode");
CREATE UNIQUE INDEX "services_name_key" ON "services"("salon_id", "category_id", lower("name")) WHERE "deleted_at" IS NULL;
CREATE INDEX "services_category_idx" ON "services"("salon_id", "category_id") WHERE "deleted_at" IS NULL;
ALTER TABLE "services" ADD CONSTRAINT "services_salon_id_fkey"
  FOREIGN KEY ("salon_id") REFERENCES "salons"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "services" ADD CONSTRAINT "services_category_fkey"
  FOREIGN KEY ("salon_id", "category_id") REFERENCES "service_categories"("salon_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "services" ADD CONSTRAINT "services_image_fkey"
  FOREIGN KEY ("salon_id", "image_file_id") REFERENCES "salon_files"("salon_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------------------------
-- 6) Staff-service assignments. `pricing_mode` is copied from the service and tied to it by a composite
--    foreign key (ON UPDATE NO ACTION): the mode of a service cannot change while assignments exist, so the
--    API replaces the assignments in the same transaction. The CHECK then guarantees, in the database itself,
--    that FIXED services carry no staff price and STAFF_BASED services always do.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE "staff_services" (
    "salon_id" UUID NOT NULL,
    "service_id" UUID NOT NULL,
    "staff_id" UUID NOT NULL,
    "pricing_mode" "service_pricing_mode" NOT NULL,
    "price" NUMERIC(10,2),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "staff_services_pkey" PRIMARY KEY ("service_id", "staff_id"),
    CONSTRAINT "staff_services_price_matches_mode" CHECK (
      ("pricing_mode" = 'FIXED' AND "price" IS NULL)
      OR ("pricing_mode" = 'STAFF_BASED' AND "price" IS NOT NULL AND "price" BETWEEN 0 AND 1000000)
    )
);
CREATE INDEX "staff_services_staff_idx" ON "staff_services"("salon_id", "staff_id");
ALTER TABLE "staff_services" ADD CONSTRAINT "staff_services_salon_id_fkey"
  FOREIGN KEY ("salon_id") REFERENCES "salons"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "staff_services" ADD CONSTRAINT "staff_services_service_fkey"
  FOREIGN KEY ("salon_id", "service_id", "pricing_mode") REFERENCES "services"("salon_id", "id", "pricing_mode") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "staff_services" ADD CONSTRAINT "staff_services_staff_fkey"
  FOREIGN KEY ("salon_id", "staff_id") REFERENCES "staff_profiles"("salon_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------------------------
-- 7) Row-Level Security (policy template from the tenancy migration) + public reads for APPROVED salons.
--    Public policies only match inside TenantDb.withPublicRead (app.public_read = 'true').
-- ---------------------------------------------------------------------------------------------
ALTER TABLE "salon_opening_hours" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "salon_opening_hours" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "salon_opening_hours"
  USING      ("salon_id" = app_current_salon_id() OR app_is_platform_admin())
  WITH CHECK ("salon_id" = app_current_salon_id() OR app_is_platform_admin());
CREATE POLICY "public_read_approved" ON "salon_opening_hours" FOR SELECT
  USING (app_public_read() AND EXISTS (SELECT 1 FROM "salons" s WHERE s."id" = "salon_opening_hours"."salon_id" AND s."status" = 'APPROVED'));

ALTER TABLE "staff_profiles" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "staff_profiles" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "staff_profiles"
  USING      ("salon_id" = app_current_salon_id() OR app_is_platform_admin())
  WITH CHECK ("salon_id" = app_current_salon_id() OR app_is_platform_admin());
CREATE POLICY "public_read_approved" ON "staff_profiles" FOR SELECT
  USING (app_public_read() AND "is_active" AND "deleted_at" IS NULL
         AND EXISTS (SELECT 1 FROM "salons" s WHERE s."id" = "staff_profiles"."salon_id" AND s."status" = 'APPROVED'));

ALTER TABLE "service_categories" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "service_categories" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "service_categories"
  USING      ("salon_id" = app_current_salon_id() OR app_is_platform_admin())
  WITH CHECK ("salon_id" = app_current_salon_id() OR app_is_platform_admin());
CREATE POLICY "public_read_approved" ON "service_categories" FOR SELECT
  USING (app_public_read() AND "is_active" AND "deleted_at" IS NULL
         AND EXISTS (SELECT 1 FROM "salons" s WHERE s."id" = "service_categories"."salon_id" AND s."status" = 'APPROVED'));

ALTER TABLE "services" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "services" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "services"
  USING      ("salon_id" = app_current_salon_id() OR app_is_platform_admin())
  WITH CHECK ("salon_id" = app_current_salon_id() OR app_is_platform_admin());
CREATE POLICY "public_read_approved" ON "services" FOR SELECT
  USING (app_public_read() AND "is_active" AND "deleted_at" IS NULL
         AND EXISTS (SELECT 1 FROM "salons" s WHERE s."id" = "services"."salon_id" AND s."status" = 'APPROVED'));

ALTER TABLE "staff_services" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "staff_services" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "staff_services"
  USING      ("salon_id" = app_current_salon_id() OR app_is_platform_admin())
  WITH CHECK ("salon_id" = app_current_salon_id() OR app_is_platform_admin());
CREATE POLICY "public_read_approved" ON "staff_services" FOR SELECT
  USING (app_public_read() AND EXISTS (SELECT 1 FROM "salons" s WHERE s."id" = "staff_services"."salon_id" AND s."status" = 'APPROVED'));

-- ---------------------------------------------------------------------------------------------
-- 8) Grants. Categories, services and staff are soft-deleted (deleted_at): the runtime role never hard-deletes
--    them. (staff_services and opening hours are replaced wholesale, so DELETE stays.) Supabase Data API stays shut.
-- ---------------------------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'salon_app') THEN
    REVOKE DELETE ON "service_categories", "services", "staff_profiles" FROM salon_app;
    REVOKE ALL ON FUNCTION salons_guard(), salon_files_guard() FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION salons_guard(), salon_files_guard() TO salon_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON "salon_opening_hours", "staff_profiles", "service_categories", "services", "staff_services" FROM anon;
    REVOKE ALL ON FUNCTION salons_guard(), salon_files_guard() FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON "salon_opening_hours", "staff_profiles", "service_categories", "services", "staff_services" FROM authenticated;
    REVOKE ALL ON FUNCTION salons_guard(), salon_files_guard() FROM authenticated;
  END IF;
END
$$;
