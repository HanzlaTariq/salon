-- PHASE 15: SECURITY AND PERFORMANCE HARDENING
--
-- What this migration does (every item is explained in docs/PHASE15.md):
--   1) Row-Level Security as a SECOND wall on the 8 tables that had none (users, auth_*, refresh_tokens, mfa_recovery_codes,
--      audit_logs, platform_settings). If an `anon` / `authenticated` grant ever comes back (Supabase Data API), those roles
--      still match no policy and see nothing. The runtime role `salon_app` keeps exactly the access it has today.
--   2) platform_settings becomes writable by SUPER_ADMIN only at database level (risk R53).
--   3) Missing foreign-key indexes on the hot paths (see docs/PERFORMANCE.md for the method).
--   4) Retention: SECURITY DEFINER purge function (sync operations, finished invitations, dead tokens and sessions) that
--      deletes only rows older than a fixed age. The runtime role still has NO delete right on those tables (risks R34, R130).
--   5) Storage reconciliation helper: tells the API which of a list of storage keys are still referenced (risks R19, R29).
--
-- Never edit this file after it has been applied; add a new migration instead.

-- ---------------------------------------------------------------------------------------------
-- 0) Helper: the maintenance flag. Set (transaction-local) only INSIDE the two functions below.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_maintenance() RETURNS boolean
LANGUAGE sql STABLE AS $$ SELECT COALESCE(current_setting('app.maintenance', true), '') = 'on' $$;

-- ---------------------------------------------------------------------------------------------
-- 1) Second wall: RLS on tables without it. ENABLE (not FORCE): the table owner / migrator keeps working.
--    A policy TO salon_app reproduces today's access; every other non-owner role gets nothing.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE "users"              ENABLE ROW LEVEL SECURITY;
ALTER TABLE "auth_sessions"      ENABLE ROW LEVEL SECURITY;
ALTER TABLE "auth_tokens"        ENABLE ROW LEVEL SECURITY;
ALTER TABLE "refresh_tokens"     ENABLE ROW LEVEL SECURITY;
ALTER TABLE "mfa_recovery_codes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "audit_logs"         ENABLE ROW LEVEL SECURITY;
ALTER TABLE "platform_settings"  ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'salon_app') THEN
    CREATE POLICY "runtime_access" ON "users"              FOR ALL TO salon_app USING (true) WITH CHECK (true);
    CREATE POLICY "runtime_access" ON "auth_sessions"      FOR ALL TO salon_app USING (true) WITH CHECK (true);
    CREATE POLICY "runtime_access" ON "auth_tokens"        FOR ALL TO salon_app USING (true) WITH CHECK (true);
    CREATE POLICY "runtime_access" ON "refresh_tokens"     FOR ALL TO salon_app USING (true) WITH CHECK (true);
    CREATE POLICY "runtime_access" ON "mfa_recovery_codes" FOR ALL TO salon_app USING (true) WITH CHECK (true);
    -- The audit log is append-only: the runtime role has SELECT and INSERT only (grants) and the same two policies.
    CREATE POLICY "runtime_read"   ON "audit_logs" FOR SELECT TO salon_app USING (true);
    CREATE POLICY "runtime_insert" ON "audit_logs" FOR INSERT TO salon_app WITH CHECK (true);
  END IF;
END $$;

-- ---------------------------------------------------------------------------------------------
-- 2) platform_settings: anyone may READ (the free-trial length is needed by public search); only SUPER_ADMIN may WRITE.
--    Risk R53: a compromised runtime credential could previously set `trialDays` to 90000 and keep every unpaid salon listed.
-- ---------------------------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'salon_app') THEN
    CREATE POLICY "settings_read"   ON "platform_settings" FOR SELECT TO salon_app USING (true);
    CREATE POLICY "settings_insert" ON "platform_settings" FOR INSERT TO salon_app WITH CHECK (app_platform_role_in(ARRAY['SUPER_ADMIN']));
    CREATE POLICY "settings_update" ON "platform_settings" FOR UPDATE TO salon_app
      USING (app_platform_role_in(ARRAY['SUPER_ADMIN'])) WITH CHECK (app_platform_role_in(ARRAY['SUPER_ADMIN']));
    CREATE POLICY "settings_delete" ON "platform_settings" FOR DELETE TO salon_app USING (app_platform_role_in(ARRAY['SUPER_ADMIN']));
  END IF;
END $$;

-- ---------------------------------------------------------------------------------------------
-- 3) Foreign-key indexes. Without one, every cascade, every RLS-filtered scan by salon and every "by session / by event"
--    lookup reads the whole table. Columns that only record WHO did something (created_by, reviewed_by, ...) are not
--    indexed on purpose (write cost, no lookup): they are listed in test/security-audit.e2e-spec.ts so a NEW foreign key
--    must either get an index or be added to that list consciously.
-- ---------------------------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS "appointment_early_offers_salon_idx"      ON "appointment_early_offers"("salon_id");
CREATE INDEX IF NOT EXISTS "appointment_status_history_salon_idx"    ON "appointment_status_history"("salon_id", "created_at");
CREATE INDEX IF NOT EXISTS "customer_favourites_salon_idx"           ON "customer_favourites"("salon_id");
CREATE INDEX IF NOT EXISTS "notifications_event_idx"                 ON "notifications"("event_id");
CREATE INDEX IF NOT EXISTS "notification_deliveries_device_idx"      ON "notification_deliveries"("device_token_id");
CREATE INDEX IF NOT EXISTS "device_tokens_session_idx"               ON "device_tokens"("session_id");
CREATE INDEX IF NOT EXISTS "sync_operations_user_idx"                ON "sync_operations"("user_id");
CREATE INDEX IF NOT EXISTS "invoices_plan_idx"                       ON "invoices"("plan_id");

