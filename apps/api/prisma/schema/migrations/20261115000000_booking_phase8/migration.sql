-- Phase 8: appointment booking engine.
-- Additive only: no earlier migration is edited. Hand-written SQL is the source of truth for CHECK constraints, the
-- double-booking EXCLUSION constraint, the status state machine, RLS policies and grants (Prisma cannot express them).
--
-- What this migration guarantees IN THE DATABASE (not only in the API):
--   * a staff member can never have two active appointments whose [start, end + buffer) ranges overlap
--     (EXCLUDE USING gist on staff_id + tstzrange; needs btree_gist, enabled in Phase 5);
--   * price / duration / names are SNAPSHOTS: they cannot be changed after the booking exists, and the totals must equal
--     the sum of the appointment lines (deferred constraint trigger);
--   * status changes follow one state machine; a cancelled / completed / no-show appointment is frozen;
--   * only the CUSTOMER can move an appointment to another time (consent), the salon can only cancel it;
--   * status history and appointment lines are append-only for the runtime role.
--
-- Access model (summary, enforced here AND in the API):
--   * Customer: own appointments only (customer_user_id = app.user_id). Creates, cancels and reschedules them.
--   * Salon owner: every appointment of their own salon (salon context + app_owns_salon). Can cancel, never move.
--   * Staff member: SELECT of their OWN appointments only.
--   * Platform admin: SELECT only.
--   * Public context (TenantDb.withPublicRead / withCustomer): may read the time span of ACTIVE appointments of APPROVED
--     salons so availability can be computed. The API selects staff_id, starts_at and blocked_until only.

-- ---------------------------------------------------------------------------------------------
-- 1) Types
-- ---------------------------------------------------------------------------------------------
CREATE TYPE "appointment_status" AS ENUM ('PENDING', 'CONFIRMED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'NO_SHOW', 'DELAYED');

-- ---------------------------------------------------------------------------------------------
-- 2) Per-salon booking policy (one optional row per salon; no row = platform defaults in the API)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE "salon_booking_policies" (
    "salon_id"                  UUID NOT NULL,
    "buffer_minutes"            SMALLINT NOT NULL DEFAULT 0,
    "min_notice_minutes"        INTEGER NOT NULL DEFAULT 30,
    "advance_days"              SMALLINT NOT NULL DEFAULT 14,
    "cancel_cutoff_minutes"     INTEGER NOT NULL DEFAULT 120,
    "reschedule_cutoff_minutes" INTEGER NOT NULL DEFAULT 120,
    "max_reschedules"           SMALLINT NOT NULL DEFAULT 2,
    "updated_by"                UUID,
    "updated_at"                TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "salon_booking_policies_pkey" PRIMARY KEY ("salon_id"),
    CONSTRAINT "salon_booking_policies_buffer" CHECK ("buffer_minutes" BETWEEN 0 AND 60 AND "buffer_minutes" % 5 = 0),
    CONSTRAINT "salon_booking_policies_notice" CHECK ("min_notice_minutes" BETWEEN 0 AND 1440),
    CONSTRAINT "salon_booking_policies_advance" CHECK ("advance_days" BETWEEN 1 AND 60),
    CONSTRAINT "salon_booking_policies_cancel_cutoff" CHECK ("cancel_cutoff_minutes" BETWEEN 0 AND 10080),
    CONSTRAINT "salon_booking_policies_reschedule_cutoff" CHECK ("reschedule_cutoff_minutes" BETWEEN 0 AND 10080),
    CONSTRAINT "salon_booking_policies_max_reschedules" CHECK ("max_reschedules" BETWEEN 0 AND 5)
);
ALTER TABLE "salon_booking_policies" ADD CONSTRAINT "salon_booking_policies_salon_id_fkey"
  FOREIGN KEY ("salon_id") REFERENCES "salons"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "salon_booking_policies" ADD CONSTRAINT "salon_booking_policies_updated_by_fkey"
  FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------------------------
