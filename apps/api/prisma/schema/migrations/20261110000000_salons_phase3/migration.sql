-- Phase 3: salon registration, application review, uploaded files, public visibility.
-- Hand-written SQL is the source of truth for CHECK constraints, partial indexes, RLS policies,
-- guard triggers and grants (Prisma cannot express them). Apply with `prisma migrate deploy`.

CREATE TYPE "salon_status" AS ENUM ('DRAFT', 'PENDING', 'APPROVED', 'REJECTED', 'SUSPENDED');
CREATE TYPE "salon_type" AS ENUM ('MEN', 'LADIES', 'UNISEX');
CREATE TYPE "salon_application_status" AS ENUM ('SUBMITTED', 'APPROVED', 'REJECTED');
CREATE TYPE "salon_file_kind" AS ENUM ('DOCUMENT', 'PHOTO');

-- ---------------------------------------------------------------------------------------------
-- salons: the tenant root. One salon per owner account in Phase 3 (branches come later).
-- ---------------------------------------------------------------------------------------------
CREATE TABLE "salons" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "owner_user_id" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "salon_type" "salon_type" NOT NULL,
    "city" VARCHAR(80) NOT NULL,
    "area" VARCHAR(80) NOT NULL,
    "address_line" VARCHAR(250) NOT NULL,
    "phone" VARCHAR(20) NOT NULL,
    "contact_email" VARCHAR(254),
    "description" VARCHAR(1000),
    "latitude" DECIMAL(9,6),
    "longitude" DECIMAL(9,6),
    "status" "salon_status" NOT NULL DEFAULT 'DRAFT',
    "submitted_at" TIMESTAMPTZ(6),
    "approved_at" TIMESTAMPTZ(6),
    "approved_by" UUID,
    "rejection_reason" VARCHAR(500),
    "suspended_reason" VARCHAR(500),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "salons_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "salons_name_len" CHECK (char_length(btrim("name")) >= 2),
    CONSTRAINT "salons_geo_pair" CHECK (("latitude" IS NULL) = ("longitude" IS NULL)),
    CONSTRAINT "salons_lat_range" CHECK ("latitude" IS NULL OR "latitude" BETWEEN -90 AND 90),
    CONSTRAINT "salons_lng_range" CHECK ("longitude" IS NULL OR "longitude" BETWEEN -180 AND 180),
    CONSTRAINT "salons_rejected_has_reason" CHECK ("status" <> 'REJECTED' OR "rejection_reason" IS NOT NULL),
    CONSTRAINT "salons_suspended_has_reason" CHECK ("status" <> 'SUSPENDED' OR "suspended_reason" IS NOT NULL),
    CONSTRAINT "salons_approved_has_stamp" CHECK ("status" NOT IN ('APPROVED', 'SUSPENDED') OR ("approved_at" IS NOT NULL AND "approved_by" IS NOT NULL))
);

CREATE UNIQUE INDEX "salons_owner_user_id_key" ON "salons"("owner_user_id");
CREATE INDEX "salons_status_created_at_idx" ON "salons"("status", "created_at");
CREATE INDEX "salons_city_status_idx" ON "salons"("city", "status");
CREATE INDEX "salons_name_trgm_idx" ON "salons" USING gin ("name" gin_trgm_ops);

ALTER TABLE "salons" ADD CONSTRAINT "salons_owner_user_id_fkey"
  FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------------------------
-- salon_applications: one row per submission (history of what was reviewed and the decision).
-- ---------------------------------------------------------------------------------------------
CREATE TABLE "salon_applications" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "salon_id" UUID NOT NULL,
    "submission_no" INTEGER NOT NULL,
    "status" "salon_application_status" NOT NULL DEFAULT 'SUBMITTED',
    "submitted_at" TIMESTAMPTZ(6) NOT NULL,
    "snapshot" JSONB NOT NULL,
    "reviewed_by" UUID,
    "reviewed_at" TIMESTAMPTZ(6),
    "decision_reason" VARCHAR(500),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "salon_applications_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "salon_applications_no_positive" CHECK ("submission_no" >= 1),
    CONSTRAINT "salon_applications_rejected_has_reason" CHECK ("status" <> 'REJECTED' OR "decision_reason" IS NOT NULL)
);

CREATE UNIQUE INDEX "salon_applications_salon_id_submission_no_key" ON "salon_applications"("salon_id", "submission_no");
-- At most one application can be waiting for review per salon.
CREATE UNIQUE INDEX "salon_applications_one_open_per_salon" ON "salon_applications"("salon_id") WHERE "status" = 'SUBMITTED';
CREATE INDEX "salon_applications_status_submitted_at_idx" ON "salon_applications"("status", "submitted_at");

ALTER TABLE "salon_applications" ADD CONSTRAINT "salon_applications_salon_id_fkey"
  FOREIGN KEY ("salon_id") REFERENCES "salons"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------------------------
-- salon_files: verification documents (private, admin-only) and photos (public after approval).
-- The object lives in a PRIVATE storage bucket; only the server-generated key is stored here.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE "salon_files" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "salon_id" UUID NOT NULL,
    "kind" "salon_file_kind" NOT NULL,
    "doc_type" VARCHAR(30) NOT NULL,
    "storage_key" VARCHAR(300) NOT NULL,
    "content_type" VARCHAR(60) NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "sha256" CHAR(64) NOT NULL,
    "original_name" VARCHAR(120),
    "uploaded_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "salon_files_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "salon_files_kind_type" CHECK (
      ("kind" = 'DOCUMENT' AND "doc_type" IN ('CNIC_FRONT', 'CNIC_BACK', 'BUSINESS_LICENSE', 'OTHER_DOCUMENT'))
      OR ("kind" = 'PHOTO' AND "doc_type" IN ('COVER', 'GALLERY'))
    ),
    CONSTRAINT "salon_files_content_type" CHECK ("content_type" IN ('image/webp', 'application/pdf')),
    CONSTRAINT "salon_files_pdf_documents_only" CHECK ("content_type" <> 'application/pdf' OR "kind" = 'DOCUMENT'),
    CONSTRAINT "salon_files_size" CHECK ("size_bytes" BETWEEN 1 AND 10485760)
);

