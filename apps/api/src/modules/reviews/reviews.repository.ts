import { Injectable } from '@nestjs/common';
import { Tx } from '../salons/salons.repository';
import { EMPTY_STARS, ReportReason, ReportStatus, ReviewSort, ReviewStatus, Stars } from './reviews.types';

type Row = Record<string, any>;
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const iso = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : v ? String(v) : null);

export interface ServiceRating { serviceId: string; name: string; rating: number }

export interface ReviewRecord {
  id: string;
  salonId: string;
  salonName: string;
  appointmentId: string;
  customerUserId: string;
  staffId: string;
  staffName: string | null;
  authorName: string;
  salonRating: number;
  staffRating: number | null;
  comment: string | null;
  status: ReviewStatus;
  hiddenReason: string | null;
  hiddenAt: string | null;
  ownerResponse: string | null;
  ownerResponseAt: string | null;
  editedAt: string | null;
  createdAt: Date;
  /** Karachi-independent instant of the visit (appointment start). */
  visitAt: string | null;
  openReport: { id: string; reason: ReportReason; createdAt: string } | null;
  services: ServiceRating[];
}

const review = (r: Row): ReviewRecord => ({
  id: r.id, salonId: r.salon_id, salonName: r.salon_name ?? '', appointmentId: r.appointment_id, customerUserId: r.customer_user_id,
  staffId: r.staff_id, staffName: r.staff_name ?? null, authorName: r.author_name,
  salonRating: Number(r.salon_rating), staffRating: num(r.staff_rating), comment: r.comment ?? null,
  status: r.status, hiddenReason: r.hidden_reason ?? null, hiddenAt: iso(r.hidden_at),
  ownerResponse: r.owner_response ?? null, ownerResponseAt: iso(r.owner_response_at), editedAt: iso(r.edited_at),
  createdAt: r.created_at, visitAt: iso(r.visit_at),
  openReport: r.open_report_id ? { id: r.open_report_id, reason: r.open_report_reason, createdAt: iso(r.open_report_at) as string } : null,
  services: [],
});

export interface StatsRow { stars: Stars; count: number; average: number | null }
const stats = (r: Row | undefined): StatsRow => {
  if (!r) return { stars: EMPTY_STARS, count: 0, average: null };
  return { stars: [Number(r.star_1), Number(r.star_2), Number(r.star_3), Number(r.star_4), Number(r.star_5)], count: Number(r.review_count), average: num(r.rating_avg) };
};

export interface ReportRecord {
  id: string; salonId: string; salonName: string; reviewId: string; reason: ReportReason; details: string | null; status: ReportStatus;
  resolutionNote: string | null; resolvedAt: string | null; createdAt: string;
  review?: { authorName: string; salonRating: number; staffRating: number | null; comment: string | null; status: ReviewStatus; staffName: string | null };
}

export interface CustomerSummaryRow {
  customerUserId: string; name: string; phone: string | null; visits: number; noShows: number; cancelled: number; spent: string;
  firstVisitAt: string | null; lastVisitAt: string | null; upcoming: number; total: number;
}

export interface HistoryLine { id: string; status: string; startsAt: string; staffName: string; totalPrice: string; services: string[] }

export interface PendingRow { appointmentId: string; salonId: string; salonName: string; staffId: string; staffName: string; startsAt: string; completedAt: Date; services: Array<{ serviceId: string; name: string }> }

/**
 * All SQL for Phase 14. Parameters are always bound with explicit casts; no value is ever concatenated into SQL.
 * Row-Level Security does the final filtering for every caller (customer, owner, staff, admin, public); the WHERE clauses
 * here repeat the intent so a customer context (which also opens public reads) can never leak another customer's rows.
 */
@Injectable()
export class ReviewsRepository {
  // ------------------------------------------------------------------ attach service ratings
  async attachServices(tx: Tx, items: ReviewRecord[]): Promise<ReviewRecord[]> {
    if (items.length === 0) return items;
    const ids = items.map((i) => i.id);
    const rows = await tx.$queryRaw<Row[]>`
      SELECT review_id, service_id, service_name, rating FROM review_services WHERE review_id = ANY(${ids}::uuid[]) ORDER BY created_at, id`;
    const by = new Map<string, ServiceRating[]>();
    for (const x of rows) by.set(x.review_id, [...(by.get(x.review_id) ?? []), { serviceId: x.service_id, name: x.service_name, rating: Number(x.rating) }]);
    for (const i of items) i.services = by.get(i.id) ?? [];
    return items;
  }

