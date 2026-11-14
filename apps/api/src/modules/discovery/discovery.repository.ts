import { Injectable } from '@nestjs/common';
import { DISCOVERY_SETTING_KEY } from '../listing/listing';
import { Tx } from '../salons/salons.repository';
import { ACTIVE_STATUSES, AbsBusy, BookingPolicy, policyFromRow } from '../booking/booking.types';
import { BoundingBox, DiscoverySort, Span, StaffWeek, WeekSpans, moneyOrNull } from './discovery.types';

type Row = Record<string, any>;
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

export interface SearchParams {
  trialDays: number;
  today: string;
  /** Salons matched by name, area or any visible service name (LIKE pattern, already escaped). */
  q: string | null;
  city: string | null;
  area: string | null;
  type: string | null;
  /** LIKE patterns, already escaped. */
  service: string | null;
  staff: string | null;
  minPrice: number | null;
  maxPrice: number | null;
  availOn: string | null;
  /** Earliest start minute that is still possible on `availOn` (now, when it is today). */
  availFrom: number;
  availAt: number | null;
  lat: number | null;
  lng: number | null;
  box: BoundingBox | null;
  radiusM: number | null;
  sort: DiscoverySort;
  limit: number;
  offset: number;
}

export interface SearchRow {
  id: string;
  name: string;
  salonType: string;
  city: string;
  area: string;
  addressLine: string;
  distanceM: number | null;
  priceFrom: string;
  priceTo: string;
  serviceCount: number;
  minDuration: number;
  staffIds: string[];
  total: number;
}

export interface ServiceStaffRow {
  serviceId: string;
  serviceName: string;
  durationMinutes: number;
  staffId: string;
  staffName: string;
  /** The exact price this staff member charges for this service (salon-wide price for FIXED services). */
  price: string | null;
}

/**
 * All SQL for Phase 7. Every method runs inside TenantDb.withPublicRead, so Row-Level Security only exposes APPROVED
 * salons (and, for the listing rule, their subscription period). Parameters are bound and carry explicit casts.
 */
