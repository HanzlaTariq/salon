import { fromPaisa, isIsoDate, toPaisa } from '../billing/billing.types';
import { dayStartMs } from '../booking/booking.types';
import { addDaysIso } from '../discovery/discovery.types';

/**
 * Phase 13 pure rules (no I/O): report ranges, trend buckets, rates and money arithmetic.
 *
 * How the numbers are defined (shown to owners in the app, tested in reports.types.spec.ts):
 *  - A day always means a calendar day in Asia/Karachi. A range is a pair of INCLUSIVE dates.
 *  - An appointment belongs to the day of its BOOKED start (starts_at). Walk-ins start when they walk in.
 *  - Salon revenue = the price snapshots of COMPLETED appointments. Cancelled, no-show and still-open appointments earn nothing.
 *    It is computed, never stored, so it can never disagree with the bookings. It is NOT the platform's subscription revenue.
 *  - Rates are taken over RESOLVED appointments (completed + cancelled + no-show), so appointments that have not happened yet
 *    do not make the salon look worse.
 */
export const EXPENSE_CATEGORIES = ['RENT', 'SALARIES', 'UTILITIES', 'SUPPLIES', 'MARKETING', 'EQUIPMENT', 'MAINTENANCE', 'TAXES_FEES', 'OTHER'] as const;
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

export const REPORT_LIMITS = {
  defaultRangeDays: 30,
  maxRangeDays: 366,
  /** Daily buckets are only offered for ranges up to this long (a chart of 366 bars is unreadable). */
  dayGroupMaxDays: 93,
  servicesDefault: 10,
  servicesMax: 50,
  expensePageSize: 25,
  cityLimit: 200,
  trendMonthsDefault: 12,
  trendMonthsMax: 24,
  maxExpense: 100_000_000,
} as const;

export const TREND_GROUPS = ['day', 'week', 'month'] as const;
export type TrendGroup = (typeof TREND_GROUPS)[number];

/** Thrown for bad report input; the services turn it into a 400. */
export class ReportInputError extends Error {}

const DAY_MS = 86_400_000;

export interface ReportRange {
  /** First day, inclusive (Karachi calendar date). */
  from: string;
  /** Last day, inclusive. */
  to: string;
  days: number;
  /** The instants the SQL compares against: [fromTs, toTs). */
  fromTs: Date;
  toTs: Date;
}

export function rangeOf(from: string, to: string): ReportRange {
  const fromMs = dayStartMs(from);
  const toMs = dayStartMs(addDaysIso(to, 1));
  return { from, to, days: Math.round((toMs - fromMs) / DAY_MS), fromTs: new Date(fromMs), toTs: new Date(toMs) };
}

/**
 * Validates `from` / `to` (both optional). Missing `to` = today, missing `from` = the default window ending at `to`.
 * Reports describe what has happened, so `to` may not be after today (Karachi).
 */
export function resolveRange(input: { from?: string; to?: string }, today: string): ReportRange {
  if (input.from !== undefined && !isIsoDate(input.from)) throw new ReportInputError('from must be a valid calendar date (YYYY-MM-DD).');
  if (input.to !== undefined && !isIsoDate(input.to)) throw new ReportInputError('to must be a valid calendar date (YYYY-MM-DD).');
  const to = input.to ?? today;
  if (to > today) throw new ReportInputError('to cannot be after today: reports describe what has already happened.');
  const from = input.from ?? addDaysIso(to, -(REPORT_LIMITS.defaultRangeDays - 1));
  if (from > to) throw new ReportInputError('from cannot be after to.');
  const r = rangeOf(from, to);
  if (r.days > REPORT_LIMITS.maxRangeDays) throw new ReportInputError(`A report can cover at most ${REPORT_LIMITS.maxRangeDays} days.`);
  return r;
}

/** The period of the same length that ends the day before `r` starts (for "compared with the previous period"). */
export function previousRange(r: ReportRange): ReportRange {
  const to = addDaysIso(r.from, -1);
  const from = addDaysIso(to, -(r.days - 1));
  return rangeOf(from, to);
}

/** Default bucket size for a range, so a chart always has a readable number of bars. */
export function defaultGroup(days: number): TrendGroup {
  return days <= 31 ? 'day' : days <= 180 ? 'week' : 'month';
}