-- 3) Appointments
--    starts_at .. ends_at   = the service itself (what the customer sees and pays for)
--    ends_at .. blocked_until = the salon's buffer (cleaning / preparation), part of the staff member's busy time
--    total_price / total_duration_minutes / staff_name / salon_name are snapshots taken at booking time.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE "appointments" (
    "id"                      UUID NOT NULL DEFAULT gen_random_uuid(),
    "salon_id"                UUID NOT NULL,
    "customer_user_id"        UUID NOT NULL,
    "staff_id"                UUID NOT NULL,
    "status"                  "appointment_status" NOT NULL DEFAULT 'CONFIRMED',
    "source"                  VARCHAR(10) NOT NULL DEFAULT 'ONLINE',
    "starts_at"               TIMESTAMPTZ(6) NOT NULL,
    "ends_at"                 TIMESTAMPTZ(6) NOT NULL,
    "buffer_minutes"          SMALLINT NOT NULL DEFAULT 0,
    "blocked_until"           TIMESTAMPTZ(6) NOT NULL,
    "total_duration_minutes"  INTEGER NOT NULL,
    "total_price"             NUMERIC(12,2) NOT NULL,
    "salon_name"              VARCHAR(120) NOT NULL,
    "staff_name"              VARCHAR(80) NOT NULL,
    "customer_note"           VARCHAR(300),
    "reschedule_count"        SMALLINT NOT NULL DEFAULT 0,
    "cancelled_at"            TIMESTAMPTZ(6),
    "cancelled_by"            UUID,
    "cancelled_by_role"       VARCHAR(10),
    "cancellation_reason"     VARCHAR(300),
    "idempotency_key"         VARCHAR(64),
    "request_fingerprint"     CHAR(64),
    "created_at"              TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at"              TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "appointments_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "appointments_source_known" CHECK ("source" IN ('ONLINE')),
    CONSTRAINT "appointments_time_order" CHECK ("ends_at" > "starts_at" AND "blocked_until" >= "ends_at"),
    CONSTRAINT "appointments_duration_matches" CHECK (
      "total_duration_minutes" BETWEEN 5 AND 1440
      AND (extract(epoch FROM ("ends_at" - "starts_at")) / 60)::int = "total_duration_minutes"
    ),
    CONSTRAINT "appointments_buffer_matches" CHECK (
      "buffer_minutes" BETWEEN 0 AND 60
      AND (extract(epoch FROM ("blocked_until" - "ends_at")) / 60)::int = "buffer_minutes"
    ),
    CONSTRAINT "appointments_price_range" CHECK ("total_price" BETWEEN 0 AND 10000000),
    CONSTRAINT "appointments_reschedule_range" CHECK ("reschedule_count" BETWEEN 0 AND 20),
    CONSTRAINT "appointments_note_len" CHECK ("customer_note" IS NULL OR char_length(btrim("customer_note")) BETWEEN 1 AND 300),
    CONSTRAINT "appointments_cancel_consistent" CHECK (
      ("status" = 'CANCELLED') = ("cancelled_at" IS NOT NULL AND "cancelled_by" IS NOT NULL AND "cancelled_by_role" IS NOT NULL)
    ),
    CONSTRAINT "appointments_cancel_role_known" CHECK ("cancelled_by_role" IS NULL OR "cancelled_by_role" IN ('CUSTOMER', 'SALON')),
    CONSTRAINT "appointments_cancel_reason_len" CHECK ("cancellation_reason" IS NULL OR char_length(btrim("cancellation_reason")) BETWEEN 1 AND 300),
    CONSTRAINT "appointments_idempotency_pair" CHECK (("idempotency_key" IS NULL) = ("request_fingerprint" IS NULL))
);

CREATE UNIQUE INDEX "appointments_salon_id_id_key" ON "appointments"("salon_id", "id");
CREATE UNIQUE INDEX "appointments_idempotency_key" ON "appointments"("customer_user_id", "idempotency_key") WHERE "idempotency_key" IS NOT NULL;
CREATE INDEX "appointments_salon_day_idx" ON "appointments"("salon_id", "starts_at");
CREATE INDEX "appointments_customer_idx" ON "appointments"("customer_user_id", "starts_at" DESC);