-- ---------------------------------------------------------------------------------------------
-- 4) Retention. The runtime role cannot DELETE from sync_operations or staff_invitations (by design: history that
--    cannot be rewritten by an API bug). A fixed-age purge therefore lives in a SECURITY DEFINER function. The policies
--    below carry the age limit themselves, so even a mistake in the function cannot remove younger rows.
-- ---------------------------------------------------------------------------------------------
DO $$
BEGIN
  -- sync_operations: 90 days (the offline ledger is only needed to make retries idempotent; clients retry within hours).
  CREATE POLICY "maintenance_purge" ON "sync_operations" FOR DELETE
    USING (app_maintenance() AND "received_at" < now() - interval '90 days');
  -- staff_invitations: finished (accepted / revoked) or expired invitations older than 90 days hold a personal e-mail address
  -- for no reason (risk R34).
  CREATE POLICY "maintenance_purge" ON "staff_invitations" FOR DELETE
    USING (app_maintenance() AND "created_at" < now() - interval '90 days' AND ("status" <> 'PENDING' OR "expires_at" < now()));
  -- Read access to the two storage-key columns, only for the reconciliation function.
  CREATE POLICY "maintenance_keys" ON "salon_files" FOR SELECT USING (app_maintenance());
  CREATE POLICY "maintenance_keys" ON "payments"    FOR SELECT USING (app_maintenance());
END $$;

CREATE OR REPLACE FUNCTION maintenance_purge() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  n_sync int; n_invites int; n_tokens int; n_refresh int; n_sessions int;
BEGIN
  PERFORM set_config('app.maintenance', 'on', true);

  DELETE FROM sync_operations WHERE received_at < now() - interval '90 days';
  GET DIAGNOSTICS n_sync = ROW_COUNT;

  DELETE FROM staff_invitations
   WHERE created_at < now() - interval '90 days' AND (status <> 'PENDING' OR expires_at < now());
  GET DIAGNOSTICS n_invites = ROW_COUNT;

  -- Single-use e-mail verification / password-reset tokens: useless a week after they expired.
  DELETE FROM auth_tokens WHERE expires_at < now() - interval '7 days';
  GET DIAGNOSTICS n_tokens = ROW_COUNT;

  DELETE FROM refresh_tokens WHERE expires_at < now() - interval '7 days';
  GET DIAGNOSTICS n_refresh = ROW_COUNT;

  -- Sessions that ended (expired or signed out) more than 30 days ago. Their refresh tokens and device registrations
  -- cascade. Reuse detection only needs live sessions.
  DELETE FROM auth_sessions
   WHERE (expires_at < now() - interval '30 days')
      OR (revoked_at IS NOT NULL AND revoked_at < now() - interval '30 days');
  GET DIAGNOSTICS n_sessions = ROW_COUNT;

  PERFORM set_config('app.maintenance', 'off', true);
  RETURN jsonb_build_object(
    'syncOperations', n_sync, 'staffInvitations', n_invites, 'authTokens', n_tokens,
    'refreshTokens', n_refresh, 'sessions', n_sessions
  );
END;
$$;

CREATE OR REPLACE FUNCTION maintenance_keys_in_use(p_keys text[]) RETURNS text[]
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  found text[];
BEGIN
  IF p_keys IS NULL OR cardinality(p_keys) > 500 THEN
    RAISE EXCEPTION 'at most 500 keys per call' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  PERFORM set_config('app.maintenance', 'on', true);
  SELECT COALESCE(array_agg(DISTINCT k), ARRAY[]::text[]) INTO found FROM (
    SELECT storage_key AS k FROM salon_files WHERE storage_key = ANY (p_keys)
    UNION ALL
    SELECT receipt_key AS k FROM payments    WHERE receipt_key = ANY (p_keys)
  ) s;
  PERFORM set_config('app.maintenance', 'off', true);
  RETURN found;
END;
$$;

-- Only the runtime role may call them (never PUBLIC, never the Supabase Data API roles).
REVOKE ALL ON FUNCTION maintenance_purge() FROM PUBLIC;
REVOKE ALL ON FUNCTION maintenance_keys_in_use(text[]) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'salon_app') THEN
    GRANT EXECUTE ON FUNCTION maintenance_purge() TO salon_app;
    GRANT EXECUTE ON FUNCTION maintenance_keys_in_use(text[]) TO salon_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON FUNCTION maintenance_purge() FROM anon;
    REVOKE ALL ON FUNCTION maintenance_keys_in_use(text[]) FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON FUNCTION maintenance_purge() FROM authenticated;
    REVOKE ALL ON FUNCTION maintenance_keys_in_use(text[]) FROM authenticated;
  END IF;
END $$;