CREATE UNIQUE INDEX "salon_files_storage_key_key" ON "salon_files"("storage_key");
CREATE INDEX "salon_files_salon_id_kind_idx" ON "salon_files"("salon_id", "kind") WHERE "deleted_at" IS NULL;
-- Single-slot types (one CNIC front, one cover, ...). GALLERY and OTHER_DOCUMENT may repeat.
CREATE UNIQUE INDEX "salon_files_one_per_slot" ON "salon_files"("salon_id", "doc_type")
  WHERE "deleted_at" IS NULL AND "doc_type" NOT IN ('GALLERY', 'OTHER_DOCUMENT');

ALTER TABLE "salon_files" ADD CONSTRAINT "salon_files_salon_id_fkey"
  FOREIGN KEY ("salon_id") REFERENCES "salons"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------------------------
-- Helper: public (unauthenticated) reads of approved salons. Set per transaction by TenantDb.
-- Missing/empty => false (fail closed).
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_public_read() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(current_setting('app.public_read', true), 'false') = 'true'
$$;

-- ---------------------------------------------------------------------------------------------
-- Row-Level Security
-- ---------------------------------------------------------------------------------------------
ALTER TABLE "salons" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "salons" FORCE ROW LEVEL SECURITY;

-- salons is the tenant root, so the owner is matched by owner_user_id (an owner has no salon context
-- until the API has looked the salon up) and by id once the context carries the salon.
CREATE POLICY "tenant_isolation" ON "salons"
  USING      ("id" = app_current_salon_id() OR "owner_user_id" = app_current_user_id() OR app_is_platform_admin())
  WITH CHECK ("id" = app_current_salon_id() OR "owner_user_id" = app_current_user_id() OR app_is_platform_admin());

-- Anyone may READ an approved salon, but only inside a transaction that opted in to public reads.
CREATE POLICY "public_read_approved" ON "salons" FOR SELECT
  USING ("status" = 'APPROVED' AND app_public_read());

ALTER TABLE "salon_applications" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "salon_applications" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "salon_applications"
  USING      ("salon_id" = app_current_salon_id() OR app_is_platform_admin())
  WITH CHECK ("salon_id" = app_current_salon_id() OR app_is_platform_admin());

ALTER TABLE "salon_files" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "salon_files" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "salon_files"
  USING      ("salon_id" = app_current_salon_id() OR app_is_platform_admin())
  WITH CHECK ("salon_id" = app_current_salon_id() OR app_is_platform_admin());

-- Photos (never documents) of APPROVED salons are readable by public-read transactions.
CREATE POLICY "public_read_photos" ON "salon_files" FOR SELECT
  USING (
    "kind" = 'PHOTO' AND "deleted_at" IS NULL AND app_public_read()
    AND EXISTS (SELECT 1 FROM "salons" s WHERE s."id" = "salon_files"."salon_id" AND s."status" = 'APPROVED')
  );

-- ---------------------------------------------------------------------------------------------
-- Guard triggers: the database itself refuses an owner approving their own salon, editing a salon
-- that is under review, or changing files after submission. The API enforces the same rules; this
-- is the second wall. (app_is_platform_admin() is also true for SUPPORT/FINANCE: risk R10.)
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
    -- Not a status change: the owner may only edit while the salon is a draft or was rejected.
    IF OLD.status NOT IN ('DRAFT', 'REJECTED') THEN
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

CREATE TRIGGER "salons_guard_trg" BEFORE INSERT OR UPDATE ON "salons"
  FOR EACH ROW EXECUTE FUNCTION salons_guard();

CREATE OR REPLACE FUNCTION salon_files_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  current_status "salon_status";
BEGIN
  IF app_is_platform_admin() THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  SELECT s.status INTO current_status FROM salons s WHERE s.id = COALESCE(NEW.salon_id, OLD.salon_id);
  IF current_status IS NULL OR current_status NOT IN ('DRAFT', 'REJECTED') THEN
    RAISE EXCEPTION 'files cannot be changed while the salon is %', COALESCE(current_status::text, 'unknown')
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE TRIGGER "salon_files_guard_trg" BEFORE INSERT OR UPDATE OR DELETE ON "salon_files"
  FOR EACH ROW EXECUTE FUNCTION salon_files_guard();

-- Files are soft-deleted (UPDATE of deleted_at); the runtime role never hard-deletes them.
-- Applications are history: the runtime role may INSERT/UPDATE (review) but never DELETE.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'salon_app') THEN
    REVOKE DELETE ON "salon_files", "salon_applications" FROM salon_app;
    REVOKE ALL ON FUNCTION app_public_read(), salons_guard(), salon_files_guard() FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION app_public_read(), salons_guard(), salon_files_guard() TO salon_app;
  END IF;
  -- Supabase Data API lock-down: these tables must never be reachable through anon/authenticated.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON "salons", "salon_applications", "salon_files" FROM anon;
    REVOKE ALL ON FUNCTION app_public_read(), salons_guard(), salon_files_guard() FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON "salons", "salon_applications", "salon_files" FROM authenticated;
    REVOKE ALL ON FUNCTION app_public_read(), salons_guard(), salon_files_guard() FROM authenticated;
  END IF;
END
$$;