@Injectable()
export class DiscoveryRepository {
  // ------------------------------------------------------------------ search
  async search(tx: Tx, p: SearchParams): Promise<SearchRow[]> {
    const box = p.box;
    const rows = await tx.$queryRaw<Row[]>`
      WITH base AS (
        SELECT s.id, s.name, s.salon_type, s.city, s.area, s.address_line, s.approved_at,
               discovery_distance_m(s.latitude, s.longitude, ${p.lat}::double precision, ${p.lng}::double precision) AS dist_m
        FROM salons s
        WHERE s.status = 'APPROVED'
          AND salon_is_listed(s.id, s.approved_at, ${p.trialDays}::int, ${p.today}::date)
          AND (${p.city}::text IS NULL OR lower(s.city) = lower(${p.city}::text))
          AND (${p.area}::text IS NULL OR lower(s.area) = lower(${p.area}::text))
          AND (${p.type}::text IS NULL OR s.salon_type::text = ${p.type}::text)
          AND (${p.q}::text IS NULL OR s.name ILIKE ${p.q}::text OR s.area ILIKE ${p.q}::text
               OR EXISTS (SELECT 1 FROM services qs WHERE qs.salon_id = s.id AND qs.is_active AND qs.deleted_at IS NULL AND qs.name ILIKE ${p.q}::text))
          AND (${box?.minLat ?? null}::numeric IS NULL
               OR (s.latitude BETWEEN ${box?.minLat ?? null}::numeric AND ${box?.maxLat ?? null}::numeric
                   AND s.longitude BETWEEN ${box?.minLng ?? null}::numeric AND ${box?.maxLng ?? null}::numeric))
          AND (${p.radiusM}::double precision IS NULL
               OR discovery_distance_m(s.latitude, s.longitude, ${p.lat}::double precision, ${p.lng}::double precision) <= ${p.radiusM}::double precision)
      ),
      -- One row per (service, staff member) a customer could actually book: active category, service and staff.
      options AS (
        SELECT sv.salon_id, sv.id AS service_id, sv.duration_minutes, ss.staff_id,
               CASE WHEN sv.pricing_mode = 'FIXED' THEN sv.base_price ELSE ss.price END AS price
        FROM base b
        JOIN services sv ON sv.salon_id = b.id AND sv.is_active AND sv.deleted_at IS NULL
        JOIN service_categories c ON c.salon_id = sv.salon_id AND c.id = sv.category_id AND c.is_active AND c.deleted_at IS NULL
        JOIN staff_services ss ON ss.salon_id = sv.salon_id AND ss.service_id = sv.id
        JOIN staff_profiles sp ON sp.salon_id = ss.salon_id AND sp.id = ss.staff_id AND sp.is_active AND sp.deleted_at IS NULL
        WHERE (${p.service}::text IS NULL OR sv.name ILIKE ${p.service}::text OR c.name ILIKE ${p.service}::text)
          AND (${p.staff}::text IS NULL OR sp.display_name ILIKE ${p.staff}::text)
          AND (${p.availOn}::date IS NULL OR (
            NOT EXISTS (SELECT 1 FROM staff_leaves lv WHERE lv.salon_id = sv.salon_id AND lv.staff_id = ss.staff_id AND lv.status = 'APPROVED'
                          AND ${p.availOn}::date BETWEEN lv.starts_on AND lv.ends_on)
            AND EXISTS (
              SELECT 1 FROM salon_opening_hours oh
              JOIN staff_working_hours wh ON wh.salon_id = oh.salon_id AND wh.weekday = oh.weekday AND wh.staff_id = ss.staff_id
              WHERE oh.salon_id = sv.salon_id AND oh.weekday = EXTRACT(ISODOW FROM ${p.availOn}::date)::int
                AND NOT oh.is_closed AND NOT wh.is_off
                AND CASE WHEN ${p.availAt}::int IS NULL
                      THEN greatest(oh.opens_minute, wh.starts_minute, ${p.availFrom}::int) + sv.duration_minutes <= least(oh.closes_minute, wh.ends_minute)
                      ELSE ${p.availAt}::int >= greatest(oh.opens_minute, wh.starts_minute, ${p.availFrom}::int)
                           AND ${p.availAt}::int + sv.duration_minutes <= least(oh.closes_minute, wh.ends_minute)
                           AND NOT EXISTS (SELECT 1 FROM staff_breaks br WHERE br.salon_id = sv.salon_id AND br.staff_id = ss.staff_id AND br.weekday = oh.weekday
                                             AND br.starts_minute < ${p.availAt}::int + sv.duration_minutes AND br.ends_minute > ${p.availAt}::int)
                    END
            )
          ))
      ),
      priced AS (
        SELECT * FROM options o
        WHERE o.price IS NOT NULL
          AND (${p.minPrice}::numeric IS NULL OR o.price >= ${p.minPrice}::numeric)
          AND (${p.maxPrice}::numeric IS NULL OR o.price <= ${p.maxPrice}::numeric)
      ),
      agg AS (
        SELECT salon_id, min(price) AS price_from, max(price) AS price_to, count(DISTINCT service_id)::int AS service_count,
               min(duration_minutes)::int AS min_duration, array_agg(DISTINCT staff_id::text) AS staff_ids
        FROM priced GROUP BY salon_id
      )
      SELECT b.id, b.name, b.salon_type, b.city, b.area, b.address_line, b.dist_m,
             a.price_from, a.price_to, a.service_count, a.min_duration, a.staff_ids,
             count(*) OVER ()::int AS total
      FROM base b JOIN agg a ON a.salon_id = b.id
      ORDER BY
        CASE WHEN ${p.sort}::text = 'nearest' THEN b.dist_m END ASC NULLS LAST,
        CASE WHEN ${p.sort}::text = 'price_low' THEN a.price_from END ASC,
        CASE WHEN ${p.sort}::text = 'newest' THEN b.approved_at END DESC NULLS LAST,
        lower(b.name), b.id
      LIMIT ${p.limit}::int OFFSET ${p.offset}::int`;
    return rows.map((r) => ({
      id: r.id, name: r.name, salonType: r.salon_type, city: r.city, area: r.area, addressLine: r.address_line,
      distanceM: num(r.dist_m), priceFrom: moneyOrNull(r.price_from) as string, priceTo: moneyOrNull(r.price_to) as string,
      serviceCount: Number(r.service_count), minDuration: Number(r.min_duration), staffIds: (r.staff_ids as string[]) ?? [], total: Number(r.total),
    }));
  }

