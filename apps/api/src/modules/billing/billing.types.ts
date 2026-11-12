/**
 * Phase 6 pure billing rules: money arithmetic, subscription periods, phases (active / grace / expired),
 * promotions, invoice amounts, proration and the reconcile planner that turns "billable staff changed"
 * into a top-up invoice or a credit. Nothing here touches a database or the clock, so everything is
 * unit-tested exhaustively (billing.types.spec.ts).
 *
 * MONEY IS NEVER A FLOAT. All amounts are integer paisa (Rs. 1 = 100 paisa) inside this file and
 * NUMERIC(12,2) text ("1234.50") at the API/database boundary. Rounding rules (explicit, documented):
 *   - charges (invoice lines, top-ups) round HALF UP to the paisa;
 *   - credits for removed staff round DOWN (the platform never over-credits).
 *
 * DATES are Asia/Karachi calendar dates ("YYYY-MM-DD"). A period covers [start, end): `end` is the first
 * day NOT covered (so a monthly period starting 2026-11-13 ends 2026-12-13).
 */
import { todayInSalonTz } from '../staff/staff.types';

export const BILLING_CYCLES = ['MONTHLY', 'YEARLY'] as const;
export type BillingCycle = (typeof BILLING_CYCLES)[number];

export const PAYMENT_METHODS = ['JAZZCASH', 'EASYPAISA', 'BANK_TRANSFER'] as const;
export type PaymentMethodKind = (typeof PAYMENT_METHODS)[number];

export const INVOICE_KINDS = ['INITIAL', 'RENEWAL', 'TOP_UP', 'COMPLIMENTARY'] as const;
export type InvoiceKind = (typeof INVOICE_KINDS)[number];
export type InvoiceStatus = 'OPEN' | 'PAID' | 'VOID';
export type PaymentStatus = 'PENDING' | 'NEEDS_INFO' | 'APPROVED' | 'REJECTED';
export type SubscriptionStatus = 'ACTIVE' | 'SUSPENDED';
export type Phase = 'NONE' | 'ACTIVE' | 'GRACE' | 'EXPIRED' | 'SUSPENDED';

export const LIVE_PAYMENT_STATUSES: readonly PaymentStatus[] = ['PENDING', 'NEEDS_INFO', 'APPROVED'];

export const BILLING_LIMITS = {
  /** A payment older than this many days is refused (stops recycled old receipts). */
  paymentMaxAgeDays: 60,
  invoicePageSize: 50,
} as const;

// ------------------------------------------------------------------ money

const MONEY_RE = /^-?\d{1,10}(\.\d{1,2})?$/;

/** "1234.5" -> 123450. Throws on anything that is not a plain decimal with at most 2 fraction digits. */
export function toPaisa(value: string): number {
  if (typeof value !== 'string' || !MONEY_RE.test(value)) throw new Error(`invalid money value: ${String(value)}`);
  const negative = value.startsWith('-');
  const [whole, frac = ''] = (negative ? value.slice(1) : value).split('.');
  const paisa = Number(whole) * 100 + Number(frac.padEnd(2, '0'));
  return negative ? -paisa : paisa;
}

/** 123450 -> "1234.50". */
export function fromPaisa(paisa: number): string {
  if (!Number.isSafeInteger(paisa)) throw new Error('paisa must be a safe integer');
  const negative = paisa < 0;
  const abs = Math.abs(paisa);
  const s = `${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
  return negative ? `-${s}` : s;
}

/** Integer division of non-negative numbers, rounding half up. */
export function roundDiv(numerator: number, denominator: number): number {
  if (denominator <= 0 || numerator < 0) throw new Error('roundDiv needs a positive denominator and a non-negative numerator');
  const twice = 2 * numerator + denominator;
  return (twice - (twice % (2 * denominator))) / (2 * denominator);
}

/** Integer division of non-negative numbers, rounding down. */
export function floorDiv(numerator: number, denominator: number): number {
  if (denominator <= 0 || numerator < 0) throw new Error('floorDiv needs a positive denominator and a non-negative numerator');
  return (numerator - (numerator % denominator)) / denominator;
}

/** "12.5" -> 1250 (basis points of a percent with at most 2 decimals: 100.00% = 10000). */
export function percentToBp(percent: number): number {
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) throw new Error('percent must be between 0 and 100');
  return Math.round(percent * 100);
}

// ------------------------------------------------------------------ calendar dates

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function parts(date: string): { y: number; m: number; d: number } {
  const m = ISO_DATE.exec(date);
  if (!m) throw new Error(`invalid date: ${date}`);
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) throw new Error(`invalid date: ${date}`);
  return { y, m: mo, d };
}

const iso = (y: number, m: number, d: number): string => `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const daysInMonth = (y: number, m: number): number => new Date(Date.UTC(y, m, 0)).getUTCDate();

export function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    parts(value);
    return true;
  } catch {
    return false;
  }
}

