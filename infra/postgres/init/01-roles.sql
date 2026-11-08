-- LOCAL DEVELOPMENT ONLY. Passwords here are dev placeholders; production roles/passwords
-- come from the secret manager and are never committed.
--
-- Least privilege:
--   salon_migrator : owns the schema, runs migrations (DDL).
--   salon_app      : used by the API at runtime. NOT a superuser, NOT the table owner,
--                    so Row-Level Security (added in Phase 2+) is actually enforced.

CREATE ROLE salon_migrator LOGIN PASSWORD 'salon_migrator_dev_pw' CREATEDB;
CREATE ROLE salon_app      LOGIN PASSWORD 'salon_app_dev_pw' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;

GRANT ALL PRIVILEGES ON DATABASE salon TO salon_migrator;
\connect salon
GRANT ALL ON SCHEMA public TO salon_migrator;
GRANT USAGE ON SCHEMA public TO salon_app;

-- Tables created later by salon_migrator are automatically usable by the app role (DML only).
ALTER DEFAULT PRIVILEGES FOR ROLE salon_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO salon_app;
ALTER DEFAULT PRIVILEGES FOR ROLE salon_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO salon_app;
