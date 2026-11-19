-- Phase 12: offline-first sync (operation ledger, internal appointment notes, change tracking).
-- Additive: no earlier migration is edited. Hand-written SQL is the source of truth for CHECK constraints, triggers, RLS policies
-- and grants (Prisma cannot express them).
--
-- What this migration guarantees IN THE DATABASE (not only in the API):
--   * every offline operation is applied AT MOST ONCE: sync_operations has a unique (salon_id, user_id, operation_id) and the API writes
--     the ledger row in the SAME transaction as the change, so a retry can never duplicate or half-apply it;
--   * the ledger and the notes are append-only for the runtime role (trigger + revoked UPDATE / DELETE);
--   * both tables are salon-owned: RLS + FORCE, the owner sees the whole salon, staff only their own operations / their own
--     appointments; customers can never read a note;
--   * appointments.updated_at is now maintained by the database clock (the delta pull of the apps relies on it);
--   * a walk-in written down offline may be synced up to 48 hours later, but ONLY inside a transaction that sets the
--     transaction-local flag `app.offline_sync` (set by the sync service). Everything else keeps the 10-minute rule of Phase 9.

-- ---------------------------------------------------------------------------------------------
-- 1) Operation ledger
-- ---------------------------------------------------------------------------------------------
CREATE TABLE "sync_operations" (
    "id"                    UUID NOT NULL DEFAULT gen_random_uuid(),
    "salon_id"              UUID NOT NULL,
    "user_id"               UUID NOT NULL,
    "device_id"             UUID NOT NULL,
    "operation_id"          UUID NOT NULL,
    "kind"                  VARCHAR(16) NOT NULL,
    "target_appointment_id" UUID,
    "ref_operation_id"      UUID,
    "fingerprint"           CHAR(64) NOT NULL,
    "client_created_at"     TIMESTAMPTZ(6) NOT NULL,
    "effective_at"          TIMESTAMPTZ(6) NOT NULL,
    "received_at"           TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "status"                VARCHAR(8) NOT NULL,
    "result_code"           VARCHAR(40),
    "result_message"        VARCHAR(300),
    "appointment_id"        UUID,

    CONSTRAINT "sync_operations_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "sync_operations_kind_known" CHECK ("kind" IN ('APPT_START', 'APPT_COMPLETE', 'APPT_NO_SHOW', 'WALK_IN_CREATE', 'NOTE_ADD')),
    CONSTRAINT "sync_operations_status_known" CHECK ("status" IN ('APPLIED', 'REJECTED')),
    CONSTRAINT "sync_operations_outcome_consistent" CHECK (
      ("status" = 'APPLIED' AND "result_code" IS NULL AND "appointment_id" IS NOT NULL)
      OR ("status" = 'REJECTED' AND "result_code" IS NOT NULL)
    ),
    CONSTRAINT "sync_operations_target_consistent" CHECK ("target_appointment_id" IS NULL OR "ref_operation_id" IS NULL)
);
CREATE UNIQUE INDEX "sync_operations_once" ON "sync_operations"("salon_id", "user_id", "operation_id");
CREATE INDEX "sync_operations_salon_received_idx" ON "sync_operations"("salon_id", "received_at");
ALTER TABLE "sync_operations" ADD CONSTRAINT "sync_operations_user_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sync_operations" ADD CONSTRAINT "sync_operations_appointment_fkey"
  FOREIGN KEY ("salon_id", "appointment_id") REFERENCES "appointments"("salon_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------------------------
-- 2) Internal appointment notes (salon side only; never visible to customers)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE "appointment_notes" (
    "id"             UUID NOT NULL DEFAULT gen_random_uuid(),
    "salon_id"       UUID NOT NULL,
    "appointment_id" UUID NOT NULL,
    "author_user_id" UUID NOT NULL,
    "body"           VARCHAR(500) NOT NULL,
    "created_at"     TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "appointment_notes_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "appointment_notes_body_len" CHECK (char_length(btrim("body")) BETWEEN 1 AND 500)
);
CREATE INDEX "appointment_notes_appt_idx" ON "appointment_notes"("appointment_id", "created_at");
CREATE INDEX "appointment_notes_salon_created_idx" ON "appointment_notes"("salon_id", "created_at");
ALTER TABLE "appointment_notes" ADD CONSTRAINT "appointment_notes_appointment_fkey"
  FOREIGN KEY ("salon_id", "appointment_id") REFERENCES "appointments"("salon_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "appointment_notes" ADD CONSTRAINT "appointment_notes_author_fkey"
  FOREIGN KEY ("author_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Both tables are append-only for everybody who is not the table owner.
CREATE OR REPLACE FUNCTION sync_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only (% blocked)', TG_TABLE_NAME, TG_OP USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER "sync_operations_no_update_delete" BEFORE UPDATE OR DELETE ON "sync_operations"
  FOR EACH ROW EXECUTE FUNCTION sync_append_only();
CREATE TRIGGER "appointment_notes_no_update_delete" BEFORE UPDATE OR DELETE ON "appointment_notes"
  FOR EACH ROW EXECUTE FUNCTION sync_append_only();

-- ---------------------------------------------------------------------------------------------
-- 3) Change tracking: appointments.updated_at comes from the DATABASE clock on every write.
--    (Earlier code wrote the application clock; the delta pull needs one trustworthy clock.)
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION appointments_touch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;
-- Fires after appointments_guard_trg (same timing, alphabetical order), so the guard still sees the caller's own columns.
CREATE TRIGGER "appointments_touch_trg" BEFORE INSERT OR UPDATE ON "appointments"
  FOR EACH ROW EXECUTE FUNCTION appointments_touch();
CREATE INDEX "appointments_salon_updated_idx" ON "appointments"("salon_id", "updated_at");

-- ---------------------------------------------------------------------------------------------
-- 4) Appointment guard, revised (CREATE OR REPLACE keeps the trigger and the grants). ONE change compared with Phase 9: the
--    walk-in INSERT rule honours the transaction-local flag `app.offline_sync` (48 hours back instead of 10 minutes).
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION appointments_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  uid uuid := app_current_user_id();
  is_customer boolean;
  moved boolean;
  early_ok boolean := false;
  allowed boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.source = 'ONLINE' AND NEW.status IN ('PENDING', 'CONFIRMED') AND NEW.starts_at <= now() THEN
      RAISE EXCEPTION 'an appointment cannot start in the past' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.source = 'WALK_IN' THEN
      -- A walk-in is created for "now or the next free time": CONFIRMED, never in the far past (10 minutes of clock slack).
      -- Phase 12: a walk-in written down OFFLINE is synced later. Only the sync service sets the transaction-local flag
      -- `app.offline_sync`; then the walk-in may start up to 48 hours back (the moment the person really walked in).
      IF NEW.status <> 'CONFIRMED'
         OR NEW.starts_at < now() - (CASE WHEN current_setting('app.offline_sync', true) = 'on' THEN interval '48 hours' ELSE interval '10 minutes' END) THEN
        RAISE EXCEPTION 'a walk-in must be a CONFIRMED appointment starting now or later' USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE ---------------------------------------------------------------------------------
  IF OLD.status IN ('COMPLETED', 'CANCELLED', 'NO_SHOW') THEN
    RAISE EXCEPTION 'a % appointment can no longer be changed', OLD.status USING ERRCODE = 'check_violation';
  END IF;
  is_customer := OLD.customer_user_id IS NOT NULL AND uid IS NOT NULL AND uid = OLD.customer_user_id;

  -- Identity and snapshots never change.
  IF NEW.id <> OLD.id OR NEW.salon_id <> OLD.salon_id OR NEW.customer_user_id IS DISTINCT FROM OLD.customer_user_id
     OR NEW.walk_in_name IS DISTINCT FROM OLD.walk_in_name OR NEW.walk_in_phone IS DISTINCT FROM OLD.walk_in_phone
     OR NEW.staff_id <> OLD.staff_id OR NEW.source <> OLD.source OR NEW.buffer_minutes <> OLD.buffer_minutes
     OR NEW.total_duration_minutes <> OLD.total_duration_minutes OR NEW.total_price <> OLD.total_price
     OR NEW.salon_name <> OLD.salon_name OR NEW.staff_name <> OLD.staff_name
     OR NEW.customer_note IS DISTINCT FROM OLD.customer_note
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.request_fingerprint IS DISTINCT FROM OLD.request_fingerprint
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'booking snapshot fields cannot be changed' USING ERRCODE = 'check_violation';
  END IF;

  -- Moving the appointment: only the customer (consent), only while it is still open.
  moved := NEW.starts_at <> OLD.starts_at OR NEW.ends_at <> OLD.ends_at OR NEW.blocked_until <> OLD.blocked_until;
  IF moved THEN
    IF NOT is_customer THEN
      RAISE EXCEPTION 'only the customer can move an appointment to another time' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF OLD.status NOT IN ('PENDING', 'CONFIRMED') OR NEW.status <> OLD.status THEN
      RAISE EXCEPTION 'only an open appointment can be rescheduled' USING ERRCODE = 'check_violation';
    END IF;
    -- Accepting an early offer: an ACCEPTED offer for exactly this start, answered in THIS transaction, and earlier than before.
    early_ok := NEW.starts_at < OLD.starts_at AND EXISTS (
      SELECT 1 FROM appointment_early_offers o
      WHERE o.appointment_id = OLD.id AND o.salon_id = OLD.salon_id AND o.status = 'ACCEPTED'
        AND o.responded_at = now() AND o.offered_start = NEW.starts_at
    );
    IF early_ok THEN
      IF NEW.reschedule_count <> OLD.reschedule_count THEN
        RAISE EXCEPTION 'accepting an early offer does not count as a reschedule' USING ERRCODE = 'check_violation';
      END IF;
    ELSE
      IF NEW.reschedule_count <> OLD.reschedule_count + 1 THEN
        RAISE EXCEPTION 'reschedule_count must increase by exactly one' USING ERRCODE = 'check_violation';
      END IF;
      IF NEW.starts_at <= now() THEN
        RAISE EXCEPTION 'an appointment cannot be moved to the past' USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  ELSIF NEW.reschedule_count <> OLD.reschedule_count THEN
    RAISE EXCEPTION 'reschedule_count only changes together with the time' USING ERRCODE = 'check_violation';
  END IF;

  -- Who may write which columns. The customer owns the arrival columns; the salon owns progress and the estimate.
  IF is_customer THEN
    IF NEW.started_at IS DISTINCT FROM OLD.started_at OR NEW.completed_at IS DISTINCT FROM OLD.completed_at
       OR NEW.no_show_at IS DISTINCT FROM OLD.no_show_at OR NEW.estimated_starts_at IS DISTINCT FROM OLD.estimated_starts_at
       OR NEW.eta_updated_at IS DISTINCT FROM OLD.eta_updated_at THEN
      RAISE EXCEPTION 'a customer cannot change the progress or the estimate of an appointment' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW.status <> OLD.status AND NEW.status <> 'CANCELLED' THEN
      RAISE EXCEPTION 'a customer can only cancel an appointment' USING ERRCODE = 'insufficient_privilege';
    END IF;
  ELSE
    IF NEW.arrival_state IS DISTINCT FROM OLD.arrival_state OR NEW.customer_eta_at IS DISTINCT FROM OLD.customer_eta_at
       OR NEW.arrival_updated_at IS DISTINCT FROM OLD.arrival_updated_at OR NEW.arrival_updates IS DISTINCT FROM OLD.arrival_updates THEN
      RAISE EXCEPTION 'only the customer reports their arrival' USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;

  -- Status state machine (unchanged from Phase 8).
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

  -- A moved appointment starts a new life: the old estimate and the old arrival report no longer apply.
  IF moved THEN
    NEW.estimated_starts_at := NULL;
    NEW.eta_updated_at := NULL;
    NEW.arrival_state := 'NONE';
    NEW.customer_eta_at := NULL;
    NEW.arrival_updated_at := NULL;
    NEW.arrival_updates := 0;
  END IF;

  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------------------------
