import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Tx, likePattern } from '../salons/salons.repository';
import { BillingCycle, InvoiceKind, InvoiceStatus, PaymentMethodKind, PaymentStatus, Phase, SubscriptionStatus, fromPaisa } from './billing.types';

/**
 * SQL for Phase 6. Everything is parameterized and tenant-scoped through the caller's `TenantDb.withTenant`
 * transaction (RLS is the second line of defence). Rows are read as `to_jsonb(row)` so that dates arrive as
 * "YYYY-MM-DD" strings and NUMERIC arrives exact; `m()` turns it into a fixed 2-decimal string, and every
 * calculation afterwards happens in integer paisa (billing.types.ts). No money value is ever used as a float.
 */
type J = Record<string, any>;

const m = (v: unknown): string => fromPaisa(Math.round(Number(v) * 100));
const d = (v: unknown): string | null => (v === null || v === undefined ? null : String(v).slice(0, 10));
const ts = (v: unknown): Date | null => (v === null || v === undefined ? null : new Date(String(v)));
const tsReq = (v: unknown): Date => new Date(String(v));

export interface PlanRecord {
  id: string; monthlyPrice: string; yearlyPrice: string; currency: string; graceDays: number; renewalNoticeDays: number;
  effectiveFrom: Date; note: string | null; createdBy: string; createdAt: Date;
}
export interface PromotionRecord {
  id: string; name: string; percentOff: number; appliesTo: BillingCycle | 'ANY'; startsOn: string; endsOn: string | null; isActive: boolean; createdAt: Date;
}
export interface PaymentMethodRecord {
  id: string; method: PaymentMethodKind; accountTitle: string; accountNumber: string; bankName: string | null; instructions: string | null;
  isActive: boolean; sortOrder: number;
}
export interface SubscriptionRecord {
  id: string; salonId: string; status: SubscriptionStatus; billingCycle: BillingCycle; periodStart: string; periodEnd: string;
  coveredStaffCount: number; periodUnitPrice: string; periodDiscountPercent: number; periodGraceDays: number;
  suspendedReason: string | null; suspendedAt: Date | null;
}
export interface InvoiceRecord {
  id: string; salonId: string; invoiceNo: string; kind: InvoiceKind; status: InvoiceStatus; billingCycle: BillingCycle; staffCount: number;
  unitPrice: string; discountPercent: number; promotionName: string | null; planId: string | null; graceDays: number;
  prorationDaysRemaining: number | null; prorationDaysTotal: number | null;
  subtotal: string; discountAmount: string; creditApplied: string; total: string;
  periodStart: string | null; periodEnd: string | null; issuedAt: Date; paidAt: Date | null; voidedAt: Date | null; voidReason: string | null;
  livePaymentId: string | null; livePaymentStatus: PaymentStatus | null;
}
export interface PaymentRecord {
  id: string; salonId: string; invoiceId: string; method: PaymentMethodKind; transactionId: string; claimedAmount: string; paidOn: string;
  senderName: string | null; note: string | null; receiptKey: string; receiptContentType: string; receiptSizeBytes: number;
  status: PaymentStatus; submittedBy: string; submittedAt: Date; reviewedBy: string | null; reviewedAt: Date | null;
  reviewReason: string | null; receivedAmount: string | null;
}
export interface AdminPaymentRow extends PaymentRecord {
  salonName: string; salonCity: string; invoiceNo: string; invoiceKind: InvoiceKind; invoiceTotal: string; billingCycle: BillingCycle;
}
export interface CreditRecord { id: string; amount: string; reason: string; invoiceId: string | null; note: string | null; createdAt: Date }
export interface AdminSubscriptionRow {
  salonId: string; salonName: string; city: string; salonStatus: string; ownerName: string; ownerEmail: string; phase: Phase;
  billingCycle: BillingCycle | null; periodStart: string | null; periodEnd: string | null; coveredStaff: number | null;
  billableStaff: number; openInvoiceTotal: string | null; openInvoiceNo: string | null;
}
export interface OverviewStats {
  phases: Record<Phase, number>; pendingPayments: number; pendingAmount: string; mrr: string; revenueThisMonth: string; revenueThisYear: string;
}
export interface AuditTrailRow { action: string; actorRole: string | null; createdAt: Date; reason: string | null }