ALTER TABLE "appointments" ADD CONSTRAINT "appointments_salon_id_fkey"
  FOREIGN KEY ("salon_id") REFERENCES "salons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_customer_fkey"
  FOREIGN KEY ("customer_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_staff_fkey"
  FOREIGN KEY ("salon_id", "staff_id") REFERENCES "staff_profiles"("salon_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_cancelled_by_fkey"
  FOREIGN KEY ("cancelled_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- THE double-booking guard. The booking transaction also validates availability in the API, but this constraint is the
-- only authority: two customers racing for the same staff member and time can never both succeed (SQLSTATE 23P01).
-- Only ACTIVE appointments occupy a staff member; cancelled / completed / no-show ones free the time.
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_no_double_booking" EXCLUDE USING gist (
  "staff_id" WITH =,
  tstzrange("starts_at", "blocked_until", '[)') WITH &&
) WHERE ("status" IN ('PENDING', 'CONFIRMED', 'IN_PROGRESS', 'DELAYED'));

-- ---------------------------------------------------------------------------------------------
-- 4) Appointment lines (one row per booked service; price and duration are snapshots)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE "appointment_services" (
    "id"               UUID NOT NULL DEFAULT gen_random_uuid(),
    "salon_id"         UUID NOT NULL,
    "appointment_id"   UUID NOT NULL,
    "service_id"       UUID NOT NULL,
    "position"         SMALLINT NOT NULL,
    "service_name"     VARCHAR(100) NOT NULL,
    "duration_minutes" INTEGER NOT NULL,
    "price"            NUMERIC(10,2) NOT NULL,
    "created_at"       TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "appointment_services_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "appointment_services_position" CHECK ("position" BETWEEN 1 AND 10),
    CONSTRAINT "appointment_services_duration" CHECK ("duration_minutes" BETWEEN 5 AND 480),
    CONSTRAINT "appointment_services_price" CHECK ("price" BETWEEN 0 AND 1000000)
);
CREATE UNIQUE INDEX "appointment_services_unique_service" ON "appointment_services"("appointment_id", "service_id");
CREATE UNIQUE INDEX "appointment_services_unique_position" ON "appointment_services"("appointment_id", "position");
CREATE INDEX "appointment_services_salon_idx" ON "appointment_services"("salon_id", "appointment_id");
ALTER TABLE "appointment_services" ADD CONSTRAINT "appointment_services_appointment_fkey"
  FOREIGN KEY ("salon_id", "appointment_id") REFERENCES "appointments"("salon_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- Services are soft-deleted, so the row (and the name snapshot's source) always exists; NO ACTION keeps history intact.
ALTER TABLE "appointment_services" ADD CONSTRAINT "appointment_services_service_fkey"
  FOREIGN KEY ("salon_id", "service_id") REFERENCES "services"("salon_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------------------------
-- 5) Status history (append-only)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE "appointment_status_history" (
    "id"             UUID NOT NULL DEFAULT gen_random_uuid(),
    "salon_id"       UUID NOT NULL,
    "appointment_id" UUID NOT NULL,
    "event"          VARCHAR(16) NOT NULL,
    "from_status"    "appointment_status",
    "to_status"      "appointment_status" NOT NULL,
    "actor_user_id"  UUID NOT NULL,
    "actor_role"     VARCHAR(14) NOT NULL,
    "reason"         VARCHAR(300),
    "old_starts_at"  TIMESTAMPTZ(6),
    "new_starts_at"  TIMESTAMPTZ(6),
    "created_at"     TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "appointment_status_history_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "appointment_status_history_event_known" CHECK ("event" IN ('CREATED', 'RESCHEDULED', 'CANCELLED', 'STATUS_CHANGED')),
    CONSTRAINT "appointment_status_history_reason_len" CHECK ("reason" IS NULL OR char_length(btrim("reason")) BETWEEN 1 AND 300)
);
CREATE INDEX "appointment_status_history_appt_idx" ON "appointment_status_history"("appointment_id", "created_at");
ALTER TABLE "appointment_status_history" ADD CONSTRAINT "appointment_status_history_appointment_fkey"
  FOREIGN KEY ("salon_id", "appointment_id") REFERENCES "appointments"("salon_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "appointment_status_history" ADD CONSTRAINT "appointment_status_history_actor_fkey"
  FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------------------------
-- 6) Guard triggers
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION appointments_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  uid uuid := app_current_user_id();
  allowed boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status IN ('PENDING', 'CONFIRMED') AND NEW.starts_at <= now() THEN
      RAISE EXCEPTION 'an appointment cannot start in the past' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE ---------------------------------------------------------------------------------
  IF OLD.status IN ('COMPLETED', 'CANCELLED', 'NO_SHOW') THEN
    RAISE EXCEPTION 'a % appointment can no longer be changed', OLD.status USING ERRCODE = 'check_violation';
  END IF;

  -- Snapshots and identity never change.
  IF NEW.id <> OLD.id OR NEW.salon_id <> OLD.salon_id OR NEW.customer_user_id <> OLD.customer_user_id
     OR NEW.staff_id <> OLD.staff_id OR NEW.source <> OLD.source OR NEW.buffer_minutes <> OLD.buffer_minutes
     OR NEW.total_duration_minutes <> OLD.total_duration_minutes OR NEW.total_price <> OLD.total_price
     OR NEW.salon_name <> OLD.salon_name OR NEW.staff_name <> OLD.staff_name
     OR NEW.customer_note IS DISTINCT FROM OLD.customer_note
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.request_fingerprint IS DISTINCT FROM OLD.request_fingerprint
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'booking snapshot fields cannot be changed' USING ERRCODE = 'check_violation';
  END IF;

  -- Moving the appointment: only the customer (consent), only while it is still open, counted once per move.
  IF NEW.starts_at <> OLD.starts_at OR NEW.ends_at <> OLD.ends_at OR NEW.blocked_until <> OLD.blocked_until THEN
    IF uid IS NULL OR uid <> OLD.customer_user_id THEN
      RAISE EXCEPTION 'only the customer can move an appointment to another time' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF OLD.status NOT IN ('PENDING', 'CONFIRMED') OR NEW.status <> OLD.status THEN
      RAISE EXCEPTION 'only an open appointment can be rescheduled' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.reschedule_count <> OLD.reschedule_count + 1 THEN
      RAISE EXCEPTION 'reschedule_count must increase by exactly one' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.starts_at <= now() THEN
      RAISE EXCEPTION 'an appointment cannot be moved to the past' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.reschedule_count <> OLD.reschedule_count THEN
    RAISE EXCEPTION 'reschedule_count only changes together with the time' USING ERRCODE = 'check_violation';
  END IF;

  -- Status state machine.
  IF NEW.status <> OLD.status THEN
    allowed := CASE OLD.status
      WHEN 'PENDING'     THEN NEW.status IN ('CONFIRMED', 'CANCELLED')
      WHEN 'CONFIRMED'   THEN NEW.status IN ('IN_PROGRESS', 'CANCELLED', 'NO_SHOW', 'DELAYED')
      WHEN 'DELAYED'     THEN NEW.status IN ('IN_PROGRESS', 'CANCELLED', 'NO_SHOW')
      WHEN 'IN_PROGRESS' THEN NEW.status IN ('COMPLETED')
      ELSE false
    END;
    IF NOT allowed THEN
      RAISE EXCEPTION 'illegal appointment status change % -> %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.status = 'CANCELLED' AND uid IS NOT NULL AND NEW.cancelled_by IS DISTINCT FROM uid THEN
      RAISE EXCEPTION 'cancelled_by must be the acting user' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.cancelled_at IS DISTINCT FROM OLD.cancelled_at OR NEW.cancelled_by IS DISTINCT FROM OLD.cancelled_by
        OR NEW.cancelled_by_role IS DISTINCT FROM OLD.cancelled_by_role
        OR NEW.cancellation_reason IS DISTINCT FROM OLD.cancellation_reason THEN
    RAISE EXCEPTION 'cancellation fields only change together with the status' USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;
CREATE TRIGGER "appointments_guard_trg" BEFORE INSERT OR UPDATE ON "appointments"
  FOR EACH ROW EXECUTE FUNCTION appointments_guard();

-- Lines can only be added in the SAME transaction that created the appointment (created_at = now() = transaction start),
-- and never changed afterwards: the price the customer saw is the price on record.
CREATE OR REPLACE FUNCTION appointment_services_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'appointment lines are immutable (% blocked)', TG_OP USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM appointments a WHERE a.id = NEW.appointment_id AND a.salon_id = NEW.salon_id AND a.created_at = now()) THEN
    RAISE EXCEPTION 'appointment lines can only be added while the appointment is being created' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "appointment_services_guard_trg" BEFORE INSERT OR UPDATE OR DELETE ON "appointment_services"
  FOR EACH ROW EXECUTE FUNCTION appointment_services_guard();

-- The totals on the appointment must equal its lines (checked at COMMIT, after all lines were inserted).
CREATE OR REPLACE FUNCTION appointments_check_totals() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  n integer;
  sum_price numeric;
  sum_minutes integer;
BEGIN
  SELECT count(*), COALESCE(sum(l.price), 0), COALESCE(sum(l.duration_minutes), 0)
    INTO n, sum_price, sum_minutes
  FROM appointment_services l WHERE l.appointment_id = NEW.id AND l.salon_id = NEW.salon_id;
  IF n < 1 OR sum_price <> NEW.total_price OR sum_minutes <> NEW.total_duration_minutes THEN
    RAISE EXCEPTION 'appointment totals must equal the sum of its services' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER "appointments_totals_match" AFTER INSERT ON "appointments"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION appointments_check_totals();

CREATE OR REPLACE FUNCTION appointment_history_block_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'appointment_status_history is append-only (% blocked)', TG_OP USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER "appointment_status_history_no_update_delete" BEFORE UPDATE OR DELETE ON "appointment_status_history"
  FOR EACH ROW EXECUTE FUNCTION appointment_history_block_mutation();

-- ---------------------------------------------------------------------------------------------
-- 7) Row-Level Security
-- ---------------------------------------------------------------------------------------------
ALTER TABLE "salon_booking_policies" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "salon_booking_policies" FORCE ROW LEVEL SECURITY;
CREATE POLICY "owner_all" ON "salon_booking_policies"
  USING      (("salon_id" = app_current_salon_id() AND app_owns_salon("salon_id")) OR app_is_platform_admin())
  WITH CHECK (("salon_id" = app_current_salon_id() AND app_owns_salon("salon_id")) OR app_is_platform_admin());
