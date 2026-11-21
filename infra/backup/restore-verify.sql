-- Checks run by the restore drill. Every check raises an exception on failure, so the drill stops with a non-zero exit code.
DO $$
DECLARE
  n int;
  missing text;
BEGIN
  SELECT count(*) INTO n FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE';
  IF n < 40 THEN RAISE EXCEPTION 'only % tables restored (expected 40 or more)', n; END IF;

  SELECT count(*) INTO n FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL;
  IF n < 15 THEN RAISE EXCEPTION 'only % applied migrations in _prisma_migrations', n; END IF;

  -- Row-Level Security must survive a restore (it is part of the schema, not of the data).
  SELECT string_agg(c.relname, ', ') INTO missing FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
   WHERE ns.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity AND c.relname <> 'spatial_ref_sys' AND c.relname <> '_prisma_migrations';
  IF missing IS NOT NULL THEN RAISE EXCEPTION 'tables without row level security after restore: %', missing; END IF;

  SELECT string_agg(c.relname, ', ') INTO missing FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
   WHERE ns.nspname = 'public' AND c.relkind = 'r' AND NOT c.relforcerowsecurity
     AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'salon_id' AND NOT a.attisdropped)
     AND c.relname NOT IN ('audit_logs', 'salon_rating_stats', 'staff_rating_stats');
  IF missing IS NOT NULL THEN RAISE EXCEPTION 'salon tables without FORCED row level security after restore: %', missing; END IF;

  -- The two protections against double booking and against rewriting history must still exist.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'appointments_no_double_booking') THEN RAISE EXCEPTION 'exclusion constraint appointments_no_double_booking is missing'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'salon_credits_append_only') THEN RAISE EXCEPTION 'append-only trigger on salon_credits is missing'; END IF;
  -- Least privilege must survive too: the runtime role cannot rewrite the audit log or delete history.
  IF EXISTS (SELECT 1 FROM information_schema.role_table_grants WHERE grantee = 'salon_app' AND table_name = 'audit_logs' AND privilege_type IN ('UPDATE', 'DELETE', 'TRUNCATE')) THEN RAISE EXCEPTION 'salon_app can change audit_logs after restore'; END IF;
  IF EXISTS (SELECT 1 FROM information_schema.role_table_grants WHERE grantee = 'salon_app' AND table_name IN ('sync_operations', 'staff_invitations') AND privilege_type = 'DELETE') THEN RAISE EXCEPTION 'salon_app can delete history tables after restore'; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.role_table_grants WHERE grantee = 'salon_app' AND table_name = 'users' AND privilege_type = 'SELECT') THEN RAISE EXCEPTION 'salon_app has no grants after restore'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'maintenance_purge') THEN RAISE EXCEPTION 'maintenance_purge() is missing'; END IF;
END $$;

SELECT 'OK schema: tables=' || count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE';
SELECT 'rows: users=' || (SELECT count(*) FROM users) || ' salons=' || (SELECT count(*) FROM salons) || ' appointments=' || (SELECT count(*) FROM appointments)
    || ' payments=' || (SELECT count(*) FROM payments) || ' audit_logs=' || (SELECT count(*) FROM audit_logs);
SELECT 'newest migration: ' || max(migration_name) FROM _prisma_migrations;
SELECT 'newest audit record: ' || coalesce(max(created_at)::text, 'none') FROM audit_logs;
