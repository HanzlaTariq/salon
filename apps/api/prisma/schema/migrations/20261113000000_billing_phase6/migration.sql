-- Phase 6: subscription plans, per-staff invoices, manual payment verification, prorated top-ups and credits.
-- Hand-written SQL is the source of truth for CHECK constraints, guard triggers, RLS policies and grants.
--
-- Money rules enforced HERE (not only in the API):
--   * An invoice becomes PAID only when a Super Admin / Finance user approved a payment for it (or its total is 0).
--   * A payment can only be approved/rejected/queried by Super Admin or Finance (role read from `users`, never from the client).
--   * A salon subscription period can only grow when a PAID invoice for exactly that period exists.
--   * Plans, credits and staff snapshots are append-only. Invoices, payments and subscriptions are never deleted.
--   * A transaction id can be used for ONE live payment per payment method (stops one receipt paying for many salons).

-- ---------------------------------------------------------------------------------------------
-- 1) Helpers
-- ---------------------------------------------------------------------------------------------
-- Role of the CURRENT user as stored in the database (NULL for owners, staff, customers and anonymous contexts).
CREATE OR REPLACE FUNCTION app_platform_role() RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT u."role"::text FROM "users" u
  WHERE u."id" = app_current_user_id() AND u."status" = 'ACTIVE' AND u."role" IN ('SUPER_ADMIN', 'SUPPORT', 'FINANCE')
$$;

-- True only inside a platform-admin context AND when the stored role is one of `roles`.
CREATE OR REPLACE FUNCTION app_platform_role_in(roles text[]) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT app_is_platform_admin() AND COALESCE(app_platform_role() = ANY (roles), false)
$$;

CREATE OR REPLACE FUNCTION billing_block_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only (% blocked)', TG_TABLE_NAME, TG_OP USING ERRCODE = 'insufficient_privilege';
END;
$$;

-- ---------------------------------------------------------------------------------------------
-- 2) Platform configuration: price versions, promotions, payment instructions
-- ---------------------------------------------------------------------------------------------
CREATE TABLE "subscription_plans" (
    "id"                      UUID NOT NULL DEFAULT gen_random_uuid(),
    "monthly_price_per_staff" NUMERIC(12,2) NOT NULL,
    "yearly_price_per_staff"  NUMERIC(12,2) NOT NULL,
    "currency"                CHAR(3) NOT NULL DEFAULT 'PKR',
    "grace_days"              SMALLINT NOT NULL,
    "renewal_notice_days"     SMALLINT NOT NULL,
    "effective_from"          TIMESTAMPTZ(6) NOT NULL,
    "note"                    VARCHAR(300),
    "created_by"              UUID NOT NULL,
    "created_at"              TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "subscription_plans_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "subscription_plans_monthly_range" CHECK ("monthly_price_per_staff" BETWEEN 1 AND 1000000),
    CONSTRAINT "subscription_plans_yearly_range" CHECK ("yearly_price_per_staff" BETWEEN 1 AND 10000000),
    CONSTRAINT "subscription_plans_currency" CHECK ("currency" = 'PKR'),
    CONSTRAINT "subscription_plans_grace" CHECK ("grace_days" BETWEEN 0 AND 60),
    CONSTRAINT "subscription_plans_notice" CHECK ("renewal_notice_days" BETWEEN 1 AND 60)
);
CREATE INDEX "subscription_plans_effective_idx" ON "subscription_plans"("effective_from" DESC, "created_at" DESC);
ALTER TABLE "subscription_plans" ADD CONSTRAINT "subscription_plans_created_by_fkey"
  FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE TRIGGER "subscription_plans_append_only" BEFORE UPDATE OR DELETE ON "subscription_plans"
  FOR EACH ROW EXECUTE FUNCTION billing_block_mutation();

