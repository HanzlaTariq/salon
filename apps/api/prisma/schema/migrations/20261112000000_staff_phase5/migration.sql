-- Phase 5: staff management.
-- Invitations (one-time, hashed tokens), staff accounts (SALON_STAFF), granular staff permissions,
-- weekly working hours, recurring breaks, leave with overlap protection, and the billing flag
-- (performs_services). Hand-written SQL is the source of truth for CHECK constraints, exclusion
-- constraints, RLS policies and grants (Prisma cannot express them).
--
-- Access model (summary, enforced here AND in the API):
--   * Salon owner: full access to the team tables of their own salon.
--   * Staff member: sees only their OWN working hours, breaks and leave. Can change own breaks and
--     request leave only when the owner granted `schedule.manage_own`. Never sees colleagues' rows
--     in the new tables.
--   * Invitation holder: may read/accept ONE invitation whose token hash matches the per-transaction
--     setting app.invite_token_hash. Anything else is invisible.

-- ---------------------------------------------------------------------------------------------
-- 1) Staff profile additions
-- ---------------------------------------------------------------------------------------------
ALTER TABLE "staff_profiles"
  ADD COLUMN "performs_services"   BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "bio"                 VARCHAR(300),
  ADD COLUMN "granted_permissions" TEXT[] NOT NULL DEFAULT '{}',
  ADD CONSTRAINT "staff_profiles_permissions_known"
    CHECK ("granted_permissions" <@ ARRAY['walk_ins.create', 'schedule.manage_own']::TEXT[]),
  ADD CONSTRAINT "staff_profiles_owner_always_active" CHECK (NOT "is_owner" OR "is_active");

-- ---------------------------------------------------------------------------------------------
-- 2) Tenancy helpers used by the Phase 5 policies (STABLE, fail closed on NULL)
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_invite_token_hash() RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.invite_token_hash', true), '')
$$;

CREATE OR REPLACE FUNCTION app_owns_salon(sid uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM "salons" s WHERE s."id" = sid AND s."owner_user_id" = app_current_user_id())
$$;

CREATE OR REPLACE FUNCTION app_is_own_staff(pid uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM "staff_profiles" sp
    WHERE sp."id" = pid AND sp."user_id" = app_current_user_id()
      AND sp."deleted_at" IS NULL AND sp."is_active"
  )
$$;

CREATE OR REPLACE FUNCTION app_has_own_staff_permission(pid uuid, perm text) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM "staff_profiles" sp
    WHERE sp."id" = pid AND sp."user_id" = app_current_user_id()
      AND sp."deleted_at" IS NULL AND sp."is_active" AND perm = ANY (sp."granted_permissions")
  )
$$;

-- A staff member can always find their OWN profile (needed before the salon context is known).
CREATE POLICY "staff_self_read" ON "staff_profiles" FOR SELECT
  USING ("user_id" = app_current_user_id() AND "deleted_at" IS NULL);

-- ---------------------------------------------------------------------------------------------
-- 3) Staff invitations (token stored as SHA-256 only; single use; expires)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE "staff_invitations" (
    "id"               UUID NOT NULL DEFAULT gen_random_uuid(),
    "salon_id"         UUID NOT NULL,
    "staff_id"         UUID NOT NULL,
    "email"            VARCHAR(254) NOT NULL,
    "token_hash"       VARCHAR(64) NOT NULL,
    "status"           VARCHAR(12) NOT NULL DEFAULT 'PENDING',
    "expires_at"       TIMESTAMPTZ(6) NOT NULL,
    "accepted_at"      TIMESTAMPTZ(6),
    "accepted_user_id" UUID,
    "revoked_at"       TIMESTAMPTZ(6),
    "created_by"       UUID NOT NULL,
    "created_at"       TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "staff_invitations_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "staff_invitations_status_known" CHECK ("status" IN ('PENDING', 'ACCEPTED', 'REVOKED')),
    CONSTRAINT "staff_invitations_email_lower" CHECK ("email" = lower("email")),
    CONSTRAINT "staff_invitations_token_hash_len" CHECK (char_length("token_hash") = 64),
    CONSTRAINT "staff_invitations_accepted_consistent" CHECK (
      ("status" = 'ACCEPTED') = ("accepted_at" IS NOT NULL AND "accepted_user_id" IS NOT NULL)
    )
);
CREATE UNIQUE INDEX "staff_invitations_token_hash_key" ON "staff_invitations"("token_hash");
-- At most one live invitation per staff member, and per e-mail address inside one salon.
CREATE UNIQUE INDEX "staff_invitations_one_pending_per_staff" ON "staff_invitations"("staff_id") WHERE "status" = 'PENDING';
CREATE UNIQUE INDEX "staff_invitations_one_pending_per_email" ON "staff_invitations"("salon_id", "email") WHERE "status" = 'PENDING';
CREATE INDEX "staff_invitations_salon_idx" ON "staff_invitations"("salon_id");

