-- Phase 9: staff queue and appointment workflow (start / complete / next customer / no-show / walk-ins / delay and ETA /
-- early availability offers / customer arrival).
-- Additive: no earlier migration is edited. Hand-written SQL is the source of truth for CHECK constraints, triggers, RLS
-- policies and grants (Prisma cannot express them).
--
-- What this migration guarantees IN THE DATABASE (not only in the API):
--   * a walk-in is an appointment WITHOUT a customer account (customer_user_id NULL, walk_in_name set); an online booking always
--     has a customer. Walk-ins and online bookings share the same table, so the no-double-booking exclusion constraint covers both;
--   * a staff member can have at most ONE appointment IN_PROGRESS (partial unique index);
--   * the ORIGINAL time (starts_at) never changes except by the customer's own consent (reschedule, or accepting an early offer);
--     the salon's updated estimate lives in its own columns (estimated_starts_at, eta_updated_at) and the customer's own estimate in
--     (arrival_state, customer_eta_at). Only the customer can write the arrival columns, only the salon can write progress columns;
--   * accepting an early-availability offer moves the start earlier WITHOUT counting as a reschedule (no penalty), and only when an
--     ACCEPTED offer for exactly that time was written in the same transaction;
--   * staff can update progress of THEIR OWN appointments only, and create walk-ins only with the `walk_ins.create` permission.

-- ---------------------------------------------------------------------------------------------
-- 1) Appointments: walk-ins, progress, estimate, customer arrival
-- ---------------------------------------------------------------------------------------------
ALTER TABLE "appointments"
  ALTER COLUMN "customer_user_id" DROP NOT NULL,
  ADD COLUMN "walk_in_name"        VARCHAR(80),
  ADD COLUMN "walk_in_phone"       VARCHAR(16),
  ADD COLUMN "started_at"          TIMESTAMPTZ(6),
  ADD COLUMN "completed_at"        TIMESTAMPTZ(6),
  ADD COLUMN "no_show_at"          TIMESTAMPTZ(6),
  ADD COLUMN "estimated_starts_at" TIMESTAMPTZ(6),
  ADD COLUMN "eta_updated_at"      TIMESTAMPTZ(6),
  ADD COLUMN "arrival_state"       VARCHAR(12) NOT NULL DEFAULT 'NONE',
  ADD COLUMN "customer_eta_at"     TIMESTAMPTZ(6),
  ADD COLUMN "arrival_updated_at"  TIMESTAMPTZ(6),
  ADD COLUMN "arrival_updates"     SMALLINT NOT NULL DEFAULT 0;

ALTER TABLE "appointments" DROP CONSTRAINT "appointments_source_known";
ALTER TABLE "appointments"
  ADD CONSTRAINT "appointments_source_known" CHECK ("source" IN ('ONLINE', 'WALK_IN')),
  ADD CONSTRAINT "appointments_party_consistent" CHECK (
    ("source" = 'ONLINE' AND "customer_user_id" IS NOT NULL AND "walk_in_name" IS NULL AND "walk_in_phone" IS NULL)
    OR ("source" = 'WALK_IN' AND "customer_user_id" IS NULL AND "walk_in_name" IS NOT NULL)
  ),
  ADD CONSTRAINT "appointments_walk_in_name_len" CHECK ("walk_in_name" IS NULL OR char_length(btrim("walk_in_name")) BETWEEN 2 AND 80),
  ADD CONSTRAINT "appointments_walk_in_phone_e164" CHECK ("walk_in_phone" IS NULL OR "walk_in_phone" ~ '^\+[1-9][0-9]{7,14}$'),
  ADD CONSTRAINT "appointments_progress_consistent" CHECK (
    (("status" IN ('IN_PROGRESS', 'COMPLETED')) = ("started_at" IS NOT NULL))
    AND (("status" = 'COMPLETED') = ("completed_at" IS NOT NULL))
    AND (("status" = 'NO_SHOW') = ("no_show_at" IS NOT NULL))
    AND ("completed_at" IS NULL OR "completed_at" >= "started_at")
  ),
  ADD CONSTRAINT "appointments_estimate_consistent" CHECK (
    "estimated_starts_at" IS NULL OR ("eta_updated_at" IS NOT NULL AND "estimated_starts_at" > "starts_at")
  ),
  ADD CONSTRAINT "appointments_arrival_state_known" CHECK ("arrival_state" IN ('NONE', 'ON_THE_WAY', 'RUNNING_LATE')),
  ADD CONSTRAINT "appointments_arrival_consistent" CHECK (
    ("arrival_state" = 'NONE') = ("arrival_updated_at" IS NULL)
    AND ("arrival_state" <> 'NONE' OR "customer_eta_at" IS NULL)
  ),
  ADD CONSTRAINT "appointments_arrival_updates_range" CHECK ("arrival_updates" BETWEEN 0 AND 10);

