import { Injectable } from '@nestjs/common';
import { AuthenticatedUser } from '../../common/auth/authenticated-user';
import { isUniqueViolation, sqlState } from '../../common/db/pg-errors';
import { AppException } from '../../common/errors/app-exception';
import { ClientContext } from '../../common/http/client-context';
import { TenantDb } from '../../common/tenancy/tenant-db.service';
import { Clock } from '../../common/util/clock';
import { insertAudit } from '../audit/audit.types';
import { Tx } from '../salons/salons.repository';
import { CreateReviewDto, PageQuery, UpdateReviewDto } from './dto/reviews.dto';
import { ReviewsRepository } from './reviews.repository';
import { REVIEW_LIMITS, authorName, cleanText, editWindow, reviewWindow } from './reviews.types';
import { customerView } from './reviews.views';

const notFound = (what: string) => new AppException('NOT_FOUND', `${what} not found.`, 404);
const conflict = (message: string, details?: unknown) => new AppException('CONFLICT', message, 409, details);
const bad = (message: string) => new AppException('VALIDATION_FAILED', message, 400);

/**
 * Phase 14: a CUSTOMER writes, edits and lists their own reviews. The customer is always the caller (no customer id is accepted).
 * Salon, staff and the visit come from the appointment. The database repeats every rule (reviews_guard), so a mistake here can
 * never create a review for somebody else's or an unfinished appointment.
 */
@Injectable()
export class CustomerReviewsService {
  constructor(private readonly tenant: TenantDb, private readonly repo: ReviewsRepository, private readonly clock: Clock) {}

  // ------------------------------------------------------------------ create
  async create(u: AuthenticatedUser, dto: CreateReviewDto, meta: ClientContext) {
    const now = this.clock.now();
    const comment = cleanText(dto.comment ?? null);
    try {
      const id = await this.tenant.withCustomer(u.id, async (tx: Tx) => {
        const appt = await this.repo.ownAppointment(tx, u.id, dto.appointmentId);
        if (!appt) throw notFound('Appointment');
        if (appt.status !== 'COMPLETED' || !appt.completedAt) throw conflict('Only a completed appointment can be reviewed.', { reason: 'NOT_COMPLETED' });
        const win = reviewWindow(appt.completedAt, now);
        if (!win.open) throw conflict(`You can review a visit for ${REVIEW_LIMITS.reviewWindowDays} days after it was completed.`, { reason: 'WINDOW_CLOSED', closedAt: win.closesAt.toISOString() });

        const allowed = new Set(appt.services.map((s) => s.serviceId));
        for (const s of dto.services ?? []) {
          if (!allowed.has(s.serviceId)) throw bad('You can only rate services that were part of this appointment.');
        }

        const reviewId = await this.repo.insertReview(tx, {
          salonId: appt.salonId, appointmentId: appt.id, customerId: u.id, staffId: appt.staffId, authorName: authorName(u.fullName),
          salonRating: dto.salonRating, staffRating: dto.staffRating ?? null, comment,
        });
        for (const s of dto.services ?? []) await this.repo.insertServiceRating(tx, { salonId: appt.salonId, reviewId, serviceId: s.serviceId, rating: s.rating });
        await insertAudit(tx, {
          actorUserId: u.id, actorRole: u.role, action: 'review.create', targetType: 'review', targetId: reviewId, salonId: appt.salonId,
          ipAddress: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId, metadata: { rating: dto.salonRating },
        });
        return reviewId;
      });
      return await this.get(u, id);
    } catch (e) {
      if (isUniqueViolation(e)) throw conflict('You have already reviewed this appointment.', { reason: 'ALREADY_REVIEWED' });
      if (sqlState(e) === '42501') throw new AppException('FORBIDDEN', 'You cannot review this appointment.', 403);
      throw e;
    }
  }

  // ------------------------------------------------------------------ edit
  async update(u: AuthenticatedUser, id: string, dto: UpdateReviewDto, meta: ClientContext) {
    if (dto.salonRating === undefined && dto.staffRating === undefined && dto.comment === undefined) throw bad('Nothing to change.');
    const now = this.clock.now();
    try {
      await this.tenant.withCustomer(u.id, async (tx: Tx) => {
        const cur = await this.repo.findOwn(tx, u.id, id);
        if (!cur) throw notFound('Review');
        if (cur.status !== 'PUBLISHED') throw conflict('A review that was hidden by moderation cannot be edited.', { reason: 'HIDDEN' });
        const win = editWindow(cur.createdAt, now);
        if (!win.open) throw conflict(`A review can be edited for ${REVIEW_LIMITS.editWindowDays} days after it was written.`, { reason: 'EDIT_WINDOW_CLOSED' });
        const next = {
          salonRating: dto.salonRating ?? cur.salonRating,
          staffRating: dto.staffRating === undefined ? cur.staffRating : dto.staffRating,
          comment: dto.comment === undefined ? cur.comment : cleanText(dto.comment),
        };
        if (next.salonRating === cur.salonRating && next.staffRating === cur.staffRating && next.comment === cur.comment) return;
        const n = await this.repo.updateOwn(tx, id, u.id, next);
        if (n === 0) throw notFound('Review');
        await insertAudit(tx, {
          actorUserId: u.id, actorRole: u.role, action: 'review.edit', targetType: 'review', targetId: id, salonId: cur.salonId,
          ipAddress: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId, metadata: { rating: next.salonRating },
        });
      });
    } catch (e) {
      if (sqlState(e) === '42501') throw new AppException('FORBIDDEN', 'You cannot change this review.', 403);
      throw e;
    }
    return this.get(u, id);
  }

  // ------------------------------------------------------------------ read
  async get(u: AuthenticatedUser, id: string) {
    const r = await this.tenant.withCustomer(u.id, (tx: Tx) => this.repo.findOwn(tx, u.id, id));
    if (!r) throw notFound('Review');
    return customerView(r, this.clock.now().getTime());
  }

  async list(u: AuthenticatedUser, q: PageQuery) {
    const pageSize = q.pageSize ?? REVIEW_LIMITS.defaultPageSize;
    const page = q.page ?? 1;
    const r = await this.tenant.withCustomer(u.id, (tx: Tx) => this.repo.listOwn(tx, u.id, pageSize, (page - 1) * pageSize));
    const now = this.clock.now().getTime();
    return { items: r.items.map((x) => customerView(x, now)), page, pageSize, total: r.total, hasMore: (page - 1) * pageSize + r.items.length < r.total };
  }

  /** Completed visits that can still be reviewed (inside the review window, not reviewed yet). */
  async pending(u: AuthenticatedUser) {
    const rows = await this.tenant.withCustomer(u.id, (tx: Tx) => this.repo.pendingFor(tx, u.id, REVIEW_LIMITS.reviewWindowDays, 50));
    const now = this.clock.now();
    return {
      windowDays: REVIEW_LIMITS.reviewWindowDays,
      items: rows.map((p) => ({
        appointmentId: p.appointmentId, salon: { id: p.salonId, name: p.salonName }, staff: { id: p.staffId, name: p.staffName }, visitAt: p.startsAt,
        completedAt: p.completedAt.toISOString(), reviewBefore: reviewWindow(p.completedAt, now).closesAt.toISOString(), services: p.services,
      })),
    };
  }
}