export function resolveGroup(requested: TrendGroup | undefined, days: number): TrendGroup {
  const g = requested ?? defaultGroup(days);
  if (g === 'day' && days > REPORT_LIMITS.dayGroupMaxDays) {
    throw new ReportInputError(`Daily buckets are available for ranges up to ${REPORT_LIMITS.dayGroupMaxDays} days. Use week or month.`);
  }
  return g;
}

/** Percentage with one decimal, or null when there is nothing to divide by. 3 of 8 -> 37.5 */
export function pct(part: number, whole: number): number | null {
  if (!Number.isFinite(part) || !Number.isFinite(whole) || whole <= 0) return null;
  return Math.round((part / whole) * 1000) / 10;
}

export interface Rates {
  /** completed + cancelled + no-show. */
  resolved: number;
  completionRate: number | null;
  cancellationRate: number | null;
  noShowRate: number | null;
}

export function ratesOf(t: { completed: number; cancelled: number; noShow: number }): Rates {
  const resolved = t.completed + t.cancelled + t.noShow;
  return { resolved, completionRate: pct(t.completed, resolved), cancellationRate: pct(t.cancelled, resolved), noShowRate: pct(t.noShow, resolved) };
}

// ------------------------------------------------------------------ money (always integer paisa in JS, decimal text on the wire)

/** Normalises a NUMERIC text from PostgreSQL to "1234.50". Anything that is not money becomes "0.00". */
export function money(v: unknown): string {
  const s = v === null || v === undefined ? '0' : String(v);
  const n = Number(s);
  if (!Number.isFinite(n)) return '0.00';
  return fromPaisa(Math.round(n * 100));
}

export const sumMoney = (values: ReadonlyArray<string>): string => fromPaisa(values.reduce((acc, v) => acc + toPaisa(money(v)), 0));

/** a - b as money text. May be negative (a salon can spend more than it earns). */
export const subtractMoney = (a: string, b: string): string => fromPaisa(toPaisa(money(a)) - toPaisa(money(b)));

/** Average ticket = revenue / completed, rounded to the nearest paisa. null when nothing was completed. */
export function averageMoney(total: string, count: number): string | null {
  if (count <= 0) return null;
  return fromPaisa(Math.round(toPaisa(money(total)) / count));
}

/** Change against the previous period in percent (one decimal). null when the previous period was zero (no meaningful ratio). */
export function changePct(current: string | number, previous: string | number): number | null {
  const c = typeof current === 'string' ? toPaisa(money(current)) : current;
  const p = typeof previous === 'string' ? toPaisa(money(previous)) : previous;
  if (p <= 0) return null;
  return Math.round(((c - p) / p) * 1000) / 10;
}

/** annual run rate = 12 x the monthly recurring revenue. */
export const annualize = (monthly: string): string => fromPaisa(toPaisa(money(monthly)) * 12);

// ------------------------------------------------------------------ expenses

const MONEY_INPUT = /^\d{1,9}(\.\d{1,2})?$/;

/** Validates an expense amount typed by a person ("1500", "1500.5") and returns it as "1500.50". */
export function parseExpenseAmount(value: string): string {
  if (typeof value !== 'string' || !MONEY_INPUT.test(value)) throw new ReportInputError('amount must be a number like 1500 or 1500.50.');
  const paisa = toPaisa(value);
  if (paisa < 1) throw new ReportInputError('amount must be at least 0.01.');
  if (paisa > REPORT_LIMITS.maxExpense * 100) throw new ReportInputError(`amount cannot be more than ${REPORT_LIMITS.maxExpense.toLocaleString('en-US')}.`);
  return fromPaisa(paisa);
}

export const EXPENSE_IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_-]{8,64}$/;

export interface ExpenseCore {
  category: string;
  amount: string;
  expenseDate: string;
  description: string | null;
}

/** True when a retried request (same Idempotency-Key) describes the same expense as the stored one. */
export function sameExpense(a: ExpenseCore, b: ExpenseCore): boolean {
  return a.category === b.category && toPaisa(money(a.amount)) === toPaisa(money(b.amount)) && a.expenseDate === b.expenseDate && (a.description ?? null) === (b.description ?? null);
}