-- 5) Row-Level Security
-- ---------------------------------------------------------------------------------------------
ALTER TABLE "sync_operations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sync_operations" FORCE ROW LEVEL SECURITY;
CREATE POLICY "owner_read" ON "sync_operations" FOR SELECT
  USING ("salon_id" = app_current_salon_id() AND app_owns_salon("salon_id"));
CREATE POLICY "own_read" ON "sync_operations" FOR SELECT
  USING ("salon_id" = app_current_salon_id() AND "user_id" = app_current_user_id());
CREATE POLICY "own_insert" ON "sync_operations" FOR INSERT
  WITH CHECK (
    "salon_id" = app_current_salon_id() AND "user_id" = app_current_user_id()
    AND (app_owns_salon("salon_id") OR EXISTS (
      SELECT 1 FROM "staff_profiles" sp
      WHERE sp."salon_id" = "sync_operations"."salon_id" AND sp."user_id" = app_current_user_id() AND sp."is_active" AND sp."deleted_at" IS NULL))
  );
CREATE POLICY "admin_read" ON "sync_operations" FOR SELECT USING (app_is_platform_admin());

ALTER TABLE "appointment_notes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "appointment_notes" FORCE ROW LEVEL SECURITY;
CREATE POLICY "owner_read" ON "appointment_notes" FOR SELECT
  USING ("salon_id" = app_current_salon_id() AND app_owns_salon("salon_id"));
