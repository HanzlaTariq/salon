import { Injectable } from '@nestjs/common';
import { AuthenticatedUser, toTenantContext } from '../../common/auth/authenticated-user';
import { sqlState } from '../../common/db/pg-errors';
import { AppException } from '../../common/errors/app-exception';
import { ClientContext } from '../../common/http/client-context';
import { TenantDb } from '../../common/tenancy/tenant-db.service';
import { insertAudit } from '../audit/audit.types';
import { Tx } from '../salons/salons.repository';
import { AdminReportsQuery, AdminReviewsQuery, HideReviewDto, ResolveReportDto } from './dto/reviews.dto';
import { ReviewsRepository } from './reviews.repository';
import { REVIEW_LIMITS, cleanText } from './reviews.types';
import { adminView } from './reviews.views';

const notFound = (what: string) => new AppException('NOT_FOUND', `${what} not found.`, 404);
const conflict = (message: string, details?: unknown) => new AppException('CONFLICT', message, 409, details);

/**
 * Phase 14: platform moderation. Reading needs `reviews.read` (Super Admin, Support); hiding, restoring and resolving reports need
 * `reviews.moderate` (Super Admin only). A moderator never edits a rating or a comment: a review is either shown or hidden, with a reason.
 * Hiding removes the review from the public counters (database trigger). Every action writes an immutable audit row.
 */
@Injectable()
export class AdminReviewsService {
  constructor(private readonly tenant: TenantDb, private readonly repo: ReviewsRepository) {}

  private ctx = (u: AuthenticatedUser) => toTenantContext(u, null);

  private audit(tx: Tx, u: AuthenticatedUser, meta: ClientContext, salonId: string, action: string, targetId: string, metadata: Record<string, unknown>) {
    return insertAudit(tx, {
      actorUserId: u.id, actorRole: u.role, action, targetType: 'review', targetId, salonId,
      ipAddress: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId, metadata,
    });
  }

  async overview(u: AuthenticatedUser) {
    return this.tenant.withTenant(this.ctx(u), (tx: Tx) => this.repo.adminCounts(tx));
  }

  async list(u: AuthenticatedUser, q: AdminReviewsQuery) {
    const pageSize = q.pageSize ?? REVIEW_LIMITS.defaultPageSize;
    const page = q.page ?? 1;
    const r = await this.tenant.withTenant(this.ctx(u), (tx: Tx) => this.repo.adminList(tx, {
      status: q.status ?? null, reported: q.reported === 'true', rating: q.rating ?? null, salonId: q.salonId ?? null, limit: pageSize, offset: (page - 1) * pageSize,
    }));
    return { items: r.items.map(adminView), page, pageSize, total: r.total, hasMore: (page - 1) * pageSize + r.items.length < r.total };
  }

  async reports(u: AuthenticatedUser, q: AdminReportsQuery) {
    const pageSize = q.pageSize ?? REVIEW_LIMITS.defaultPageSize;
    const page = q.page ?? 1;
    const r = await this.tenant.withTenant(this.ctx(u), (tx: Tx) => this.repo.adminReports(tx, q.status ?? 'OPEN', pageSize, (page - 1) * pageSize));
    return { items: r.items, page, pageSize, total: r.total, hasMore: (page - 1) * pageSize + r.items.length < r.total };
  }

  // ------------------------------------------------------------------ hide / restore
  async hide(u: AuthenticatedUser, id: string, dto: HideReviewDto, meta: ClientContext) {
    const reason = cleanText(dto.reason);
    if (!reason || reason.length < REVIEW_LIMITS.hiddenReasonMin) throw new AppException('VALIDATION_FAILED', 'A reason is required.', 400);
    await this.tenant.withTenant(this.ctx(u), async (tx: Tx) => {
      await this.hideInTx(tx, u, id, reason, meta);
    });
    return this.one(u, id);
  }

  private async hideInTx(tx: Tx, u: AuthenticatedUser, id: string, reason: string, meta: ClientContext): Promise<void> {
    const cur = await this.repo.adminFind(tx, id);
    if (!cur) throw notFound('Review');
    if (cur.status === 'HIDDEN') throw conflict('This review is already hidden.', { reason: 'ALREADY_HIDDEN' });
    if ((await this.repo.setHidden(tx, id, u.id, reason)) === 0) throw conflict('This review is already hidden.', { reason: 'ALREADY_HIDDEN' });
    await this.audit(tx, u, meta, cur.salonId, 'review.hide', id, { reason, rating: cur.salonRating });
  }

  async restore(u: AuthenticatedUser, id: string, meta: ClientContext) {
    await this.tenant.withTenant(this.ctx(u), async (tx: Tx) => {
      const cur = await this.repo.adminFind(tx, id);
      if (!cur) throw notFound('Review');
      if (cur.status !== 'HIDDEN') throw conflict('This review is not hidden.', { reason: 'NOT_HIDDEN' });
      await this.repo.setHidden(tx, id, u.id, null);
      await this.audit(tx, u, meta, cur.salonId, 'review.restore', id, { previousReason: cur.hiddenReason });
    });
    return this.one(u, id);
  }

  private async one(u: AuthenticatedUser, id: string) {
    const r = await this.tenant.withTenant(this.ctx(u), (tx: Tx) => this.repo.adminFind(tx, id));
    if (!r) throw notFound('Review');
    return adminView(r);
  }

  // ------------------------------------------------------------------ reports
  /** DISMISS: the review stays public. HIDE_REVIEW: the review is hidden (reason = the note, or the report reason) and the report is ACTIONED. */
  async resolve(u: AuthenticatedUser, reportId: string, dto: ResolveReportDto, meta: ClientContext) {
    const note = cleanText(dto.note ?? null);
    try {
      await this.tenant.withTenant(this.ctx(u), async (tx: Tx) => {
        const rep = await this.repo.findReport(tx, reportId);
        if (!rep) throw notFound('Report');
        if (rep.status !== 'OPEN') throw conflict('This report has already been resolved.', { reason: 'ALREADY_RESOLVED' });
        if (dto.action === 'HIDE_REVIEW') {
          const review = await this.repo.adminFind(tx, rep.reviewId);
          if (review && review.status === 'PUBLISHED') {
            await this.hideInTx(tx, u, rep.reviewId, note ?? `Removed after a report by the salon (${review.openReport?.reason ?? 'report'}).`, meta);
          }
        }
        const n = await this.repo.resolveReport(tx, reportId, u.id, dto.action === 'HIDE_REVIEW' ? 'ACTIONED' : 'DISMISSED', note);
        if (n === 0) throw conflict('This report has already been resolved.', { reason: 'ALREADY_RESOLVED' });
        await this.audit(tx, u, meta, rep.salonId, 'review.report_resolve', rep.reviewId, { reportId, action: dto.action });
      });
    } catch (e) {
      if (sqlState(e) === '42501') throw new AppException('FORBIDDEN', 'You cannot resolve this report.', 403);
      throw e;
    }
    return { id: reportId, status: dto.action === 'HIDE_REVIEW' ? 'ACTIONED' : 'DISMISSED' };
  }
}
