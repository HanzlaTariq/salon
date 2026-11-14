import { Injectable } from '@nestjs/common';
import { Tx } from '../salons/salons.repository';
import { ACTIVE_STATUSES, BookingPolicy, policyFromRow } from './booking.types';

type Row = Record<string, any>;
const money = (v: unknown): string => Number(v).toFixed(2);
const date = (v: unknown): Date => (v instanceof Date ? v : new Date(v as string));
const dateOrNull = (v: unknown): Date | null => (v === null || v === undefined ? null : date(v));

export interface AppointmentRecord {
  id: string;
  salonId: string;
  customerUserId: string;
  staffId: string;
  status: string;
  source: string;
  startsAt: Date;
  endsAt: Date;
  bufferMinutes: number;
  blockedUntil: Date;
  totalDurationMinutes: number;
  totalPrice: string;
  salonName: string;
  staffName: string;
  customerNote: string | null;
  rescheduleCount: number;
  cancelledAt: Date | null;
  cancelledByRole: string | null;
  cancellationReason: string | null;
  idempotencyKey: string | null;
  requestFingerprint: string | null;
  createdAt: Date;
  /** Only filled by queries that join the customer (owner view: name and phone; staff view: name only). */
  customerName: string | null;
  customerPhone: string | null;
}

export interface LineRecord {
  appointmentId: string;
  serviceId: string;
  position: number;
  serviceName: string;
  durationMinutes: number;
  price: string;
}

export interface HistoryRecord {
  appointmentId: string;
  event: string;
  fromStatus: string | null;
  toStatus: string;
  actorRole: string;
  reason: string | null;
  oldStartsAt: Date | null;
  newStartsAt: Date | null;
  createdAt: Date;
}

export interface BookableRow {
  serviceId: string;
  serviceName: string;
  durationMinutes: number;
  price: string | null;
  staffName: string;
}