const plan = (r: J): PlanRecord => ({
  id: r.id, monthlyPrice: m(r.monthly_price_per_staff), yearlyPrice: m(r.yearly_price_per_staff), currency: r.currency, graceDays: r.grace_days,
  renewalNoticeDays: r.renewal_notice_days, effectiveFrom: tsReq(r.effective_from), note: r.note, createdBy: r.created_by, createdAt: tsReq(r.created_at),
});
const promotion = (r: J): PromotionRecord => ({
  id: r.id, name: r.name, percentOff: Number(r.percent_off), appliesTo: r.applies_to, startsOn: d(r.starts_on) as string, endsOn: d(r.ends_on),
  isActive: r.is_active, createdAt: tsReq(r.created_at),
});
const method = (r: J): PaymentMethodRecord => ({
  id: r.id, method: r.method, accountTitle: r.account_title, accountNumber: r.account_number, bankName: r.bank_name, instructions: r.instructions,
  isActive: r.is_active, sortOrder: r.sort_order,
});
const subscription = (r: J): SubscriptionRecord => ({
  id: r.id, salonId: r.salon_id, status: r.status, billingCycle: r.billing_cycle, periodStart: d(r.period_start) as string, periodEnd: d(r.period_end) as string,
  coveredStaffCount: r.covered_staff_count, periodUnitPrice: m(r.period_unit_price), periodDiscountPercent: Number(r.period_discount_percent),
  periodGraceDays: r.period_grace_days, suspendedReason: r.suspended_reason, suspendedAt: ts(r.suspended_at),
});
const invoice = (r: J): InvoiceRecord => ({
  id: r.id, salonId: r.salon_id, invoiceNo: r.invoice_no, kind: r.kind, status: r.status, billingCycle: r.billing_cycle, staffCount: r.staff_count,
  unitPrice: m(r.unit_price), discountPercent: Number(r.discount_percent), promotionName: r.promotion_name, planId: r.plan_id, graceDays: r.grace_days,
  prorationDaysRemaining: r.proration_days_remaining, prorationDaysTotal: r.proration_days_total,
  subtotal: m(r.subtotal), discountAmount: m(r.discount_amount), creditApplied: m(r.credit_applied), total: m(r.total),
  periodStart: d(r.period_start), periodEnd: d(r.period_end), issuedAt: tsReq(r.issued_at), paidAt: ts(r.paid_at), voidedAt: ts(r.voided_at),
  voidReason: r.void_reason, livePaymentId: r.live_payment_id ?? null, livePaymentStatus: r.live_payment_status ?? null,
});
const payment = (r: J): PaymentRecord => ({
  id: r.id, salonId: r.salon_id, invoiceId: r.invoice_id, method: r.method, transactionId: r.transaction_id, claimedAmount: m(r.claimed_amount),
  paidOn: d(r.paid_on) as string, senderName: r.sender_name, note: r.note, receiptKey: r.receipt_key, receiptContentType: r.receipt_content_type,
  receiptSizeBytes: r.receipt_size_bytes, status: r.status, submittedBy: r.submitted_by, submittedAt: tsReq(r.submitted_at), reviewedBy: r.reviewed_by,
  reviewedAt: ts(r.reviewed_at), reviewReason: r.review_reason, receivedAmount: r.received_amount === null || r.received_amount === undefined ? null : m(r.received_amount),
});

@Injectable()
export class BillingRepository {
  constructor(private readonly prisma: PrismaService) {}

  // ------------------------------------------------------------------ plans / promotions / payment methods
  async currentPlan(tx: Tx, now: Date): Promise<PlanRecord | null> {
    const r = await tx.$queryRaw<J[]>`
      SELECT to_jsonb(p) AS j FROM subscription_plans p WHERE p.effective_from <= ${now}::timestamptz
      ORDER BY p.effective_from DESC, p.created_at DESC, p.id DESC LIMIT 1`;
    return r[0] ? plan(r[0].j) : null;
  }

  async listPlans(tx: Tx, limit: number): Promise<PlanRecord[]> {
    const r = await tx.$queryRaw<J[]>`
      SELECT to_jsonb(p) AS j FROM subscription_plans p ORDER BY p.effective_from DESC, p.created_at DESC, p.id DESC LIMIT ${limit}::int`;
    return r.map((x) => plan(x.j));
  }

  async insertPlan(tx: Tx, p: { monthly: string; yearly: string; graceDays: number; renewalNoticeDays: number; effectiveFrom: Date; note: string | null; createdBy: string }): Promise<PlanRecord> {
    const r = await tx.$queryRaw<J[]>`
      INSERT INTO subscription_plans (monthly_price_per_staff, yearly_price_per_staff, grace_days, renewal_notice_days, effective_from, note, created_by)
      VALUES (${p.monthly}::numeric, ${p.yearly}::numeric, ${p.graceDays}::smallint, ${p.renewalNoticeDays}::smallint, ${p.effectiveFrom}::timestamptz,
              ${p.note}::varchar, ${p.createdBy}::uuid)
      RETURNING to_jsonb(subscription_plans) AS j`;
    return plan(r[0].j);
  }

  async listPromotions(tx: Tx): Promise<PromotionRecord[]> {
    const r = await tx.$queryRaw<J[]>`SELECT to_jsonb(p) AS j FROM subscription_promotions p ORDER BY p.is_active DESC, p.starts_on DESC, p.created_at DESC`;
    return r.map((x) => promotion(x.j));
  }