CREATE TABLE "subscription_promotions" (
    "id"          UUID NOT NULL DEFAULT gen_random_uuid(),
    "name"        VARCHAR(80) NOT NULL,
    "percent_off" NUMERIC(5,2) NOT NULL,
    "applies_to"  VARCHAR(7) NOT NULL DEFAULT 'ANY',
    "starts_on"   DATE NOT NULL,
    "ends_on"     DATE,
    "is_active"   BOOLEAN NOT NULL DEFAULT true,
    "created_by"  UUID NOT NULL,
    "created_at"  TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at"  TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "subscription_promotions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "subscription_promotions_percent" CHECK ("percent_off" > 0 AND "percent_off" <= 100),
    CONSTRAINT "subscription_promotions_applies" CHECK ("applies_to" IN ('MONTHLY', 'YEARLY', 'ANY')),
    CONSTRAINT "subscription_promotions_dates" CHECK ("ends_on" IS NULL OR "ends_on" >= "starts_on"),
    CONSTRAINT "subscription_promotions_name" CHECK (char_length(btrim("name")) >= 2)
);
ALTER TABLE "subscription_promotions" ADD CONSTRAINT "subscription_promotions_created_by_fkey"
  FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "payment_methods" (
    "id"             UUID NOT NULL DEFAULT gen_random_uuid(),
    "method"         VARCHAR(14) NOT NULL,
    "account_title"  VARCHAR(80) NOT NULL,
    "account_number" VARCHAR(40) NOT NULL,
    "bank_name"      VARCHAR(80),
    "instructions"   VARCHAR(500),
    "is_active"      BOOLEAN NOT NULL DEFAULT true,
    "sort_order"     SMALLINT NOT NULL DEFAULT 0,
    "created_by"     UUID NOT NULL,
    "created_at"     TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at"     TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "payment_methods_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "payment_methods_method" CHECK ("method" IN ('JAZZCASH', 'EASYPAISA', 'BANK_TRANSFER')),
    CONSTRAINT "payment_methods_bank_needs_name" CHECK ("method" <> 'BANK_TRANSFER' OR "bank_name" IS NOT NULL),
    CONSTRAINT "payment_methods_title" CHECK (char_length(btrim("account_title")) >= 2),
    CONSTRAINT "payment_methods_number" CHECK (char_length(btrim("account_number")) >= 4)
);
ALTER TABLE "payment_methods" ADD CONSTRAINT "payment_methods_created_by_fkey"
  FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------------------------
-- 3) Salon subscription (one per salon), invoices, payments, credits, staff snapshots
-- ---------------------------------------------------------------------------------------------
CREATE TABLE "salon_subscriptions" (
    "id"                      UUID NOT NULL DEFAULT gen_random_uuid(),
    "salon_id"                UUID NOT NULL,
    "status"                  VARCHAR(10) NOT NULL DEFAULT 'ACTIVE',
    "billing_cycle"           VARCHAR(7) NOT NULL,
    "period_start"            DATE NOT NULL,
    "period_end"              DATE NOT NULL,
    "covered_staff_count"     INTEGER NOT NULL,
    "period_unit_price"       NUMERIC(12,2) NOT NULL,
    "period_discount_percent" NUMERIC(5,2) NOT NULL DEFAULT 0,
    "period_grace_days"       SMALLINT NOT NULL DEFAULT 0,
    "suspended_reason"        VARCHAR(500),
    "suspended_at"            TIMESTAMPTZ(6),
    "created_at"              TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at"              TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "salon_subscriptions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "salon_subscriptions_status" CHECK ("status" IN ('ACTIVE', 'SUSPENDED')),
    CONSTRAINT "salon_subscriptions_cycle" CHECK ("billing_cycle" IN ('MONTHLY', 'YEARLY')),
    CONSTRAINT "salon_subscriptions_period" CHECK ("period_end" > "period_start"),
    CONSTRAINT "salon_subscriptions_covered" CHECK ("covered_staff_count" >= 0),
    CONSTRAINT "salon_subscriptions_price" CHECK ("period_unit_price" >= 0),
    CONSTRAINT "salon_subscriptions_discount" CHECK ("period_discount_percent" BETWEEN 0 AND 100),
    CONSTRAINT "salon_subscriptions_grace" CHECK ("period_grace_days" BETWEEN 0 AND 60),
    CONSTRAINT "salon_subscriptions_suspended_consistent" CHECK (("status" = 'SUSPENDED') = ("suspended_at" IS NOT NULL))
);
CREATE UNIQUE INDEX "salon_subscriptions_salon_key" ON "salon_subscriptions"("salon_id");
CREATE INDEX "salon_subscriptions_period_end_idx" ON "salon_subscriptions"("period_end");
ALTER TABLE "salon_subscriptions" ADD CONSTRAINT "salon_subscriptions_salon_fkey"
  FOREIGN KEY ("salon_id") REFERENCES "salons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE SEQUENCE "invoice_no_seq";

