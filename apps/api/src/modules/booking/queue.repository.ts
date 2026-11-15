import { Injectable } from '@nestjs/common';
import { Tx } from '../salons/salons.repository';
import { AppointmentRecord, mapAppointment } from './booking.repository';
import { ACTIVE_STATUSES } from './booking.types';

type Row = Record<string, any>;
const date = (v: unknown): Date => (v instanceof Date ? v : new Date(v as string));
const ACTIVE = [...ACTIVE_STATUSES] as string[];

export interface StaffLaneRecord {
  id: string;
  name: string;
  isOwner: boolean;
}

export interface OwnStaffRecord {
  id: string;
  salonId: string;
  name: string;
  isActive: boolean;
  performsServices: boolean;
  permissions: string[];
}

export interface OfferRecord {
  id: string;
  appointmentId: string;
  offeredStart: Date;
  expiresAt: Date;
  status: 'PENDING' | 'ACCEPTED' | 'DECLINED' | 'EXPIRED' | 'WITHDRAWN';
  createdAt: Date;
}

export interface TodayCounts {
  completed: number;
  noShows: number;
}

export interface NewWalkIn {
  salonId: string;
  staffId: string;
  name: string;
  phone: string | null;
  startsAt: Date;
  endsAt: Date;
  bufferMinutes: number;
  blockedUntil: Date;
  totalDurationMinutes: number;
  totalPrice: string;
  salonName: string;
  staffName: string;
  note: string | null;
  idempotencyKey: string | null;
  requestFingerprint: string | null;
  now: Date;
}

const offer = (r: Row): OfferRecord => ({
  id: r.id, appointmentId: r.appointment_id, offeredStart: date(r.offered_start), expiresAt: date(r.expires_at), status: r.status, createdAt: date(r.created_at),
});

/**
 * All SQL for Phase 9 (the live queue, walk-ins, early offers, customer arrival). Same rules as BookingRepository: every method
 * takes the transaction opened by TenantDb so Row-Level Security applies, parameters are bound and carry explicit casts.
 *
 * IMPORTANT: every status change below repeats the EXPECTED status in its WHERE clause. A concurrent change (customer cancels while
 * staff taps Start) then updates zero rows and the service reports a conflict instead of overwriting the other change.
 */
