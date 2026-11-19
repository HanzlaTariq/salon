import { Injectable } from '@nestjs/common';
import { Tx } from '../salons/salons.repository';
import { TrendGroup, money } from './reports.types';

type Row = Record<string, any>;
const int = (v: unknown): number => Number(v ?? 0);

// ------------------------------------------------------------------ records

export interface AppointmentTotals {
  total: number;
  completed: number;
  cancelled: number;
  noShow: number;
  /** PENDING / CONFIRMED / IN_PROGRESS / DELAYED: has not been resolved yet. */
  open: number;
  walkIn: number;
  online: number;
  cancelledByCustomer: number;
  cancelledBySalon: number;
  revenue: string;
  onlineRevenue: string;
  walkInRevenue: string;
  /** Real service time (started -> completed) of completed appointments, in minutes. */
  avgServiceMinutes: number | null;
}

export interface TrendPoint {
  /** First day of the bucket (YYYY-MM-DD). */
  bucket: string;
  total: number;
  completed: number;
  cancelled: number;
  noShow: number;
  walkIn: number;
  revenue: string;
  expenses: string;
}

export interface StaffRow {
  staffId: string;
  name: string;
  isOwner: boolean;
  isActive: boolean;
  total: number;
  completed: number;
  cancelled: number;
  noShow: number;
  walkIn: number;
  revenue: string;
  avgServiceMinutes: number | null;
}

export interface ServiceRow {
  serviceId: string;
  name: string;
  times: number;
  revenue: string;
}

export interface RetentionRow {
  served: number;
  newCustomers: number;
  returningCustomers: number;
  visits: number;
  walkInVisits: number;
}

export interface ExpenseRecord {
  id: string;
  category: string;
  amount: string;
  expenseDate: string;
  description: string | null;
  idempotencyKey: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ExpenseCategoryTotal {
  category: string;
  total: string;
  count: number;
}

export interface OwnStaffRow {
  id: string;
  salonId: string;
  name: string;
  isActive: boolean;
}

const expense = (r: Row): ExpenseRecord => ({
  id: r.id, category: r.category, amount: money(r.amount), expenseDate: r.expense_date, description: r.description ?? null,
  idempotencyKey: r.idempotency_key ?? null, createdAt: r.created_at, updatedAt: r.updated_at,
});

/**
 * All SQL for Phase 13 salon reports and expenses. Same rules as the other repositories: every method takes the transaction
 * opened by TenantDb (so Row-Level Security applies), every value is a bound parameter with an explicit cast, money is NUMERIC
 * cast to text (never a JS float). Every query ALSO names the salon explicitly (defence in depth next to RLS).
 *
 * `staffId` (optional) narrows an appointment query to ONE staff member: used for the staff member's own report.
 */
@Injectable()
export class ReportsRepository {
  // ------------------------------------------------------------------ appointments
  async totals(tx: Tx, salonId: string, from: Date, to: Date, staffId: string | null = null): Promise<AppointmentTotals> {
    const r = await tx.$queryRaw<Row[]>`
      SELECT count(*)::int AS total,
             count(*) FILTER (WHERE status = 'COMPLETED')::int AS completed,
             count(*) FILTER (WHERE status = 'CANCELLED')::int AS cancelled,
             count(*) FILTER (WHERE status = 'NO_SHOW')::int AS no_show,
             count(*) FILTER (WHERE status IN ('PENDING', 'CONFIRMED', 'IN_PROGRESS', 'DELAYED'))::int AS open,
             count(*) FILTER (WHERE source = 'WALK_IN')::int AS walk_in,
             count(*) FILTER (WHERE source = 'ONLINE')::int AS online,
             count(*) FILTER (WHERE status = 'CANCELLED' AND cancelled_by_role = 'CUSTOMER')::int AS cancelled_customer,
             count(*) FILTER (WHERE status = 'CANCELLED' AND cancelled_by_role = 'SALON')::int AS cancelled_salon,
             COALESCE(SUM(total_price) FILTER (WHERE status = 'COMPLETED'), 0)::text AS revenue,
             COALESCE(SUM(total_price) FILTER (WHERE status = 'COMPLETED' AND source = 'ONLINE'), 0)::text AS online_revenue,
             COALESCE(SUM(total_price) FILTER (WHERE status = 'COMPLETED' AND source = 'WALK_IN'), 0)::text AS walk_in_revenue,
             (AVG(EXTRACT(EPOCH FROM (completed_at - started_at)) / 60) FILTER (WHERE status = 'COMPLETED'))::float8 AS avg_minutes
      FROM appointments
      WHERE salon_id = ${salonId}::uuid AND starts_at >= ${from}::timestamptz AND starts_at < ${to}::timestamptz
        AND (${staffId}::uuid IS NULL OR staff_id = ${staffId}::uuid)`;
    const x = r[0] ?? {};
    return {
      total: int(x.total), completed: int(x.completed), cancelled: int(x.cancelled), noShow: int(x.no_show), open: int(x.open),
      walkIn: int(x.walk_in), online: int(x.online), cancelledByCustomer: int(x.cancelled_customer), cancelledBySalon: int(x.cancelled_salon),
      revenue: money(x.revenue), onlineRevenue: money(x.online_revenue), walkInRevenue: money(x.walk_in_revenue),
      avgServiceMinutes: x.avg_minutes === null || x.avg_minutes === undefined ? null : Math.round(Number(x.avg_minutes) * 10) / 10,
    };
  }