CREATE TABLE "invoices" (
    "id"                       UUID NOT NULL DEFAULT gen_random_uuid(),
    "salon_id"                 UUID NOT NULL,
    "invoice_no"               VARCHAR(24) NOT NULL
      DEFAULT ('INV-' || to_char(now() AT TIME ZONE 'Asia/Karachi', 'YYYY') || '-' || lpad(nextval('invoice_no_seq')::text, 6, '0')),
    "kind"                     VARCHAR(14) NOT NULL,
    "status"                   VARCHAR(6) NOT NULL DEFAULT 'OPEN',
    "billing_cycle"            VARCHAR(7) NOT NULL,
    "staff_count"              INTEGER NOT NULL,
    "unit_price"               NUMERIC(12,2) NOT NULL,
    "discount_percent"         NUMERIC(5,2) NOT NULL DEFAULT 0,
    "promotion_id"             UUID,
    "promotion_name"           VARCHAR(80),
    "plan_id"                  UUID,
    "grace_days"               SMALLINT NOT NULL DEFAULT 0,
    "proration_days_remaining" SMALLINT,
    "proration_days_total"     SMALLINT,
    "subtotal"                 NUMERIC(12,2) NOT NULL,
    "discount_amount"          NUMERIC(12,2) NOT NULL DEFAULT 0,
    "credit_applied"           NUMERIC(12,2) NOT NULL DEFAULT 0,
    "total"                    NUMERIC(12,2) NOT NULL,
    "currency"                 CHAR(3) NOT NULL DEFAULT 'PKR',
    "period_start"             DATE,
    "period_end"               DATE,
    "issued_at"                TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "paid_at"                  TIMESTAMPTZ(6),
    "voided_at"                TIMESTAMPTZ(6),
    "void_reason"              VARCHAR(300),
    "created_by"               UUID NOT NULL,
    "created_at"               TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "invoices_kind" CHECK ("kind" IN ('INITIAL', 'RENEWAL', 'TOP_UP', 'COMPLIMENTARY')),
    CONSTRAINT "invoices_status" CHECK ("status" IN ('OPEN', 'PAID', 'VOID')),
    CONSTRAINT "invoices_cycle" CHECK ("billing_cycle" IN ('MONTHLY', 'YEARLY')),
    CONSTRAINT "invoices_staff_count" CHECK ("staff_count" >= 0 AND ("kind" = 'COMPLIMENTARY' OR "staff_count" >= 1)),
    CONSTRAINT "invoices_unit_price" CHECK ("unit_price" >= 0),
    CONSTRAINT "invoices_discount_percent" CHECK ("discount_percent" BETWEEN 0 AND 100),
    CONSTRAINT "invoices_amounts" CHECK ("subtotal" >= 0 AND "discount_amount" >= 0 AND "credit_applied" >= 0 AND "total" >= 0
                                         AND "discount_amount" <= "subtotal"),
    CONSTRAINT "invoices_total_consistent" CHECK ("total" = "subtotal" - "discount_amount" - "credit_applied"),
    CONSTRAINT "invoices_currency" CHECK ("currency" = 'PKR'),
    CONSTRAINT "invoices_status_consistent" CHECK (("status" = 'PAID') = ("paid_at" IS NOT NULL) AND ("status" = 'VOID') = ("voided_at" IS NOT NULL)),
    CONSTRAINT "invoices_period_consistent" CHECK (("period_start" IS NULL) = ("period_end" IS NULL) AND ("period_end" IS NULL OR "period_end" > "period_start")),
    CONSTRAINT "invoices_paid_has_period" CHECK ("status" <> 'PAID' OR "period_end" IS NOT NULL),
    CONSTRAINT "invoices_topup_shape" CHECK ("kind" <> 'TOP_UP' OR ("proration_days_remaining" IS NOT NULL AND "proration_days_total" IS NOT NULL AND "period_end" IS NOT NULL)),
    CONSTRAINT "invoices_void_reason" CHECK ("status" <> 'VOID' OR char_length(btrim(COALESCE("void_reason", ''))) >= 3)
);
CREATE UNIQUE INDEX "invoices_invoice_no_key" ON "invoices"("invoice_no");
CREATE UNIQUE INDEX "invoices_salon_id_id_key" ON "invoices"("salon_id", "id");
-- At most ONE open main invoice and ONE open top-up per salon.
CREATE UNIQUE INDEX "invoices_one_open_main" ON "invoices"("salon_id") WHERE "status" = 'OPEN' AND "kind" IN ('INITIAL', 'RENEWAL');
CREATE UNIQUE INDEX "invoices_one_open_topup" ON "invoices"("salon_id") WHERE "status" = 'OPEN' AND "kind" = 'TOP_UP';
CREATE INDEX "invoices_salon_issued_idx" ON "invoices"("salon_id", "issued_at" DESC);
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_salon_fkey"
  FOREIGN KEY ("salon_id") REFERENCES "salons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_plan_fkey"
  FOREIGN KEY ("plan_id") REFERENCES "subscription_plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_promotion_fkey"
  FOREIGN KEY ("promotion_id") REFERENCES "subscription_promotions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_created_by_fkey"
  FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "payments" (
    "id"                  UUID NOT NULL DEFAULT gen_random_uuid(),
    "salon_id"            UUID NOT NULL,
    "invoice_id"          UUID NOT NULL,
    "method"              VARCHAR(14) NOT NULL,
    "transaction_id"      VARCHAR(40) NOT NULL,
    "claimed_amount"      NUMERIC(12,2) NOT NULL,
    "paid_on"             DATE NOT NULL,
    "sender_name"         VARCHAR(80),
    "note"                VARCHAR(300),
    "receipt_key"         VARCHAR(300) NOT NULL,
    "receipt_content_type" VARCHAR(60) NOT NULL,
    "receipt_size_bytes"  INTEGER NOT NULL,
    "receipt_sha256"      CHAR(64) NOT NULL,
    "status"              VARCHAR(12) NOT NULL DEFAULT 'PENDING',
    "submitted_by"        UUID NOT NULL,
    "submitted_at"        TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "reviewed_by"         UUID,
    "reviewed_at"         TIMESTAMPTZ(6),
    "review_reason"       VARCHAR(500),
    "received_amount"     NUMERIC(12,2),
    "updated_at"          TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "payments_method" CHECK ("method" IN ('JAZZCASH', 'EASYPAISA', 'BANK_TRANSFER')),
    CONSTRAINT "payments_status" CHECK ("status" IN ('PENDING', 'NEEDS_INFO', 'APPROVED', 'REJECTED')),
    CONSTRAINT "payments_txn_format" CHECK ("transaction_id" ~ '^[A-Za-z0-9][A-Za-z0-9._/-]{3,39}$'),
    CONSTRAINT "payments_claimed_positive" CHECK ("claimed_amount" > 0),
    CONSTRAINT "payments_receipt_size" CHECK ("receipt_size_bytes" > 0 AND "receipt_size_bytes" <= 10485760),
    CONSTRAINT "payments_approved_complete" CHECK ("status" <> 'APPROVED' OR ("received_amount" IS NOT NULL AND "reviewed_by" IS NOT NULL AND "reviewed_at" IS NOT NULL)),
    CONSTRAINT "payments_reason_required" CHECK ("status" NOT IN ('REJECTED', 'NEEDS_INFO') OR char_length(btrim(COALESCE("review_reason", ''))) >= 3)
);
CREATE UNIQUE INDEX "payments_receipt_key_key" ON "payments"("receipt_key");
-- One live payment per invoice, and one live use per (method, transaction id) across ALL salons.
CREATE UNIQUE INDEX "payments_one_live_per_invoice" ON "payments"("invoice_id") WHERE "status" IN ('PENDING', 'NEEDS_INFO', 'APPROVED');
CREATE UNIQUE INDEX "payments_txn_unique_live" ON "payments"("method", lower("transaction_id")) WHERE "status" IN ('PENDING', 'NEEDS_INFO', 'APPROVED');
CREATE INDEX "payments_queue_idx" ON "payments"("status", "submitted_at");
CREATE INDEX "payments_salon_idx" ON "payments"("salon_id", "submitted_at" DESC);
ALTER TABLE "payments" ADD CONSTRAINT "payments_invoice_fkey"
  FOREIGN KEY ("salon_id", "invoice_id") REFERENCES "invoices"("salon_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "payments" ADD CONSTRAINT "payments_submitted_by_fkey"
  FOREIGN KEY ("submitted_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "payments" ADD CONSTRAINT "payments_reviewed_by_fkey"
  FOREIGN KEY ("reviewed_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "salon_credits" (
    "id"         UUID NOT NULL DEFAULT gen_random_uuid(),
    "salon_id"   UUID NOT NULL,
    "amount"     NUMERIC(12,2) NOT NULL,
    "reason"     VARCHAR(24) NOT NULL,
    "invoice_id" UUID,
    "note"       VARCHAR(200),
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "salon_credits_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "salon_credits_amount" CHECK ("amount" <> 0),
    CONSTRAINT "salon_credits_reason" CHECK (
      ("amount" > 0 AND "reason" IN ('STAFF_REMOVED', 'INVOICE_VOIDED', 'STALE_TOPUP_PAYMENT'))
      OR ("amount" < 0 AND "reason" = 'APPLIED_TO_INVOICE')
    ),
    CONSTRAINT "salon_credits_invoice_link" CHECK ("reason" = 'STAFF_REMOVED' OR "invoice_id" IS NOT NULL)
);
CREATE INDEX "salon_credits_salon_idx" ON "salon_credits"("salon_id", "created_at");
ALTER TABLE "salon_credits" ADD CONSTRAINT "salon_credits_salon_fkey"
  FOREIGN KEY ("salon_id") REFERENCES "salons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "salon_credits" ADD CONSTRAINT "salon_credits_invoice_fkey"
  FOREIGN KEY ("salon_id", "invoice_id") REFERENCES "invoices"("salon_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "salon_credits" ADD CONSTRAINT "salon_credits_created_by_fkey"
  FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE TRIGGER "salon_credits_append_only" BEFORE UPDATE OR DELETE ON "salon_credits"
  FOR EACH ROW EXECUTE FUNCTION billing_block_mutation();

-- History of the billable staff count (requirement: keep historical records of staff count and charges).
CREATE TABLE "subscription_staff_snapshots" (
    "id"              UUID NOT NULL DEFAULT gen_random_uuid(),
    "salon_id"        UUID NOT NULL,
    "billable_staff"  INTEGER NOT NULL,
    "covered_staff"   INTEGER,
    "reason"          VARCHAR(16) NOT NULL,
    "invoice_id"      UUID,
    "created_at"      TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "subscription_staff_snapshots_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "subscription_staff_snapshots_reason" CHECK ("reason" IN ('INVOICE', 'ACTIVATION', 'STAFF_CHANGE')),
    CONSTRAINT "subscription_staff_snapshots_counts" CHECK ("billable_staff" >= 0 AND ("covered_staff" IS NULL OR "covered_staff" >= 0))
);
CREATE INDEX "subscription_staff_snapshots_salon_idx" ON "subscription_staff_snapshots"("salon_id", "created_at");
ALTER TABLE "subscription_staff_snapshots" ADD CONSTRAINT "subscription_staff_snapshots_salon_fkey"
  FOREIGN KEY ("salon_id") REFERENCES "salons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE TRIGGER "subscription_staff_snapshots_append_only" BEFORE UPDATE OR DELETE ON "subscription_staff_snapshots"
  FOR EACH ROW EXECUTE FUNCTION billing_block_mutation();

-- ---------------------------------------------------------------------------------------------
-- 4) Guard triggers (defence in depth: they hold even if an API bug tried something else)
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION invoices_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'COMPLIMENTARY' AND NOT app_platform_role_in(ARRAY['SUPER_ADMIN']) THEN
      RAISE EXCEPTION 'only a Super Admin can grant a complimentary period' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW."status" <> 'OPEN' AND NEW."total" <> 0 THEN
      RAISE EXCEPTION 'a new invoice with an amount due must start OPEN' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD."status" <> 'OPEN' THEN
    RAISE EXCEPTION 'a % invoice cannot change', OLD."status" USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."salon_id" <> OLD."salon_id" OR NEW."invoice_no" <> OLD."invoice_no" OR NEW."kind" <> OLD."kind"
     OR NEW."billing_cycle" <> OLD."billing_cycle" OR NEW."staff_count" <> OLD."staff_count"
     OR NEW."unit_price" <> OLD."unit_price" OR NEW."discount_percent" <> OLD."discount_percent"
     OR NEW."subtotal" <> OLD."subtotal" OR NEW."discount_amount" <> OLD."discount_amount"
     OR NEW."credit_applied" <> OLD."credit_applied" OR NEW."total" <> OLD."total" OR NEW."currency" <> OLD."currency"
     OR NEW."issued_at" <> OLD."issued_at" OR NEW."created_by" <> OLD."created_by" OR NEW."grace_days" <> OLD."grace_days"
     OR NEW."plan_id" IS DISTINCT FROM OLD."plan_id" OR NEW."promotion_id" IS DISTINCT FROM OLD."promotion_id" THEN
    RAISE EXCEPTION 'invoice amounts are immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."status" = OLD."status" THEN
    RAISE EXCEPTION 'invoice fields cannot be edited' USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF NEW."status" = 'PAID' THEN
    IF OLD."period_start" IS NOT NULL AND (NEW."period_start" <> OLD."period_start" OR NEW."period_end" <> OLD."period_end") THEN
      RAISE EXCEPTION 'the invoice period is fixed' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW."total" > 0 THEN
      IF NOT app_platform_role_in(ARRAY['SUPER_ADMIN', 'FINANCE']) THEN
        RAISE EXCEPTION 'only Super Admin or Finance can mark an invoice paid' USING ERRCODE = 'insufficient_privilege';
      END IF;
      IF NOT EXISTS (SELECT 1 FROM "payments" p WHERE p."invoice_id" = NEW."id" AND p."status" = 'APPROVED') THEN
        RAISE EXCEPTION 'an invoice is paid only after a payment was approved' USING ERRCODE = 'integrity_constraint_violation';
      END IF;
    END IF;
  ELSIF NEW."status" = 'VOID' THEN
    IF app_platform_role() IS NOT NULL AND NOT app_platform_role_in(ARRAY['SUPER_ADMIN']) THEN
      RAISE EXCEPTION 'only a Super Admin can void an invoice' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW."period_start" IS DISTINCT FROM OLD."period_start" OR NEW."period_end" IS DISTINCT FROM OLD."period_end" THEN
      RAISE EXCEPTION 'the invoice period is fixed' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM "payments" p WHERE p."invoice_id" = NEW."id" AND p."status" IN ('PENDING', 'NEEDS_INFO', 'APPROVED')) THEN
      RAISE EXCEPTION 'an invoice with a live payment cannot be voided' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  ELSE
    RAISE EXCEPTION 'illegal invoice transition' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "invoices_guard_trg" BEFORE INSERT OR UPDATE ON "invoices" FOR EACH ROW EXECUTE FUNCTION invoices_guard();
CREATE TRIGGER "invoices_no_delete" BEFORE DELETE ON "invoices" FOR EACH ROW EXECUTE FUNCTION billing_block_mutation();

CREATE OR REPLACE FUNCTION payments_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  inv_total NUMERIC(12,2);
  inv_status VARCHAR(6);
  reviewer BOOLEAN := app_platform_role_in(ARRAY['SUPER_ADMIN', 'FINANCE']);
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'PENDING' OR NEW."reviewed_by" IS NOT NULL OR NEW."reviewed_at" IS NOT NULL
       OR NEW."review_reason" IS NOT NULL OR NEW."received_amount" IS NOT NULL THEN
      RAISE EXCEPTION 'a payment is submitted as PENDING' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW."submitted_by" IS DISTINCT FROM app_current_user_id() THEN
      RAISE EXCEPTION 'a payment can only be submitted by the signed-in user' USING ERRCODE = 'insufficient_privilege';
    END IF;
    SELECT i."total", i."status" INTO inv_total, inv_status FROM "invoices" i WHERE i."id" = NEW."invoice_id" AND i."salon_id" = NEW."salon_id";
    IF inv_status IS DISTINCT FROM 'OPEN' OR inv_total IS NULL OR inv_total <= 0 THEN
      RAISE EXCEPTION 'payments can only be submitted for an open invoice with an amount due' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW."claimed_amount" <> inv_total THEN
      RAISE EXCEPTION 'the payment amount must equal the invoice total' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD."status" IN ('APPROVED', 'REJECTED') THEN
    RAISE EXCEPTION 'a % payment cannot change', OLD."status" USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."salon_id" <> OLD."salon_id" OR NEW."invoice_id" <> OLD."invoice_id" OR NEW."method" <> OLD."method"
     OR NEW."claimed_amount" <> OLD."claimed_amount" OR NEW."submitted_by" <> OLD."submitted_by" OR NEW."submitted_at" <> OLD."submitted_at" THEN
    RAISE EXCEPTION 'payment identity and amount are immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF reviewer THEN
    -- Reviewers decide; they never edit what the owner submitted.
    IF NEW."transaction_id" <> OLD."transaction_id" OR NEW."receipt_key" <> OLD."receipt_key" OR NEW."paid_on" <> OLD."paid_on"
       OR NEW."sender_name" IS DISTINCT FROM OLD."sender_name" OR NEW."note" IS DISTINCT FROM OLD."note"
       OR NEW."receipt_sha256" <> OLD."receipt_sha256" THEN
      RAISE EXCEPTION 'reviewers cannot edit the submitted details' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW."reviewed_by" IS DISTINCT FROM app_current_user_id() THEN
      RAISE EXCEPTION 'the reviewer must be the signed-in user' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NOT ((OLD."status" = 'PENDING' AND NEW."status" IN ('APPROVED', 'REJECTED', 'NEEDS_INFO'))
         OR (OLD."status" = 'NEEDS_INFO' AND NEW."status" = 'REJECTED')) THEN
      RAISE EXCEPTION 'illegal payment transition % -> %', OLD."status", NEW."status" USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW."status" = 'APPROVED' THEN
      SELECT i."total" INTO inv_total FROM "invoices" i WHERE i."id" = NEW."invoice_id";
      IF NEW."received_amount" IS DISTINCT FROM inv_total THEN
        RAISE EXCEPTION 'the received amount must equal the invoice total' USING ERRCODE = 'integrity_constraint_violation';
      END IF;
    END IF;
  ELSIF app_platform_role() IS NOT NULL THEN
    RAISE EXCEPTION 'this role cannot change payments' USING ERRCODE = 'insufficient_privilege';
  ELSE
    -- Owner: may only answer an information request (NEEDS_INFO -> PENDING). Review fields are untouchable.
    IF OLD."status" <> 'NEEDS_INFO' OR NEW."status" <> 'PENDING' THEN
      RAISE EXCEPTION 'owners can only respond to an information request' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW."reviewed_by" IS DISTINCT FROM OLD."reviewed_by" OR NEW."reviewed_at" IS DISTINCT FROM OLD."reviewed_at"
       OR NEW."review_reason" IS DISTINCT FROM OLD."review_reason" OR NEW."received_amount" IS DISTINCT FROM OLD."received_amount" THEN
      RAISE EXCEPTION 'review fields cannot be changed by the owner' USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "payments_guard_trg" BEFORE INSERT OR UPDATE ON "payments" FOR EACH ROW EXECUTE FUNCTION payments_guard();
CREATE TRIGGER "payments_no_delete" BEFORE DELETE ON "payments" FOR EACH ROW EXECUTE FUNCTION billing_block_mutation();

CREATE OR REPLACE FUNCTION salon_subscriptions_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW."period_end" <> OLD."period_end" OR NEW."period_start" <> OLD."period_start" THEN
    IF TG_OP = 'UPDATE' AND NEW."period_end" < OLD."period_end" THEN
      RAISE EXCEPTION 'a subscription period cannot be shortened' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM "invoices" i
      WHERE i."salon_id" = NEW."salon_id" AND i."status" = 'PAID' AND i."kind" IN ('INITIAL', 'RENEWAL', 'COMPLIMENTARY')
        AND i."period_start" = NEW."period_start" AND i."period_end" = NEW."period_end"
    ) THEN
      RAISE EXCEPTION 'a subscription period needs a paid invoice for exactly that period' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW."status" <> OLD."status" AND NOT app_platform_role_in(ARRAY['SUPER_ADMIN']) THEN
    RAISE EXCEPTION 'only a Super Admin can suspend or reactivate a subscription' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'INSERT' AND NEW."status" <> 'ACTIVE' THEN
    RAISE EXCEPTION 'a subscription starts ACTIVE' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "salon_subscriptions_guard_trg" BEFORE INSERT OR UPDATE ON "salon_subscriptions"
  FOR EACH ROW EXECUTE FUNCTION salon_subscriptions_guard();