  // ------------------------------------------------------------------ customer
  /** The caller's own appointment with its lines (customer_own_read). */
  async ownAppointment(tx: Tx, customerId: string, appointmentId: string) {
    const r = await tx.$queryRaw<Row[]>`
      SELECT a.id, a.salon_id, a.staff_id, a.status::text AS status, a.completed_at, a.starts_at, a.salon_name, a.staff_name
      FROM appointments a WHERE a.id = ${appointmentId}::uuid AND a.customer_user_id = ${customerId}::uuid`;
    if (!r[0]) return null;
    const lines = await tx.$queryRaw<Row[]>`SELECT service_id, service_name FROM appointment_services WHERE appointment_id = ${appointmentId}::uuid ORDER BY position`;
    return {
      id: r[0].id as string, salonId: r[0].salon_id as string, staffId: r[0].staff_id as string, status: r[0].status as string,
      completedAt: (r[0].completed_at as Date | null) ?? null, startsAt: r[0].starts_at as Date, salonName: r[0].salon_name as string, staffName: r[0].staff_name as string,
      services: lines.map((l) => ({ serviceId: l.service_id as string, name: l.service_name as string })),
    };
  }

  async insertReview(
    tx: Tx, v: { salonId: string; appointmentId: string; customerId: string; staffId: string; authorName: string; salonRating: number; staffRating: number | null; comment: string | null },
  ): Promise<string> {
    const r = await tx.$queryRaw<Row[]>`
      INSERT INTO reviews (salon_id, appointment_id, customer_user_id, staff_id, author_name, salon_rating, staff_rating, comment)
      VALUES (${v.salonId}::uuid, ${v.appointmentId}::uuid, ${v.customerId}::uuid, ${v.staffId}::uuid, ${v.authorName}::varchar, ${v.salonRating}::smallint,
              ${v.staffRating}::smallint, ${v.comment}::varchar)
      RETURNING id`;
    return r[0].id as string;
  }

  async insertServiceRating(tx: Tx, v: { salonId: string; reviewId: string; serviceId: string; rating: number }): Promise<void> {
    await tx.$executeRaw`
      INSERT INTO review_services (salon_id, review_id, service_id, service_name, rating)
      VALUES (${v.salonId}::uuid, ${v.reviewId}::uuid, ${v.serviceId}::uuid, 'pending', ${v.rating}::smallint)`;
  }

  async updateOwn(tx: Tx, id: string, customerId: string, v: { salonRating: number; staffRating: number | null; comment: string | null }): Promise<number> {
    return tx.$executeRaw`
      UPDATE reviews SET salon_rating = ${v.salonRating}::smallint, staff_rating = ${v.staffRating}::smallint, comment = ${v.comment}::varchar
      WHERE id = ${id}::uuid AND customer_user_id = ${customerId}::uuid`;
  }

  async findOwn(tx: Tx, customerId: string, id: string): Promise<ReviewRecord | null> {
    const r = await tx.$queryRaw<Row[]>`
      SELECT r.*, a.starts_at AS visit_at, sl.name AS salon_name, sp.display_name AS staff_name,
        (SELECT x.id FROM review_reports x WHERE x.review_id = r.id AND x.status = 'OPEN') AS open_report_id,
        (SELECT x.reason FROM review_reports x WHERE x.review_id = r.id AND x.status = 'OPEN') AS open_report_reason,
        (SELECT x.created_at FROM review_reports x WHERE x.review_id = r.id AND x.status = 'OPEN') AS open_report_at FROM reviews r LEFT JOIN appointments a ON a.id = r.appointment_id LEFT JOIN salons sl ON sl.id = r.salon_id LEFT JOIN staff_profiles sp ON sp.id = r.staff_id
      WHERE r.id = ${id}::uuid AND r.customer_user_id = ${customerId}::uuid`;
    return r[0] ? (await this.attachServices(tx, [review(r[0])]))[0] : null;
  }