  /**
   * One row per bucket between `fromDate` and `toDate`, INCLUDING buckets with no activity (so a chart has no holes).
   * Expenses are added only when `withExpenses` (the salon owner); a staff member never sees them.
   */
  async trend(
    tx: Tx, salonId: string, fromDate: string, toDate: string, from: Date, to: Date, group: TrendGroup, staffId: string | null, withExpenses: boolean,
  ): Promise<TrendPoint[]> {
    const r = await tx.$queryRaw<Row[]>`
      WITH buckets AS (
        SELECT d::date AS bucket
        FROM generate_series(
          date_trunc(${group}::text, ${fromDate}::date)::date, ${toDate}::date,
          (CASE ${group}::text WHEN 'day' THEN interval '1 day' WHEN 'week' THEN interval '7 days' ELSE interval '1 month' END)
        ) AS d
      ), appt AS (
        SELECT date_trunc(${group}::text, (starts_at AT TIME ZONE 'Asia/Karachi'))::date AS bucket,
               count(*)::int AS total,
               count(*) FILTER (WHERE status = 'COMPLETED')::int AS completed,
               count(*) FILTER (WHERE status = 'CANCELLED')::int AS cancelled,
               count(*) FILTER (WHERE status = 'NO_SHOW')::int AS no_show,
               count(*) FILTER (WHERE source = 'WALK_IN')::int AS walk_in,
               COALESCE(SUM(total_price) FILTER (WHERE status = 'COMPLETED'), 0) AS revenue
        FROM appointments
        WHERE salon_id = ${salonId}::uuid AND starts_at >= ${from}::timestamptz AND starts_at < ${to}::timestamptz
          AND (${staffId}::uuid IS NULL OR staff_id = ${staffId}::uuid)
        GROUP BY 1
      ), spent AS (
        SELECT date_trunc(${group}::text, expense_date::timestamp)::date AS bucket, SUM(amount) AS amount
        FROM salon_expenses
        WHERE ${withExpenses}::boolean AND salon_id = ${salonId}::uuid AND deleted_at IS NULL
          AND expense_date >= ${fromDate}::date AND expense_date <= ${toDate}::date
        GROUP BY 1
      )
      SELECT to_char(b.bucket, 'YYYY-MM-DD') AS bucket,
             COALESCE(a.total, 0)::int AS total, COALESCE(a.completed, 0)::int AS completed, COALESCE(a.cancelled, 0)::int AS cancelled,
             COALESCE(a.no_show, 0)::int AS no_show, COALESCE(a.walk_in, 0)::int AS walk_in,
             COALESCE(a.revenue, 0)::text AS revenue, COALESCE(e.amount, 0)::text AS expenses
      FROM buckets b LEFT JOIN appt a ON a.bucket = b.bucket LEFT JOIN spent e ON e.bucket = b.bucket
      ORDER BY b.bucket`;
    return r.map((x) => ({
      bucket: x.bucket, total: int(x.total), completed: int(x.completed), cancelled: int(x.cancelled), noShow: int(x.no_show),
      walkIn: int(x.walk_in), revenue: money(x.revenue), expenses: money(x.expenses),
    }));
  }