/** Adds calendar months, clamping the day to the end of the target month (Jan 31 + 1 month = Feb 28/29). */
export function addMonths(date: string, months: number): string {
  const { y, m, d } = parts(date);
  const index = y * 12 + (m - 1) + months;
  const ny = Math.floor(index / 12);
  const nm = (index % 12) + 1;
  return iso(ny, nm, Math.min(d, daysInMonth(ny, nm)));
}

export function addDays(date: string, days: number): string {
  const { y, m, d } = parts(date);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return iso(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

/** Whole days from `a` to `b` (b - a). */
export function diffDays(a: string, b: string): number {
  const pa = parts(a);
  const pb = parts(b);
  return Math.round((Date.UTC(pb.y, pb.m - 1, pb.d) - Date.UTC(pa.y, pa.m - 1, pa.d)) / 86_400_000);
}

export const maxDate = (a: string, b: string): string => (a >= b ? a : b);

/** Today as an Asia/Karachi calendar date. */
export const todayKarachi = (now: Date): string => todayInSalonTz(now);

// ------------------------------------------------------------------ periods and phases

export const cycleEnd = (start: string, cycle: BillingCycle): string => addMonths(start, cycle === 'MONTHLY' ? 1 : 12);

/**
 * The period a newly paid invoice buys. Early renewal continues exactly where the paid period ends (no
 * lost days, no overlap); a renewal after the period ended starts today.
 */
export function nextPeriod(cycle: BillingCycle, currentEnd: string | null, today: string): { start: string; end: string } {
  const start = currentEnd !== null && currentEnd > today ? currentEnd : today;
  return { start, end: cycleEnd(start, cycle) };
}

export interface SubscriptionLike {
  status: SubscriptionStatus;
  periodStart: string;
  periodEnd: string;
  graceDays: number;
}

export function phaseOf(sub: SubscriptionLike | null, today: string): Phase {
  if (!sub) return 'NONE';
  if (sub.status === 'SUSPENDED') return 'SUSPENDED';
  if (today < sub.periodEnd) return 'ACTIVE';
  if (today < addDays(sub.periodEnd, sub.graceDays)) return 'GRACE';
  return 'EXPIRED';
}

/** Later phases (7+) use this to decide whether a salon may take bookings / appear in search. */
export const isOperational = (phase: Phase): boolean => phase === 'ACTIVE' || phase === 'GRACE';

/** Renewal opens `noticeDays` before the paid period ends (or any time once it is not ACTIVE any more). */
export function renewalOpensOn(sub: SubscriptionLike, noticeDays: number): string {
  return addDays(sub.periodEnd, -noticeDays);
}

// ------------------------------------------------------------------ pricing

export interface PlanPrices {
  id: string;
  monthlyPaisa: number;
  yearlyPaisa: number;
  graceDays: number;
  renewalNoticeDays: number;
}

export const unitPriceFor = (plan: PlanPrices, cycle: BillingCycle): number => (cycle === 'MONTHLY' ? plan.monthlyPaisa : plan.yearlyPaisa);

export interface PromotionLike {
  id: string;
  name: string;
  percentOff: number;
  appliesTo: BillingCycle | 'ANY';
  startsOn: string;
  endsOn: string | null;
  isActive: boolean;
}

/** One promotion per invoice: the biggest discount that is active today and matches the cycle (ties: name, then id). */
export function bestPromotion(promos: ReadonlyArray<PromotionLike>, cycle: BillingCycle, today: string): PromotionLike | null {
  const usable = promos.filter(
    (p) => p.isActive && p.startsOn <= today && (p.endsOn === null || today <= p.endsOn) && (p.appliesTo === 'ANY' || p.appliesTo === cycle),
  );
  usable.sort((a, b) => b.percentOff - a.percentOff || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return usable[0] ?? null;
}

/** Net price of ONE staff member for a full period after the percentage discount. */
export function netUnit(unitPaisa: number, percent: number): { discountPerStaff: number; net: number } {
  const discountPerStaff = roundDiv(unitPaisa * percentToBp(percent), 10_000);
  return { discountPerStaff, net: unitPaisa - discountPerStaff };
}

export interface InvoiceAmounts {
  unitPaisa: number;
  staff: number;
  discountPercent: number;
  subtotal: number;
  discountAmount: number;
  creditApplied: number;
  total: number;
}

/** INITIAL / RENEWAL amounts for `staff` billable members for one full period. Credit is spent first. */
export function computeMainInvoice(i: { unitPaisa: number; staff: number; discountPercent: number; creditBalancePaisa: number }): InvoiceAmounts {
  if (!Number.isInteger(i.staff) || i.staff < 1) throw new Error('an invoice needs at least one billable staff member');
  const { discountPerStaff, net } = netUnit(i.unitPaisa, i.discountPercent);
  const subtotal = i.unitPaisa * i.staff;
  const discountAmount = discountPerStaff * i.staff;
  const due = net * i.staff;
  const creditApplied = Math.min(Math.max(0, i.creditBalancePaisa), due);
  return { unitPaisa: i.unitPaisa, staff: i.staff, discountPercent: i.discountPercent, subtotal, discountAmount, creditApplied, total: due - creditApplied };
}

export interface Proration {
  remainingDays: number;
  totalDays: number;
}

/** Days left in the paid period counted from today (today included). Before the period starts the whole period is left. */
export function prorationWindow(sub: { periodStart: string; periodEnd: string }, today: string): Proration {
  const totalDays = diffDays(sub.periodStart, sub.periodEnd);
  const remainingDays = Math.max(0, Math.min(totalDays, diffDays(maxDate(today, sub.periodStart), sub.periodEnd)));
  return { remainingDays, totalDays };
}

/** TOP_UP amounts: staff added mid-period pay the remaining part of the period at the period's locked price. */
export function computeTopUp(i: {
  unitPaisa: number; staff: number; discountPercent: number; remainingDays: number; totalDays: number; creditBalancePaisa: number;
}): InvoiceAmounts {
  if (!Number.isInteger(i.staff) || i.staff < 1) throw new Error('a top-up needs at least one staff member');
  if (i.totalDays < 1 || i.remainingDays < 1 || i.remainingDays > i.totalDays) throw new Error('invalid proration window');
  const { net } = netUnit(i.unitPaisa, i.discountPercent);
  const netPro = roundDiv(net * i.remainingDays, i.totalDays);
  const grossPro = Math.max(netPro, roundDiv(i.unitPaisa * i.remainingDays, i.totalDays));
  const subtotal = grossPro * i.staff;
  const discountAmount = (grossPro - netPro) * i.staff;
  const due = netPro * i.staff;
  const creditApplied = Math.min(Math.max(0, i.creditBalancePaisa), due);
  return { unitPaisa: i.unitPaisa, staff: i.staff, discountPercent: i.discountPercent, subtotal, discountAmount, creditApplied, total: due - creditApplied };
}

/** Credit for staff removed mid-period: the unused part of what was paid for them, rounded DOWN. */
export function computeRemovalCredit(i: { unitPaisa: number; discountPercent: number; removed: number; remainingDays: number; totalDays: number }): number {
  if (i.removed < 1 || i.totalDays < 1 || i.remainingDays < 0 || i.remainingDays > i.totalDays) throw new Error('invalid credit input');
  const { net } = netUnit(i.unitPaisa, i.discountPercent);
  return floorDiv(net * i.remainingDays, i.totalDays) * i.removed;
}

// ------------------------------------------------------------------ reconcile planner

export interface ReconcileSub {
  status: SubscriptionStatus;
  periodStart: string;
  periodEnd: string;
  coveredStaff: number;
}

export interface OpenTopUp {
  id: string;
  staffCount: number;
  periodStart: string;
  periodEnd: string;
  /** A payment for it is PENDING / NEEDS_INFO / APPROVED: the invoice must not change until a reviewer decides. */
  hasLivePayment: boolean;
}

export type ReconcileAction =
  | { type: 'VOID_TOPUP'; invoiceId: string }
  | { type: 'CREATE_TOPUP'; staff: number }
  | { type: 'GRANT_CREDIT'; removed: number; newCovered: number };

/**
 * Decides what to do when the billable staff count (`billable`) differs from the staff the paid period covers.
 *  - more staff  -> ONE open top-up invoice for the difference (an existing unpaid one is replaced when stale);
 *  - fewer staff -> a credit for the unused part, applied to the next invoice; the covered count drops at once;
 *  - nothing happens outside a running, non-suspended period, and nothing changes while a reviewer is looking at a
 *    payment for the open top-up (the next reconcile converges after the decision).
 */
export function planReconcile(i: { today: string; sub: ReconcileSub | null; billable: number; openTopUp: OpenTopUp | null }): ReconcileAction[] {
  const { sub } = i;
  if (!sub || sub.status === 'SUSPENDED' || i.today >= sub.periodEnd) return [];
  const delta = i.billable - sub.coveredStaff;
  let top = i.openTopUp;
  const actions: ReconcileAction[] = [];

  if (top?.hasLivePayment) return [];
  if (top) {
    const stale = top.periodStart !== sub.periodStart || top.periodEnd !== sub.periodEnd;
    const wanted = delta > 0 ? delta : 0;
    if (stale || top.staffCount !== wanted) {
      actions.push({ type: 'VOID_TOPUP', invoiceId: top.id });
      top = null;
    }
  }
  if (delta > 0 && !top) actions.push({ type: 'CREATE_TOPUP', staff: delta });
  if (delta < 0) actions.push({ type: 'GRANT_CREDIT', removed: -delta, newCovered: i.billable });
  return actions;
}

/** A paid top-up is applied only to the period it was issued for; otherwise the money becomes credit (never lost). */
export function topUpSettlement(sub: { periodStart: string; periodEnd: string } | null, invoice: { periodStart: string; periodEnd: string }): 'APPLY' | 'CREDIT' {
  return sub && sub.periodStart === invoice.periodStart && sub.periodEnd === invoice.periodEnd ? 'APPLY' : 'CREDIT';
}