  /** Total number of matches, used only when the requested page is past the end (the window total is then unavailable). */
  async firstPageTotal(tx: Tx, p: SearchParams): Promise<number> {
    const r = await this.search(tx, { ...p, limit: 1, offset: 0 });
    return r[0]?.total ?? 0;
  }

  // ------------------------------------------------------------------ filters / options
  /** Cities and areas that currently have at least one listed salon with a bookable service. */
  async cityAreas(tx: Tx, trialDays: number, today: string): Promise<Array<{ city: string; area: string; salons: number }>> {
    const r = await tx.$queryRaw<Row[]>`
      SELECT min(s.city) AS city, min(s.area) AS area, count(*)::int AS salons
      FROM salons s
      WHERE s.status = 'APPROVED'
        AND salon_is_listed(s.id, s.approved_at, ${trialDays}::int, ${today}::date)
        AND EXISTS (
          SELECT 1 FROM services sv
          JOIN service_categories c ON c.salon_id = sv.salon_id AND c.id = sv.category_id AND c.is_active AND c.deleted_at IS NULL
          JOIN staff_services ss ON ss.salon_id = sv.salon_id AND ss.service_id = sv.id
          JOIN staff_profiles sp ON sp.salon_id = ss.salon_id AND sp.id = ss.staff_id AND sp.is_active AND sp.deleted_at IS NULL
          WHERE sv.salon_id = s.id AND sv.is_active AND sv.deleted_at IS NULL AND (sv.base_price IS NOT NULL OR ss.price IS NOT NULL))
      GROUP BY lower(s.city), lower(s.area)
      ORDER BY lower(min(s.city)), lower(min(s.area))
      LIMIT 500`;
    return r.map((x) => ({ city: x.city as string, area: x.area as string, salons: Number(x.salons) }));
  }

  // ------------------------------------------------------------------ cards: photos, hours, staff weeks
  async coverKeys(tx: Tx, salonIds: string[]): Promise<Map<string, string>> {
    if (salonIds.length === 0) return new Map();
    const r = await tx.$queryRaw<Row[]>`
      SELECT DISTINCT ON (salon_id) salon_id, storage_key FROM salon_files
      WHERE salon_id = ANY(${salonIds}::uuid[]) AND kind = 'PHOTO' AND doc_type = 'COVER' AND deleted_at IS NULL
      ORDER BY salon_id, created_at DESC`;
    return new Map(r.map((x) => [x.salon_id as string, x.storage_key as string]));
  }

  async hoursForSalons(tx: Tx, salonIds: string[]): Promise<Map<string, WeekSpans>> {
    const out = new Map<string, Record<number, Span | null>>();
    if (salonIds.length === 0) return out;
    const r = await tx.$queryRaw<Row[]>`
      SELECT salon_id, weekday, is_closed, opens_minute, closes_minute FROM salon_opening_hours WHERE salon_id = ANY(${salonIds}::uuid[])`;
    for (const x of r) {
      const week = out.get(x.salon_id) ?? {};
      week[Number(x.weekday)] = x.is_closed || x.opens_minute === null || x.closes_minute === null ? null : { start: Number(x.opens_minute), end: Number(x.closes_minute) };
      out.set(x.salon_id, week);
    }
    return out;
  }