CREATE TRIGGER "salon_subscriptions_no_delete" BEFORE DELETE ON "salon_subscriptions"
  FOR EACH ROW EXECUTE FUNCTION billing_block_mutation();

-- Credit balance can never go below zero. Billing writes lock the salon row first, so this check is serialised per salon.
CREATE OR REPLACE FUNCTION salon_credits_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  bal NUMERIC(12,2);
BEGIN
  SELECT COALESCE(SUM(c."amount"), 0) INTO bal FROM "salon_credits" c WHERE c."salon_id" = NEW."salon_id";
  IF bal + NEW."amount" < 0 THEN
    RAISE EXCEPTION 'the credit balance cannot go below zero' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "salon_credits_guard_trg" BEFORE INSERT ON "salon_credits" FOR EACH ROW EXECUTE FUNCTION salon_credits_guard();

-- ---------------------------------------------------------------------------------------------
-- 5) Row-Level Security
-- ---------------------------------------------------------------------------------------------
-- Platform configuration: readable by any signed-in context; written by Super Admin only.
ALTER TABLE "subscription_plans" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "subscription_plans" FORCE ROW LEVEL SECURITY;
CREATE POLICY "read_signed_in" ON "subscription_plans" FOR SELECT USING (app_current_user_id() IS NOT NULL);
CREATE POLICY "insert_super_admin" ON "subscription_plans" FOR INSERT WITH CHECK (app_platform_role_in(ARRAY['SUPER_ADMIN']));