  async insertPromotion(tx: Tx, p: { name: string; percentOff: string; appliesTo: string; startsOn: string; endsOn: string | null; createdBy: string }): Promise<PromotionRecord> {
    const r = await tx.$queryRaw<J[]>`
      INSERT INTO subscription_promotions (name, percent_off, applies_to, starts_on, ends_on, created_by)
      VALUES (${p.name}::varchar, ${p.percentOff}::numeric, ${p.appliesTo}::varchar, ${p.startsOn}::date, ${p.endsOn}::date, ${p.createdBy}::uuid)
      RETURNING to_jsonb(subscription_promotions) AS j`;
    return promotion(r[0].j);
  }

  async setPromotionActive(tx: Tx, id: string, isActive: boolean, now: Date): Promise<PromotionRecord | null> {
    const r = await tx.$queryRaw<J[]>`
      UPDATE subscription_promotions SET is_active = ${isActive}::boolean, updated_at = ${now}::timestamptz WHERE id = ${id}::uuid
      RETURNING to_jsonb(subscription_promotions) AS j`;
    return r[0] ? promotion(r[0].j) : null;
  }

  async listPaymentMethods(tx: Tx, onlyActive: boolean): Promise<PaymentMethodRecord[]> {
    const r = await tx.$queryRaw<J[]>`
      SELECT to_jsonb(p) AS j FROM payment_methods p WHERE (${onlyActive}::boolean = false OR p.is_active = true)
      ORDER BY p.sort_order, p.created_at`;
    return r.map((x) => method(x.j));
  }

  async insertPaymentMethod(tx: Tx, p: { method: string; accountTitle: string; accountNumber: string; bankName: string | null; instructions: string | null; sortOrder: number; createdBy: string }): Promise<PaymentMethodRecord> {
    const r = await tx.$queryRaw<J[]>`
      INSERT INTO payment_methods (method, account_title, account_number, bank_name, instructions, sort_order, created_by)
      VALUES (${p.method}::varchar, ${p.accountTitle}::varchar, ${p.accountNumber}::varchar, ${p.bankName}::varchar, ${p.instructions}::varchar,
              ${p.sortOrder}::smallint, ${p.createdBy}::uuid)
      RETURNING to_jsonb(payment_methods) AS j`;
    return method(r[0].j);
  }

  async findPaymentMethod(tx: Tx, id: string): Promise<PaymentMethodRecord | null> {
    const r = await tx.$queryRaw<J[]>`SELECT to_jsonb(p) AS j FROM payment_methods p WHERE p.id = ${id}::uuid`;
    return r[0] ? method(r[0].j) : null;
  }

  async updatePaymentMethod(tx: Tx, id: string, p: { accountTitle: string; accountNumber: string; bankName: string | null; instructions: string | null; isActive: boolean; sortOrder: number }, now: Date): Promise<PaymentMethodRecord | null> {
    const r = await tx.$queryRaw<J[]>`
      UPDATE payment_methods SET account_title = ${p.accountTitle}::varchar, account_number = ${p.accountNumber}::varchar, bank_name = ${p.bankName}::varchar,
             instructions = ${p.instructions}::varchar, is_active = ${p.isActive}::boolean, sort_order = ${p.sortOrder}::smallint, updated_at = ${now}::timestamptz
      WHERE id = ${id}::uuid RETURNING to_jsonb(payment_methods) AS j`;
    return r[0] ? method(r[0].j) : null;
  }

  // ------------------------------------------------------------------ subscription, staff count, credits
  async findSubscription(tx: Tx, salonId: string): Promise<SubscriptionRecord | null> {
    const r = await tx.$queryRaw<J[]>`SELECT to_jsonb(s) AS j FROM salon_subscriptions s WHERE s.salon_id = ${salonId}::uuid`;
    return r[0] ? subscription(r[0].j) : null;
  }

  async insertSubscription(tx: Tx, s: { salonId: string; cycle: BillingCycle; periodStart: string; periodEnd: string; covered: number; unitPrice: string; discountPercent: number; graceDays: number }): Promise<SubscriptionRecord> {
    const r = await tx.$queryRaw<J[]>`
      INSERT INTO salon_subscriptions (salon_id, billing_cycle, period_start, period_end, covered_staff_count, period_unit_price, period_discount_percent, period_grace_days)
      VALUES (${s.salonId}::uuid, ${s.cycle}::varchar, ${s.periodStart}::date, ${s.periodEnd}::date, ${s.covered}::int, ${s.unitPrice}::numeric,
              ${s.discountPercent}::numeric, ${s.graceDays}::smallint)
      RETURNING to_jsonb(salon_subscriptions) AS j`;
    return subscription(r[0].j);
  }

