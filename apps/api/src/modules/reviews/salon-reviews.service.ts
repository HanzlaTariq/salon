import { Injectable } from '@nestjs/common';
import { AuthenticatedUser, toTenantContext } from '../../common/auth/authenticated-user';
import { isUniqueViolation, sqlState } from '../../common/db/pg-errors';
import { AppException } from '../../common/errors/app-exception';
import { ClientContext } from '../../common/http/client-context';
import { TenantDb } from '../../common/tenancy/tenant-db.service';
import { insertAudit } from '../audit/audit.types';
import { SalonRecord } from '../salons/salon.types';
import { SalonsRepository, Tx, likePattern } from '../salons/salons.repository';
import { CustomersQuery, OwnerReviewsQuery, PageQuery, ReportReviewDto, RespondDto } from './dto/reviews.dto';
import { ReviewsRepository } from './reviews.repository';
import { REVIEW_LIMITS, cleanText, summarise } from './reviews.types';
import { ownerView, staffView } from './reviews.views';

const notFound = (what: string) => new AppException('NOT_FOUND', `${what} not found.`, 404);
const conflict = (message: string, details?: unknown) => new AppException('CONFLICT', message, 409, details);
const bad = (message: string) => new AppException('VALIDATION_FAILED', message, 400);
const paging = (q: PageQuery, size: number) => {
  const pageSize = q.pageSize ?? size;
  const page = q.page ?? 1;
  return { page, pageSize, offset: (page - 1) * pageSize };
};

/**
 * Phase 14, salon side.
 *   SALON_OWNER: reviews of the own salon, the public response, reports to the platform, customer list and customer history.
 *   SALON_STAFF: reviews that name them, nothing else.
 * The salon comes from the session (owner's salon / staff member's own profile); no salon id, staff id or customer id of another
 * tenant is ever accepted. Row-Level Security repeats every rule.
 */
@Injectable()
export class SalonReviewsService {
  constructor(private readonly tenant: TenantDb, private readonly repo: ReviewsRepository, private readonly salons: SalonsRepository) {}

  private async scope(u: AuthenticatedUser): Promise<{ salon: SalonRecord; run: <R>(fn: (tx: Tx) => Promise<R>) => Promise<R> }> {
    const salon = await this.tenant.withTenant(toTenantContext(u), (tx: Tx) => this.salons.findByOwner(tx, u.id));
    if (!salon) throw notFound('Salon');
    return { salon, run: (fn) => this.tenant.withTenant(toTenantContext(u, salon.id), fn) };
  }

  private audit(tx: Tx, u: AuthenticatedUser, meta: ClientContext, salonId: string, action: string, targetId: string, metadata?: Record<string, unknown>) {
    return insertAudit(tx, {
      actorUserId: u.id, actorRole: u.role, action, targetType: 'review', targetId, salonId,
      ipAddress: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId, metadata: metadata ?? null,
    });
  }

  // ------------------------------------------------------------------ owner: reviews
  async summary(u: AuthenticatedUser) {
    const { salon, run } = await this.scope(u);
    const d = await run(async (tx) => ({
      stats: await this.repo.salonStats(tx, salon.id), staff: await this.repo.staffStats(tx, salon.id), unanswered: await this.repo.unansweredCount(tx, salon.id),
    }));
    return { ...summarise(d.stats.stars), unanswered: d.unanswered, staff: d.staff.map((s) => ({ staffId: s.staffId, name: s.name, ...summarise(s.stars) })) };
  }

  async list(u: AuthenticatedUser, q: OwnerReviewsQuery) {
    const { page, pageSize, offset } = paging(q, REVIEW_LIMITS.defaultPageSize);
    const { salon, run } = await this.scope(u);
    const r = await run((tx) => this.repo.listForSalon(tx, salon.id, { rating: q.rating ?? null, unanswered: q.unanswered === 'true', staffId: q.staffId ?? null, limit: pageSize, offset }));
    return { items: r.items.map(ownerView), page, pageSize, total: r.total, hasMore: offset + r.items.length < r.total };
  }

  // ------------------------------------------------------------------ owner: public response
  async respond(u: AuthenticatedUser, id: string, dto: RespondDto, meta: ClientContext) {
    const text = cleanText(dto.text);
    if (!text) throw bad('The response cannot be empty.');
    const { salon, run } = await this.scope(u);
    try {
      await run(async (tx) => {
        const cur = await this.repo.findForSalon(tx, salon.id, id);
        if (!cur || cur.status !== 'PUBLISHED') throw notFound('Review');
        if (cur.ownerResponse === text) return;
        if ((await this.repo.setResponse(tx, salon.id, id, u.id, text)) === 0) throw notFound('Review');
        await this.audit(tx, u, meta, salon.id, cur.ownerResponse ? 'review.response_update' : 'review.response_create', id);
      });
    } catch (e) {
      if (sqlState(e) === '42501') throw new AppException('FORBIDDEN', 'You cannot respond to this review.', 403);
      throw e;
    }
    return this.one(u, id);
  }

