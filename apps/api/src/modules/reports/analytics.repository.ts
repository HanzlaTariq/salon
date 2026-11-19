import { Injectable } from '@nestjs/common';
import { Tx } from '../salons/salons.repository';
import { money } from './reports.types';

type Row = Record<string, any>;
const int = (v: unknown): number => Number(v ?? 0);

export type SalonStatusKey = 'DRAFT' | 'PENDING' | 'APPROVED' | 'REJECTED' | 'SUSPENDED';
export const SALON_STATUS_KEYS: readonly SalonStatusKey[] = ['DRAFT', 'PENDING', 'APPROVED', 'REJECTED', 'SUSPENDED'];

export interface PlatformBookingTotals {
  total: number;
  completed: number;
  cancelled: number;
  noShow: number;
  open: number;
  walkIn: number;
  online: number;
}

export interface MonthPoint {
  /** YYYY-MM */
  month: string;
  newSalons: number;
  approvedSalons: number;
  newCustomers: number;
  newOwners: number;
  appointments: number;
  completed: number;
}

export interface RevenuePoint {
  month: string;
  verified: string;
  payments: number;
}

export interface CityRow {
  city: string;
  approvedSalons: number;
  suspendedSalons: number;
  activeStaff: number;
  subscribedSalons: number;
  appointments: number;
  completed: number;
  cancelled: number;
  noShow: number;
}

/**
 * All SQL for the Super Admin analytics (Phase 13). Runs inside TenantDb.withTenant with a platform-admin context, so the
 * `admin_read` Row-Level-Security policies apply.
 *
 * PRIVACY BOUNDARY (deliberate): the platform sees booking COUNTS only. There is no query here that sums a salon's appointment
 * prices, and `salon_expenses` is not readable by platform roles at all. Money in these queries is platform subscription revenue
 * (verified payments) only, so salon revenue and platform revenue can never be mixed up.
 */
@Injectable()
export class AnalyticsRepository {
  async salonsByStatus(tx: Tx): Promise<Record<SalonStatusKey, number>> {
    const r = await tx.$queryRaw<Row[]>`SELECT status::text AS status, count(*)::int AS n FROM salons GROUP BY status`;
    const out = { DRAFT: 0, PENDING: 0, APPROVED: 0, REJECTED: 0, SUSPENDED: 0 } as Record<SalonStatusKey, number>;
    for (const x of r) if (x.status in out) out[x.status as SalonStatusKey] = int(x.n);
    return out;
  }

  /** Salon funnel inside the range: applications submitted (first submissions and re-submissions), approved and rejected. */
  async salonFunnel(tx: Tx, from: Date, to: Date): Promise<{ submitted: number; approved: number; rejected: number }> {
    const r = await tx.$queryRaw<Row[]>`
      SELECT count(*) FILTER (WHERE submitted_at >= ${from}::timestamptz AND submitted_at < ${to}::timestamptz)::int AS submitted,
             count(*) FILTER (WHERE status = 'APPROVED' AND reviewed_at >= ${from}::timestamptz AND reviewed_at < ${to}::timestamptz)::int AS approved,
             count(*) FILTER (WHERE status = 'REJECTED' AND reviewed_at >= ${from}::timestamptz AND reviewed_at < ${to}::timestamptz)::int AS rejected
      FROM salon_applications`;
    return { submitted: int(r[0]?.submitted), approved: int(r[0]?.approved), rejected: int(r[0]?.rejected) };
  }

  /** Staff of live salons (approved or suspended: the same set billing looks at). `billable` = active AND performs services. */
  async staffCounts(tx: Tx): Promise<{ active: number; billable: number }> {
    const r = await tx.$queryRaw<Row[]>`
      SELECT count(*) FILTER (WHERE sp.is_active)::int AS active,
             count(*) FILTER (WHERE sp.is_active AND sp.performs_services)::int AS billable
      FROM staff_profiles sp JOIN salons s ON s.id = sp.salon_id
      WHERE sp.deleted_at IS NULL AND s.status IN ('APPROVED', 'SUSPENDED')`;
    return { active: int(r[0]?.active), billable: int(r[0]?.billable) };
  }