  async renewSubscription(tx: Tx, s: { salonId: string; cycle: BillingCycle; periodStart: string; periodEnd: string; covered: number; unitPrice: string; discountPercent: number; graceDays: number }, now: Date): Promise<SubscriptionRecord> {
    const r = await tx.$queryRaw<J[]>`
      UPDATE salon_subscriptions SET billing_cycle = ${s.cycle}::varchar, period_start = ${s.periodStart}::date, period_end = ${s.periodEnd}::date,
             covered_staff_count = ${s.covered}::int, period_unit_price = ${s.unitPrice}::numeric, period_discount_percent = ${s.discountPercent}::numeric,
             period_grace_days = ${s.graceDays}::smallint, updated_at = ${now}::timestamptz
      WHERE salon_id = ${s.salonId}::uuid RETURNING to_jsonb(salon_subscriptions) AS j`;
    return subscription(r[0].j);
  }

  async setCovered(tx: Tx, salonId: string, covered: number, now: Date): Promise<void> {
    await tx.$executeRaw`UPDATE salon_subscriptions SET covered_staff_count = ${covered}::int, updated_at = ${now}::timestamptz WHERE salon_id = ${salonId}::uuid`;
  }

  async setSubscriptionStatus(tx: Tx, salonId: string, status: SubscriptionStatus, reason: string | null, now: Date): Promise<SubscriptionRecord | null> {
    const r = await tx.$queryRaw<J[]>`
      UPDATE salon_subscriptions
      SET status = ${status}::varchar, suspended_reason = ${status === 'SUSPENDED' ? reason : null}::varchar,
          suspended_at = ${status === 'SUSPENDED' ? now : null}::timestamptz, updated_at = ${now}::timestamptz
      WHERE salon_id = ${salonId}::uuid RETURNING to_jsonb(salon_subscriptions) AS j`;
    return r[0] ? subscription(r[0].j) : null;
  }

  /** Billable = active AND performs services; the owner counts once (one staff_profiles row per person). Mirrors billingSummary(). */
  async billableCount(tx: Tx, salonId: string): Promise<number> {
    const r = await tx.$queryRaw<J[]>`
      SELECT count(*)::int AS n FROM staff_profiles WHERE salon_id = ${salonId}::uuid AND deleted_at IS NULL AND is_active = true AND performs_services = true`;
    return Number(r[0].n);
  }

  async creditBalance(tx: Tx, salonId: string): Promise<string> {
    const r = await tx.$queryRaw<J[]>`SELECT COALESCE(SUM(amount), 0)::text AS bal FROM salon_credits WHERE salon_id = ${salonId}::uuid`;
    return m(r[0].bal);
  }

  async insertCredit(tx: Tx, c: { salonId: string; amount: string; reason: string; invoiceId: string | null; note: string | null; createdBy: string }): Promise<void> {
    await tx.$executeRaw`
      INSERT INTO salon_credits (salon_id, amount, reason, invoice_id, note, created_by)
      VALUES (${c.salonId}::uuid, ${c.amount}::numeric, ${c.reason}::varchar, ${c.invoiceId}::uuid, ${c.note}::varchar, ${c.createdBy}::uuid)`;
  }

  async listCredits(tx: Tx, salonId: string, limit: number): Promise<CreditRecord[]> {
    const r = await tx.$queryRaw<J[]>`SELECT to_jsonb(c) AS j FROM salon_credits c WHERE c.salon_id = ${salonId}::uuid ORDER BY c.created_at DESC, c.id DESC LIMIT ${limit}::int`;
    return r.map((x) => ({ id: x.j.id, amount: m(x.j.amount), reason: x.j.reason, invoiceId: x.j.invoice_id, note: x.j.note, createdAt: tsReq(x.j.created_at) }));
  }

  /** Appends a snapshot only when the billable/covered numbers changed (keeps the history meaningful, not noisy). */
  async snapshotStaff(tx: Tx, s: { salonId: string; billable: number; covered: number | null; reason: 'INVOICE' | 'ACTIVATION' | 'STAFF_CHANGE'; invoiceId: string | null }): Promise<void> {
    await tx.$executeRaw`
      INSERT INTO subscription_staff_snapshots (salon_id, billable_staff, covered_staff, reason, invoice_id)
      SELECT ${s.salonId}::uuid, ${s.billable}::int, ${s.covered}::int, ${s.reason}::varchar, ${s.invoiceId}::uuid
      WHERE ${s.reason}::varchar <> 'STAFF_CHANGE' OR NOT EXISTS (
        SELECT 1 FROM (SELECT billable_staff, covered_staff FROM subscription_staff_snapshots WHERE salon_id = ${s.salonId}::uuid
                       ORDER BY created_at DESC, id DESC LIMIT 1) last
        WHERE last.billable_staff = ${s.billable}::int AND last.covered_staff IS NOT DISTINCT FROM ${s.covered}::int)`;
  }