  /** Every active service-performing staff member (even with no activity) plus anyone who had appointments in the range. */
  async staffPerformance(tx: Tx, salonId: string, from: Date, to: Date): Promise<StaffRow[]> {
    const r = await tx.$queryRaw<Row[]>`
      WITH agg AS (
        SELECT staff_id, max(staff_name) AS snapshot_name,
               count(*)::int AS total,
               count(*) FILTER (WHERE status = 'COMPLETED')::int AS completed,
               count(*) FILTER (WHERE status = 'CANCELLED')::int AS cancelled,
               count(*) FILTER (WHERE status = 'NO_SHOW')::int AS no_show,
               count(*) FILTER (WHERE source = 'WALK_IN')::int AS walk_in,
               COALESCE(SUM(total_price) FILTER (WHERE status = 'COMPLETED'), 0) AS revenue,
               (AVG(EXTRACT(EPOCH FROM (completed_at - started_at)) / 60) FILTER (WHERE status = 'COMPLETED'))::float8 AS avg_minutes
        FROM appointments
        WHERE salon_id = ${salonId}::uuid AND starts_at >= ${from}::timestamptz AND starts_at < ${to}::timestamptz
        GROUP BY staff_id
      ), roster AS (
        SELECT id, display_name, is_owner, (is_active AND deleted_at IS NULL) AS is_active
        FROM staff_profiles
        WHERE salon_id = ${salonId}::uuid AND (deleted_at IS NULL AND is_active AND performs_services OR id IN (SELECT staff_id FROM agg))
      )
      SELECT COALESCE(r.id, a.staff_id) AS staff_id, COALESCE(r.display_name, a.snapshot_name) AS name,
             COALESCE(r.is_owner, false) AS is_owner, COALESCE(r.is_active, false) AS is_active,
             COALESCE(a.total, 0)::int AS total, COALESCE(a.completed, 0)::int AS completed, COALESCE(a.cancelled, 0)::int AS cancelled,
             COALESCE(a.no_show, 0)::int AS no_show, COALESCE(a.walk_in, 0)::int AS walk_in,
             COALESCE(a.revenue, 0)::text AS revenue, a.avg_minutes
      FROM roster r FULL JOIN agg a ON a.staff_id = r.id
      ORDER BY COALESCE(a.revenue, 0) DESC, lower(COALESCE(r.display_name, a.snapshot_name)), COALESCE(r.id, a.staff_id)`;
    return r.map((x) => ({
      staffId: x.staff_id, name: x.name, isOwner: Boolean(x.is_owner), isActive: Boolean(x.is_active), total: int(x.total), completed: int(x.completed),
      cancelled: int(x.cancelled), noShow: int(x.no_show), walkIn: int(x.walk_in), revenue: money(x.revenue),
      avgServiceMinutes: x.avg_minutes === null || x.avg_minutes === undefined ? null : Math.round(Number(x.avg_minutes) * 10) / 10,
    }));
  }

  /** Most performed services (completed appointments only), using the price and name that were on the booking. */
  async popularServices(tx: Tx, salonId: string, from: Date, to: Date, limit: number, staffId: string | null = null): Promise<ServiceRow[]> {
    const r = await tx.$queryRaw<Row[]>`
      SELECT l.service_id,
             (array_agg(l.service_name ORDER BY a.starts_at DESC))[1] AS name,
             count(*)::int AS times,
             COALESCE(SUM(l.price), 0)::text AS revenue
      FROM appointment_services l
      JOIN appointments a ON a.id = l.appointment_id AND a.salon_id = l.salon_id
      WHERE a.salon_id = ${salonId}::uuid AND a.status = 'COMPLETED'
        AND a.starts_at >= ${from}::timestamptz AND a.starts_at < ${to}::timestamptz
        AND (${staffId}::uuid IS NULL OR a.staff_id = ${staffId}::uuid)
      GROUP BY l.service_id
      ORDER BY times DESC, SUM(l.price) DESC, 2, l.service_id
      LIMIT ${limit}::int`;
    return r.map((x) => ({ serviceId: x.service_id, name: x.name, times: int(x.times), revenue: money(x.revenue) }));
  }