  async userCounts(tx: Tx, from: Date, to: Date): Promise<{ customers: number; activeCustomers: number; newCustomers: number; owners: number; newOwners: number }> {
    const r = await tx.$queryRaw<Row[]>`
      SELECT count(*) FILTER (WHERE role = 'CUSTOMER')::int AS customers,
             count(*) FILTER (WHERE role = 'CUSTOMER' AND status = 'ACTIVE')::int AS active_customers,
             count(*) FILTER (WHERE role = 'CUSTOMER' AND created_at >= ${from}::timestamptz AND created_at < ${to}::timestamptz)::int AS new_customers,
             count(*) FILTER (WHERE role = 'SALON_OWNER')::int AS owners,
             count(*) FILTER (WHERE role = 'SALON_OWNER' AND created_at >= ${from}::timestamptz AND created_at < ${to}::timestamptz)::int AS new_owners
      FROM users WHERE role IN ('CUSTOMER', 'SALON_OWNER')`;
    const x = r[0] ?? {};
    return { customers: int(x.customers), activeCustomers: int(x.active_customers), newCustomers: int(x.new_customers), owners: int(x.owners), newOwners: int(x.new_owners) };
  }

  /** Counts only, across every salon. */
  async bookingTotals(tx: Tx, from: Date, to: Date): Promise<PlatformBookingTotals> {
    const r = await tx.$queryRaw<Row[]>`
      SELECT count(*)::int AS total,
             count(*) FILTER (WHERE status = 'COMPLETED')::int AS completed,
             count(*) FILTER (WHERE status = 'CANCELLED')::int AS cancelled,
             count(*) FILTER (WHERE status = 'NO_SHOW')::int AS no_show,
             count(*) FILTER (WHERE status IN ('PENDING', 'CONFIRMED', 'IN_PROGRESS', 'DELAYED'))::int AS open,
             count(*) FILTER (WHERE source = 'WALK_IN')::int AS walk_in,
             count(*) FILTER (WHERE source = 'ONLINE')::int AS online
      FROM appointments WHERE starts_at >= ${from}::timestamptz AND starts_at < ${to}::timestamptz`;
    const x = r[0] ?? {};
    return { total: int(x.total), completed: int(x.completed), cancelled: int(x.cancelled), noShow: int(x.no_show), open: int(x.open), walkIn: int(x.walk_in), online: int(x.online) };
  }

  /** Verified subscription revenue per Asia/Karachi month for the last `months` months (current month included), zero-filled. */
  async revenueSeries(tx: Tx, today: string, months: number): Promise<RevenuePoint[]> {
    const r = await tx.$queryRaw<Row[]>`
      WITH m AS (
        SELECT d::date AS month
        FROM generate_series(date_trunc('month', ${today}::date) - ((${months}::int - 1) * interval '1 month'), date_trunc('month', ${today}::date), interval '1 month') AS d
      ), p AS (
        SELECT date_trunc('month', reviewed_at AT TIME ZONE 'Asia/Karachi')::date AS month, received_amount
        FROM payments
        WHERE status = 'APPROVED'
          AND reviewed_at >= ((date_trunc('month', ${today}::date) - ((${months}::int - 1) * interval '1 month'))::timestamp AT TIME ZONE 'Asia/Karachi')
      )
      SELECT to_char(m.month, 'YYYY-MM') AS month, COALESCE(SUM(p.received_amount), 0)::text AS verified, count(p.month)::int AS payments
      FROM m LEFT JOIN p ON p.month = m.month GROUP BY m.month ORDER BY m.month`;
    return r.map((x) => ({ month: x.month, verified: money(x.verified), payments: int(x.payments) }));
  }