  async listSnapshots(tx: Tx, salonId: string, limit: number): Promise<Array<{ billableStaff: number; coveredStaff: number | null; reason: string; createdAt: Date }>> {
    const r = await tx.$queryRaw<J[]>`SELECT to_jsonb(s) AS j FROM subscription_staff_snapshots s WHERE s.salon_id = ${salonId}::uuid ORDER BY s.created_at DESC, s.id DESC LIMIT ${limit}::int`;
    return r.map((x) => ({ billableStaff: x.j.billable_staff, coveredStaff: x.j.covered_staff, reason: x.j.reason, createdAt: tsReq(x.j.created_at) }));
  }

  // ------------------------------------------------------------------ invoices
  async insertInvoice(tx: Tx, i: {
    salonId: string; kind: InvoiceKind; status: InvoiceStatus; cycle: BillingCycle; staffCount: number; unitPrice: string; discountPercent: number;
    promotionId: string | null; promotionName: string | null; planId: string | null; graceDays: number; prorationRemaining: number | null; prorationTotal: number | null;
    subtotal: string; discountAmount: string; creditApplied: string; total: string; periodStart: string | null; periodEnd: string | null; paidAt: Date | null; createdBy: string;
  }): Promise<string> {
    const r = await tx.$queryRaw<J[]>`
      INSERT INTO invoices (salon_id, kind, status, billing_cycle, staff_count, unit_price, discount_percent, promotion_id, promotion_name, plan_id, grace_days,
                            proration_days_remaining, proration_days_total, subtotal, discount_amount, credit_applied, total, period_start, period_end, paid_at, created_by)
      VALUES (${i.salonId}::uuid, ${i.kind}::varchar, ${i.status}::varchar, ${i.cycle}::varchar, ${i.staffCount}::int, ${i.unitPrice}::numeric, ${i.discountPercent}::numeric,
              ${i.promotionId}::uuid, ${i.promotionName}::varchar, ${i.planId}::uuid, ${i.graceDays}::smallint, ${i.prorationRemaining}::smallint, ${i.prorationTotal}::smallint,
              ${i.subtotal}::numeric, ${i.discountAmount}::numeric, ${i.creditApplied}::numeric, ${i.total}::numeric, ${i.periodStart}::date, ${i.periodEnd}::date,
              ${i.paidAt}::timestamptz, ${i.createdBy}::uuid)
      RETURNING id`;
    return r[0].id as string;
  }

  async findInvoice(tx: Tx, id: string, opts: { lock?: boolean } = {}): Promise<InvoiceRecord | null> {
    if (opts.lock) await tx.$queryRaw`SELECT id FROM invoices WHERE id = ${id}::uuid FOR UPDATE`;
    const r = await tx.$queryRaw<J[]>`
      SELECT to_jsonb(i) || jsonb_build_object('live_payment_id', lp.id, 'live_payment_status', lp.status) AS j
      FROM invoices i
      LEFT JOIN LATERAL (SELECT p.id, p.status FROM payments p WHERE p.invoice_id = i.id AND p.status IN ('PENDING', 'NEEDS_INFO', 'APPROVED')
                         ORDER BY p.submitted_at DESC LIMIT 1) lp ON true
      WHERE i.id = ${id}::uuid`;
    return r[0] ? invoice(r[0].j) : null;
  }

  async listInvoices(tx: Tx, salonId: string, limit: number, offset: number): Promise<InvoiceRecord[]> {
    const r = await tx.$queryRaw<J[]>`
      SELECT to_jsonb(i) || jsonb_build_object('live_payment_id', lp.id, 'live_payment_status', lp.status) AS j
      FROM invoices i
      LEFT JOIN LATERAL (SELECT p.id, p.status FROM payments p WHERE p.invoice_id = i.id AND p.status IN ('PENDING', 'NEEDS_INFO', 'APPROVED')
                         ORDER BY p.submitted_at DESC LIMIT 1) lp ON true
      WHERE i.salon_id = ${salonId}::uuid ORDER BY i.issued_at DESC, i.id DESC LIMIT ${limit}::int OFFSET ${offset}::int`;
    return r.map((x) => invoice(x.j));
  }

  async findOpenInvoice(tx: Tx, salonId: string, top: boolean): Promise<InvoiceRecord | null> {
    const r = await tx.$queryRaw<J[]>`
      SELECT to_jsonb(i) || jsonb_build_object('live_payment_id', lp.id, 'live_payment_status', lp.status) AS j
      FROM invoices i
      LEFT JOIN LATERAL (SELECT p.id, p.status FROM payments p WHERE p.invoice_id = i.id AND p.status IN ('PENDING', 'NEEDS_INFO', 'APPROVED')
                         ORDER BY p.submitted_at DESC LIMIT 1) lp ON true
      WHERE i.salon_id = ${salonId}::uuid AND i.status = 'OPEN' AND ((${top}::boolean AND i.kind = 'TOP_UP') OR (NOT ${top}::boolean AND i.kind IN ('INITIAL', 'RENEWAL')))
      LIMIT 1`;
    return r[0] ? invoice(r[0].j) : null;
  }

