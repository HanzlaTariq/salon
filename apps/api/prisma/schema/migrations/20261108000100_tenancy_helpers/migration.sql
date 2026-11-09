-- Tenancy helpers used by every Row-Level-Security policy added in later phases.
-- The API sets these with set_config(..., true) inside each request transaction (see TenantDb).
-- Missing/empty settings resolve to NULL, so a request WITHOUT context matches no rows (fail closed).

CREATE OR REPLACE FUNCTION app_current_salon_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.salon_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION app_current_user_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.user_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION app_is_platform_admin() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(current_setting('app.is_platform_admin', true), 'false') = 'true'
$$;

-- POLICY TEMPLATE for every salon-owned table (applied in the migration that creates the table):
--
--   ALTER TABLE <t> ENABLE ROW LEVEL SECURITY;
--   ALTER TABLE <t> FORCE  ROW LEVEL SECURITY;
--   CREATE POLICY tenant_isolation ON <t>
--     USING      (salon_id = app_current_salon_id() OR app_is_platform_admin())
--     WITH CHECK (salon_id = app_current_salon_id() OR app_is_platform_admin());