  async listOwn(tx: Tx, customerId: string, limit: number, offset: number): Promise<{ items: ReviewRecord[]; total: number }> {
    const r = await tx.$queryRaw<Row[]>`
      SELECT r.*, a.starts_at AS visit_at, sl.name AS salon_name, sp.display_name AS staff_name,
        (SELECT x.id FROM review_reports x WHERE x.review_id = r.id AND x.status = 'OPEN') AS open_report_id,
        (SELECT x.reason FROM review_reports x WHERE x.review_id = r.id AND x.status = 'OPEN') AS open_report_reason,
        (SELECT x.created_at FROM review_reports x WHERE x.review_id = r.id AND x.status = 'OPEN') AS open_report_at, count(*) OVER ()::int AS total
      FROM reviews r LEFT JOIN appointments a ON a.id = r.appointment_id LEFT JOIN salons sl ON sl.id = r.salon_id LEFT JOIN staff_profiles sp ON sp.id = r.staff_id
      WHERE r.customer_user_id = ${customerId}::uuid ORDER BY r.created_at DESC, r.id LIMIT ${limit}::int OFFSET ${offset}::int`;
    return { items: await this.attachServices(tx, r.map(review)), total: Number(r[0]?.total ?? 0) };
  }

  /** Completed, not yet reviewed appointments of the caller that finished inside the review window. */
  async pendingFor(tx: Tx, customerId: string, windowDays: number, limit: number): Promise<PendingRow[]> {
    const r = await tx.$queryRaw<Row[]>`
      SELECT a.id, a.salon_id, a.salon_name, a.staff_id, a.staff_name, a.starts_at, a.completed_at
      FROM appointments a
      WHERE a.customer_user_id = ${customerId}::uuid AND a.status = 'COMPLETED' AND a.completed_at IS NOT NULL
        AND a.completed_at >= now() - (${windowDays}::int * interval '1 day')
        AND NOT EXISTS (SELECT 1 FROM reviews rv WHERE rv.appointment_id = a.id)
      ORDER BY a.completed_at DESC LIMIT ${limit}::int`;
    if (r.length === 0) return [];
    const ids = r.map((x) => x.id as string);
    const lines = await tx.$queryRaw<Row[]>`SELECT appointment_id, service_id, service_name FROM appointment_services WHERE appointment_id = ANY(${ids}::uuid[]) ORDER BY appointment_id, position`;
    const by = new Map<string, Array<{ serviceId: string; name: string }>>();
    for (const l of lines) by.set(l.appointment_id, [...(by.get(l.appointment_id) ?? []), { serviceId: l.service_id, name: l.service_name }]);
    return r.map((x) => ({
      appointmentId: x.id, salonId: x.salon_id, salonName: x.salon_name, staffId: x.staff_id, staffName: x.staff_name,
      startsAt: iso(x.starts_at) as string, completedAt: x.completed_at, services: by.get(x.id) ?? [],
    }));
  }

  // ------------------------------------------------------------------ public
  async salonStats(tx: Tx, salonId: string): Promise<StatsRow> {
    const r = await tx.$queryRaw<Row[]>`SELECT star_1, star_2, star_3, star_4, star_5, review_count, rating_avg FROM salon_rating_stats WHERE salon_id = ${salonId}::uuid`;
    return stats(r[0]);
  }

  async staffStats(tx: Tx, salonId: string): Promise<Array<{ staffId: string; name: string } & StatsRow>> {
    const r = await tx.$queryRaw<Row[]>`
      SELECT t.staff_id, sp.display_name, t.star_1, t.star_2, t.star_3, t.star_4, t.star_5, t.review_count, t.rating_avg
      FROM staff_rating_stats t JOIN staff_profiles sp ON sp.id = t.staff_id AND sp.salon_id = t.salon_id AND sp.is_active AND sp.deleted_at IS NULL
      WHERE t.salon_id = ${salonId}::uuid AND t.review_count > 0 ORDER BY t.rating_avg DESC, t.review_count DESC, lower(sp.display_name)`;
    return r.map((x) => ({ staffId: x.staff_id as string, name: x.display_name as string, ...stats(x) }));
  }

  /** PUBLISHED reviews of one salon (the caller must have checked that the salon is listed). */
  async listPublished(tx: Tx, salonId: string, sort: ReviewSort, limit: number, offset: number): Promise<{ items: ReviewRecord[]; total: number }> {
    const r = await tx.$queryRaw<Row[]>`
      SELECT r.*, a.starts_at AS visit_at, sl.name AS salon_name, sp.display_name AS staff_name,
        (SELECT x.id FROM review_reports x WHERE x.review_id = r.id AND x.status = 'OPEN') AS open_report_id,
        (SELECT x.reason FROM review_reports x WHERE x.review_id = r.id AND x.status = 'OPEN') AS open_report_reason,
        (SELECT x.created_at FROM review_reports x WHERE x.review_id = r.id AND x.status = 'OPEN') AS open_report_at, count(*) OVER ()::int AS total
      FROM reviews r LEFT JOIN appointments a ON a.id = r.appointment_id LEFT JOIN salons sl ON sl.id = r.salon_id LEFT JOIN staff_profiles sp ON sp.id = r.staff_id
      WHERE r.salon_id = ${salonId}::uuid AND r.status = 'PUBLISHED'
      ORDER BY
        CASE WHEN ${sort}::text = 'highest' THEN r.salon_rating END DESC,
        CASE WHEN ${sort}::text = 'lowest' THEN r.salon_rating END ASC,
        r.created_at DESC, r.id
      LIMIT ${limit}::int OFFSET ${offset}::int`;
    return { items: await this.attachServices(tx, r.map(review)), total: Number(r[0]?.total ?? 0) };
  }