ALTER TABLE "subscription_promotions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "subscription_promotions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "read_signed_in" ON "subscription_promotions" FOR SELECT USING (app_current_user_id() IS NOT NULL);
CREATE POLICY "insert_super_admin" ON "subscription_promotions" FOR INSERT WITH CHECK (app_platform_role_in(ARRAY['SUPER_ADMIN']));
CREATE POLICY "update_super_admin" ON "subscription_promotions" FOR UPDATE
  USING (app_platform_role_in(ARRAY['SUPER_ADMIN'])) WITH CHECK (app_platform_role_in(ARRAY['SUPER_ADMIN']));

ALTER TABLE "payment_methods" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payment_methods" FORCE ROW LEVEL SECURITY;
CREATE POLICY "read_signed_in" ON "payment_methods" FOR SELECT USING (app_current_user_id() IS NOT NULL);
CREATE POLICY "insert_super_admin" ON "payment_methods" FOR INSERT WITH CHECK (app_platform_role_in(ARRAY['SUPER_ADMIN']));
CREATE POLICY "update_super_admin" ON "payment_methods" FOR UPDATE
  USING (app_platform_role_in(ARRAY['SUPER_ADMIN'])) WITH CHECK (app_platform_role_in(ARRAY['SUPER_ADMIN']));

