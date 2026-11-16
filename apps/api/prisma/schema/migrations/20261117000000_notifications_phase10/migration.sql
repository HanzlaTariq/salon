-- Phase 10: notifications (push + in-app history).
-- Additive: no earlier migration is edited. Hand-written SQL is the source of truth for CHECK constraints, triggers, RLS
-- policies and grants (Prisma cannot express them).
--
-- HOW IT WORKS (a transactional outbox):
--   1. A fact happens (a booking is created, a delay is forecast, a salon is approved, a payment is decided, ...). A DATABASE TRIGGER
--      writes ONE small row into `notification_events` in the SAME transaction (kind + ids, never names, phones or message text).
--      If the business transaction rolls back, the event rolls back with it; if it commits, the event can never be lost.
--      A few time-based events (30/20/10-minute reminders, subscription expiry) are added by the worker's sweepers.
--   2. The WORKER (a background loop inside the API, or a cron-triggered tick) claims events with FOR UPDATE SKIP LOCKED, re-reads the
--      facts from the database, decides WHO is notified (never the actor, never a suspended account, never a stale event),
--      applies the person's preferences and language, writes the in-app history row (`notifications`) and sends the push (FCM).
--   3. Retries are safe: the history row is unique per (user, event), deliveries are unique per (notification, device) and only
--      PENDING deliveries are sent again.
--
-- What this migration guarantees IN THE DATABASE:
--   * recipients are NEVER taken from a client or from the event row: only the worker, from verified rows, decides them;
--   * a user can read and mark as read ONLY their own history, manage ONLY their own devices and preferences (RLS + guard trigger);
--   * a history row can never be edited except for `read_at` (trigger), and an outbox event is invisible to tenants;
--   * a failing notification trigger can never block the business action that fired it (the trigger swallows its own error and
--     raises a WARNING).

-- ---------------------------------------------------------------------------------------------
-- 1) Worker context flag (same pattern as app_is_platform_admin())
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_is_notification_worker() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(current_setting('app.notification_worker', true), 'false') = 'true'
$$;

-- ---------------------------------------------------------------------------------------------
-- 2) Outbox
-- ---------------------------------------------------------------------------------------------
CREATE TABLE "notification_events" (
    "id"            UUID NOT NULL DEFAULT gen_random_uuid(),
    "kind"          VARCHAR(24) NOT NULL,
    "salon_id"      UUID,
    "ref_type"      VARCHAR(12) NOT NULL,
    "ref_id"        UUID NOT NULL,
    "actor_user_id" UUID,
    "payload"       JSONB NOT NULL DEFAULT '{}'::jsonb,
    "dedupe_key"    VARCHAR(140) NOT NULL,
    "status"        VARCHAR(8) NOT NULL DEFAULT 'PENDING',
    "attempts"      SMALLINT NOT NULL DEFAULT 0,
    "run_at"        TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "locked_until"  TIMESTAMPTZ(6),
    "last_error"    VARCHAR(200),
    "created_at"    TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "processed_at"  TIMESTAMPTZ(6),

    CONSTRAINT "notification_events_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "notification_events_dedupe_key" UNIQUE ("dedupe_key"),
    CONSTRAINT "notification_events_kind_known" CHECK ("kind" IN (
      'BOOKING_CREATED', 'BOOKING_CANCELLED', 'BOOKING_RESCHEDULED', 'SERVICE_COMPLETED', 'NO_SHOW_RECORDED', 'DELAY_NOTICE',
      'ARRIVAL_UPDATE', 'EARLY_OFFER', 'EARLY_RESPONSE', 'APPOINTMENT_REMINDER', 'SALON_STATUS', 'PAYMENT_DECISION',
      'SUBSCRIPTION_NOTICE', 'STAFF_JOINED', 'STAFF_SCHEDULE'
    )),
    CONSTRAINT "notification_events_ref_known" CHECK ("ref_type" IN ('HISTORY', 'APPOINTMENT', 'SALON', 'PAYMENT', 'SUBSCRIPTION', 'INVITATION', 'STAFF')),
    CONSTRAINT "notification_events_status_known" CHECK ("status" IN ('PENDING', 'DONE', 'DEAD')),
    CONSTRAINT "notification_events_attempts_range" CHECK ("attempts" BETWEEN 0 AND 20),
    CONSTRAINT "notification_events_payload_small" CHECK (pg_column_size("payload") <= 1000),
    CONSTRAINT "notification_events_processed" CHECK (("status" = 'PENDING') = ("processed_at" IS NULL))
);
-- The worker's claim query.
CREATE INDEX "notification_events_due_idx" ON "notification_events"("run_at") WHERE "status" = 'PENDING';
CREATE INDEX "notification_events_purge_idx" ON "notification_events"("processed_at") WHERE "status" <> 'PENDING';

