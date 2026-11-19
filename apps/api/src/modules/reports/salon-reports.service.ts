import { Injectable } from '@nestjs/common';
import { AuthenticatedUser, toTenantContext } from '../../common/auth/authenticated-user';
import { AppException } from '../../common/errors/app-exception';
import { TenantDb } from '../../common/tenancy/tenant-db.service';
import { Clock } from '../../common/util/clock';
import { todayKarachi } from '../billing/billing.types';
import { SalonRecord } from '../salons/salon.types';
import { SalonsRepository, Tx } from '../salons/salons.repository';
import { ExpensesQuery, RangeQuery, ServicesQuery, TrendQuery } from './dto/reports.dto';
import { ReportsRepository } from './reports.repository';
import {
  ReportInputError, ReportRange, REPORT_LIMITS, averageMoney, changePct, pct, previousRange, ratesOf, resolveGroup, resolveRange, subtractMoney,
} from './reports.types';

const notFound = (what: string) => new AppException('NOT_FOUND', `${what} not found.`, 404);
const forbidden = (message: string) => new AppException('FORBIDDEN', message, 403);

/** Turns a bad-input error of the pure rules into the API's 400. */
export function inputGuard<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof ReportInputError) throw new AppException('VALIDATION_FAILED', e.message, 400);
    throw e;
  }
}

export const rangeView = (r: ReportRange) => ({ from: r.from, to: r.to, days: r.days });

/**
 * Phase 13, salon side: the owner's reports (whole salon) and a staff member's own performance report.
 *
 * Who sees what (the salon is ALWAYS derived from the verified session, never from the request):
 *  - SALON_OWNER: every number of their own salon, including expenses and net result.
 *  - SALON_STAFF: ONLY their own performance (their staff id comes from their own profile, never from input). No expenses,
 *    no colleagues, no customer names. Colleagues' figures answer 404 because there is nothing to address them with.
 *  - Platform roles and customers: 403 (default deny; the platform sees counts through /admin/analytics, never a salon's money).
 */
@Injectable()
export class SalonReportsService {
  constructor(
    private readonly tenant: TenantDb,
    private readonly repo: ReportsRepository,
    private readonly salons: SalonsRepository,
    private readonly clock: Clock,
  ) {}

  // ------------------------------------------------------------------ who is calling
  private async ownerSalon(u: AuthenticatedUser): Promise<SalonRecord> {
    const salon = await this.tenant.withTenant(toTenantContext(u), (tx: Tx) => this.salons.findByOwner(tx, u.id));
    if (!salon) throw notFound('Salon');
    return salon;
  }

  private async run(u: AuthenticatedUser): Promise<{ salon: SalonRecord; tx: <R>(fn: (tx: Tx) => Promise<R>) => Promise<R> }> {
    const salon = await this.ownerSalon(u);
    return { salon, tx: (fn) => this.tenant.withTenant(toTenantContext(u, salon.id), fn) };
  }

  private today = (): string => todayKarachi(this.clock.now());

  // ------------------------------------------------------------------ owner
  async summary(u: AuthenticatedUser, q: RangeQuery) {
    const range = inputGuard(() => resolveRange(q, this.today()));
    const prev = previousRange(range);
    const { salon, tx } = await this.run(u);
    return tx(async (t) => {
      // Sequential on purpose: one transaction = one connection = one query at a time.
      const cur = await this.repo.totals(t, salon.id, range.fromTs, range.toTs);
      const before = await this.repo.totals(t, salon.id, prev.fromTs, prev.toTs);
      const spent = await this.repo.expenseTotal(t, salon.id, range.from, range.to);
      const spentBefore = await this.repo.expenseTotal(t, salon.id, prev.from, prev.to);
      const net = subtractMoney(cur.revenue, spent.total);
      const netBefore = subtractMoney(before.revenue, spentBefore.total);
      return {
        currency: 'PKR',
        range: rangeView(range),
        appointments: {
          total: cur.total, completed: cur.completed, cancelled: cur.cancelled, noShow: cur.noShow, open: cur.open, walkIn: cur.walkIn, online: cur.online,
          cancelledByCustomer: cur.cancelledByCustomer, cancelledBySalon: cur.cancelledBySalon,
        },
        rates: ratesOf(cur),
        revenue: {
          total: cur.revenue, online: cur.onlineRevenue, walkIn: cur.walkInRevenue,
          averageTicket: averageMoney(cur.revenue, cur.completed), avgServiceMinutes: cur.avgServiceMinutes,
        },
        expenses: { total: spent.total, count: spent.count },
        net,
        previous: {
          range: rangeView(prev), appointments: before.total, completed: before.completed, revenue: before.revenue, expenses: spentBefore.total, net: netBefore,
          revenueChangePct: changePct(cur.revenue, before.revenue), completedChangePct: changePct(cur.completed, before.completed),
        },
      };
    });
  }