  async markInvoicePaid(tx: Tx, id: string, period: { start: string; end: string }, now: Date): Promise<void> {
    await tx.$executeRaw`
      UPDATE invoices SET status = 'PAID', paid_at = ${now}::timestamptz, period_start = ${period.start}::date, period_end = ${period.end}::date WHERE id = ${id}::uuid`;
  }

  async voidInvoice(tx: Tx, id: string, reason: string, now: Date): Promise<void> {
    await tx.$executeRaw`UPDATE invoices SET status = 'VOID', voided_at = ${now}::timestamptz, void_reason = ${reason}::varchar WHERE id = ${id}::uuid`;
  }

  // ------------------------------------------------------------------ payments
  async insertPayment(tx: Tx, p: {
    id: string; salonId: string; invoiceId: string; method: PaymentMethodKind; transactionId: string; claimedAmount: string; paidOn: string;
    senderName: string | null; note: string | null; receiptKey: string; receiptContentType: string; receiptSizeBytes: number; receiptSha256: string; submittedBy: string;
  }): Promise<void> {
    await tx.$executeRaw`
      INSERT INTO payments (id, salon_id, invoice_id, method, transaction_id, claimed_amount, paid_on, sender_name, note, receipt_key, receipt_content_type,
                            receipt_size_bytes, receipt_sha256, submitted_by)
      VALUES (${p.id}::uuid, ${p.salonId}::uuid, ${p.invoiceId}::uuid, ${p.method}::varchar, ${p.transactionId}::varchar, ${p.claimedAmount}::numeric, ${p.paidOn}::date,
              ${p.senderName}::varchar, ${p.note}::varchar, ${p.receiptKey}::varchar, ${p.receiptContentType}::varchar, ${p.receiptSizeBytes}::int,
              ${p.receiptSha256}::varchar, ${p.submittedBy}::uuid)`;
  }

  async findPayment(tx: Tx, id: string, opts: { lock?: boolean } = {}): Promise<PaymentRecord | null> {
    if (opts.lock) await tx.$queryRaw`SELECT id FROM payments WHERE id = ${id}::uuid FOR UPDATE`;
    const r = await tx.$queryRaw<J[]>`SELECT to_jsonb(p) AS j FROM payments p WHERE p.id = ${id}::uuid`;
    return r[0] ? payment(r[0].j) : null;
  }

  async listPaymentsForSalon(tx: Tx, salonId: string, limit: number): Promise<PaymentRecord[]> {
    const r = await tx.$queryRaw<J[]>`SELECT to_jsonb(p) AS j FROM payments p WHERE p.salon_id = ${salonId}::uuid ORDER BY p.submitted_at DESC, p.id DESC LIMIT ${limit}::int`;
    return r.map((x) => payment(x.j));
  }

  /** Owner answers an information request. `receipt` is set only when a new image replaced the old one. */
  async respondToInfoRequest(tx: Tx, id: string, p: { transactionId: string; note: string | null; receipt: { key: string; contentType: string; sizeBytes: number; sha256: string } | null }, now: Date): Promise<boolean> {
    const n = await tx.$executeRaw`
      UPDATE payments SET status = 'PENDING', transaction_id = ${p.transactionId}::varchar, note = ${p.note}::varchar,
             receipt_key = COALESCE(${p.receipt?.key ?? null}::varchar, receipt_key),
             receipt_content_type = COALESCE(${p.receipt?.contentType ?? null}::varchar, receipt_content_type),
             receipt_size_bytes = COALESCE(${p.receipt?.sizeBytes ?? null}::int, receipt_size_bytes),
             receipt_sha256 = COALESCE(${p.receipt?.sha256 ?? null}::varchar, receipt_sha256), updated_at = ${now}::timestamptz
      WHERE id = ${id}::uuid AND status = 'NEEDS_INFO'`;
    return n === 1;
  }

  async reviewPayment(tx: Tx, id: string, r: { status: 'APPROVED' | 'REJECTED' | 'NEEDS_INFO'; reviewerId: string; reason: string | null; receivedAmount: string | null }, now: Date): Promise<boolean> {
    const n = await tx.$executeRaw`
      UPDATE payments SET status = ${r.status}::varchar, reviewed_by = ${r.reviewerId}::uuid, reviewed_at = ${now}::timestamptz,
             review_reason = ${r.reason}::varchar, received_amount = ${r.receivedAmount}::numeric, updated_at = ${now}::timestamptz
      WHERE id = ${id}::uuid AND status IN ('PENDING', 'NEEDS_INFO')`;
    return n === 1;
  }