-- One appointment in service per staff member, at any moment.
CREATE UNIQUE INDEX "appointments_one_in_progress_per_staff" ON "appointments"("staff_id") WHERE "status" = 'IN_PROGRESS';
-- Retried walk-in creation (offline sync, flaky network) never duplicates the walk-in.
CREATE UNIQUE INDEX "appointments_walk_in_idempotency" ON "appointments"("salon_id", "idempotency_key") WHERE "source" = 'WALK_IN' AND "idempotency_key" IS NOT NULL;
-- The live queue of one staff member.
CREATE INDEX "appointments_staff_queue_idx" ON "appointments"("staff_id", "starts_at") WHERE "status" IN ('PENDING', 'CONFIRMED', 'IN_PROGRESS', 'DELAYED');

-- ---------------------------------------------------------------------------------------------
-- 2) Salon policy: how long the salon waits before a staff member may mark a no-show
-- ---------------------------------------------------------------------------------------------
ALTER TABLE "salon_booking_policies"
  ADD COLUMN "no_show_grace_minutes" SMALLINT NOT NULL DEFAULT 15,
  ADD CONSTRAINT "salon_booking_policies_no_show_grace" CHECK ("no_show_grace_minutes" BETWEEN 5 AND 120 AND "no_show_grace_minutes" % 5 = 0);

-- ---------------------------------------------------------------------------------------------
-- 3) History: more event kinds (still append-only). Non-status events repeat the current status in from/to.
--    ETA_CHANGED: old/new_starts_at = old/new ESTIMATE (NULL = on time). ARRIVAL_UPDATE: reason = state, new_starts_at = customer ETA.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE "appointment_status_history" DROP CONSTRAINT "appointment_status_history_event_known";
ALTER TABLE "appointment_status_history" ADD CONSTRAINT "appointment_status_history_event_known" CHECK ("event" IN (
  'CREATED', 'RESCHEDULED', 'CANCELLED', 'STATUS_CHANGED', 'STARTED', 'COMPLETED', 'NO_SHOW', 'ETA_CHANGED', 'ARRIVAL_UPDATE',
  'EARLY_OFFERED', 'EARLY_ACCEPTED', 'EARLY_DECLINED', 'EARLY_WITHDRAWN'
));

-- Several history rows are written in ONE transaction (complete + start on "next customer", accept + arrival). now() is the same for
-- all of them, so their order would be decided by the random id. clock_timestamp() keeps the real order of events.
ALTER TABLE "appointment_status_history" ALTER COLUMN "created_at" SET DEFAULT clock_timestamp();