  /**
   * Customers with a COMPLETED visit in the range: how many are new to this salon and how many came before.
   * Walk-ins have no account, so they are counted as visits but cannot be followed over time.
   */
  async retention(tx: Tx, salonId: string, from: Date, to: Date): Promise<RetentionRow> {
    const r = await tx.$queryRaw<Row[]>`
      WITH done AS (
        SELECT customer_user_id, starts_at FROM appointments
        WHERE salon_id = ${salonId}::uuid AND status = 'COMPLETED' AND customer_user_id IS NOT NULL AND starts_at < ${to}::timestamptz
      ), firsts AS (
        SELECT customer_user_id, min(starts_at) AS first_at FROM done GROUP BY customer_user_id
      ), inrange AS (
        SELECT customer_user_id, count(*)::int AS visits FROM done WHERE starts_at >= ${from}::timestamptz GROUP BY customer_user_id
      )
      SELECT count(*)::int AS served,
             count(*) FILTER (WHERE f.first_at >= ${from}::timestamptz)::int AS new_customers,
             COALESCE(SUM(i.visits), 0)::int AS visits,
             (SELECT count(*)::int FROM appointments w WHERE w.salon_id = ${salonId}::uuid AND w.status = 'COMPLETED' AND w.source = 'WALK_IN'
                AND w.starts_at >= ${from}::timestamptz AND w.starts_at < ${to}::timestamptz) AS walk_in_visits
      FROM inrange i JOIN firsts f ON f.customer_user_id = i.customer_user_id`;
    const x = r[0] ?? {};
    const served = int(x.served);
    const fresh = int(x.new_customers);
    return { served, newCustomers: fresh, returningCustomers: served - fresh, visits: int(x.visits), walkInVisits: int(x.walk_in_visits) };
  }

  // ------------------------------------------------------------------ expenses
  async expenseTotal(tx: Tx, salonId: string, fromDate: string, toDate: string): Promise<{ total: string; count: number }> {
    const r = await tx.$queryRaw<Row[]>`
      SELECT COALESCE(SUM(amount), 0)::text AS total, count(*)::int AS n FROM salon_expenses
      WHERE salon_id = ${salonId}::uuid AND deleted_at IS NULL AND expense_date >= ${fromDate}::date AND expense_date <= ${toDate}::date`;
    return { total: money(r[0]?.total), count: int(r[0]?.n) };
  }

  async expensesByCategory(tx: Tx, salonId: string, fromDate: string, toDate: string): Promise<ExpenseCategoryTotal[]> {
    const r = await tx.$queryRaw<Row[]>`
      SELECT category, SUM(amount)::text AS total, count(*)::int AS n FROM salon_expenses
      WHERE salon_id = ${salonId}::uuid AND deleted_at IS NULL AND expense_date >= ${fromDate}::date AND expense_date <= ${toDate}::date
      GROUP BY category ORDER BY SUM(amount) DESC, category`;
    return r.map((x) => ({ category: x.category, total: money(x.total), count: int(x.n) }));
  }

  async listExpenses(
    tx: Tx, salonId: string, f: { fromDate: string; toDate: string; category: string | null; limit: number; offset: number },
  ): Promise<{ items: ExpenseRecord[]; total: number; sum: string }> {
    const rows = await tx.$queryRaw<Row[]>`
      SELECT id, category, amount::text AS amount, to_char(expense_date, 'YYYY-MM-DD') AS expense_date, description, idempotency_key, created_at, updated_at
      FROM salon_expenses
      WHERE salon_id = ${salonId}::uuid AND deleted_at IS NULL AND expense_date >= ${f.fromDate}::date AND expense_date <= ${f.toDate}::date
        AND (${f.category}::varchar IS NULL OR category = ${f.category}::varchar)
      ORDER BY expense_date DESC, created_at DESC, id
      LIMIT ${f.limit}::int OFFSET ${f.offset}::int`;
    const agg = await tx.$queryRaw<Row[]>`
      SELECT count(*)::int AS n, COALESCE(SUM(amount), 0)::text AS total FROM salon_expenses
      WHERE salon_id = ${salonId}::uuid AND deleted_at IS NULL AND expense_date >= ${f.fromDate}::date AND expense_date <= ${f.toDate}::date
        AND (${f.category}::varchar IS NULL OR category = ${f.category}::varchar)`;
    return { items: rows.map(expense), total: int(agg[0]?.n), sum: money(agg[0]?.total) };
  }