  /** Working hours, breaks and APPROVED leave of the given (active, visible) staff. Leave reasons are never selected. */
  async staffWeeks(tx: Tx, staffIds: string[], today: string, horizonEnd: string): Promise<Map<string, StaffWeek & { salonId: string }>> {
    const out = new Map<string, StaffWeek & { salonId: string }>();
    if (staffIds.length === 0) return out;
    const [people, hours, breaks, leaves] = await Promise.all([
      tx.$queryRaw<Row[]>`SELECT id, salon_id, display_name FROM staff_profiles WHERE id = ANY(${staffIds}::uuid[]) AND is_active AND deleted_at IS NULL`,
      tx.$queryRaw<Row[]>`SELECT staff_id, weekday, is_off, starts_minute, ends_minute FROM staff_working_hours WHERE staff_id = ANY(${staffIds}::uuid[])`,
      tx.$queryRaw<Row[]>`SELECT staff_id, weekday, starts_minute, ends_minute FROM staff_breaks WHERE staff_id = ANY(${staffIds}::uuid[])`,
      tx.$queryRaw<Row[]>`
        SELECT staff_id, to_char(starts_on, 'YYYY-MM-DD') AS starts_on, to_char(ends_on, 'YYYY-MM-DD') AS ends_on FROM staff_leaves
        WHERE staff_id = ANY(${staffIds}::uuid[]) AND status = 'APPROVED' AND ends_on >= ${today}::date AND starts_on <= ${horizonEnd}::date`,
    ]);
    const mutable = new Map<string, { w: StaffWeek & { salonId: string }; hours: Record<number, Span | null>; breaks: Record<number, Span[]>; leaves: Array<{ startsOn: string; endsOn: string }> }>();
    for (const p of people) {
      const hoursRec: Record<number, Span | null> = {};
      const breaksRec: Record<number, Span[]> = {};
      const leavesArr: Array<{ startsOn: string; endsOn: string }> = [];
      mutable.set(p.id, { w: { staffId: p.id, salonId: p.salon_id, name: p.display_name, hours: hoursRec, breaks: breaksRec, leaves: leavesArr }, hours: hoursRec, breaks: breaksRec, leaves: leavesArr });
    }
    for (const x of hours) {
      const m = mutable.get(x.staff_id);
      if (m) m.hours[Number(x.weekday)] = x.is_off || x.starts_minute === null || x.ends_minute === null ? null : { start: Number(x.starts_minute), end: Number(x.ends_minute) };
    }
    for (const x of breaks) {
      const m = mutable.get(x.staff_id);
      if (m) (m.breaks[Number(x.weekday)] ??= []).push({ start: Number(x.starts_minute), end: Number(x.ends_minute) });
    }
    for (const x of leaves) mutable.get(x.staff_id)?.leaves.push({ startsOn: x.starts_on, endsOn: x.ends_on });
    for (const [id, m] of mutable) out.set(id, m.w);
    return out;
  }

  // ------------------------------------------------------------------ one salon: availability preview
  async salonListed(tx: Tx, salonId: string, trialDays: number, today: string): Promise<boolean> {
    const r = await tx.$queryRaw<Row[]>`
      SELECT 1 AS ok FROM salons s WHERE s.id = ${salonId}::uuid AND s.status = 'APPROVED'
        AND salon_is_listed(s.id, s.approved_at, ${trialDays}::int, ${today}::date)`;
    return r.length > 0;
  }