-- ---------------------------------------------------------------------------------------------
-- 4) Early availability offers ("your stylist is free earlier: come now / keep my time")
-- ---------------------------------------------------------------------------------------------
CREATE TABLE "appointment_early_offers" (
    "id"                  UUID NOT NULL DEFAULT gen_random_uuid(),
    "salon_id"            UUID NOT NULL,
    "appointment_id"      UUID NOT NULL,
    "offered_by"          UUID NOT NULL,
    "offered_start"       TIMESTAMPTZ(6) NOT NULL,
    "expires_at"          TIMESTAMPTZ(6) NOT NULL,
    "status"              VARCHAR(10) NOT NULL DEFAULT 'PENDING',
    "responded_at"        TIMESTAMPTZ(6),
    "customer_eta_minutes" SMALLINT,
    "created_at"          TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "appointment_early_offers_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "appointment_early_offers_status_known" CHECK ("status" IN ('PENDING', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'WITHDRAWN')),
    CONSTRAINT "appointment_early_offers_responded" CHECK (("status" = 'PENDING') = ("responded_at" IS NULL)),
    CONSTRAINT "appointment_early_offers_expiry" CHECK ("expires_at" > "created_at"),
    CONSTRAINT "appointment_early_offers_eta" CHECK ("customer_eta_minutes" IS NULL OR ("customer_eta_minutes" BETWEEN 1 AND 120 AND "status" = 'ACCEPTED'))
);
CREATE UNIQUE INDEX "appointment_early_offers_one_pending" ON "appointment_early_offers"("appointment_id") WHERE "status" = 'PENDING';
CREATE INDEX "appointment_early_offers_appt_idx" ON "appointment_early_offers"("appointment_id", "created_at");
ALTER TABLE "appointment_early_offers" ADD CONSTRAINT "appointment_early_offers_appointment_fkey"
  FOREIGN KEY ("salon_id", "appointment_id") REFERENCES "appointments"("salon_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "appointment_early_offers" ADD CONSTRAINT "appointment_early_offers_offered_by_fkey"
  FOREIGN KEY ("offered_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION appointment_early_offers_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  uid uuid := app_current_user_id();
  cust uuid;
  orig timestamptz;
BEGIN
  SELECT a.customer_user_id, a.starts_at INTO cust, orig FROM appointments a WHERE a.id = NEW.appointment_id AND a.salon_id = NEW.salon_id;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'PENDING' THEN
      RAISE EXCEPTION 'an offer starts as PENDING' USING ERRCODE = 'check_violation';
    END IF;
    IF cust IS NULL THEN
      RAISE EXCEPTION 'a walk-in has no app account and cannot receive an offer' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.offered_start >= orig THEN
      RAISE EXCEPTION 'an early offer must be earlier than the booked time' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.offered_by IS DISTINCT FROM uid THEN
      RAISE EXCEPTION 'offered_by must be the acting user' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status <> 'PENDING' THEN
    RAISE EXCEPTION 'a % offer can no longer be changed', OLD.status USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.id <> OLD.id OR NEW.salon_id <> OLD.salon_id OR NEW.appointment_id <> OLD.appointment_id OR NEW.offered_by <> OLD.offered_by
     OR NEW.offered_start <> OLD.offered_start OR NEW.expires_at <> OLD.expires_at OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'offer fields cannot be changed' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status IN ('ACCEPTED', 'DECLINED') THEN
    -- Only the customer answers. The answer must come before the offer runs out.
    IF cust IS NULL OR uid IS NULL OR uid <> cust THEN
      RAISE EXCEPTION 'only the customer can accept or decline an offer' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF now() > OLD.expires_at THEN
      RAISE EXCEPTION 'this offer has expired' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.status IN ('WITHDRAWN', 'EXPIRED') THEN
    IF uid IS NOT NULL AND uid = cust THEN
      RAISE EXCEPTION 'the customer cannot withdraw or expire an offer' USING ERRCODE = 'insufficient_privilege';
    END IF;
  ELSE
    RAISE EXCEPTION 'illegal offer status change' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "appointment_early_offers_guard_trg" BEFORE INSERT OR UPDATE ON "appointment_early_offers"
  FOR EACH ROW EXECUTE FUNCTION appointment_early_offers_guard();

-- ---------------------------------------------------------------------------------------------
-- 5) Appointment guard, revised (CREATE OR REPLACE keeps the trigger and the grants of Phase 8)
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
      IF NEW.status <> 'CONFIRMED' OR NEW.starts_at < now() - interval '10 minutes' THEN
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
-- 6) Row-Level Security
--    Staff: UPDATE progress of their OWN appointments (never to CANCELLED), insert walk-ins with the permission, write their own
--    history rows and offers. The owner policies of Phase 8 already cover the owner. Customers keep their Phase 8 policies.
-- ---------------------------------------------------------------------------------------------
CREATE POLICY "staff_own_update" ON "appointments" FOR UPDATE
  USING      ("salon_id" = app_current_salon_id() AND app_is_own_staff("staff_id") AND "status" IN ('PENDING', 'CONFIRMED', 'IN_PROGRESS', 'DELAYED'))
  WITH CHECK ("salon_id" = app_current_salon_id() AND app_is_own_staff("staff_id") AND "status" IN ('CONFIRMED', 'IN_PROGRESS', 'COMPLETED', 'NO_SHOW', 'DELAYED'));

CREATE POLICY "staff_walk_in_insert" ON "appointments" FOR INSERT
  WITH CHECK (
    "salon_id" = app_current_salon_id() AND "source" = 'WALK_IN' AND "customer_user_id" IS NULL AND "status" = 'CONFIRMED'
    AND "reschedule_count" = 0 AND "cancelled_at" IS NULL
    AND app_has_own_staff_permission("staff_id", 'walk_ins.create')
    AND EXISTS (SELECT 1 FROM "salons" s WHERE s."id" = "salon_id" AND s."status" = 'APPROVED')
  );

