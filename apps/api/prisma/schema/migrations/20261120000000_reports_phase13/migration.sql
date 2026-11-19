-- Phase 13: reports and analytics.
-- Additive: no earlier migration is edited. Hand-written SQL is the source of truth for CHECK constraints, the guard trigger,
-- RLS policies and grants (Prisma cannot express them).
--
-- What this migration adds:
--   * salon_expenses: the salon's own costs (rent, salaries, supplies ...). Salon revenue is NEVER stored: it is always computed from
--     COMPLETED appointments (price snapshots), so a report can never drift from the bookings.
--     Privacy: ONLY the salon owner can read or write expenses. There is deliberately NO policy for staff, customers, the public
--     context or platform admins (Super Admin / Support / Finance see platform subscription revenue and booking COUNTS, never a
--     salon's costs). Expenses are never hard-deleted by the runtime role (soft delete).
--   * indexes that keep the report queries fast (salon revenue, staff performance, retention, platform-wide analytics).

-- ---------------------------------------------------------------------------------------------
-- 1) Expenses
-- ---------------------------------------------------------------------------------------------
CREATE TABLE "salon_expenses" (
    "id"              UUID NOT NULL DEFAULT gen_random_uuid(),
    "salon_id"        UUID NOT NULL,
    "category"        VARCHAR(16) NOT NULL,
    "amount"          NUMERIC(12,2) NOT NULL,
    -- A calendar date in Asia/Karachi (when the money was spent), not a timestamp.
    "expense_date"    DATE NOT NULL,
    "description"     VARCHAR(200),
    "idempotency_key" VARCHAR(64),
    "created_by"      UUID NOT NULL,
    "created_at"      TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at"      TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "deleted_at"      TIMESTAMPTZ(6),
    "deleted_by"      UUID,

    CONSTRAINT "salon_expenses_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "salon_expenses_category_known" CHECK ("category" IN
      ('RENT', 'SALARIES', 'UTILITIES', 'SUPPLIES', 'MARKETING', 'EQUIPMENT', 'MAINTENANCE', 'TAXES_FEES', 'OTHER')),
    CONSTRAINT "salon_expenses_amount_range" CHECK ("amount" >= 0.01 AND "amount" <= 100000000),
    CONSTRAINT "salon_expenses_date_floor" CHECK ("expense_date" >= DATE '2020-01-01'),
    CONSTRAINT "salon_expenses_description_len" CHECK ("description" IS NULL OR char_length(btrim("description")) BETWEEN 1 AND 200),
    CONSTRAINT "salon_expenses_other_needs_description" CHECK ("category" <> 'OTHER' OR "description" IS NOT NULL),
    CONSTRAINT "salon_expenses_idempotency_len" CHECK ("idempotency_key" IS NULL OR char_length("idempotency_key") BETWEEN 8 AND 64),
    CONSTRAINT "salon_expenses_delete_consistent" CHECK (("deleted_at" IS NULL) = ("deleted_by" IS NULL))
);

ALTER TABLE "salon_expenses"
  ADD CONSTRAINT "salon_expenses_salon_fkey" FOREIGN KEY ("salon_id") REFERENCES "salons"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "salon_expenses_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "salon_expenses_deleted_by_fkey" FOREIGN KEY ("deleted_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "salon_expenses_salon_date_idx" ON "salon_expenses"("salon_id", "expense_date") WHERE "deleted_at" IS NULL;
-- A retried "add expense" (flaky mobile network) can never create a second row.
CREATE UNIQUE INDEX "salon_expenses_idempotency" ON "salon_expenses"("salon_id", "idempotency_key") WHERE "idempotency_key" IS NOT NULL;

CREATE OR REPLACE FUNCTION salon_expenses_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  today date := (now() AT TIME ZONE 'Asia/Karachi')::date;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.expense_date > today THEN
      RAISE EXCEPTION 'an expense cannot be dated in the future' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.deleted_at IS NOT NULL THEN
      RAISE EXCEPTION 'an expense cannot be created as deleted' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE
  IF OLD.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'a deleted expense can no longer be changed' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.id <> OLD.id OR NEW.salon_id <> OLD.salon_id OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key THEN
    RAISE EXCEPTION 'expense identity fields cannot be changed' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.expense_date <> OLD.expense_date AND NEW.expense_date > today THEN
    RAISE EXCEPTION 'an expense cannot be dated in the future' USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;
CREATE TRIGGER "salon_expenses_guard_trg" BEFORE INSERT OR UPDATE ON "salon_expenses"
  FOR EACH ROW EXECUTE FUNCTION salon_expenses_guard();

-- ---------------------------------------------------------------------------------------------
-- 2) Row-Level Security: owner only (fail closed for everyone else)
-- ---------------------------------------------------------------------------------------------
ALTER TABLE "salon_expenses" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "salon_expenses" FORCE ROW LEVEL SECURITY;
CREATE POLICY "owner_all" ON "salon_expenses"
  USING      ("salon_id" = app_current_salon_id() AND app_owns_salon("salon_id"))
  WITH CHECK ("salon_id" = app_current_salon_id() AND app_owns_salon("salon_id") AND "created_by" = app_current_user_id());

-- ---------------------------------------------------------------------------------------------
-- 3) Indexes for the report queries (all additive, all IF NOT EXISTS-free on purpose: a clash must fail loudly)
-- ---------------------------------------------------------------------------------------------
-- Platform-wide analytics scan appointments by time across salons.
CREATE INDEX "appointments_starts_at_idx" ON "appointments"("starts_at");
-- Salon revenue: completed appointments of one salon in a time range, answered from the index alone.
CREATE INDEX "appointments_completed_idx" ON "appointments"("salon_id", "starts_at") INCLUDE ("total_price", "source") WHERE "status" = 'COMPLETED';
-- Staff performance (all statuses of one staff member in a time range).
CREATE INDEX "appointments_staff_day_idx" ON "appointments"("staff_id", "starts_at");
-- Retention: first / repeat visits of a customer at a salon.
CREATE INDEX "appointments_retention_idx" ON "appointments"("salon_id", "customer_user_id", "starts_at") WHERE "status" = 'COMPLETED' AND "customer_user_id" IS NOT NULL;
-- New registrations per period.
CREATE INDEX "users_role_created_idx" ON "users"("role", "created_at");
-- Verified platform revenue per month.
CREATE INDEX "payments_approved_idx" ON "payments"("reviewed_at") WHERE "status" = 'APPROVED';

-- ---------------------------------------------------------------------------------------------
-- 4) Grants. Expenses are soft-deleted only. The Supabase Data API stays shut for the new table and function.
-- ---------------------------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'salon_app') THEN
    REVOKE DELETE ON "salon_expenses" FROM salon_app;
    REVOKE ALL ON FUNCTION salon_expenses_guard() FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION salon_expenses_guard() TO salon_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON "salon_expenses" FROM anon;
    REVOKE ALL ON FUNCTION salon_expenses_guard() FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON "salon_expenses" FROM authenticated;
    REVOKE ALL ON FUNCTION salon_expenses_guard() FROM authenticated;
  END IF;
END
$$;