@Injectable()
export class QueueRepository {
  // ------------------------------------------------------------------ concurrency
  /** Serialises all queue work of ONE staff member (start, complete, next, walk-in, offers, estimate refresh). Released at commit. */
  async lockStaff(tx: Tx, staffId: string): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`queue:${staffId}`}::text, 0))`;
  }

  // ------------------------------------------------------------------ staff
  /** The caller's own staff profile (RLS `staff_self_read`) with the permissions the owner granted. */
  async findOwnStaff(tx: Tx, userId: string): Promise<OwnStaffRecord | null> {
    const r = await tx.$queryRaw<Row[]>`
      SELECT id, salon_id, display_name, is_active, performs_services, granted_permissions
      FROM staff_profiles WHERE user_id = ${userId}::uuid AND deleted_at IS NULL`;
    const x = r[0];
    return x
      ? { id: x.id, salonId: x.salon_id, name: x.display_name, isActive: Boolean(x.is_active), performsServices: Boolean(x.performs_services), permissions: (x.granted_permissions ?? []) as string[] }
      : null;
  }

  /** Active staff who perform services (the people that can have a queue), optionally narrowed to some ids. */
  async lanes(tx: Tx, salonId: string, staffIds: string[] | null): Promise<StaffLaneRecord[]> {
    const r = await tx.$queryRaw<Row[]>`
      SELECT id, display_name, is_owner FROM staff_profiles
      WHERE salon_id = ${salonId}::uuid AND is_active AND deleted_at IS NULL AND performs_services
        AND (${staffIds}::uuid[] IS NULL OR id = ANY(${staffIds}::uuid[]))
      ORDER BY lower(display_name), id`;
    return r.map((x) => ({ id: x.id, name: x.display_name, isOwner: Boolean(x.is_owner) }));
  }

  // ------------------------------------------------------------------ reads
  /** The services one staff member offers (active, in an active category), with THEIR price. Feeds the walk-in form. */
  async offeredServices(tx: Tx, salonId: string, staffId: string): Promise<Array<{ id: string; name: string; durationMinutes: number; price: string }>> {
    const r = await tx.$queryRaw<Row[]>`
      SELECT sv.id, sv.name, sv.duration_minutes,
             CASE WHEN sv.pricing_mode = 'FIXED' THEN sv.base_price ELSE ss.price END AS price
      FROM services sv
      JOIN service_categories c ON c.salon_id = sv.salon_id AND c.id = sv.category_id AND c.is_active AND c.deleted_at IS NULL
      JOIN staff_services ss ON ss.salon_id = sv.salon_id AND ss.service_id = sv.id AND ss.staff_id = ${staffId}::uuid
      JOIN staff_profiles sp ON sp.salon_id = ss.salon_id AND sp.id = ss.staff_id AND sp.is_active AND sp.deleted_at IS NULL
      WHERE sv.salon_id = ${salonId}::uuid AND sv.is_active AND sv.deleted_at IS NULL
      ORDER BY c.display_order, lower(sv.name), sv.id`;
    return r
      .filter((x) => x.price !== null && x.price !== undefined)
      .map((x) => ({ id: x.id as string, name: x.name as string, durationMinutes: Number(x.duration_minutes), price: Number(x.price).toFixed(2) }));
  }

  /**
   * Open appointments of the given staff for ONE Karachi day, plus anything still IN_PROGRESS from earlier. Customer name (walk-ins:
   * their own name); the phone only when `includePhone` (owner), staff never get it.
   */
  async openToday(tx: Tx, salonId: string, staffIds: string[], dayStart: Date, dayEnd: Date, includePhone: boolean): Promise<AppointmentRecord[]> {
    const r = await tx.$queryRaw<Row[]>`
      SELECT a.*, COALESCE(u.full_name, a.walk_in_name) AS customer_name,
             CASE WHEN ${includePhone}::boolean THEN COALESCE(u.phone, a.walk_in_phone) END AS customer_phone
      FROM appointments a LEFT JOIN users u ON u.id = a.customer_user_id
      WHERE a.salon_id = ${salonId}::uuid AND a.staff_id = ANY(${staffIds}::uuid[]) AND a.status::text = ANY(${ACTIVE}::text[])
        AND (a.status = 'IN_PROGRESS' OR (a.starts_at >= ${dayStart}::timestamptz AND a.starts_at < ${dayEnd}::timestamptz))
      ORDER BY a.staff_id, a.starts_at, a.id`;
    return r.map(mapAppointment);
  }

  /** Appointments from BEFORE today that are still open (CONFIRMED and forgotten): the salon closes them as completed-less no-shows. */
  async overdue(tx: Tx, salonId: string, staffIds: string[], dayStart: Date, includePhone: boolean, limit: number): Promise<AppointmentRecord[]> {
    const r = await tx.$queryRaw<Row[]>`
      SELECT a.*, COALESCE(u.full_name, a.walk_in_name) AS customer_name,
             CASE WHEN ${includePhone}::boolean THEN COALESCE(u.phone, a.walk_in_phone) END AS customer_phone
      FROM appointments a LEFT JOIN users u ON u.id = a.customer_user_id
      WHERE a.salon_id = ${salonId}::uuid AND a.staff_id = ANY(${staffIds}::uuid[]) AND a.status = 'CONFIRMED'
        AND a.starts_at < ${dayStart}::timestamptz
      ORDER BY a.starts_at DESC, a.id LIMIT ${limit}::int`;
    return r.map(mapAppointment);
  }

  async todayCounts(tx: Tx, salonId: string, staffIds: string[], dayStart: Date, dayEnd: Date): Promise<Map<string, TodayCounts>> {
    const r = await tx.$queryRaw<Row[]>`
      SELECT staff_id, (count(*) FILTER (WHERE status = 'COMPLETED'))::int AS completed, (count(*) FILTER (WHERE status = 'NO_SHOW'))::int AS no_shows
      FROM appointments
      WHERE salon_id = ${salonId}::uuid AND staff_id = ANY(${staffIds}::uuid[]) AND starts_at >= ${dayStart}::timestamptz AND starts_at < ${dayEnd}::timestamptz
      GROUP BY staff_id`;
    return new Map(r.map((x) => [x.staff_id as string, { completed: Number(x.completed), noShows: Number(x.no_shows) }]));
  }

  async waitingWalkIns(tx: Tx, salonId: string, staffId: string, dayStart: Date, dayEnd: Date): Promise<number> {
    const r = await tx.$queryRaw<Row[]>`
      SELECT count(*)::int AS n FROM appointments
      WHERE salon_id = ${salonId}::uuid AND staff_id = ${staffId}::uuid AND source = 'WALK_IN' AND status = 'CONFIRMED'
        AND starts_at >= ${dayStart}::timestamptz AND starts_at < ${dayEnd}::timestamptz`;
    return Number(r[0]?.n ?? 0);
  }

  async findWalkInByIdempotency(tx: Tx, salonId: string, key: string): Promise<AppointmentRecord | null> {
    const r = await tx.$queryRaw<Row[]>`
      SELECT a.*, a.walk_in_name AS customer_name, NULL::text AS customer_phone
      FROM appointments a WHERE a.salon_id = ${salonId}::uuid AND a.source = 'WALK_IN' AND a.idempotency_key = ${key}::varchar`;
    return r[0] ? mapAppointment(r[0]) : null;
  }

  async inProgressFor(tx: Tx, staffId: string): Promise<{ id: string } | null> {
    const r = await tx.$queryRaw<Row[]>`SELECT id FROM appointments WHERE staff_id = ${staffId}::uuid AND status = 'IN_PROGRESS' LIMIT 1`;
    return r[0] ? { id: r[0].id as string } : null;
  }

  // ------------------------------------------------------------------ progress writes (salon side)
  async markStarted(tx: Tx, id: string, now: Date): Promise<boolean> {
    const r = await tx.$queryRaw<Row[]>`
      UPDATE appointments SET status = 'IN_PROGRESS', started_at = ${now}::timestamptz, estimated_starts_at = NULL, updated_at = ${now}::timestamptz
      WHERE id = ${id}::uuid AND status = 'CONFIRMED' RETURNING id`;
    return r.length > 0;
  }

  async markCompleted(tx: Tx, id: string, now: Date): Promise<boolean> {
    const r = await tx.$queryRaw<Row[]>`
      UPDATE appointments SET status = 'COMPLETED', completed_at = ${now}::timestamptz, updated_at = ${now}::timestamptz
      WHERE id = ${id}::uuid AND status = 'IN_PROGRESS' RETURNING id`;
    return r.length > 0;
  }

  async markNoShow(tx: Tx, id: string, now: Date): Promise<boolean> {
    const r = await tx.$queryRaw<Row[]>`
      UPDATE appointments SET status = 'NO_SHOW', no_show_at = ${now}::timestamptz, estimated_starts_at = NULL, updated_at = ${now}::timestamptz
      WHERE id = ${id}::uuid AND status = 'CONFIRMED' RETURNING id`;
    return r.length > 0;
  }

  /** Stores the salon's estimate (NULL = back on time). The ORIGINAL time (starts_at) is never touched. */
  async saveEstimate(tx: Tx, id: string, estimate: Date | null, now: Date): Promise<boolean> {
    const r = await tx.$queryRaw<Row[]>`
      UPDATE appointments SET estimated_starts_at = ${estimate}::timestamptz, eta_updated_at = ${now}::timestamptz, updated_at = ${now}::timestamptz
      WHERE id = ${id}::uuid AND status IN ('CONFIRMED', 'PENDING') RETURNING id`;
    return r.length > 0;
  }

  async insertWalkIn(tx: Tx, w: NewWalkIn): Promise<string> {
    const r = await tx.$queryRaw<Row[]>`
      INSERT INTO appointments (salon_id, customer_user_id, staff_id, status, source, walk_in_name, walk_in_phone, starts_at, ends_at, buffer_minutes,
                                blocked_until, total_duration_minutes, total_price, salon_name, staff_name, customer_note, idempotency_key,
                                request_fingerprint, updated_at)
      VALUES (${w.salonId}::uuid, NULL, ${w.staffId}::uuid, 'CONFIRMED', 'WALK_IN', ${w.name}::varchar, ${w.phone}::varchar, ${w.startsAt}::timestamptz,
              ${w.endsAt}::timestamptz, ${w.bufferMinutes}::smallint, ${w.blockedUntil}::timestamptz, ${w.totalDurationMinutes}::int,
              ${w.totalPrice}::numeric, ${w.salonName}::varchar, ${w.staffName}::varchar, ${w.note}::varchar, ${w.idempotencyKey}::varchar,
              ${w.requestFingerprint}::char(64), ${w.now}::timestamptz)
      RETURNING id`;
    return r[0].id as string;
  }

  // ------------------------------------------------------------------ early offers
  async pendingOffers(tx: Tx, appointmentIds: string[]): Promise<Map<string, OfferRecord>> {
    const out = new Map<string, OfferRecord>();
    if (appointmentIds.length === 0) return out;
    const r = await tx.$queryRaw<Row[]>`
      SELECT id, appointment_id, offered_start, expires_at, status, created_at FROM appointment_early_offers
      WHERE appointment_id = ANY(${appointmentIds}::uuid[]) AND status = 'PENDING'`;
    for (const x of r) out.set(x.appointment_id as string, offer(x));
    return out;
  }

  async offerCount(tx: Tx, appointmentId: string): Promise<number> {
    const r = await tx.$queryRaw<Row[]>`SELECT count(*)::int AS n FROM appointment_early_offers WHERE appointment_id = ${appointmentId}::uuid`;
    return Number(r[0]?.n ?? 0);
  }

  /** An offer whose time ran out is closed, so a new one can be made (one PENDING offer per appointment). */
  async expireOffers(tx: Tx, appointmentId: string, now: Date): Promise<void> {
    await tx.$executeRaw`
      UPDATE appointment_early_offers SET status = 'EXPIRED', responded_at = ${now}::timestamptz
      WHERE appointment_id = ${appointmentId}::uuid AND status = 'PENDING' AND expires_at <= ${now}::timestamptz`;
  }

  async insertOffer(tx: Tx, o: { salonId: string; appointmentId: string; offeredBy: string; offeredStart: Date; expiresAt: Date }): Promise<string> {
    const r = await tx.$queryRaw<Row[]>`
      INSERT INTO appointment_early_offers (salon_id, appointment_id, offered_by, offered_start, expires_at)
      VALUES (${o.salonId}::uuid, ${o.appointmentId}::uuid, ${o.offeredBy}::uuid, ${o.offeredStart}::timestamptz, ${o.expiresAt}::timestamptz)
      RETURNING id`;
    return r[0].id as string;
  }

  /** Withdraws the open offer of an appointment (staff changed their mind, or the appointment started / ended). Returns the offer or null. */
  async withdrawOffer(tx: Tx, appointmentId: string, now: Date): Promise<OfferRecord | null> {
    const r = await tx.$queryRaw<Row[]>`
      UPDATE appointment_early_offers SET status = 'WITHDRAWN', responded_at = ${now}::timestamptz
      WHERE appointment_id = ${appointmentId}::uuid AND status = 'PENDING'
      RETURNING id, appointment_id, offered_start, expires_at, status, created_at`;
    return r[0] ? offer(r[0]) : null;
  }

  /** The caller's own open offer by id (customer context; the explicit customer filter does not rely on RLS alone). */
  async findOfferForCustomer(tx: Tx, customerId: string, appointmentId: string, offerId: string): Promise<OfferRecord | null> {
    const r = await tx.$queryRaw<Row[]>`
      SELECT o.id, o.appointment_id, o.offered_start, o.expires_at, o.status, o.created_at
      FROM appointment_early_offers o JOIN appointments a ON a.id = o.appointment_id AND a.salon_id = o.salon_id
      WHERE o.id = ${offerId}::uuid AND o.appointment_id = ${appointmentId}::uuid AND a.customer_user_id = ${customerId}::uuid`;
    return r[0] ? offer(r[0]) : null;
  }

  /** The customer answers. `responded_at` uses the database clock on purpose: the appointment trigger checks it equals now() of this transaction. */
  async answerOffer(tx: Tx, offerId: string, status: 'ACCEPTED' | 'DECLINED', etaMinutes: number | null): Promise<boolean> {
    const r = await tx.$queryRaw<Row[]>`
      UPDATE appointment_early_offers SET status = ${status}::varchar, responded_at = now(), customer_eta_minutes = ${etaMinutes}::smallint
      WHERE id = ${offerId}::uuid AND status = 'PENDING' RETURNING id`;
    return r.length > 0;
  }

  // ------------------------------------------------------------------ customer writes
  /** Accepting an early offer moves the start earlier; it is NOT a reschedule, so the counter stays (the trigger checks the accepted offer). */
  async moveEarly(tx: Tx, customerId: string, id: string, t: { startsAt: Date; endsAt: Date; blockedUntil: Date }, now: Date): Promise<boolean> {
    const r = await tx.$queryRaw<Row[]>`
      UPDATE appointments SET starts_at = ${t.startsAt}::timestamptz, ends_at = ${t.endsAt}::timestamptz, blocked_until = ${t.blockedUntil}::timestamptz,
        updated_at = ${now}::timestamptz
      WHERE id = ${id}::uuid AND customer_user_id = ${customerId}::uuid AND status = 'CONFIRMED' RETURNING id`;
    return r.length > 0;
  }

  async setArrival(tx: Tx, customerId: string, id: string, state: 'ON_THE_WAY' | 'RUNNING_LATE', etaAt: Date | null, now: Date): Promise<boolean> {
    const r = await tx.$queryRaw<Row[]>`
      UPDATE appointments SET arrival_state = ${state}::varchar, customer_eta_at = ${etaAt}::timestamptz, arrival_updated_at = ${now}::timestamptz,
        arrival_updates = arrival_updates + 1, updated_at = ${now}::timestamptz
      WHERE id = ${id}::uuid AND customer_user_id = ${customerId}::uuid AND status = 'CONFIRMED' AND arrival_updates < 10 RETURNING id`;
    return r.length > 0;
  }
}