  /** Month-by-month growth for the last `months` months (current month included), zero-filled. */
  async growthSeries(tx: Tx, today: string, months: number): Promise<MonthPoint[]> {
    const r = await tx.$queryRaw<Row[]>`
      WITH m AS (
        SELECT d::date AS month
        FROM generate_series(date_trunc('month', ${today}::date) - ((${months}::int - 1) * interval '1 month'), date_trunc('month', ${today}::date), interval '1 month') AS d
      ), start_ts AS (
        SELECT ((SELECT min(month) FROM m)::timestamp AT TIME ZONE 'Asia/Karachi') AS ts
      ), sal AS (
        SELECT date_trunc('month', created_at AT TIME ZONE 'Asia/Karachi')::date AS month, count(*)::int AS n
        FROM salons WHERE status <> 'DRAFT' AND created_at >= (SELECT ts FROM start_ts) GROUP BY 1
      ), apr AS (
        SELECT date_trunc('month', approved_at AT TIME ZONE 'Asia/Karachi')::date AS month, count(*)::int AS n
        FROM salons WHERE approved_at >= (SELECT ts FROM start_ts) GROUP BY 1
      ), usr AS (
        SELECT date_trunc('month', created_at AT TIME ZONE 'Asia/Karachi')::date AS month,
               count(*) FILTER (WHERE role = 'CUSTOMER')::int AS customers, count(*) FILTER (WHERE role = 'SALON_OWNER')::int AS owners
        FROM users WHERE role IN ('CUSTOMER', 'SALON_OWNER') AND created_at >= (SELECT ts FROM start_ts) GROUP BY 1
      ), apt AS (
        SELECT date_trunc('month', starts_at AT TIME ZONE 'Asia/Karachi')::date AS month, count(*)::int AS n,
               count(*) FILTER (WHERE status = 'COMPLETED')::int AS completed
        FROM appointments WHERE starts_at >= (SELECT ts FROM start_ts) AND starts_at < ((date_trunc('month', ${today}::date) + interval '1 month')::timestamp AT TIME ZONE 'Asia/Karachi')
        GROUP BY 1
      )
      SELECT to_char(m.month, 'YYYY-MM') AS month,
             COALESCE(sal.n, 0)::int AS new_salons, COALESCE(apr.n, 0)::int AS approved_salons,
             COALESCE(usr.customers, 0)::int AS new_customers, COALESCE(usr.owners, 0)::int AS new_owners,
             COALESCE(apt.n, 0)::int AS appointments, COALESCE(apt.completed, 0)::int AS completed
      FROM m LEFT JOIN sal ON sal.month = m.month LEFT JOIN apr ON apr.month = m.month LEFT JOIN usr ON usr.month = m.month LEFT JOIN apt ON apt.month = m.month
      ORDER BY m.month`;
    return r.map((x) => ({
      month: x.month, newSalons: int(x.new_salons), approvedSalons: int(x.approved_salons), newCustomers: int(x.new_customers),
      newOwners: int(x.new_owners), appointments: int(x.appointments), completed: int(x.completed),
    }));
  }

  /** City-wise statistics of live salons (approved or suspended). City names are grouped ignoring case and surrounding spaces. */
  async cityStats(tx: Tx, from: Date, to: Date, today: string, limit: number): Promise<CityRow[]> {
    const r = await tx.$queryRaw<Row[]>`
      WITH live AS (
        SELECT id, status::text AS status, btrim(city) AS city, lower(btrim(city)) AS city_key FROM salons WHERE status IN ('APPROVED', 'SUSPENDED')
      ), staff AS (
        SELECT salon_id, count(*)::int AS n FROM staff_profiles WHERE deleted_at IS NULL AND is_active AND performs_services GROUP BY salon_id
      ), ap AS (
        SELECT salon_id, count(*)::int AS total,
               count(*) FILTER (WHERE status = 'COMPLETED')::int AS completed,
               count(*) FILTER (WHERE status = 'CANCELLED')::int AS cancelled,
               count(*) FILTER (WHERE status = 'NO_SHOW')::int AS no_show
        FROM appointments WHERE starts_at >= ${from}::timestamptz AND starts_at < ${to}::timestamptz GROUP BY salon_id
      )
      SELECT (array_agg(live.city ORDER BY live.city))[1] AS city,
             count(*) FILTER (WHERE live.status = 'APPROVED')::int AS approved_salons,
             count(*) FILTER (WHERE live.status = 'SUSPENDED')::int AS suspended_salons,
             COALESCE(SUM(staff.n), 0)::int AS active_staff,
             count(*) FILTER (WHERE sub.status = 'ACTIVE' AND ${today}::date < sub.period_end + sub.period_grace_days::int)::int AS subscribed_salons,
             COALESCE(SUM(ap.total), 0)::int AS appointments, COALESCE(SUM(ap.completed), 0)::int AS completed,
             COALESCE(SUM(ap.cancelled), 0)::int AS cancelled, COALESCE(SUM(ap.no_show), 0)::int AS no_show
      FROM live
      LEFT JOIN staff ON staff.salon_id = live.id
      LEFT JOIN ap ON ap.salon_id = live.id
      LEFT JOIN salon_subscriptions sub ON sub.salon_id = live.id
      GROUP BY live.city_key
      ORDER BY COALESCE(SUM(ap.total), 0) DESC, count(*) DESC, live.city_key
      LIMIT ${limit}::int`;
    return r.map((x) => ({
      city: x.city, approvedSalons: int(x.approved_salons), suspendedSalons: int(x.suspended_salons), activeStaff: int(x.active_staff),
      subscribedSalons: int(x.subscribed_salons), appointments: int(x.appointments), completed: int(x.completed), cancelled: int(x.cancelled), noShow: int(x.no_show),
    }));
  }
}