ALTER TABLE "staff_invitations" ADD CONSTRAINT "staff_invitations_salon_id_fkey"
  FOREIGN KEY ("salon_id") REFERENCES "salons"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "staff_invitations" ADD CONSTRAINT "staff_invitations_staff_fkey"
  FOREIGN KEY ("salon_id", "staff_id") REFERENCES "staff_profiles"("salon_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "staff_invitations" ADD CONSTRAINT "staff_invitations_created_by_fkey"
  FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "staff_invitations" ADD CONSTRAINT "staff_invitations_accepted_user_fkey"
  FOREIGN KEY ("accepted_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------------------------
-- 4) Weekly working hours (one row per weekday; minutes since midnight, 5-minute grid)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE "staff_working_hours" (
    "salon_id"      UUID NOT NULL,
    "staff_id"      UUID NOT NULL,
    "weekday"       SMALLINT NOT NULL,
    "is_off"        BOOLEAN NOT NULL DEFAULT false,
    "starts_minute" SMALLINT,
    "ends_minute"   SMALLINT,
    "updated_at"    TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "staff_working_hours_pkey" PRIMARY KEY ("staff_id", "weekday"),
    CONSTRAINT "staff_working_hours_weekday_range" CHECK ("weekday" BETWEEN 1 AND 7),
    CONSTRAINT "staff_working_hours_interval" CHECK (
      ("is_off" AND "starts_minute" IS NULL AND "ends_minute" IS NULL)
      OR (NOT "is_off"
          AND "starts_minute" BETWEEN 0 AND 1435 AND "starts_minute" % 5 = 0
          AND "ends_minute" BETWEEN 5 AND 1440 AND "ends_minute" % 5 = 0
          AND "ends_minute" > "starts_minute")
    )
);
CREATE INDEX "staff_working_hours_salon_idx" ON "staff_working_hours"("salon_id");
ALTER TABLE "staff_working_hours" ADD CONSTRAINT "staff_working_hours_staff_fkey"
  FOREIGN KEY ("salon_id", "staff_id") REFERENCES "staff_profiles"("salon_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------------------------
-- 5) Recurring weekly breaks (no overlap for the same staff member on the same weekday)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE "staff_breaks" (
    "id"            UUID NOT NULL DEFAULT gen_random_uuid(),
    "salon_id"      UUID NOT NULL,
    "staff_id"      UUID NOT NULL,
    "weekday"       SMALLINT NOT NULL,
    "starts_minute" SMALLINT NOT NULL,
    "ends_minute"   SMALLINT NOT NULL,
    "label"         VARCHAR(60) NOT NULL DEFAULT 'Break',
    "created_at"    TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "staff_breaks_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "staff_breaks_weekday_range" CHECK ("weekday" BETWEEN 1 AND 7),
    CONSTRAINT "staff_breaks_interval" CHECK (
      "starts_minute" BETWEEN 0 AND 1435 AND "starts_minute" % 5 = 0
      AND "ends_minute" BETWEEN 5 AND 1440 AND "ends_minute" % 5 = 0
      AND "ends_minute" > "starts_minute"
    ),
    CONSTRAINT "staff_breaks_label_len" CHECK (char_length(btrim("label")) >= 1)
);
CREATE INDEX "staff_breaks_staff_idx" ON "staff_breaks"("salon_id", "staff_id", "weekday");
ALTER TABLE "staff_breaks" ADD CONSTRAINT "staff_breaks_no_overlap" EXCLUDE USING gist (
  "staff_id" WITH =,
  "weekday" WITH =,
  int4range("starts_minute"::int, "ends_minute"::int) WITH &&
);
ALTER TABLE "staff_breaks" ADD CONSTRAINT "staff_breaks_staff_fkey"
  FOREIGN KEY ("salon_id", "staff_id") REFERENCES "staff_profiles"("salon_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------------------------
-- 6) Leave (dates, inclusive). A staff member's leave periods may not overlap while pending/approved.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE "staff_leaves" (
    "id"           UUID NOT NULL DEFAULT gen_random_uuid(),
    "salon_id"     UUID NOT NULL,
    "staff_id"     UUID NOT NULL,
    "starts_on"    DATE NOT NULL,
    "ends_on"      DATE NOT NULL,
    "status"       VARCHAR(10) NOT NULL DEFAULT 'APPROVED',
    "reason"       VARCHAR(200),
    "requested_by" UUID NOT NULL,
    "decided_by"   UUID,
    "decided_at"   TIMESTAMPTZ(6),
    "created_at"   TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at"   TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "staff_leaves_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "staff_leaves_status_known" CHECK ("status" IN ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED')),
    CONSTRAINT "staff_leaves_order" CHECK ("ends_on" >= "starts_on"),
    CONSTRAINT "staff_leaves_max_span" CHECK ("ends_on" - "starts_on" <= 89),
    CONSTRAINT "staff_leaves_reason_len" CHECK ("reason" IS NULL OR char_length(btrim("reason")) BETWEEN 1 AND 200)
);
CREATE INDEX "staff_leaves_staff_idx" ON "staff_leaves"("salon_id", "staff_id", "starts_on");
ALTER TABLE "staff_leaves" ADD CONSTRAINT "staff_leaves_no_overlap" EXCLUDE USING gist (
  "staff_id" WITH =,
  daterange("starts_on", "ends_on", '[]') WITH &&
) WHERE ("status" IN ('PENDING', 'APPROVED'));
ALTER TABLE "staff_leaves" ADD CONSTRAINT "staff_leaves_staff_fkey"
  FOREIGN KEY ("salon_id", "staff_id") REFERENCES "staff_profiles"("salon_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------------------------
-- 7) Row-Level Security
-- ---------------------------------------------------------------------------------------------
ALTER TABLE "staff_invitations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "staff_invitations" FORCE ROW LEVEL SECURITY;
CREATE POLICY "owner_all" ON "staff_invitations"
  USING      (("salon_id" = app_current_salon_id() AND app_owns_salon("salon_id")) OR app_is_platform_admin())
  WITH CHECK (("salon_id" = app_current_salon_id() AND app_owns_salon("salon_id")) OR app_is_platform_admin());
CREATE POLICY "invite_token_select" ON "staff_invitations" FOR SELECT
  USING ("token_hash" = app_invite_token_hash());
CREATE POLICY "invite_token_update" ON "staff_invitations" FOR UPDATE
  USING ("token_hash" = app_invite_token_hash())
  WITH CHECK ("token_hash" = app_invite_token_hash());

ALTER TABLE "staff_working_hours" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "staff_working_hours" FORCE ROW LEVEL SECURITY;
CREATE POLICY "owner_all" ON "staff_working_hours"
  USING      (("salon_id" = app_current_salon_id() AND app_owns_salon("salon_id")) OR app_is_platform_admin())
  WITH CHECK (("salon_id" = app_current_salon_id() AND app_owns_salon("salon_id")) OR app_is_platform_admin());
CREATE POLICY "own_read" ON "staff_working_hours" FOR SELECT
  USING ("salon_id" = app_current_salon_id() AND app_is_own_staff("staff_id"));

ALTER TABLE "staff_breaks" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "staff_breaks" FORCE ROW LEVEL SECURITY;
CREATE POLICY "owner_all" ON "staff_breaks"
  USING      (("salon_id" = app_current_salon_id() AND app_owns_salon("salon_id")) OR app_is_platform_admin())
  WITH CHECK (("salon_id" = app_current_salon_id() AND app_owns_salon("salon_id")) OR app_is_platform_admin());
CREATE POLICY "own_manage" ON "staff_breaks"
  USING      ("salon_id" = app_current_salon_id() AND app_has_own_staff_permission("staff_id", 'schedule.manage_own'))
  WITH CHECK ("salon_id" = app_current_salon_id() AND app_has_own_staff_permission("staff_id", 'schedule.manage_own'));

ALTER TABLE "staff_leaves" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "staff_leaves" FORCE ROW LEVEL SECURITY;
CREATE POLICY "owner_all" ON "staff_leaves"
  USING      (("salon_id" = app_current_salon_id() AND app_owns_salon("salon_id")) OR app_is_platform_admin())
  WITH CHECK (("salon_id" = app_current_salon_id() AND app_owns_salon("salon_id")) OR app_is_platform_admin());
CREATE POLICY "own_read" ON "staff_leaves" FOR SELECT
  USING ("salon_id" = app_current_salon_id() AND app_is_own_staff("staff_id"));
CREATE POLICY "own_request" ON "staff_leaves" FOR INSERT
  WITH CHECK ("salon_id" = app_current_salon_id()
              AND app_has_own_staff_permission("staff_id", 'schedule.manage_own')
              AND "status" = 'PENDING' AND "requested_by" = app_current_user_id());
CREATE POLICY "own_cancel" ON "staff_leaves" FOR UPDATE
  USING      ("salon_id" = app_current_salon_id() AND "status" = 'PENDING'
              AND app_has_own_staff_permission("staff_id", 'schedule.manage_own'))
  WITH CHECK ("salon_id" = app_current_salon_id() AND "status" = 'CANCELLED'
              AND app_has_own_staff_permission("staff_id", 'schedule.manage_own'));

-- ---------------------------------------------------------------------------------------------
-- 8) Grants. Leave and invitations are never hard-deleted by the runtime role. The Supabase Data API
--    stays shut for the new tables and functions.
-- ---------------------------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'salon_app') THEN
    REVOKE DELETE ON "staff_invitations", "staff_leaves" FROM salon_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON "staff_invitations", "staff_working_hours", "staff_breaks", "staff_leaves" FROM anon;
    REVOKE ALL ON FUNCTION app_invite_token_hash(), app_owns_salon(uuid), app_is_own_staff(uuid),
      app_has_own_staff_permission(uuid, text) FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON "staff_invitations", "staff_working_hours", "staff_breaks", "staff_leaves" FROM authenticated;
    REVOKE ALL ON FUNCTION app_invite_token_hash(), app_owns_salon(uuid), app_is_own_staff(uuid),
      app_has_own_staff_permission(uuid, text) FROM authenticated;
  END IF;
END
$$;