  // ------------------------------------------------------------------ owner
  async listForSalon(
    tx: Tx, salonId: string, f: { rating: number | null; unanswered: boolean; staffId: string | null; limit: number; offset: number },
  ): Promise<{ items: ReviewRecord[]; total: number }> {
    const r = await tx.$queryRaw<Row[]>`
      SELECT r.*, a.starts_at AS visit_at, sl.name AS salon_name, sp.display_name AS staff_name,
        (SELECT x.id FROM review_reports x WHERE x.review_id = r.id AND x.status = 'OPEN') AS open_report_id,
        (SELECT x.reason FROM review_reports x WHERE x.review_id = r.id AND x.status = 'OPEN') AS open_report_reason,
        (SELECT x.created_at FROM review_reports x WHERE x.review_id = r.id AND x.status = 'OPEN') AS open_report_at, count(*) OVER ()::int AS total
      FROM reviews r LEFT JOIN appointments a ON a.id = r.appointment_id LEFT JOIN salons sl ON sl.id = r.salon_id LEFT JOIN staff_profiles sp ON sp.id = r.staff_id
      WHERE r.salon_id = ${salonId}::uuid AND r.status = 'PUBLISHED'
        AND (${f.rating}::int IS NULL OR r.salon_rating = ${f.rating}::int)
        AND (NOT ${f.unanswered}::boolean OR r.owner_response IS NULL)
        AND (${f.staffId}::uuid IS NULL OR r.staff_id = ${f.staffId}::uuid)
      ORDER BY r.created_at DESC, r.id LIMIT ${f.limit}::int OFFSET ${f.offset}::int`;
    return { items: await this.attachServices(tx, r.map(review)), total: Number(r[0]?.total ?? 0) };
  }

  async unansweredCount(tx: Tx, salonId: string): Promise<number> {
    const r = await tx.$queryRaw<Row[]>`SELECT count(*)::int AS n FROM reviews WHERE salon_id = ${salonId}::uuid AND status = 'PUBLISHED' AND owner_response IS NULL`;
    return Number(r[0]?.n ?? 0);
  }

  async findForSalon(tx: Tx, salonId: string, id: string): Promise<ReviewRecord | null> {
    const r = await tx.$queryRaw<Row[]>`
      SELECT r.*, a.starts_at AS visit_at, sl.name AS salon_name, sp.display_name AS staff_name,
        (SELECT x.id FROM review_reports x WHERE x.review_id = r.id AND x.status = 'OPEN') AS open_report_id,
        (SELECT x.reason FROM review_reports x WHERE x.review_id = r.id AND x.status = 'OPEN') AS open_report_reason,
        (SELECT x.created_at FROM review_reports x WHERE x.review_id = r.id AND x.status = 'OPEN') AS open_report_at FROM reviews r LEFT JOIN appointments a ON a.id = r.appointment_id LEFT JOIN salons sl ON sl.id = r.salon_id LEFT JOIN staff_profiles sp ON sp.id = r.staff_id
      WHERE r.id = ${id}::uuid AND r.salon_id = ${salonId}::uuid`;
    return r[0] ? (await this.attachServices(tx, [review(r[0])]))[0] : null;
  }

  async setResponse(tx: Tx, salonId: string, id: string, ownerId: string, text: string | null): Promise<number> {
    return tx.$executeRaw`
      UPDATE reviews SET owner_response = ${text}::varchar, owner_response_by = CASE WHEN ${text}::varchar IS NULL THEN NULL ELSE ${ownerId}::uuid END,
                         owner_response_at = CASE WHEN ${text}::varchar IS NULL THEN NULL ELSE now() END
      WHERE id = ${id}::uuid AND salon_id = ${salonId}::uuid`;
  }