-- ---------------------------------------------------------------------------------------------
-- 3) In-app history (the inbox). Rendered in the person's language at creation time.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE "notifications" (
    "id"         UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id"    UUID NOT NULL,
    "salon_id"   UUID,
    "event_id"   UUID,
    "type"       VARCHAR(40) NOT NULL,
    "category"   VARCHAR(10) NOT NULL,
    "title"      VARCHAR(120) NOT NULL,
    "body"       VARCHAR(300) NOT NULL,
    "data"       JSONB NOT NULL DEFAULT '{}'::jsonb,
    "locale"     VARCHAR(2) NOT NULL DEFAULT 'en',
    "dedupe_key" VARCHAR(140) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "read_at"    TIMESTAMPTZ(6),

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "notifications_user_dedupe" UNIQUE ("user_id", "dedupe_key"),
    CONSTRAINT "notifications_type_shape" CHECK ("type" ~ '^[A-Z][A-Z_]{2,39}$'),
    CONSTRAINT "notifications_category_known" CHECK ("category" IN ('BOOKINGS', 'REMINDERS', 'QUEUE', 'TEAM', 'ACCOUNT')),
    CONSTRAINT "notifications_locale_known" CHECK ("locale" IN ('en', 'ur')),
    CONSTRAINT "notifications_title_len" CHECK (char_length(btrim("title")) BETWEEN 1 AND 120),
    CONSTRAINT "notifications_body_len" CHECK (char_length(btrim("body")) BETWEEN 1 AND 300),
    CONSTRAINT "notifications_data_small" CHECK (pg_column_size("data") <= 1000)
);
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_event_fkey" FOREIGN KEY ("event_id") REFERENCES "notification_events"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "notifications_inbox_idx" ON "notifications"("user_id", "created_at" DESC, "id" DESC);
CREATE INDEX "notifications_unread_idx" ON "notifications"("user_id") WHERE "read_at" IS NULL;

-- Only `read_at` may ever change, and only from NULL to a time (an unread flag cannot come back, history cannot be rewritten).
-- The one other change allowed is `event_id` becoming NULL, which the foreign key does when the retention purge deletes an old event.
CREATE OR REPLACE FUNCTION notifications_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.user_id <> OLD.user_id OR NEW.salon_id IS DISTINCT FROM OLD.salon_id
     OR (NEW.event_id IS DISTINCT FROM OLD.event_id AND NEW.event_id IS NOT NULL) -- only the retention purge may unlink the (deleted) event
     OR NEW.type <> OLD.type OR NEW.category <> OLD.category OR NEW.title <> OLD.title OR NEW.body <> OLD.body OR NEW.data <> OLD.data
     OR NEW.locale <> OLD.locale OR NEW.dedupe_key <> OLD.dedupe_key OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'a notification cannot be edited, only marked as read' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.read_at IS NOT NULL AND NEW.read_at IS DISTINCT FROM OLD.read_at THEN
    RAISE EXCEPTION 'a read notification cannot be changed' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "notifications_guard_trg" BEFORE UPDATE ON "notifications" FOR EACH ROW EXECUTE FUNCTION notifications_guard();