  async removeResponse(u: AuthenticatedUser, id: string, meta: ClientContext) {
    const { salon, run } = await this.scope(u);
    await run(async (tx) => {
      const cur = await this.repo.findForSalon(tx, salon.id, id);
      if (!cur || cur.status !== 'PUBLISHED') throw notFound('Review');
      if (!cur.ownerResponse) return;
      await this.repo.setResponse(tx, salon.id, id, u.id, null);
      await this.audit(tx, u, meta, salon.id, 'review.response_delete', id);
    });
  }

  private async one(u: AuthenticatedUser, id: string) {
    const { salon, run } = await this.scope(u);
    const r = await run((tx) => this.repo.findForSalon(tx, salon.id, id));
    if (!r || r.status !== 'PUBLISHED') throw notFound('Review');
    return ownerView(r);
  }

  // ------------------------------------------------------------------ owner: report a review to the platform
  async report(u: AuthenticatedUser, id: string, dto: ReportReviewDto, meta: ClientContext) {
    const details = cleanText(dto.details ?? null);
    if (dto.reason === 'OTHER' && !details) throw bad('Please describe the problem when the reason is "other".');
    const { salon, run } = await this.scope(u);
    try {
      const reportId = await run(async (tx) => {
        const cur = await this.repo.findForSalon(tx, salon.id, id);
        if (!cur || cur.status !== 'PUBLISHED') throw notFound('Review');
        if (cur.openReport) throw conflict('This review has already been reported and is waiting for the platform team.', { reason: 'ALREADY_REPORTED' });
        const rid = await this.repo.insertReport(tx, { salonId: salon.id, reviewId: id, reportedBy: u.id, reason: dto.reason, details });
        await this.audit(tx, u, meta, salon.id, 'review.report', id, { reportId: rid, reason: dto.reason });
        return rid;
      });
      return { id: reportId, reviewId: id, reason: dto.reason, status: 'OPEN' as const };
    } catch (e) {
      if (isUniqueViolation(e)) throw conflict('This review has already been reported and is waiting for the platform team.', { reason: 'ALREADY_REPORTED' });
      if (sqlState(e) === '42501') throw new AppException('FORBIDDEN', 'You cannot report this review.', 403);
      throw e;
    }
  }

  async myReports(u: AuthenticatedUser) {
    const { salon, run } = await this.scope(u);
    const items = await run((tx) => this.repo.listReportsForSalon(tx, salon.id, 100));
    return { items: items.map((r) => ({ id: r.id, reviewId: r.reviewId, reason: r.reason, details: r.details, status: r.status, resolutionNote: r.resolutionNote, resolvedAt: r.resolvedAt, createdAt: r.createdAt })) };
  }

  // ------------------------------------------------------------------ owner: customers and their history at this salon
  async customers(u: AuthenticatedUser, q: CustomersQuery) {
    const { page, pageSize, offset } = paging(q, REVIEW_LIMITS.customersPageSize);
    const { salon, run } = await this.scope(u);
    const r = await run((tx) => this.repo.customers(tx, salon.id, { q: q.q ? likePattern(q.q) : null, sort: q.sort ?? 'recent', limit: pageSize, offset }));
    return { items: r.items.map(customerSummary), page, pageSize, total: r.total, hasMore: offset + r.items.length < r.total, currency: 'PKR' };
  }

  async customer(u: AuthenticatedUser, customerId: string) {
    const { salon, run } = await this.scope(u);
    const d = await run(async (tx) => {
      const c = await this.repo.customer(tx, salon.id, customerId);
      if (!c) return null;
      return { c, history: await this.repo.customerHistory(tx, salon.id, customerId, REVIEW_LIMITS.historyAppointments), reviews: await this.repo.customerReview(tx, salon.id, customerId) };
    });
    if (!d) throw notFound('Customer');
    return {
      ...customerSummary(d.c), currency: 'PKR',
      history: d.history.map((h) => ({ id: h.id, status: h.status, startsAt: h.startsAt, staffName: h.staffName, totalPrice: h.totalPrice, services: h.services })),
      reviews: d.reviews.map(ownerView),
    };
  }

  // ------------------------------------------------------------------ staff: reviews about their own work
  async myStaffReviews(u: AuthenticatedUser, q: PageQuery) {
    const { page, pageSize, offset } = paging(q, REVIEW_LIMITS.defaultPageSize);
    const d = await this.tenant.withTenant(toTenantContext(u), async (own: Tx) => {
      const me = await this.repo.findOwnStaff(own, u.id);
      if (!me || !me.isActive) return null;
      return { me, ctx: toTenantContext(u, me.salonId) };
    });
    if (!d) throw notFound('Staff profile');
    const r = await this.tenant.withTenant(d.ctx, async (tx: Tx) => ({
      stats: await this.repo.staffOwnStats(tx, d.me.id), list: await this.repo.listForStaff(tx, d.me.salonId, d.me.id, pageSize, offset),
    }));
    return { summary: summarise(r.stats.stars), items: r.list.items.map(staffView), page, pageSize, total: r.list.total, hasMore: offset + r.list.items.length < r.list.total };
  }
}

const customerSummary = (c: import('./reviews.repository').CustomerSummaryRow) => ({
  customerId: c.customerUserId, name: c.name, phone: c.phone, visits: c.visits, noShows: c.noShows, cancelled: c.cancelled, upcoming: c.upcoming,
  totalSpent: c.spent, firstVisitAt: c.firstVisitAt, lastVisitAt: c.lastVisitAt,
});