  async insertReport(tx: Tx, v: { salonId: string; reviewId: string; reportedBy: string; reason: ReportReason; details: string | null }): Promise<string> {
    const r = await tx.$queryRaw<Row[]>`
      INSERT INTO review_reports (salon_id, review_id, reported_by, reason, details)
      VALUES (${v.salonId}::uuid, ${v.reviewId}::uuid, ${v.reportedBy}::uuid, ${v.reason}::varchar, ${v.details}::varchar) RETURNING id`;
    return r[0].id as string;
  }

  async listReportsForSalon(tx: Tx, salonId: string, limit: number): Promise<ReportRecord[]> {
    const r = await tx.$queryRaw<Row[]>`
      SELECT x.id, x.salon_id, x.review_id, x.reason, x.details, x.status, x.resolution_note, x.resolved_at, x.created_at, '' AS salon_name
      FROM review_reports x WHERE x.salon_id = ${salonId}::uuid ORDER BY x.created_at DESC LIMIT ${limit}::int`;
    return r.map(report);
  }

  // ------------------------------------------------------------------ staff
  async findOwnStaff(tx: Tx, userId: string): Promise<{ id: string; salonId: string; isActive: boolean } | null> {
    const r = await tx.$queryRaw<Row[]>`SELECT id, salon_id, is_active FROM staff_profiles WHERE user_id = ${userId}::uuid AND deleted_at IS NULL`;
    return r[0] ? { id: r[0].id as string, salonId: r[0].salon_id as string, isActive: Boolean(r[0].is_active) } : null;
  }

  async staffOwnStats(tx: Tx, staffId: string): Promise<StatsRow> {
    const r = await tx.$queryRaw<Row[]>`SELECT star_1, star_2, star_3, star_4, star_5, review_count, rating_avg FROM staff_rating_stats WHERE staff_id = ${staffId}::uuid`;
    return stats(r[0]);
  }

  /** Reviews that rate THIS staff member (a staff rating is present). Never the owner's response data of other people, never customers' ids. */
  async listForStaff(tx: Tx, salonId: string, staffId: string, limit: number, offset: number): Promise<{ items: ReviewRecord[]; total: number }> {
    const r = await tx.$queryRaw<Row[]>`
      SELECT r.*, a.starts_at AS visit_at, sl.name AS salon_name, sp.display_name AS staff_name,
        (SELECT x.id FROM review_reports x WHERE x.review_id = r.id AND x.status = 'OPEN') AS open_report_id,
        (SELECT x.reason FROM review_reports x WHERE x.review_id = r.id AND x.status = 'OPEN') AS open_report_reason,
        (SELECT x.created_at FROM review_reports x WHERE x.review_id = r.id AND x.status = 'OPEN') AS open_report_at, count(*) OVER ()::int AS total
      FROM reviews r LEFT JOIN appointments a ON a.id = r.appointment_id LEFT JOIN salons sl ON sl.id = r.salon_id LEFT JOIN staff_profiles sp ON sp.id = r.staff_id
      WHERE r.salon_id = ${salonId}::uuid AND r.staff_id = ${staffId}::uuid AND r.status = 'PUBLISHED'
      ORDER BY r.created_at DESC, r.id LIMIT ${limit}::int OFFSET ${offset}::int`;
    return { items: await this.attachServices(tx, r.map(review)), total: Number(r[0]?.total ?? 0) };
  }

  // ------------------------------------------------------------------ admin
  async adminList(
    tx: Tx, f: { status: ReviewStatus | null; reported: boolean; rating: number | null; salonId: string | null; limit: number; offset: number },
  ): Promise<{ items: ReviewRecord[]; total: number }> {
    const r = await tx.$queryRaw<Row[]>`
      SELECT r.*, a.starts_at AS visit_at, sl.name AS salon_name, sp.display_name AS staff_name,
        (SELECT x.id FROM review_reports x WHERE x.review_id = r.id AND x.status = 'OPEN') AS open_report_id,
        (SELECT x.reason FROM review_reports x WHERE x.review_id = r.id AND x.status = 'OPEN') AS open_report_reason,
        (SELECT x.created_at FROM review_reports x WHERE x.review_id = r.id AND x.status = 'OPEN') AS open_report_at, count(*) OVER ()::int AS total
      FROM reviews r LEFT JOIN appointments a ON a.id = r.appointment_id LEFT JOIN salons sl ON sl.id = r.salon_id LEFT JOIN staff_profiles sp ON sp.id = r.staff_id
      WHERE (${f.status}::text IS NULL OR r.status = ${f.status}::text)
        AND (NOT ${f.reported}::boolean OR EXISTS (SELECT 1 FROM review_reports x WHERE x.review_id = r.id AND x.status = 'OPEN'))
        AND (${f.rating}::int IS NULL OR r.salon_rating = ${f.rating}::int)
        AND (${f.salonId}::uuid IS NULL OR r.salon_id = ${f.salonId}::uuid)
      ORDER BY r.created_at DESC, r.id LIMIT ${f.limit}::int OFFSET ${f.offset}::int`;
    return { items: await this.attachServices(tx, r.map(review)), total: Number(r[0]?.total ?? 0) };
  }