-- ---------------------------------------------------------------------------------------------
-- 4) Devices (FCM registration tokens). Only the hash is unique and indexed; a device that signs in as another person moves.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE "device_tokens" (
    "id"              UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id"         UUID NOT NULL,
    "session_id"      UUID,
    "token"           TEXT NOT NULL,
    "token_hash"      CHAR(64) NOT NULL,
    "platform"        VARCHAR(7) NOT NULL,
    "app"             VARCHAR(8) NOT NULL,
    "app_version"     VARCHAR(20),
    "created_at"      TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "last_seen_at"    TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "disabled_at"     TIMESTAMPTZ(6),
    "disabled_reason" VARCHAR(20),

    CONSTRAINT "device_tokens_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "device_tokens_token_hash_key" UNIQUE ("token_hash"),
    CONSTRAINT "device_tokens_token_len" CHECK (char_length("token") BETWEEN 20 AND 4096),
    CONSTRAINT "device_tokens_hash_shape" CHECK ("token_hash" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "device_tokens_platform_known" CHECK ("platform" IN ('ANDROID', 'IOS')),
    CONSTRAINT "device_tokens_app_known" CHECK ("app" IN ('CUSTOMER', 'BUSINESS')),
    CONSTRAINT "device_tokens_disabled_consistent" CHECK (("disabled_at" IS NULL) = ("disabled_reason" IS NULL))
);
ALTER TABLE "device_tokens" ADD CONSTRAINT "device_tokens_user_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "device_tokens" ADD CONSTRAINT "device_tokens_session_fkey" FOREIGN KEY ("session_id") REFERENCES "auth_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "device_tokens_active_idx" ON "device_tokens"("user_id", "last_seen_at" DESC) WHERE "disabled_at" IS NULL;

-- ---------------------------------------------------------------------------------------------
-- 5) Preferences (one row per person; no row = the defaults). The ACCOUNT category (salon approval, payments, subscription) has
--    no switch: those messages are essential. `reminder_offsets` = minutes before the appointment (0 = at the appointment time).
-- ---------------------------------------------------------------------------------------------
CREATE TABLE "notification_preferences" (
    "user_id"          UUID NOT NULL,
    "push_enabled"     BOOLEAN NOT NULL DEFAULT true,
    "language"         VARCHAR(2) NOT NULL DEFAULT 'en',
    "bookings"         BOOLEAN NOT NULL DEFAULT true,
    "reminders"        BOOLEAN NOT NULL DEFAULT true,
    "queue"            BOOLEAN NOT NULL DEFAULT true,
    "team"             BOOLEAN NOT NULL DEFAULT true,
    "reminder_offsets" SMALLINT[] NOT NULL DEFAULT '{30,20,10,0}',
    "updated_at"       TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("user_id"),
    CONSTRAINT "notification_preferences_language_known" CHECK ("language" IN ('en', 'ur')),
    CONSTRAINT "notification_preferences_offsets" CHECK ("reminder_offsets" <@ '{0,10,20,30}'::smallint[] AND cardinality("reminder_offsets") <= 4)
);
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_user_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------------------------
-- 6) Deliveries: one row per (notification, device). Makes a retry send only what is still PENDING.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE "notification_deliveries" (
    "id"                  UUID NOT NULL DEFAULT gen_random_uuid(),
    "notification_id"     UUID NOT NULL,
    "device_token_id"     UUID NOT NULL,
    "status"              VARCHAR(13) NOT NULL DEFAULT 'PENDING',
    "attempts"            SMALLINT NOT NULL DEFAULT 0,
    "last_error"          VARCHAR(120),
    "provider_message_id" VARCHAR(200),
    "sent_at"             TIMESTAMPTZ(6),
    "created_at"          TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at"          TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "notification_deliveries_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "notification_deliveries_unique" UNIQUE ("notification_id", "device_token_id"),
    CONSTRAINT "notification_deliveries_status_known" CHECK ("status" IN ('PENDING', 'SENT', 'FAILED', 'INVALID_TOKEN')),
    CONSTRAINT "notification_deliveries_attempts_range" CHECK ("attempts" BETWEEN 0 AND 20),
    CONSTRAINT "notification_deliveries_sent_consistent" CHECK (("status" = 'SENT') = ("sent_at" IS NOT NULL))
);
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_notification_fkey" FOREIGN KEY ("notification_id") REFERENCES "notifications"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_device_fkey" FOREIGN KEY ("device_token_id") REFERENCES "device_tokens"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "notification_deliveries_pending_idx" ON "notification_deliveries"("notification_id") WHERE "status" = 'PENDING';