  async trend(u: AuthenticatedUser, q: TrendQuery) {
    const range = inputGuard(() => resolveRange(q, this.today()));
    const group = inputGuard(() => resolveGroup(q.group, range.days));
    const { salon, tx } = await this.run(u);
    const points = await tx((t) => this.repo.trend(t, salon.id, range.from, range.to, range.fromTs, range.toTs, group, null, true));
    return { currency: 'PKR', range: rangeView(range), group, points };
  }

  async staff(u: AuthenticatedUser, q: RangeQuery) {
    const range = inputGuard(() => resolveRange(q, this.today()));
    const { salon, tx } = await this.run(u);
    const rows = await tx((t) => this.repo.staffPerformance(t, salon.id, range.fromTs, range.toTs));
    const totalRevenue = rows.reduce((acc, r) => acc + Math.round(Number(r.revenue) * 100), 0);
    return {
      currency: 'PKR',
      range: rangeView(range),
      items: rows.map((r) => ({
        ...r,
        averageTicket: averageMoney(r.revenue, r.completed),
        revenueSharePct: pct(Math.round(Number(r.revenue) * 100), totalRevenue),
        rates: ratesOf(r),
      })),
    };
  }

  async services(u: AuthenticatedUser, q: ServicesQuery) {
    const range = inputGuard(() => resolveRange(q, this.today()));
    const limit = q.limit ?? REPORT_LIMITS.servicesDefault;
    const { salon, tx } = await this.run(u);
    const items = await tx((t) => this.repo.popularServices(t, salon.id, range.fromTs, range.toTs, limit));
    return { currency: 'PKR', range: rangeView(range), items };
  }

  async retention(u: AuthenticatedUser, q: RangeQuery) {
    const range = inputGuard(() => resolveRange(q, this.today()));
    const { salon, tx } = await this.run(u);
    const r = await tx((t) => this.repo.retention(t, salon.id, range.fromTs, range.toTs));
    return {
      range: rangeView(range),
      customers: { served: r.served, new: r.newCustomers, returning: r.returningCustomers, returningRatePct: pct(r.returningCustomers, r.served) },
      visits: { byCustomers: r.visits, avgPerCustomer: r.served > 0 ? Math.round((r.visits / r.served) * 10) / 10 : null, walkIns: r.walkInVisits },
    };
  }

  async expenses(u: AuthenticatedUser, q: RangeQuery) {
    const range = inputGuard(() => resolveRange(q, this.today()));
    const { salon, tx } = await this.run(u);
    const { total, byCategory } = await tx(async (t) => ({
      total: await this.repo.expenseTotal(t, salon.id, range.from, range.to),
      byCategory: await this.repo.expensesByCategory(t, salon.id, range.from, range.to),
    }));
    const totalPaisa = Math.round(Number(total.total) * 100);
    return {
      currency: 'PKR',
      range: rangeView(range),
      total: total.total,
      count: total.count,
      byCategory: byCategory.map((c) => ({ ...c, sharePct: pct(Math.round(Number(c.total) * 100), totalPaisa) })),
    };
  }

  // ------------------------------------------------------------------ staff: own performance only
  async myPerformance(u: AuthenticatedUser, q: TrendQuery) {
    const range = inputGuard(() => resolveRange(q, this.today()));
    const group = inputGuard(() => resolveGroup(q.group, range.days));
    const own = await this.tenant.withTenant(toTenantContext(u), (tx: Tx) => this.repo.findOwnStaff(tx, u.id));
    if (!own) throw notFound('Staff profile');
    if (!own.isActive) throw forbidden('Your access has been disabled by the salon owner.');
    return this.tenant.withTenant(toTenantContext(u, own.salonId), async (tx: Tx) => {
      const t = await this.repo.totals(tx, own.salonId, range.fromTs, range.toTs, own.id);
      const points = await this.repo.trend(tx, own.salonId, range.from, range.to, range.fromTs, range.toTs, group, own.id, false);
      const top = await this.repo.popularServices(tx, own.salonId, range.fromTs, range.toTs, REPORT_LIMITS.servicesDefault, own.id);
      return {
        currency: 'PKR',
        range: rangeView(range),
        group,
        staff: { id: own.id, name: own.name },
        appointments: { total: t.total, completed: t.completed, cancelled: t.cancelled, noShow: t.noShow, open: t.open, walkIn: t.walkIn },
        rates: ratesOf(t),
        revenue: { total: t.revenue, averageTicket: averageMoney(t.revenue, t.completed), avgServiceMinutes: t.avgServiceMinutes },
        // A staff member never sees salon expenses: the expense column is dropped here, not just zero.
        points: points.map(({ expenses: _expenses, ...rest }) => rest),
        topServices: top,
      };
    });
  }
}