  async adminFind(tx: Tx, id: string): Promise<ReviewRecord | null> {
    const r = await tx.$queryRaw<Row[]>`
      SELECT r.*, a.starts_at AS visit_at, sl.name AS salon_name, sp.display_name AS staff_name,
        (SELECT x.id FROM review_reports x WHERE x.review_id = r.id AND x.status = 'OPEN') AS open_report_id,
        (SELECT x.reason FROM review_reports x WHERE x.review_id = r.id AND x.status = 'OPEN') AS open_report_reason,
        (SELECT x.created_at FROM review_reports x WHERE x.review_id = r.id AND x.status = 'OPEN') AS open_report_at FROM reviews r LEFT JOIN appointments a ON a.id = r.appointment_id LEFT JOIN salons sl ON sl.id = r.salon_id LEFT JOIN staff_profiles sp ON sp.id = r.staff_id WHERE r.id = ${id}::uuid`;
    return r[0] ? (await this.attachServices(tx, [review(r[0])]))[0] : null;
  }

  async setHidden(tx: Tx, id: string, adminId: string, reason: string | null): Promise<number> {
    return reason === null
      ? tx.$executeRaw`UPDATE reviews SET status = 'PUBLISHED', hidden_reason = NULL, hidden_by = NULL, hidden_at = NULL WHERE id = ${id}::uuid AND status = 'HIDDEN'`
      : tx.$executeRaw`UPDATE reviews SET status = 'HIDDEN', hidden_reason = ${reason}::varchar, hidden_by = ${adminId}::uuid, hidden_at = now() WHERE id = ${id}::uuid AND status = 'PUBLISHED'`;
  }

  async adminReports(tx: Tx, status: ReportStatus | null, limit: number, offset: number): Promise<{ items: ReportRecord[]; total: number }> {
    const r = await tx.$queryRaw<Row[]>`
      SELECT x.id, x.salon_id, x.review_id, x.reason, x.details, x.status, x.resolution_note, x.resolved_at, x.created_at, s.name AS salon_name,
             rv.author_name, rv.salon_rating, rv.staff_rating, rv.comment, rv.status AS review_status, sp.display_name AS staff_name,
             count(*) OVER ()::int AS total
      FROM review_reports x JOIN reviews rv ON rv.id = x.review_id JOIN salons s ON s.id = x.salon_id LEFT JOIN staff_profiles sp ON sp.id = rv.staff_id
      WHERE (${status}::text IS NULL OR x.status = ${status}::text)
      ORDER BY (x.status = 'OPEN') DESC, x.created_at ASC, x.id LIMIT ${limit}::int OFFSET ${offset}::int`;
    return { items: r.map(report), total: Number(r[0]?.total ?? 0) };
  }

  async findReport(tx: Tx, id: string): Promise<{ id: string; reviewId: string; salonId: string; status: ReportStatus } | null> {
    const r = await tx.$queryRaw<Row[]>`SELECT id, review_id, salon_id, status FROM review_reports WHERE id = ${id}::uuid FOR UPDATE`;
    return r[0] ? { id: r[0].id, reviewId: r[0].review_id, salonId: r[0].salon_id, status: r[0].status } : null;
  }

  async resolveReport(tx: Tx, id: string, adminId: string, status: 'DISMISSED' | 'ACTIONED', note: string | null): Promise<number> {
    return tx.$executeRaw`
      UPDATE review_reports SET status = ${status}::varchar, resolved_by = ${adminId}::uuid, resolved_at = now(), resolution_note = ${note}::varchar
      WHERE id = ${id}::uuid AND status = 'OPEN'`;
  }

  /** Counts for the moderation screen header. */
  async adminCounts(tx: Tx): Promise<{ openReports: number; hidden: number; published: number }> {
    const r = await tx.$queryRaw<Row[]>`
      SELECT (SELECT count(*) FROM review_reports WHERE status = 'OPEN')::int AS open_reports,
             (SELECT count(*) FROM reviews WHERE status = 'HIDDEN')::int AS hidden,
             (SELECT count(*) FROM reviews WHERE status = 'PUBLISHED')::int AS published`;
    return { openReports: Number(r[0].open_reports), hidden: Number(r[0].hidden), published: Number(r[0].published) };
  }