-- ---------------------------------------------------------------------------------------------
-- 7) Sweeper index: "confirmed online appointments starting soon" (30/20/10/0-minute reminders)
-- ---------------------------------------------------------------------------------------------
CREATE INDEX "appointments_reminder_idx" ON "appointments"("starts_at") WHERE "status" = 'CONFIRMED' AND "customer_user_id" IS NOT NULL;

-- ---------------------------------------------------------------------------------------------
-- 8) Triggers. Every one of them goes through notify_enqueue(), which can never break the business action.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION notify_enqueue(p_kind text, p_salon uuid, p_ref_type text, p_ref uuid, p_actor uuid, p_payload jsonb, p_dedupe text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    -- No ON CONFLICT here: it would need a SELECT policy, and tenants must not be able to read the outbox.
    INSERT INTO notification_events (kind, salon_id, ref_type, ref_id, actor_user_id, payload, dedupe_key)
    VALUES (p_kind, p_salon, p_ref_type, p_ref, p_actor, COALESCE(p_payload, '{}'::jsonb), p_dedupe);
  EXCEPTION
    WHEN unique_violation THEN NULL; -- the same fact was already queued in this transaction
    WHEN OTHERS THEN
    RAISE WARNING 'notification event % was not queued: %', p_kind, SQLERRM;
  END;
END;
$$;

-- 8a) Appointment history -> booking, cancellation, reschedule, completion, no-show, delay, arrival, early-offer events.
CREATE OR REPLACE FUNCTION notify_appointment_history() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  k text;
BEGIN
  k := CASE NEW.event
    WHEN 'CREATED'        THEN 'BOOKING_CREATED'
    WHEN 'CANCELLED'      THEN 'BOOKING_CANCELLED'
    WHEN 'RESCHEDULED'    THEN 'BOOKING_RESCHEDULED'
    WHEN 'COMPLETED'      THEN 'SERVICE_COMPLETED'
    WHEN 'NO_SHOW'        THEN 'NO_SHOW_RECORDED'
    WHEN 'ETA_CHANGED'    THEN 'DELAY_NOTICE'
    WHEN 'ARRIVAL_UPDATE' THEN 'ARRIVAL_UPDATE'
    WHEN 'EARLY_OFFERED'  THEN 'EARLY_OFFER'
    WHEN 'EARLY_ACCEPTED' THEN 'EARLY_RESPONSE'
    WHEN 'EARLY_DECLINED' THEN 'EARLY_RESPONSE'
    ELSE NULL
  END;
  IF k IS NOT NULL THEN
    PERFORM notify_enqueue(k, NEW.salon_id, 'HISTORY', NEW.id, NEW.actor_user_id, '{}'::jsonb, 'history:' || NEW.id::text);
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "appointment_status_history_notify_trg" AFTER INSERT ON "appointment_status_history"
  FOR EACH ROW EXECUTE FUNCTION notify_appointment_history();

-- 8b) Salon approval / rejection / suspension / reactivation.
CREATE OR REPLACE FUNCTION notify_salon_status() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IN ('APPROVED', 'REJECTED', 'SUSPENDED') THEN
    PERFORM notify_enqueue('SALON_STATUS', NEW.id, 'SALON', NEW.id, app_current_user_id(),
      jsonb_build_object('from', OLD.status::text, 'status', NEW.status::text),
      'salon:' || NEW.id::text || ':' || NEW.status::text || ':' || txid_current()::text);
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "salons_notify_trg" AFTER UPDATE OF "status" ON "salons"
  FOR EACH ROW WHEN (OLD."status" IS DISTINCT FROM NEW."status") EXECUTE FUNCTION notify_salon_status();