  async adminListPayments(tx: Tx, f: { status?: PaymentStatus; q?: string; limit: number; offset: number }): Promise<{ items: AdminPaymentRow[]; total: number }> {
    const status = f.status ?? null;
    const q = f.q ? likePattern(f.q) : null;
    const rows = await tx.$queryRaw<J[]>`
      SELECT to_jsonb(p) || jsonb_build_object('salon_name', s.name, 'salon_city', s.city, 'invoice_no', i.invoice_no, 'invoice_kind', i.kind,
             'invoice_total', i.total, 'billing_cycle', i.billing_cycle) AS j
      FROM payments p JOIN salons s ON s.id = p.salon_id JOIN invoices i ON i.id = p.invoice_id
      WHERE (${status}::varchar IS NULL OR p.status = ${status}::varchar)
        AND (${q}::varchar IS NULL OR s.name ILIKE ${q}::varchar OR p.transaction_id ILIKE ${q}::varchar OR i.invoice_no ILIKE ${q}::varchar)
      ORDER BY (p.status = 'PENDING') DESC, CASE WHEN p.status = 'PENDING' THEN p.submitted_at END ASC, p.submitted_at DESC, p.id
      LIMIT ${f.limit}::int OFFSET ${f.offset}::int`;
    const c = await tx.$queryRaw<J[]>`
      SELECT count(*)::int AS n FROM payments p JOIN salons s ON s.id = p.salon_id JOIN invoices i ON i.id = p.invoice_id
      WHERE (${status}::varchar IS NULL OR p.status = ${status}::varchar)
        AND (${q}::varchar IS NULL OR s.name ILIKE ${q}::varchar OR p.transaction_id ILIKE ${q}::varchar OR i.invoice_no ILIKE ${q}::varchar)`;
    return { items: rows.map((x) => adminPayment(x.j)), total: Number(c[0].n) };
  }

  async adminFindPayment(tx: Tx, id: string): Promise<AdminPaymentRow | null> {
    const r = await tx.$queryRaw<J[]>`
      SELECT to_jsonb(p) || jsonb_build_object('salon_name', s.name, 'salon_city', s.city, 'invoice_no', i.invoice_no, 'invoice_kind', i.kind,
             'invoice_total', i.total, 'billing_cycle', i.billing_cycle) AS j
      FROM payments p JOIN salons s ON s.id = p.salon_id JOIN invoices i ON i.id = p.invoice_id WHERE p.id = ${id}::uuid`;
    return r[0] ? adminPayment(r[0].j) : null;
  }

  /** Decision trail for one payment (audit_logs is append-only; only non-secret columns are returned). */
  async paymentTrail(tx: Tx, paymentId: string): Promise<AuditTrailRow[]> {
    const r = await tx.$queryRaw<J[]>`
      SELECT action, actor_role, created_at, metadata->>'reason' AS reason FROM audit_logs
      WHERE target_type = 'payment' AND target_id = ${paymentId}::varchar ORDER BY created_at, id`;
    return r.map((x) => ({ action: x.action, actorRole: x.actor_role, createdAt: new Date(x.created_at), reason: x.reason ?? null }));
  }

  // ------------------------------------------------------------------ admin subscriptions and overview
  async adminListSubscriptions(tx: Tx, f: { phase?: Phase; q?: string; today: string; limit: number; offset: number }): Promise<{ items: AdminSubscriptionRow[]; total: number }> {
    const phase = f.phase ?? null;
    const q = f.q ? likePattern(f.q) : null;
    const rows = await tx.$queryRaw<J[]>`
      WITH x AS (
        SELECT s.id AS salon_id, s.name, s.city, s.status::text AS salon_status, u.full_name AS owner_name, u.email AS owner_email,
               sub.billing_cycle, to_char(sub.period_start, 'YYYY-MM-DD') AS period_start, to_char(sub.period_end, 'YYYY-MM-DD') AS period_end,
               sub.covered_staff_count,
               CASE WHEN sub.id IS NULL THEN 'NONE' WHEN sub.status = 'SUSPENDED' THEN 'SUSPENDED'
                    WHEN ${f.today}::date < sub.period_end THEN 'ACTIVE'
                    WHEN ${f.today}::date < sub.period_end + sub.period_grace_days::int THEN 'GRACE' ELSE 'EXPIRED' END AS phase,
               sub.period_end AS period_end_date,
               (SELECT count(*)::int FROM staff_profiles sp WHERE sp.salon_id = s.id AND sp.deleted_at IS NULL AND sp.is_active AND sp.performs_services) AS billable,
               oi.total::text AS open_total, oi.invoice_no AS open_no
        FROM salons s JOIN users u ON u.id = s.owner_user_id
        LEFT JOIN salon_subscriptions sub ON sub.salon_id = s.id
        LEFT JOIN LATERAL (SELECT i.total, i.invoice_no FROM invoices i WHERE i.salon_id = s.id AND i.status = 'OPEN' AND i.kind IN ('INITIAL', 'RENEWAL')
                           ORDER BY i.issued_at DESC LIMIT 1) oi ON true
        WHERE s.status IN ('APPROVED', 'SUSPENDED')
          AND (${q}::varchar IS NULL OR s.name ILIKE ${q}::varchar OR u.email ILIKE ${q}::varchar OR s.city ILIKE ${q}::varchar)
      )
      SELECT *, count(*) OVER()::int AS total_rows FROM x WHERE (${phase}::varchar IS NULL OR phase = ${phase}::varchar)
      ORDER BY CASE phase WHEN 'EXPIRED' THEN 0 WHEN 'GRACE' THEN 1 WHEN 'NONE' THEN 3 ELSE 2 END, period_end_date ASC NULLS LAST, name
      LIMIT ${f.limit}::int OFFSET ${f.offset}::int`;
    return {
      total: rows.length ? Number(rows[0].total_rows) : 0,
      items: rows.map((r) => ({
        salonId: r.salon_id, salonName: r.name, city: r.city, salonStatus: r.salon_status, ownerName: r.owner_name, ownerEmail: r.owner_email, phase: r.phase,
        billingCycle: r.billing_cycle, periodStart: r.period_start, periodEnd: r.period_end, coveredStaff: r.covered_staff_count === null ? null : Number(r.covered_staff_count),
        billableStaff: Number(r.billable), openInvoiceTotal: r.open_total === null ? null : m(r.open_total), openInvoiceNo: r.open_no,
      })),
    };
  }