-- Customers see the cancellation / notice rules before they book.
CREATE POLICY "public_read_approved" ON "salon_booking_policies" FOR SELECT
  USING (app_public_read() AND EXISTS (SELECT 1 FROM "salons" s WHERE s."id" = "salon_booking_policies"."salon_id" AND s."status" = 'APPROVED'));

ALTER TABLE "appointments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "appointments" FORCE ROW LEVEL SECURITY;
CREATE POLICY "owner_all" ON "appointments"
  USING      ("salon_id" = app_current_salon_id() AND app_owns_salon("salon_id"))
  WITH CHECK ("salon_id" = app_current_salon_id() AND app_owns_salon("salon_id"));
CREATE POLICY "staff_own_read" ON "appointments" FOR SELECT
  USING ("salon_id" = app_current_salon_id() AND app_is_own_staff("staff_id"));
CREATE POLICY "admin_read" ON "appointments" FOR SELECT
  USING (app_is_platform_admin());
CREATE POLICY "customer_own_read" ON "appointments" FOR SELECT
  USING ("customer_user_id" = app_current_user_id());
CREATE POLICY "customer_own_insert" ON "appointments" FOR INSERT
  WITH CHECK (
    "customer_user_id" = app_current_user_id()
    AND "status" = 'CONFIRMED' AND "source" = 'ONLINE' AND "reschedule_count" = 0 AND "cancelled_at" IS NULL
    AND EXISTS (SELECT 1 FROM "users" u WHERE u."id" = "customer_user_id" AND u."role" = 'CUSTOMER' AND u."status" = 'ACTIVE')
    AND EXISTS (SELECT 1 FROM "salons" s WHERE s."id" = "salon_id" AND s."status" = 'APPROVED')
  );
