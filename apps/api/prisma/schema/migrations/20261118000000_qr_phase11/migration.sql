-- Phase 11: permanent salon link + QR code.
-- Additive: no earlier migration is edited. Hand-written SQL is the source of truth for CHECK constraints, triggers, RLS policies
-- and grants (Prisma cannot express them).
--
--   * Every APPROVED salon gets ONE permanent public code (10 characters, random, unguessable, unrelated to the salon name).
--     The QR code and poster only encode  <PUBLIC_LINK_BASE_URL>/s/<code>, so they stay valid when the salon edits its details.
--   * The code is created by a trigger when a salon becomes APPROVED (existing approved salons are backfilled below). The trigger
--     can never block an approval: on any problem it raises a WARNING and the owner's first QR request creates the code.
--   * The runtime role can only SELECT and INSERT. A code can never be changed or deleted (trigger + revoked privileges).

CREATE OR REPLACE FUNCTION salon_qr_new_code() RETURNS varchar
LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  alphabet constant text := 'abcdefghjkmnpqrstuvwxyz23456789'; -- 31 characters, no i, l, o, 0, 1
  a bytea := decode(replace(gen_random_uuid()::text, '-', ''), 'hex');
  b bytea := decode(replace(gen_random_uuid()::text, '-', ''), 'hex');
  result text := '';
  i int;
BEGIN
  -- bytes 0..4 of a random UUID are fully random (version/variant bits live in bytes 6 and 8)
  FOR i IN 0..4 LOOP
    result := result || substr(alphabet, (get_byte(a, i) % 31) + 1, 1) || substr(alphabet, (get_byte(b, i) % 31) + 1, 1);
  END LOOP;
  RETURN result;
END;
$$;

CREATE TABLE "salon_qr_codes" (
    "id"         UUID NOT NULL DEFAULT gen_random_uuid(),
    "salon_id"   UUID NOT NULL,
    "code"       VARCHAR(10) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "salon_qr_codes_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "salon_qr_codes_code_format" CHECK ("code" ~ '^[a-hj-km-np-z2-9]{10}$')
);
CREATE UNIQUE INDEX "salon_qr_codes_salon_id_key" ON "salon_qr_codes"("salon_id");
CREATE UNIQUE INDEX "salon_qr_codes_code_key" ON "salon_qr_codes"("code");
ALTER TABLE "salon_qr_codes" ADD CONSTRAINT "salon_qr_codes_salon_id_fkey"
  FOREIGN KEY ("salon_id") REFERENCES "salons"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row-Level Security: the salon (or a platform admin) sees its own row; public-read transactions see rows of APPROVED salons.
ALTER TABLE "salon_qr_codes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "salon_qr_codes" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "salon_qr_codes"
  USING      ("salon_id" = app_current_salon_id() OR app_is_platform_admin())
  WITH CHECK ("salon_id" = app_current_salon_id() OR app_is_platform_admin());
CREATE POLICY "public_read_approved" ON "salon_qr_codes" FOR SELECT
  USING (app_public_read() AND EXISTS (SELECT 1 FROM "salons" s WHERE s."id" = "salon_qr_codes"."salon_id" AND s."status" = 'APPROVED'));

-- Guard: a code is created only for an APPROVED salon and is permanent (nobody, not even an admin, can change it).
CREATE OR REPLACE FUNCTION salon_qr_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  current_status "salon_status";
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT s.status INTO current_status FROM salons s WHERE s.id = NEW.salon_id;
    IF current_status IS DISTINCT FROM 'APPROVED' THEN
      RAISE EXCEPTION 'a salon link can only be created for an approved salon' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'a salon link is permanent and cannot be changed' USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER "salon_qr_guard_trg" BEFORE INSERT OR UPDATE ON "salon_qr_codes"
  FOR EACH ROW EXECUTE FUNCTION salon_qr_guard();

-- Creates the code when a salon becomes APPROVED (also on reactivation: the existing code is kept). Never blocks the approval.
CREATE OR REPLACE FUNCTION salon_qr_on_approved() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  attempt int := 0;
BEGIN
  LOOP
    attempt := attempt + 1;
    BEGIN
      INSERT INTO salon_qr_codes (salon_id, code) VALUES (NEW.id, salon_qr_new_code()) ON CONFLICT ("salon_id") DO NOTHING;
      RETURN NULL;
    EXCEPTION
      WHEN unique_violation THEN
        IF attempt >= 5 THEN
          RAISE WARNING 'salon link for % was not created (code collision)', NEW.id;
          RETURN NULL;
        END IF;
      WHEN OTHERS THEN
        RAISE WARNING 'salon link for % was not created (%)', NEW.id, SQLSTATE;
        RETURN NULL;
    END;
  END LOOP;
END;
$$;
CREATE TRIGGER "salon_qr_on_approved_trg" AFTER INSERT OR UPDATE OF "status" ON "salons"
  FOR EACH ROW WHEN (NEW."status" = 'APPROVED') EXECUTE FUNCTION salon_qr_on_approved();

-- Backfill: salons approved before this migration (the migrator role is subject to RLS too, so act as platform admin).
SELECT set_config('app.is_platform_admin', 'true', false);
INSERT INTO "salon_qr_codes" ("salon_id", "code")
  SELECT s."id", salon_qr_new_code() FROM "salons" s WHERE s."status" = 'APPROVED'
  ON CONFLICT ("salon_id") DO NOTHING;
SELECT set_config('app.is_platform_admin', 'false', false);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'salon_app') THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON "salon_qr_codes" FROM salon_app;
    REVOKE ALL ON FUNCTION salon_qr_new_code(), salon_qr_guard(), salon_qr_on_approved() FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION salon_qr_new_code(), salon_qr_guard(), salon_qr_on_approved() TO salon_app;
  END IF;
  -- Supabase Data API lock-down.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON "salon_qr_codes" FROM anon;
    REVOKE ALL ON FUNCTION salon_qr_new_code(), salon_qr_guard(), salon_qr_on_approved() FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON "salon_qr_codes" FROM authenticated;
    REVOKE ALL ON FUNCTION salon_qr_new_code(), salon_qr_guard(), salon_qr_on_approved() FROM authenticated;
  END IF;
END
$$;