  // ------------------------------------------------------------------ favourites
  async favourites(tx: Tx, customerId: string, trialDays: number, today: string, limit: number): Promise<Array<{
    salonId: string; name: string; city: string; area: string; salonType: string; createdAt: string; ratingAvg: number | null; ratingCount: number; coverKey: string | null;
  }>> {
    const r = await tx.$queryRaw<Row[]>`
      SELECT f.salon_id, f.created_at, s.name, s.city, s.area, s.salon_type, st.rating_avg, COALESCE(st.review_count, 0) AS review_count,
             (SELECT sf.storage_key FROM salon_files sf WHERE sf.salon_id = s.id AND sf.kind = 'PHOTO' AND sf.doc_type = 'COVER' AND sf.deleted_at IS NULL
              ORDER BY sf.created_at DESC LIMIT 1) AS cover_key
      FROM customer_favourites f
      JOIN salons s ON s.id = f.salon_id AND s.status = 'APPROVED' AND salon_is_listed(s.id, s.approved_at, ${trialDays}::int, ${today}::date)
      LEFT JOIN salon_rating_stats st ON st.salon_id = s.id
      WHERE f.customer_user_id = ${customerId}::uuid ORDER BY f.created_at DESC LIMIT ${limit}::int`;
    return r.map((x) => ({
      salonId: x.salon_id, name: x.name, city: x.city, area: x.area, salonType: x.salon_type, createdAt: iso(x.created_at) as string,
      ratingAvg: num(x.rating_avg), ratingCount: Number(x.review_count), coverKey: x.cover_key ?? null,
    }));
  }

  async addFavourite(tx: Tx, customerId: string, salonId: string): Promise<boolean> {
    const n = await tx.$executeRaw`INSERT INTO customer_favourites (customer_user_id, salon_id) VALUES (${customerId}::uuid, ${salonId}::uuid) ON CONFLICT DO NOTHING`;
    return n > 0;
  }

  async removeFavourite(tx: Tx, customerId: string, salonId: string): Promise<boolean> {
    const n = await tx.$executeRaw`DELETE FROM customer_favourites WHERE customer_user_id = ${customerId}::uuid AND salon_id = ${salonId}::uuid`;
    return n > 0;
  }

  // ------------------------------------------------------------------ owner: customers and their history
  async customers(
    tx: Tx, salonId: string, f: { q: string | null; sort: 'recent' | 'visits' | 'spent'; limit: number; offset: number },
  ): Promise<{ items: CustomerSummaryRow[]; total: number }> {
    const r = await tx.$queryRaw<Row[]>`
      SELECT a.customer_user_id, u.full_name, u.phone,
             count(*) FILTER (WHERE a.status = 'COMPLETED')::int AS visits,
             count(*) FILTER (WHERE a.status = 'NO_SHOW')::int AS no_shows,
             count(*) FILTER (WHERE a.status = 'CANCELLED')::int AS cancelled,
             count(*) FILTER (WHERE a.status IN ('PENDING', 'CONFIRMED', 'IN_PROGRESS', 'DELAYED'))::int AS upcoming,
             COALESCE(sum(a.total_price) FILTER (WHERE a.status = 'COMPLETED'), 0) AS spent,
             min(a.starts_at) FILTER (WHERE a.status = 'COMPLETED') AS first_visit,
             max(a.starts_at) FILTER (WHERE a.status = 'COMPLETED') AS last_visit,
             count(*) OVER ()::int AS total
      FROM appointments a JOIN users u ON u.id = a.customer_user_id
      WHERE a.salon_id = ${salonId}::uuid AND a.customer_user_id IS NOT NULL
        AND (${f.q}::text IS NULL OR u.full_name ILIKE ${f.q}::text)
      GROUP BY a.customer_user_id, u.full_name, u.phone
      ORDER BY
        CASE WHEN ${f.sort}::text = 'visits' THEN count(*) FILTER (WHERE a.status = 'COMPLETED') END DESC,
        CASE WHEN ${f.sort}::text = 'spent' THEN COALESCE(sum(a.total_price) FILTER (WHERE a.status = 'COMPLETED'), 0) END DESC,
        max(a.starts_at) DESC, a.customer_user_id
      LIMIT ${f.limit}::int OFFSET ${f.offset}::int`;
    return { items: r.map(customerRow), total: Number(r[0]?.total ?? 0) };
  }