-- A customer may cancel or move their own open appointment; the guard trigger allows nothing else.
CREATE POLICY "customer_own_update" ON "appointments" FOR UPDATE
  USING      ("customer_user_id" = app_current_user_id() AND "status" = 'CONFIRMED')
  WITH CHECK ("customer_user_id" = app_current_user_id() AND "status" IN ('CONFIRMED', 'CANCELLED'));
-- Availability: the time span of ACTIVE appointments of APPROVED salons (the API selects times only).
CREATE POLICY "public_busy_read" ON "appointments" FOR SELECT
  USING (app_public_read() AND "status" IN ('PENDING', 'CONFIRMED', 'IN_PROGRESS', 'DELAYED')
         AND EXISTS (SELECT 1 FROM "salons" s WHERE s."id" = "appointments"."salon_id" AND s."status" = 'APPROVED'));

ALTER TABLE "appointment_services" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "appointment_services" FORCE ROW LEVEL SECURITY;
-- Lines are NEVER readable through the public availability policy: every policy below names its audience explicitly
-- (the sub-selects also run under the appointment policies, but the explicit conditions do not depend on them).
CREATE POLICY "owner_all" ON "appointment_services"
  USING      ("salon_id" = app_current_salon_id() AND app_owns_salon("salon_id"))
  WITH CHECK ("salon_id" = app_current_salon_id() AND app_owns_salon("salon_id"));