CREATE POLICY "staff_walk_in_insert" ON "appointment_services" FOR INSERT
  WITH CHECK (
    "salon_id" = app_current_salon_id()
    AND EXISTS (SELECT 1 FROM "appointments" a WHERE a."id" = "appointment_services"."appointment_id" AND a."salon_id" = "appointment_services"."salon_id"
                AND a."source" = 'WALK_IN' AND app_has_own_staff_permission(a."staff_id", 'walk_ins.create'))
  );

CREATE POLICY "staff_insert" ON "appointment_status_history" FOR INSERT
  WITH CHECK (
    "salon_id" = app_current_salon_id() AND "actor_user_id" = app_current_user_id() AND "actor_role" = 'SALON_STAFF'
    AND EXISTS (SELECT 1 FROM "appointments" a WHERE a."id" = "appointment_status_history"."appointment_id"
                AND a."salon_id" = "appointment_status_history"."salon_id" AND app_is_own_staff(a."staff_id"))
  );

ALTER TABLE "appointment_early_offers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "appointment_early_offers" FORCE ROW LEVEL SECURITY;
CREATE POLICY "owner_all" ON "appointment_early_offers"
  USING      ("salon_id" = app_current_salon_id() AND app_owns_salon("salon_id"))
  WITH CHECK ("salon_id" = app_current_salon_id() AND app_owns_salon("salon_id"));
CREATE POLICY "staff_own_read" ON "appointment_early_offers" FOR SELECT
  USING ("salon_id" = app_current_salon_id()
         AND EXISTS (SELECT 1 FROM "appointments" a WHERE a."id" = "appointment_early_offers"."appointment_id"
                     AND a."salon_id" = "appointment_early_offers"."salon_id" AND app_is_own_staff(a."staff_id")));
CREATE POLICY "staff_own_insert" ON "appointment_early_offers" FOR INSERT
  WITH CHECK ("salon_id" = app_current_salon_id() AND "status" = 'PENDING' AND "offered_by" = app_current_user_id()
              AND EXISTS (SELECT 1 FROM "appointments" a WHERE a."id" = "appointment_early_offers"."appointment_id"
                          AND a."salon_id" = "appointment_early_offers"."salon_id" AND app_is_own_staff(a."staff_id")));
CREATE POLICY "staff_own_update" ON "appointment_early_offers" FOR UPDATE
  USING      ("salon_id" = app_current_salon_id() AND "status" = 'PENDING'
              AND EXISTS (SELECT 1 FROM "appointments" a WHERE a."id" = "appointment_early_offers"."appointment_id"
                          AND a."salon_id" = "appointment_early_offers"."salon_id" AND app_is_own_staff(a."staff_id")))
  WITH CHECK ("salon_id" = app_current_salon_id() AND "status" IN ('WITHDRAWN', 'EXPIRED'));
CREATE POLICY "admin_read" ON "appointment_early_offers" FOR SELECT
  USING (app_is_platform_admin());
CREATE POLICY "customer_own_read" ON "appointment_early_offers" FOR SELECT
  USING (EXISTS (SELECT 1 FROM "appointments" a WHERE a."id" = "appointment_early_offers"."appointment_id"
                 AND a."customer_user_id" = app_current_user_id()));
CREATE POLICY "customer_own_answer" ON "appointment_early_offers" FOR UPDATE
  USING      ("status" = 'PENDING'
              AND EXISTS (SELECT 1 FROM "appointments" a WHERE a."id" = "appointment_early_offers"."appointment_id"
                          AND a."customer_user_id" = app_current_user_id()))
  WITH CHECK ("status" IN ('ACCEPTED', 'DECLINED')
              AND EXISTS (SELECT 1 FROM "appointments" a WHERE a."id" = "appointment_early_offers"."appointment_id"
                          AND a."customer_user_id" = app_current_user_id()));

-- ---------------------------------------------------------------------------------------------
-- 7) Grants. Offers are never hard-deleted by the runtime role. The Supabase Data API stays shut.
-- ---------------------------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'salon_app') THEN
    REVOKE DELETE ON "appointment_early_offers" FROM salon_app;
    REVOKE ALL ON FUNCTION appointment_early_offers_guard() FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION appointment_early_offers_guard() TO salon_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON "appointment_early_offers" FROM anon;
    REVOKE ALL ON FUNCTION appointment_early_offers_guard() FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON "appointment_early_offers" FROM authenticated;
    REVOKE ALL ON FUNCTION appointment_early_offers_guard() FROM authenticated;
  END IF;
END
$$;