-- Salon-owned billing tables. Owner: own salon only. Platform: any admin can read; Super Admin / Finance can write.
-- (Support has NO write access at database level: continues risk R20 for the billing tables.)
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['salon_subscriptions', 'invoices', 'payments', 'salon_credits', 'subscription_staff_snapshots'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY "owner_read" ON %I FOR SELECT USING ("salon_id" = app_current_salon_id() AND app_owns_salon("salon_id"))$p$, t);
    EXECUTE format($p$CREATE POLICY "owner_insert" ON %I FOR INSERT WITH CHECK ("salon_id" = app_current_salon_id() AND app_owns_salon("salon_id"))$p$, t);
    EXECUTE format($p$CREATE POLICY "platform_read" ON %I FOR SELECT USING (app_is_platform_admin())$p$, t);
    EXECUTE format($p$CREATE POLICY "platform_insert" ON %I FOR INSERT WITH CHECK (app_platform_role_in(ARRAY['SUPER_ADMIN', 'FINANCE']))$p$, t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['salon_subscriptions', 'invoices'] LOOP
    EXECUTE format($p$CREATE POLICY "owner_update" ON %I FOR UPDATE USING ("salon_id" = app_current_salon_id() AND app_owns_salon("salon_id")) WITH CHECK ("salon_id" = app_current_salon_id() AND app_owns_salon("salon_id"))$p$, t);
    EXECUTE format($p$CREATE POLICY "platform_update" ON %I FOR UPDATE USING (app_platform_role_in(ARRAY['SUPER_ADMIN', 'FINANCE'])) WITH CHECK (app_platform_role_in(ARRAY['SUPER_ADMIN', 'FINANCE']))$p$, t);
  END LOOP;
END
$$;
-- Payments: the owner may answer an information request on their own payment; reviewers decide.
CREATE POLICY "owner_respond" ON "payments" FOR UPDATE
  USING ("salon_id" = app_current_salon_id() AND app_owns_salon("salon_id") AND "status" = 'NEEDS_INFO')
  WITH CHECK ("salon_id" = app_current_salon_id() AND app_owns_salon("salon_id") AND "status" = 'PENDING');
CREATE POLICY "platform_review" ON "payments" FOR UPDATE
  USING (app_platform_role_in(ARRAY['SUPER_ADMIN', 'FINANCE'])) WITH CHECK (app_platform_role_in(ARRAY['SUPER_ADMIN', 'FINANCE']));

-- ---------------------------------------------------------------------------------------------
-- 6) Grants. Nothing in Phase 6 is ever hard-deleted by the runtime role. The Supabase Data API stays shut.
-- ---------------------------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'salon_app') THEN
    REVOKE UPDATE, DELETE ON "subscription_plans", "salon_credits", "subscription_staff_snapshots" FROM salon_app;
    REVOKE DELETE ON "subscription_promotions", "payment_methods", "salon_subscriptions", "invoices", "payments" FROM salon_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON "subscription_plans", "subscription_promotions", "payment_methods", "salon_subscriptions", "invoices", "payments",
      "salon_credits", "subscription_staff_snapshots" FROM anon;
    REVOKE ALL ON SEQUENCE "invoice_no_seq" FROM anon;
    REVOKE ALL ON FUNCTION app_platform_role(), app_platform_role_in(text[]), billing_block_mutation(), invoices_guard(),
      payments_guard(), salon_subscriptions_guard(), salon_credits_guard() FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON "subscription_plans", "subscription_promotions", "payment_methods", "salon_subscriptions", "invoices", "payments",
      "salon_credits", "subscription_staff_snapshots" FROM authenticated;
    REVOKE ALL ON SEQUENCE "invoice_no_seq" FROM authenticated;
    REVOKE ALL ON FUNCTION app_platform_role(), app_platform_role_in(text[]), billing_block_mutation(), invoices_guard(),
      payments_guard(), salon_subscriptions_guard(), salon_credits_guard() FROM authenticated;
  END IF;
END
$$;