CREATE POLICY "owner_insert" ON "appointment_notes" FOR INSERT
  WITH CHECK ("salon_id" = app_current_salon_id() AND app_owns_salon("salon_id") AND "author_user_id" = app_current_user_id());
CREATE POLICY "staff_own_read" ON "appointment_notes" FOR SELECT
  USING ("salon_id" = app_current_salon_id()
         AND EXISTS (SELECT 1 FROM "appointments" a WHERE a."id" = "appointment_notes"."appointment_id" AND a."salon_id" = "appointment_notes"."salon_id"
                     AND app_is_own_staff(a."staff_id")));
CREATE POLICY "staff_own_insert" ON "appointment_notes" FOR INSERT
  WITH CHECK ("salon_id" = app_current_salon_id() AND "author_user_id" = app_current_user_id()
              AND EXISTS (SELECT 1 FROM "appointments" a WHERE a."id" = "appointment_notes"."appointment_id" AND a."salon_id" = "appointment_notes"."salon_id"
                          AND app_is_own_staff(a."staff_id")));
CREATE POLICY "admin_read" ON "appointment_notes" FOR SELECT USING (app_is_platform_admin());

-- ---------------------------------------------------------------------------------------------
-- 6) Grants. The runtime role can only append. The Supabase Data API stays shut.
-- ---------------------------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'salon_app') THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON "sync_operations" FROM salon_app;
    REVOKE UPDATE, DELETE, TRUNCATE ON "appointment_notes" FROM salon_app;
    REVOKE ALL ON FUNCTION sync_append_only() FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION sync_append_only() TO salon_app;
    REVOKE ALL ON FUNCTION appointments_touch() FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION appointments_touch() TO salon_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON "sync_operations", "appointment_notes" FROM anon;
    REVOKE ALL ON FUNCTION sync_append_only(), appointments_touch() FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON "sync_operations", "appointment_notes" FROM authenticated;
    REVOKE ALL ON FUNCTION sync_append_only(), appointments_touch() FROM authenticated;
  END IF;
END
$$;