export interface NewAppointment {
  salonId: string;
  customerUserId: string;
  staffId: string;
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

export interface NewHistory {
  salonId: string;
  appointmentId: string;
  event: 'CREATED' | 'RESCHEDULED' | 'CANCELLED' | 'STATUS_CHANGED';
  fromStatus: string | null;
  toStatus: string;
  actorUserId: string;
  actorRole: 'CUSTOMER' | 'SALON_OWNER' | 'SALON_STAFF';
  reason: string | null;
  oldStartsAt: Date | null;
  newStartsAt: Date | null;
}

const appointment = (r: Row): AppointmentRecord => ({
  id: r.id, salonId: r.salon_id, customerUserId: r.customer_user_id, staffId: r.staff_id, status: r.status, source: r.source,
  startsAt: date(r.starts_at), endsAt: date(r.ends_at), bufferMinutes: Number(r.buffer_minutes), blockedUntil: date(r.blocked_until),
  totalDurationMinutes: Number(r.total_duration_minutes), totalPrice: money(r.total_price), salonName: r.salon_name, staffName: r.staff_name,
  customerNote: r.customer_note ?? null, rescheduleCount: Number(r.reschedule_count), cancelledAt: dateOrNull(r.cancelled_at),
  cancelledByRole: r.cancelled_by_role ?? null, cancellationReason: r.cancellation_reason ?? null, idempotencyKey: r.idempotency_key ?? null,
  requestFingerprint: r.request_fingerprint ?? null, createdAt: date(r.created_at),
  customerName: r.customer_name ?? null, customerPhone: r.customer_phone ?? null,
});

/** The statuses that hold a staff member's time, as a SQL-bindable array (the exclusion constraint uses the same list). */
const ACTIVE = [...ACTIVE_STATUSES] as string[];

/**
 * All SQL for Phase 8 (bookings and booking policies). Every method takes the transaction opened by TenantDb so
 * Row-Level Security applies; parameters are bound and carry explicit casts.
 *
 * IMPORTANT (customer transactions): TenantDb.withCustomer also opens the PUBLIC read context (needed to read salon,
 * services and staff). In that context RLS additionally lets a query SEE the time span of other customers' active
 * appointments (availability). Therefore EVERY customer query below filters `customer_user_id` explicitly: RLS is the
 * second line of defence there, not the first.
 */
@Injectable()
export class BookingRepository {
  // ------------------------------------------------------------------ concurrency
  /** Serialises booking work of ONE customer (limits, idempotent retries). Released at the end of the transaction. */
  async lockCustomer(tx: Tx, userId: string): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`booking:${userId}`}::text, 0))`;
  }

  // ------------------------------------------------------------------ salon, policy, catalogue lookups
  /** An APPROVED salon that is currently listed (same rule as public search: `salon_is_listed`). */
  async salonForBooking(tx: Tx, salonId: string, trialDays: number, today: string): Promise<{ id: string; name: string } | null> {
    const r = await tx.$queryRaw<Row[]>`
      SELECT s.id, s.name FROM salons s
      WHERE s.id = ${salonId}::uuid AND s.status = 'APPROVED'
        AND salon_is_listed(s.id, s.approved_at, ${trialDays}::int, ${today}::date)`;
    return r[0] ? { id: r[0].id as string, name: r[0].name as string } : null;
  }

  async getPolicy(tx: Tx, salonId: string): Promise<{ policy: BookingPolicy; customized: boolean }> {
    const r = await tx.$queryRaw<Row[]>`SELECT * FROM salon_booking_policies WHERE salon_id = ${salonId}::uuid`;
    return { policy: policyFromRow(r[0]), customized: r.length > 0 };
  }

  async upsertPolicy(tx: Tx, salonId: string, p: BookingPolicy, userId: string, now: Date): Promise<void> {
    await tx.$executeRaw`
      INSERT INTO salon_booking_policies (salon_id, buffer_minutes, min_notice_minutes, advance_days, cancel_cutoff_minutes,
                                          reschedule_cutoff_minutes, max_reschedules, updated_by, updated_at)
      VALUES (${salonId}::uuid, ${p.bufferMinutes}::smallint, ${p.minNoticeMinutes}::int, ${p.advanceDays}::smallint, ${p.cancelCutoffMinutes}::int,
              ${p.rescheduleCutoffMinutes}::int, ${p.maxReschedules}::smallint, ${userId}::uuid, ${now}::timestamptz)
      ON CONFLICT (salon_id) DO UPDATE SET buffer_minutes = EXCLUDED.buffer_minutes, min_notice_minutes = EXCLUDED.min_notice_minutes,
        advance_days = EXCLUDED.advance_days, cancel_cutoff_minutes = EXCLUDED.cancel_cutoff_minutes,
        reschedule_cutoff_minutes = EXCLUDED.reschedule_cutoff_minutes, max_reschedules = EXCLUDED.max_reschedules,
        updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at`;
  }

  /**
   * The chosen services as THIS staff member performs them, with the exact price they charge. Active category, service
   * and staff member only. Prices and durations always come from here, never from the client.
   */
  async bookable(tx: Tx, salonId: string, staffId: string, serviceIds: string[]): Promise<BookableRow[]> {
    const r = await tx.$queryRaw<Row[]>`
      SELECT sv.id AS service_id, sv.name AS service_name, sv.duration_minutes, sp.display_name AS staff_name,
             CASE WHEN sv.pricing_mode = 'FIXED' THEN sv.base_price ELSE ss.price END AS price
      FROM services sv
      JOIN service_categories c ON c.salon_id = sv.salon_id AND c.id = sv.category_id AND c.is_active AND c.deleted_at IS NULL
      JOIN staff_services ss ON ss.salon_id = sv.salon_id AND ss.service_id = sv.id AND ss.staff_id = ${staffId}::uuid
      JOIN staff_profiles sp ON sp.salon_id = ss.salon_id AND sp.id = ss.staff_id AND sp.is_active AND sp.deleted_at IS NULL
      WHERE sv.salon_id = ${salonId}::uuid AND sv.id = ANY(${serviceIds}::uuid[]) AND sv.is_active AND sv.deleted_at IS NULL`;
    return r.map((x) => ({
      serviceId: x.service_id, serviceName: x.service_name, durationMinutes: Number(x.duration_minutes),
      price: x.price === null || x.price === undefined ? null : money(x.price), staffName: x.staff_name,
    }));
  }

  /** How many open upcoming appointments the customer holds (overall and at this salon). */
  async countActive(tx: Tx, customerId: string, salonId: string, now: Date): Promise<{ total: number; inSalon: number }> {
    const r = await tx.$queryRaw<Row[]>`
      SELECT count(*)::int AS total, (count(*) FILTER (WHERE a.salon_id = ${salonId}::uuid))::int AS in_salon
      FROM appointments a
      WHERE a.customer_user_id = ${customerId}::uuid AND a.status::text = ANY(${ACTIVE}::text[]) AND a.ends_at > ${now}::timestamptz`;
    return { total: Number(r[0]?.total ?? 0), inSalon: Number(r[0]?.in_salon ?? 0) };
  }

  // ------------------------------------------------------------------ writes
  async findByIdempotency(tx: Tx, customerId: string, key: string): Promise<AppointmentRecord | null> {
    const r = await tx.$queryRaw<Row[]>`
      SELECT a.* FROM appointments a WHERE a.customer_user_id = ${customerId}::uuid AND a.idempotency_key = ${key}::varchar`;
    return r[0] ? appointment(r[0]) : null;
  }

  async insertAppointment(tx: Tx, a: NewAppointment): Promise<string> {
    const r = await tx.$queryRaw<Row[]>`
      INSERT INTO appointments (salon_id, customer_user_id, staff_id, status, source, starts_at, ends_at, buffer_minutes, blocked_until,
                                total_duration_minutes, total_price, salon_name, staff_name, customer_note, idempotency_key,
                                request_fingerprint, updated_at)
      VALUES (${a.salonId}::uuid, ${a.customerUserId}::uuid, ${a.staffId}::uuid, 'CONFIRMED', 'ONLINE', ${a.startsAt}::timestamptz,
              ${a.endsAt}::timestamptz, ${a.bufferMinutes}::smallint, ${a.blockedUntil}::timestamptz, ${a.totalDurationMinutes}::int,
              ${a.totalPrice}::numeric, ${a.salonName}::varchar, ${a.staffName}::varchar, ${a.note}::varchar, ${a.idempotencyKey}::varchar,
              ${a.requestFingerprint}::char(64), ${a.now}::timestamptz)
      RETURNING id`;
    return r[0].id as string;
  }

  async insertLine(tx: Tx, salonId: string, appointmentId: string, l: { serviceId: string; position: number; serviceName: string; durationMinutes: number; price: string }): Promise<void> {
    await tx.$executeRaw`
      INSERT INTO appointment_services (salon_id, appointment_id, service_id, position, service_name, duration_minutes, price)
      VALUES (${salonId}::uuid, ${appointmentId}::uuid, ${l.serviceId}::uuid, ${l.position}::smallint, ${l.serviceName}::varchar,
              ${l.durationMinutes}::int, ${l.price}::numeric)`;
  }

  async insertHistory(tx: Tx, h: NewHistory): Promise<void> {
    await tx.$executeRaw`
      INSERT INTO appointment_status_history (salon_id, appointment_id, event, from_status, to_status, actor_user_id, actor_role, reason, old_starts_at, new_starts_at)
      VALUES (${h.salonId}::uuid, ${h.appointmentId}::uuid, ${h.event}::varchar, ${h.fromStatus}::appointment_status, ${h.toStatus}::appointment_status,
              ${h.actorUserId}::uuid, ${h.actorRole}::varchar, ${h.reason}::varchar, ${h.oldStartsAt}::timestamptz, ${h.newStartsAt}::timestamptz)`;
  }

  /** Customer cancels their own CONFIRMED appointment. Returns false when nothing matched (already changed). */
  async cancelByCustomer(tx: Tx, customerId: string, id: string, reason: string | null, now: Date): Promise<boolean> {
    const r = await tx.$queryRaw<Row[]>`
      UPDATE appointments SET status = 'CANCELLED', cancelled_at = ${now}::timestamptz, cancelled_by = ${customerId}::uuid,
        cancelled_by_role = 'CUSTOMER', cancellation_reason = ${reason}::varchar, updated_at = ${now}::timestamptz
      WHERE id = ${id}::uuid AND customer_user_id = ${customerId}::uuid AND status = 'CONFIRMED'
      RETURNING id`;
    return r.length > 0;
  }

  /** The salon owner cancels an open appointment of THEIR salon that has not ended yet. */
  async cancelBySalon(tx: Tx, salonId: string, ownerId: string, id: string, reason: string, now: Date): Promise<boolean> {
    const r = await tx.$queryRaw<Row[]>`
      UPDATE appointments SET status = 'CANCELLED', cancelled_at = ${now}::timestamptz, cancelled_by = ${ownerId}::uuid,
        cancelled_by_role = 'SALON', cancellation_reason = ${reason}::varchar, updated_at = ${now}::timestamptz
      WHERE id = ${id}::uuid AND salon_id = ${salonId}::uuid AND status IN ('PENDING', 'CONFIRMED') AND ends_at > ${now}::timestamptz
      RETURNING id`;
    return r.length > 0;
  }

  /** Customer moves their own appointment. `expectedCount` makes concurrent reschedules of one booking safe. */
  async reschedule(
    tx: Tx, customerId: string, id: string, expectedCount: number,
    t: { startsAt: Date; endsAt: Date; blockedUntil: Date }, now: Date,
  ): Promise<boolean> {
    const r = await tx.$queryRaw<Row[]>`
      UPDATE appointments SET starts_at = ${t.startsAt}::timestamptz, ends_at = ${t.endsAt}::timestamptz, blocked_until = ${t.blockedUntil}::timestamptz,
        reschedule_count = reschedule_count + 1, updated_at = ${now}::timestamptz
      WHERE id = ${id}::uuid AND customer_user_id = ${customerId}::uuid AND status = 'CONFIRMED' AND reschedule_count = ${expectedCount}::smallint
      RETURNING id`;
    return r.length > 0;
  }

  // ------------------------------------------------------------------ reads: customer
  async findForCustomer(tx: Tx, customerId: string, id: string): Promise<AppointmentRecord | null> {
    const r = await tx.$queryRaw<Row[]>`
      SELECT a.* FROM appointments a WHERE a.id = ${id}::uuid AND a.customer_user_id = ${customerId}::uuid`;
    return r[0] ? appointment(r[0]) : null;
  }

  async listForCustomer(tx: Tx, customerId: string, f: { scope: 'upcoming' | 'past' | 'all'; now: Date; limit: number; offset: number }): Promise<{ items: AppointmentRecord[]; total: number }> {
    const r = await tx.$queryRaw<Row[]>`
      SELECT a.*, count(*) OVER ()::int AS total FROM appointments a
      WHERE a.customer_user_id = ${customerId}::uuid
        AND (${f.scope}::text = 'all'
             OR (${f.scope}::text = 'upcoming' AND a.status::text = ANY(${ACTIVE}::text[]) AND a.ends_at >= ${f.now}::timestamptz)
             OR (${f.scope}::text = 'past' AND NOT (a.status::text = ANY(${ACTIVE}::text[]) AND a.ends_at >= ${f.now}::timestamptz)))
      ORDER BY CASE WHEN ${f.scope}::text = 'upcoming' THEN a.starts_at END ASC, a.starts_at DESC, a.id
      LIMIT ${f.limit}::int OFFSET ${f.offset}::int`;
    return { items: r.map(appointment), total: Number(r[0]?.total ?? 0) };
  }

  // ------------------------------------------------------------------ reads: salon side (owner and staff)
  /** One appointment of a salon, with the customer's name (and phone only when `includePhone`). */
  async findForSalon(tx: Tx, salonId: string, id: string, includePhone: boolean, staffId: string | null): Promise<AppointmentRecord | null> {
    const r = await tx.$queryRaw<Row[]>`
      SELECT a.*, u.full_name AS customer_name, CASE WHEN ${includePhone}::boolean THEN u.phone END AS customer_phone
      FROM appointments a JOIN users u ON u.id = a.customer_user_id
      WHERE a.id = ${id}::uuid AND a.salon_id = ${salonId}::uuid AND (${staffId}::uuid IS NULL OR a.staff_id = ${staffId}::uuid)`;
    return r[0] ? appointment(r[0]) : null;
  }

  async listForSalon(
    tx: Tx, salonId: string,
    f: { from: Date; to: Date; staffId: string | null; status: string | null; includePhone: boolean; limit: number; offset: number },
  ): Promise<{ items: AppointmentRecord[]; total: number }> {
    const r = await tx.$queryRaw<Row[]>`
      SELECT a.*, u.full_name AS customer_name, CASE WHEN ${f.includePhone}::boolean THEN u.phone END AS customer_phone,
             count(*) OVER ()::int AS total
      FROM appointments a JOIN users u ON u.id = a.customer_user_id
      WHERE a.salon_id = ${salonId}::uuid AND a.starts_at >= ${f.from}::timestamptz AND a.starts_at < ${f.to}::timestamptz
        AND (${f.staffId}::uuid IS NULL OR a.staff_id = ${f.staffId}::uuid)
        AND (${f.status}::text IS NULL OR a.status::text = ${f.status}::text)
      ORDER BY a.starts_at ASC, a.id
      LIMIT ${f.limit}::int OFFSET ${f.offset}::int`;
    return { items: r.map(appointment), total: Number(r[0]?.total ?? 0) };
  }

  /** The caller's own staff profile (RLS `staff_self_read`): works before any salon context is set. */
  async findOwnStaff(tx: Tx, userId: string): Promise<{ id: string; salonId: string; isActive: boolean } | null> {
    const r = await tx.$queryRaw<Row[]>`
      SELECT id, salon_id, is_active FROM staff_profiles WHERE user_id = ${userId}::uuid AND deleted_at IS NULL`;
    return r[0] ? { id: r[0].id as string, salonId: r[0].salon_id as string, isActive: Boolean(r[0].is_active) } : null;
  }

  // ------------------------------------------------------------------ lines and history (shared)
  async linesFor(tx: Tx, appointmentIds: string[]): Promise<Map<string, LineRecord[]>> {
    const out = new Map<string, LineRecord[]>();
    if (appointmentIds.length === 0) return out;
    const r = await tx.$queryRaw<Row[]>`
      SELECT appointment_id, service_id, position, service_name, duration_minutes, price
      FROM appointment_services WHERE appointment_id = ANY(${appointmentIds}::uuid[]) ORDER BY appointment_id, position`;
    for (const x of r) {
      const list = out.get(x.appointment_id) ?? [];
      list.push({
        appointmentId: x.appointment_id, serviceId: x.service_id, position: Number(x.position), serviceName: x.service_name,
        durationMinutes: Number(x.duration_minutes), price: money(x.price),
      });
      out.set(x.appointment_id, list);
    }
    return out;
  }

  async historyFor(tx: Tx, appointmentId: string): Promise<HistoryRecord[]> {
    const r = await tx.$queryRaw<Row[]>`
      SELECT appointment_id, event, from_status, to_status, actor_role, reason, old_starts_at, new_starts_at, created_at
      FROM appointment_status_history WHERE appointment_id = ${appointmentId}::uuid ORDER BY created_at, id`;
    return r.map((x) => ({
      appointmentId: x.appointment_id, event: x.event, fromStatus: x.from_status ?? null, toStatus: x.to_status, actorRole: x.actor_role,
      reason: x.reason ?? null, oldStartsAt: dateOrNull(x.old_starts_at), newStartsAt: dateOrNull(x.new_starts_at), createdAt: date(x.created_at),
    }));
  }
}