  async findExpense(tx: Tx, salonId: string, id: string): Promise<ExpenseRecord | null> {
    const r = await tx.$queryRaw<Row[]>`
      SELECT id, category, amount::text AS amount, to_char(expense_date, 'YYYY-MM-DD') AS expense_date, description, idempotency_key, created_at, updated_at
      FROM salon_expenses WHERE id = ${id}::uuid AND salon_id = ${salonId}::uuid AND deleted_at IS NULL`;
    return r[0] ? expense(r[0]) : null;
  }

  async findExpenseByKey(tx: Tx, salonId: string, key: string): Promise<ExpenseRecord | null> {
    const r = await tx.$queryRaw<Row[]>`
      SELECT id, category, amount::text AS amount, to_char(expense_date, 'YYYY-MM-DD') AS expense_date, description, idempotency_key, created_at, updated_at
      FROM salon_expenses WHERE salon_id = ${salonId}::uuid AND idempotency_key = ${key}::varchar`;
    return r[0] ? expense(r[0]) : null;
  }

  async insertExpense(
    tx: Tx, e: { salonId: string; category: string; amount: string; expenseDate: string; description: string | null; idempotencyKey: string | null; createdBy: string },
  ): Promise<ExpenseRecord> {
    const r = await tx.$queryRaw<Row[]>`
      INSERT INTO salon_expenses (salon_id, category, amount, expense_date, description, idempotency_key, created_by)
      VALUES (${e.salonId}::uuid, ${e.category}::varchar, ${e.amount}::numeric, ${e.expenseDate}::date, ${e.description}::varchar, ${e.idempotencyKey}::varchar, ${e.createdBy}::uuid)
      RETURNING id, category, amount::text AS amount, to_char(expense_date, 'YYYY-MM-DD') AS expense_date, description, idempotency_key, created_at, updated_at`;
    return expense(r[0]);
  }

  async updateExpense(
    tx: Tx, salonId: string, id: string, e: { category: string; amount: string; expenseDate: string; description: string | null },
  ): Promise<ExpenseRecord | null> {
    const r = await tx.$queryRaw<Row[]>`
      UPDATE salon_expenses SET category = ${e.category}::varchar, amount = ${e.amount}::numeric, expense_date = ${e.expenseDate}::date, description = ${e.description}::varchar
      WHERE id = ${id}::uuid AND salon_id = ${salonId}::uuid AND deleted_at IS NULL
      RETURNING id, category, amount::text AS amount, to_char(expense_date, 'YYYY-MM-DD') AS expense_date, description, idempotency_key, created_at, updated_at`;
    return r[0] ? expense(r[0]) : null;
  }

  async softDeleteExpense(tx: Tx, salonId: string, id: string, by: string): Promise<boolean> {
    const n = await tx.$executeRaw`
      UPDATE salon_expenses SET deleted_at = now(), deleted_by = ${by}::uuid
      WHERE id = ${id}::uuid AND salon_id = ${salonId}::uuid AND deleted_at IS NULL`;
    return n === 1;
  }

  // ------------------------------------------------------------------ staff (own profile)
  /** The caller's own staff profile (RLS `staff_self_read`). */
  async findOwnStaff(tx: Tx, userId: string): Promise<OwnStaffRow | null> {
    const r = await tx.$queryRaw<Row[]>`
      SELECT id, salon_id, display_name, is_active FROM staff_profiles WHERE user_id = ${userId}::uuid AND deleted_at IS NULL`;
    const x = r[0];
    return x ? { id: x.id, salonId: x.salon_id, name: x.display_name, isActive: Boolean(x.is_active) } : null;
  }
}