  async customer(tx: Tx, salonId: string, customerId: string): Promise<CustomerSummaryRow | null> {
    const r = await tx.$queryRaw<Row[]>`
      SELECT a.customer_user_id, u.full_name, u.phone,
             count(*) FILTER (WHERE a.status = 'COMPLETED')::int AS visits,
             count(*) FILTER (WHERE a.status = 'NO_SHOW')::int AS no_shows,
             count(*) FILTER (WHERE a.status = 'CANCELLED')::int AS cancelled,
             count(*) FILTER (WHERE a.status IN ('PENDING', 'CONFIRMED', 'IN_PROGRESS', 'DELAYED'))::int AS upcoming,
             COALESCE(sum(a.total_price) FILTER (WHERE a.status = 'COMPLETED'), 0) AS spent,
             min(a.starts_at) FILTER (WHERE a.status = 'COMPLETED') AS first_visit,
             max(a.starts_at) FILTER (WHERE a.status = 'COMPLETED') AS last_visit,
             1 AS total
      FROM appointments a JOIN users u ON u.id = a.customer_user_id
      WHERE a.salon_id = ${salonId}::uuid AND a.customer_user_id = ${customerId}::uuid
      GROUP BY a.customer_user_id, u.full_name, u.phone`;
    return r[0] ? customerRow(r[0]) : null;
  }

  async customerHistory(tx: Tx, salonId: string, customerId: string, limit: number): Promise<HistoryLine[]> {
    const r = await tx.$queryRaw<Row[]>`
      SELECT a.id, a.status::text AS status, a.starts_at, a.staff_name, a.total_price,
             COALESCE((SELECT array_agg(s.service_name ORDER BY s.position) FROM appointment_services s WHERE s.appointment_id = a.id), ARRAY[]::varchar[]) AS services
      FROM appointments a WHERE a.salon_id = ${salonId}::uuid AND a.customer_user_id = ${customerId}::uuid
      ORDER BY a.starts_at DESC, a.id LIMIT ${limit}::int`;
    return r.map((x) => ({ id: x.id, status: x.status, startsAt: iso(x.starts_at) as string, staffName: x.staff_name, totalPrice: String(Number(x.total_price).toFixed(2)), services: (x.services as string[]) ?? [] }));
  }

  async customerReview(tx: Tx, salonId: string, customerId: string): Promise<ReviewRecord[]> {
    const r = await tx.$queryRaw<Row[]>`
      SELECT r.*, a.starts_at AS visit_at, sl.name AS salon_name, sp.display_name AS staff_name,
        (SELECT x.id FROM review_reports x WHERE x.review_id = r.id AND x.status = 'OPEN') AS open_report_id,
        (SELECT x.reason FROM review_reports x WHERE x.review_id = r.id AND x.status = 'OPEN') AS open_report_reason,
        (SELECT x.created_at FROM review_reports x WHERE x.review_id = r.id AND x.status = 'OPEN') AS open_report_at FROM reviews r LEFT JOIN appointments a ON a.id = r.appointment_id LEFT JOIN salons sl ON sl.id = r.salon_id LEFT JOIN staff_profiles sp ON sp.id = r.staff_id
      WHERE r.salon_id = ${salonId}::uuid AND r.customer_user_id = ${customerId}::uuid AND r.status = 'PUBLISHED' ORDER BY r.created_at DESC LIMIT 20`;
    return this.attachServices(tx, r.map(review));
  }
}

const customerRow = (x: Row): CustomerSummaryRow => ({
  customerUserId: x.customer_user_id, name: x.full_name, phone: x.phone ?? null, visits: Number(x.visits), noShows: Number(x.no_shows), cancelled: Number(x.cancelled),
  spent: Number(x.spent).toFixed(2), firstVisitAt: iso(x.first_visit), lastVisitAt: iso(x.last_visit), upcoming: Number(x.upcoming), total: Number(x.total),
});

const report = (x: Row): ReportRecord => ({
  id: x.id, salonId: x.salon_id, salonName: x.salon_name ?? '', reviewId: x.review_id, reason: x.reason, details: x.details ?? null, status: x.status,
  resolutionNote: x.resolution_note ?? null, resolvedAt: iso(x.resolved_at), createdAt: iso(x.created_at) as string,
  ...(x.author_name !== undefined
    ? { review: { authorName: x.author_name, salonRating: Number(x.salon_rating), staffRating: num(x.staff_rating), comment: x.comment ?? null, status: x.review_status, staffName: x.staff_name ?? null } }
    : {}),
});