-- 8c) Payment decisions (verified / rejected / more information needed).
CREATE OR REPLACE FUNCTION notify_payment_decision() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IN ('APPROVED', 'REJECTED', 'NEEDS_INFO') THEN
    PERFORM notify_enqueue('PAYMENT_DECISION', NEW.salon_id, 'PAYMENT', NEW.id, app_current_user_id(),
      jsonb_build_object('status', NEW.status),
      'payment:' || NEW.id::text || ':' || NEW.status || ':' || txid_current()::text);
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "payments_notify_trg" AFTER UPDATE OF "status" ON "payments"
  FOR EACH ROW WHEN (OLD."status" IS DISTINCT FROM NEW."status") EXECUTE FUNCTION notify_payment_decision();

-- 8d) A staff invitation was accepted: tell the owner.
CREATE OR REPLACE FUNCTION notify_staff_joined() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'ACCEPTED' THEN
    PERFORM notify_enqueue('STAFF_JOINED', NEW.salon_id, 'INVITATION', NEW.id, NEW.accepted_user_id, '{}'::jsonb, 'invitation:' || NEW.id::text);
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "staff_invitations_notify_trg" AFTER UPDATE OF "status" ON "staff_invitations"
  FOR EACH ROW WHEN (OLD."status" IS DISTINCT FROM NEW."status") EXECUTE FUNCTION notify_staff_joined();

-- 8e) Working hours, breaks or leave changed: tell the staff member (one event per staff member and transaction).
CREATE OR REPLACE FUNCTION notify_staff_schedule() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  sid uuid;
  slid uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    sid := OLD.staff_id; slid := OLD.salon_id;
  ELSE
    sid := NEW.staff_id; slid := NEW.salon_id;
  END IF;
  PERFORM notify_enqueue('STAFF_SCHEDULE', slid, 'STAFF', sid, app_current_user_id(), '{}'::jsonb, 'schedule:' || sid::text || ':' || txid_current()::text);
  RETURN NULL;
END;
$$;
CREATE TRIGGER "staff_working_hours_notify_trg" AFTER INSERT OR UPDATE OR DELETE ON "staff_working_hours" FOR EACH ROW EXECUTE FUNCTION notify_staff_schedule();
CREATE TRIGGER "staff_breaks_notify_trg"        AFTER INSERT OR UPDATE OR DELETE ON "staff_breaks"        FOR EACH ROW EXECUTE FUNCTION notify_staff_schedule();
CREATE TRIGGER "staff_leaves_notify_trg"        AFTER INSERT OR UPDATE OR DELETE ON "staff_leaves"        FOR EACH ROW EXECUTE FUNCTION notify_staff_schedule();

-- ---------------------------------------------------------------------------------------------
-- 9) Row-Level Security
-- ---------------------------------------------------------------------------------------------
ALTER TABLE "notification_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "notification_events" FORCE ROW LEVEL SECURITY;
-- Anyone inside a business transaction may QUEUE a fact (the row holds only ids). Nobody but the worker (and platform staff, read-only) can see or change it.
CREATE POLICY "enqueue" ON "notification_events" FOR INSERT WITH CHECK (true);
CREATE POLICY "worker_all" ON "notification_events" USING (app_is_notification_worker()) WITH CHECK (app_is_notification_worker());
CREATE POLICY "admin_read" ON "notification_events" FOR SELECT USING (app_is_platform_admin());

ALTER TABLE "notifications" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "notifications" FORCE ROW LEVEL SECURITY;
CREATE POLICY "own_read" ON "notifications" FOR SELECT USING ("user_id" = app_current_user_id());
CREATE POLICY "own_mark_read" ON "notifications" FOR UPDATE USING ("user_id" = app_current_user_id()) WITH CHECK ("user_id" = app_current_user_id());
CREATE POLICY "worker_all" ON "notifications" USING (app_is_notification_worker()) WITH CHECK (app_is_notification_worker());