  /** The chosen services with every staff member who performs them and the exact price each one charges. */
  async serviceStaff(tx: Tx, salonId: string, serviceIds: string[]): Promise<ServiceStaffRow[]> {
    const r = await tx.$queryRaw<Row[]>`
      SELECT sv.id AS service_id, sv.name AS service_name, sv.duration_minutes, ss.staff_id, sp.display_name AS staff_name,
             CASE WHEN sv.pricing_mode = 'FIXED' THEN sv.base_price ELSE ss.price END AS price
      FROM services sv
      JOIN service_categories c ON c.salon_id = sv.salon_id AND c.id = sv.category_id AND c.is_active AND c.deleted_at IS NULL
      JOIN staff_services ss ON ss.salon_id = sv.salon_id AND ss.service_id = sv.id
      JOIN staff_profiles sp ON sp.salon_id = ss.salon_id AND sp.id = ss.staff_id AND sp.is_active AND sp.deleted_at IS NULL
      WHERE sv.salon_id = ${salonId}::uuid AND sv.id = ANY(${serviceIds}::uuid[]) AND sv.is_active AND sv.deleted_at IS NULL
      ORDER BY lower(sp.display_name), sp.id, lower(sv.name), sv.id`;
    return r.map((x) => ({
      serviceId: x.service_id, serviceName: x.service_name, durationMinutes: Number(x.duration_minutes), staffId: x.staff_id,
      staffName: x.staff_name, price: moneyOrNull(x.price),
    }));
  }

  // ------------------------------------------------------------------ Phase 8: booking policy and busy time
  /** Booking rules per salon (defaults for salons that never saved a policy). Readable in the public context. */
  async policies(tx: Tx, salonIds: string[]): Promise<Map<string, BookingPolicy>> {
    const out = new Map<string, BookingPolicy>();
    if (salonIds.length === 0) return out;
    const r = await tx.$queryRaw<Row[]>`SELECT * FROM salon_booking_policies WHERE salon_id = ANY(${salonIds}::uuid[])`;
    for (const id of salonIds) out.set(id, policyFromRow(r.find((x) => x.salon_id === id)));
    return out;
  }

  /**
   * Busy time (appointment start .. blocked_until, buffer included) of the given staff in [fromMs, toMs). ONLY the staff id
   * and the two instants are selected: no customer, price or service data ever leaves this query. `excludeId` leaves one
   * appointment out (a customer moving their own booking must not collide with its old slot).
   */
  async busyByStaff(tx: Tx, staffIds: string[], fromMs: number, toMs: number, excludeId: string | null = null): Promise<Map<string, AbsBusy[]>> {
    const out = new Map<string, AbsBusy[]>();
    if (staffIds.length === 0) return out;
    const active = [...ACTIVE_STATUSES] as string[];
    const from = new Date(fromMs);
    const to = new Date(toMs);
    const r = await tx.$queryRaw<Row[]>`
      SELECT staff_id, (extract(epoch FROM starts_at) * 1000)::float8 AS start_ms, (extract(epoch FROM blocked_until) * 1000)::float8 AS end_ms
      FROM appointments
      WHERE staff_id = ANY(${staffIds}::uuid[]) AND status::text = ANY(${active}::text[])
        AND starts_at < ${to}::timestamptz AND blocked_until > ${from}::timestamptz
        AND (${excludeId}::uuid IS NULL OR id <> ${excludeId}::uuid)`;
    for (const x of r) {
      const list = out.get(x.staff_id) ?? [];
      list.push({ startMs: Number(x.start_ms), endMs: Number(x.end_ms) });
      out.set(x.staff_id, list);
    }
    return out;
  }

  // ------------------------------------------------------------------ settings (Super Admin)
  async upsertTrialDays(tx: Tx, trialDays: number, userId: string, now: Date): Promise<void> {
    await tx.$executeRaw`
      INSERT INTO platform_settings (key, value, updated_by, updated_at)
      VALUES (${DISCOVERY_SETTING_KEY}::varchar, jsonb_build_object('trialDays', ${trialDays}::int), ${userId}::uuid, ${now}::timestamptz)
      ON CONFLICT (key) DO UPDATE SET value = platform_settings.value || jsonb_build_object('trialDays', ${trialDays}::int),
        updated_by = ${userId}::uuid, updated_at = ${now}::timestamptz`;
  }
}