  async overview(tx: Tx, today: string, monthStart: string, yearStart: string): Promise<OverviewStats> {
    const phases = await tx.$queryRaw<J[]>`
      SELECT CASE WHEN sub.id IS NULL THEN 'NONE' WHEN sub.status = 'SUSPENDED' THEN 'SUSPENDED'
                  WHEN ${today}::date < sub.period_end THEN 'ACTIVE'
                  WHEN ${today}::date < sub.period_end + sub.period_grace_days::int THEN 'GRACE' ELSE 'EXPIRED' END AS phase, count(*)::int AS n
      FROM salons s LEFT JOIN salon_subscriptions sub ON sub.salon_id = s.id WHERE s.status IN ('APPROVED', 'SUSPENDED') GROUP BY 1`;
    const pend = await tx.$queryRaw<J[]>`
      SELECT count(*)::int AS n, COALESCE(SUM(p.claimed_amount), 0)::text AS amount FROM payments p WHERE p.status IN ('PENDING', 'NEEDS_INFO')`;
    const mrr = await tx.$queryRaw<J[]>`
      SELECT COALESCE(SUM(ROUND(sub.covered_staff_count * sub.period_unit_price * (1 - sub.period_discount_percent / 100.0)
                                / CASE sub.billing_cycle WHEN 'YEARLY' THEN 12 ELSE 1 END, 2)), 0)::text AS mrr
      FROM salon_subscriptions sub
      WHERE sub.status = 'ACTIVE' AND ${today}::date < sub.period_end + sub.period_grace_days::int`;
    const rev = await tx.$queryRaw<J[]>`
      SELECT COALESCE(SUM(p.received_amount) FILTER (WHERE p.reviewed_at >= (${monthStart}::date)::timestamp AT TIME ZONE 'Asia/Karachi'), 0)::text AS month,
             COALESCE(SUM(p.received_amount) FILTER (WHERE p.reviewed_at >= (${yearStart}::date)::timestamp AT TIME ZONE 'Asia/Karachi'), 0)::text AS year
      FROM payments p WHERE p.status = 'APPROVED'`;
    const counts: Record<Phase, number> = { NONE: 0, ACTIVE: 0, GRACE: 0, EXPIRED: 0, SUSPENDED: 0 };
    for (const r of phases) counts[r.phase as Phase] = Number(r.n);
    return { phases: counts, pendingPayments: Number(pend[0].n), pendingAmount: m(pend[0].amount), mrr: m(mrr[0].mrr), revenueThisMonth: m(rev[0].month), revenueThisYear: m(rev[0].year) };
  }

  // ------------------------------------------------------------------ people (outside the tenant transaction)
  async listReviewerContacts(): Promise<Array<{ email: string; fullName: string }>> {
    const r = await this.prisma.$queryRaw<J[]>`SELECT email, full_name FROM users WHERE role IN ('SUPER_ADMIN', 'FINANCE') AND status = 'ACTIVE'`;
    return r.map((x) => ({ email: x.email, fullName: x.full_name }));
  }
}

function adminPayment(j: J): AdminPaymentRow {
  return { ...payment(j), salonName: j.salon_name, salonCity: j.salon_city, invoiceNo: j.invoice_no, invoiceKind: j.invoice_kind, invoiceTotal: m(j.invoice_total), billingCycle: j.billing_cycle };
}