CREATE POLICY "staff_own_read" ON "appointment_services" FOR SELECT
  USING ("salon_id" = app_current_salon_id()
         AND EXISTS (SELECT 1 FROM "appointments" a WHERE a."id" = "appointment_services"."appointment_id"
                     AND a."salon_id" = "appointment_services"."salon_id" AND app_is_own_staff(a."staff_id")));
CREATE POLICY "admin_read" ON "appointment_services" FOR SELECT
  USING (app_is_platform_admin());
CREATE POLICY "customer_own_read" ON "appointment_services" FOR SELECT
  USING (EXISTS (SELECT 1 FROM "appointments" a WHERE a."id" = "appointment_services"."appointment_id"
                 AND a."customer_user_id" = app_current_user_id()));
CREATE POLICY "customer_own_insert" ON "appointment_services" FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM "appointments" a WHERE a."id" = "appointment_services"."appointment_id"
                      AND a."salon_id" = "appointment_services"."salon_id" AND a."customer_user_id" = app_current_user_id()));

ALTER TABLE "appointment_status_history" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "appointment_status_history" FORCE ROW LEVEL SECURITY;
CREATE POLICY "owner_read" ON "appointment_status_history" FOR SELECT
  USING ("salon_id" = app_current_salon_id() AND app_owns_salon("salon_id"));
CREATE POLICY "owner_insert" ON "appointment_status_history" FOR INSERT
  WITH CHECK ("salon_id" = app_current_salon_id() AND app_owns_salon("salon_id") AND "actor_user_id" = app_current_user_id());
CREATE POLICY "staff_own_read" ON "appointment_status_history" FOR SELECT
  USING ("salon_id" = app_current_salon_id()
         AND EXISTS (SELECT 1 FROM "appointments" a WHERE a."id" = "appointment_status_history"."appointment_id"
                     AND a."salon_id" = "appointment_status_history"."salon_id" AND app_is_own_staff(a."staff_id")));
CREATE POLICY "admin_read" ON "appointment_status_history" FOR SELECT
  USING (app_is_platform_admin());
CREATE POLICY "customer_own_read" ON "appointment_status_history" FOR SELECT
  USING (EXISTS (SELECT 1 FROM "appointments" a WHERE a."id" = "appointment_status_history"."appointment_id"
                 AND a."customer_user_id" = app_current_user_id()));
CREATE POLICY "customer_own_insert" ON "appointment_status_history" FOR INSERT
  WITH CHECK ("actor_user_id" = app_current_user_id()
              AND EXISTS (SELECT 1 FROM "appointments" a WHERE a."id" = "appointment_status_history"."appointment_id"
                          AND a."salon_id" = "appointment_status_history"."salon_id" AND a."customer_user_id" = app_current_user_id()));

-- ---------------------------------------------------------------------------------------------
-- 8) Grants. Appointments, lines and history are never hard-deleted by the runtime role; lines and history are never
--    updated. The Supabase Data API stays shut for the new tables and functions.
-- ---------------------------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'salon_app') THEN
    REVOKE DELETE ON "appointments", "appointment_services", "appointment_status_history" FROM salon_app;
    REVOKE UPDATE ON "appointment_services", "appointment_status_history" FROM salon_app;
    REVOKE ALL ON FUNCTION appointments_guard(), appointment_services_guard(), appointments_check_totals(), appointment_history_block_mutation() FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION appointments_guard(), appointment_services_guard(), appointments_check_totals(), appointment_history_block_mutation() TO salon_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON "salon_booking_policies", "appointments", "appointment_services", "appointment_status_history" FROM anon;
    REVOKE ALL ON FUNCTION appointments_guard(), appointment_services_guard(), appointments_check_totals(), appointment_history_block_mutation() FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON "salon_booking_policies", "appointments", "appointment_services", "appointment_status_history" FROM authenticated;
    REVOKE ALL ON FUNCTION appointments_guard(), appointment_services_guard(), appointments_check_totals(), appointment_history_block_mutation() FROM authenticated;
  END IF;
END
$$;