ALTER TABLE "device_tokens" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "device_tokens" FORCE ROW LEVEL SECURITY;
CREATE POLICY "own_read" ON "device_tokens" FOR SELECT USING ("user_id" = app_current_user_id());
CREATE POLICY "own_disable" ON "device_tokens" FOR UPDATE USING ("user_id" = app_current_user_id()) WITH CHECK ("user_id" = app_current_user_id());
CREATE POLICY "worker_all" ON "device_tokens" USING (app_is_notification_worker()) WITH CHECK (app_is_notification_worker());

ALTER TABLE "notification_preferences" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "notification_preferences" FORCE ROW LEVEL SECURITY;
CREATE POLICY "own_all" ON "notification_preferences" USING ("user_id" = app_current_user_id()) WITH CHECK ("user_id" = app_current_user_id());
CREATE POLICY "worker_read" ON "notification_preferences" FOR SELECT USING (app_is_notification_worker());

ALTER TABLE "notification_deliveries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "notification_deliveries" FORCE ROW LEVEL SECURITY;
CREATE POLICY "worker_all" ON "notification_deliveries" USING (app_is_notification_worker()) WITH CHECK (app_is_notification_worker());

-- The worker may READ (never write) the facts it needs to decide who to notify. Every policy is additive: the tenant policies
-- of the earlier phases are unchanged, and no tenant, customer or admin request ever sets this flag.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['appointments', 'appointment_services', 'appointment_status_history', 'appointment_early_offers',
                           'salons', 'staff_profiles', 'payments', 'invoices', 'salon_subscriptions', 'staff_invitations'] LOOP
    EXECUTE format($p$CREATE POLICY "notification_worker_read" ON %I FOR SELECT USING (app_is_notification_worker())$p$, t);
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------------------------
-- 10) Grants. The Supabase Data API stays shut (no anon / authenticated access to anything new).
-- ---------------------------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'salon_app') THEN
    REVOKE ALL ON FUNCTION notify_enqueue(text, uuid, text, uuid, uuid, jsonb, text) FROM PUBLIC;
    REVOKE ALL ON FUNCTION notify_appointment_history() FROM PUBLIC;
    REVOKE ALL ON FUNCTION notify_salon_status() FROM PUBLIC;
    REVOKE ALL ON FUNCTION notify_payment_decision() FROM PUBLIC;
    REVOKE ALL ON FUNCTION notify_staff_joined() FROM PUBLIC;
    REVOKE ALL ON FUNCTION notify_staff_schedule() FROM PUBLIC;
    REVOKE ALL ON FUNCTION notifications_guard() FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION notify_enqueue(text, uuid, text, uuid, uuid, jsonb, text) TO salon_app;
    GRANT EXECUTE ON FUNCTION notify_appointment_history() TO salon_app;
    GRANT EXECUTE ON FUNCTION notify_salon_status() TO salon_app;
    GRANT EXECUTE ON FUNCTION notify_payment_decision() TO salon_app;
    GRANT EXECUTE ON FUNCTION notify_staff_joined() TO salon_app;
    GRANT EXECUTE ON FUNCTION notify_staff_schedule() TO salon_app;
    GRANT EXECUTE ON FUNCTION notifications_guard() TO salon_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON "notification_events", "notifications", "device_tokens", "notification_preferences", "notification_deliveries" FROM anon;
    REVOKE ALL ON FUNCTION notify_enqueue(text, uuid, text, uuid, uuid, jsonb, text) FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON "notification_events", "notifications", "device_tokens", "notification_preferences", "notification_deliveries" FROM authenticated;
    REVOKE ALL ON FUNCTION notify_enqueue(text, uuid, text, uuid, uuid, jsonb, text) FROM authenticated;
  END IF;
END
$$;
