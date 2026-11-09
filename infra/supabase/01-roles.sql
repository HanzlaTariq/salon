-- SUPABASE SETUP. Run ONCE in: Supabase Dashboard > SQL Editor (as `postgres`), BEFORE `prisma migrate deploy`.
-- 1) Change the password below. 2) Put the same password in DATABASE_URL (user: salon_app.<project-ref>).
--
-- Why: the API must NOT connect as `postgres` (it has BYPASSRLS, which would disable tenant isolation).
--   postgres   : owns tables, runs migrations (DIRECT_URL).
--   salon_app  : runtime role used by the API (DATABASE_URL). NOBYPASSRLS, DML only.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'salon_app') THEN
    CREATE ROLE salon_app LOGIN PASSWORD 'CHANGE_ME_STRONG_PASSWORD'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END $$;

-- Supavisor/Prisma: let postgres manage the role and keep sane limits.
GRANT salon_app TO postgres;
ALTER ROLE salon_app SET statement_timeout = '30s';
ALTER ROLE salon_app SET idle_in_transaction_session_timeout = '30s';

GRANT USAGE ON SCHEMA public TO salon_app;

-- Tables/sequences created later by postgres (i.e. by migrations) are usable by the app role (DML only).
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO salon_app;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO salon_app;

-- SECURITY: Supabase exposes `public` through its REST/GraphQL Data API using the anon/authenticated roles.
-- This project's tables (password hashes, MFA secrets) must NEVER be reachable that way.
-- The API talks to Postgres directly, so these roles need no access at all.
REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON TABLES    FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM anon, authenticated;
