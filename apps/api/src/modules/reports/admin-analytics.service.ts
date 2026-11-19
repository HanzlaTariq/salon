import { Injectable } from '@nestjs/common';
import { AuthenticatedUser, toTenantContext } from '../../common/auth/authenticated-user';
import { TenantDb } from '../../common/tenancy/tenant-db.service';
import { Clock } from '../../common/util/clock';
import { BillingRepository } from '../billing/billing.repository';
import { todayKarachi } from '../billing/billing.types';
import { Tx } from '../salons/salons.repository';
import { AdminTrendQuery, RangeQuery } from './dto/reports.dto';
import { AnalyticsRepository, SALON_STATUS_KEYS } from './analytics.repository';
import { REPORT_LIMITS, annualize, pct, ratesOf, resolveRange } from './reports.types';
import { inputGuard, rangeView } from './salon-reports.service';

/**
 * Phase 13, platform side (Super Admin / Support / Finance, permission `analytics.read`).
 *
 * Two kinds of money exist in this product and they are never mixed:
 *   1. PLATFORM revenue: what salons pay the platform (subscriptions, verified manual payments). Reported here.
 *   2. SALON revenue: what customers pay a salon. PRIVATE to that salon. The platform sees booking COUNTS only; there is no
 *      query anywhere in this module that sums a salon's appointment prices or reads its expenses.
 */
@Injectable()
export class AdminAnalyticsService {
  constructor(
    private readonly tenant: TenantDb,
    private readonly repo: AnalyticsRepository,
    private readonly billing: BillingRepository,
    private readonly clock: Clock,
  ) {}

  private run<T>(u: AuthenticatedUser, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.tenant.withTenant(toTenantContext(u), fn);
  }

  private today = (): string => todayKarachi(this.clock.now());

  async overview(u: AuthenticatedUser, q: RangeQuery) {
    const today = this.today();
    const range = inputGuard(() => resolveRange(q, today));
    return this.run(u, async (tx) => {
      // Sequential on purpose: one transaction = one connection = one query at a time.
      const byStatus = await this.repo.salonsByStatus(tx);
      const funnel = await this.repo.salonFunnel(tx, range.fromTs, range.toTs);
      const staff = await this.repo.staffCounts(tx);
      const users = await this.repo.userCounts(tx, range.fromTs, range.toTs);
      const bookings = await this.repo.bookingTotals(tx, range.fromTs, range.toTs);
      const sub = await this.billing.overview(tx, today, `${today.slice(0, 7)}-01`, `${today.slice(0, 4)}-01-01`);
      return {
        currency: 'PKR',
        range: rangeView(range),
        salons: {
          total: SALON_STATUS_KEYS.reduce((acc, k) => acc + byStatus[k], 0),
          byStatus,
          applicationsSubmittedInRange: funnel.submitted,
          approvedInRange: funnel.approved,
          rejectedInRange: funnel.rejected,
        },
        staff,
        customers: { registered: users.customers, active: users.activeCustomers, newInRange: users.newCustomers },
        owners: { registered: users.owners, newInRange: users.newOwners },
        subscriptions: {
          active: sub.phases.ACTIVE, inGrace: sub.phases.GRACE, expired: sub.phases.EXPIRED, suspended: sub.phases.SUSPENDED, neverSubscribed: sub.phases.NONE,
        },
        /** PLATFORM subscription revenue only (verified payments). Salon revenue is private to each salon and is not included. */
        platformRevenue: {
          monthlyRecurringRevenue: sub.mrr,
          annualRunRate: annualize(sub.mrr),
          verifiedThisMonth: sub.revenueThisMonth,
          verifiedThisYear: sub.revenueThisYear,
          pendingPayments: sub.pendingPayments,
          pendingAmount: sub.pendingAmount,
        },
        /** Counts only. */
        bookings: { ...bookings, rates: ratesOf(bookings), walkInSharePct: pct(bookings.walkIn, bookings.total) },
      };
    });
  }

  async trend(u: AuthenticatedUser, q: AdminTrendQuery) {
    const months = q.months ?? REPORT_LIMITS.trendMonthsDefault;
    const today = this.today();
    return this.run(u, async (tx) => ({
      months,
      growth: await this.repo.growthSeries(tx, today, months),
      subscriptionRevenue: await this.repo.revenueSeries(tx, today, months),
    }));
  }

  async cities(u: AuthenticatedUser, q: RangeQuery) {
    const today = this.today();
    const range = inputGuard(() => resolveRange(q, today));
    const items = await this.run(u, (tx) => this.repo.cityStats(tx, range.fromTs, range.toTs, today, REPORT_LIMITS.cityLimit));
    return { range: rangeView(range), items: items.map((c) => ({ ...c, rates: ratesOf(c) })) };
  }
}
