import { Inject, Injectable, Logger } from '@nestjs/common';
import { AuthenticatedUser, toTenantContext } from '../../common/auth/authenticated-user';
import { AppException } from '../../common/errors/app-exception';
import { ClientContext } from '../../common/http/client-context';
import { ObjectStorage } from '../../common/storage/object-storage';
import { TenantDb } from '../../common/tenancy/tenant-db.service';
import { Clock } from '../../common/util/clock';
import { ENV, Env } from '../../config/env';
import { insertAudit } from '../audit/audit.types';
import { DEFAULT_TRIAL_DAYS, ListingPolicy, MAX_TRIAL_DAYS } from '../listing/listing';
import { SALON_TYPES } from '../salons/salon.types';
import { formatHm } from '../salons/opening-hours';
import { likePattern, Tx } from '../salons/salons.repository';
import { AvailabilityQuery, DiscoverySearchQuery, UpdateDiscoverySettingsDto } from './dto/discovery.dto';
import { DiscoveryRepository, SearchParams, SearchRow } from './discovery.repository';
import {
  DISCOVERY_LIMITS, DISCOVERY_SORTS, DiscoverySort, StaffWeek, WeekSpans, addDaysIso, boundingBox, distanceKm, freeSpans, isIsoDateText, karachiMinute,
  nextAvailable, notBeforeToday, parseClock, slotStarts, sumMoney,
} from './discovery.types';

const bad = (message: string) => new AppException('VALIDATION_FAILED', message, 400);
const notFound = (what: string) => new AppException('NOT_FOUND', `${what} not found.`, 404);

/**
 * Phase 7: customer discovery. Public and read-only. Every query runs through TenantDb.withPublicRead, so the database
 * only ever returns APPROVED salons, and `salon_is_listed()` additionally applies the trial / subscription rule.
 * Nothing is trusted from the client except what validation allows; location is used for the request only.
 */
@Injectable()
export class DiscoveryService {
  private readonly logger = new Logger(DiscoveryService.name);

  constructor(
    private readonly tenant: TenantDb,
    private readonly repo: DiscoveryRepository,
    private readonly listing: ListingPolicy,
    private readonly storage: ObjectStorage,
    private readonly clock: Clock,
    @Inject(ENV) private readonly env: Env,
  ) {}

  // ------------------------------------------------------------------ options (cities, areas, sorts)
  async options() {
    const rows = await this.tenant.withPublicRead(async (tx: Tx) => {
      const p = await this.listing.params(tx);
      return this.repo.cityAreas(tx, p.trialDays, p.today);
    });
    const cities = new Map<string, { city: string; salons: number; areas: Array<{ area: string; salons: number }> }>();
    for (const r of rows) {
      const key = r.city.toLowerCase();
      const c = cities.get(key) ?? { city: r.city, salons: 0, areas: [] };
      c.salons += r.salons;
      c.areas.push({ area: r.area, salons: r.salons });
      cities.set(key, c);
    }
    return {
      cities: [...cities.values()],
      salonTypes: [...SALON_TYPES],
      /** Only orders that can be answered truthfully today. Rating, popularity and earliest-available arrive with their data (Phases 14 and 8). */
      sorts: [...DISCOVERY_SORTS],
      radiusKm: { default: DISCOVERY_LIMITS.defaultRadiusKm, max: DISCOVERY_LIMITS.maxRadiusKm },
      availabilityHorizonDays: DISCOVERY_LIMITS.horizonDays,
      pageSize: { default: DISCOVERY_LIMITS.defaultPageSize, max: DISCOVERY_LIMITS.maxPageSize },
      currency: 'PKR',
    };
  }

  // ------------------------------------------------------------------ search
  async search(q: DiscoverySearchQuery) {
    const now = this.clock.now();
    const nowMinute = karachiMinute(now);
    const hasLat = q.lat !== undefined;
    const hasLng = q.lng !== undefined;
    if (hasLat !== hasLng) throw bad('Send both lat and lng, or neither.');
    const located = hasLat && hasLng;
    if (q.radiusKm !== undefined && !located) throw bad('radiusKm needs lat and lng.');
    if (q.sort === 'nearest' && !located) throw bad('Sorting by distance needs lat and lng. Search by city or area instead.');
    if (q.minPrice !== undefined && q.maxPrice !== undefined && q.minPrice > q.maxPrice) throw bad('minPrice cannot be higher than maxPrice.');
    if (q.time !== undefined && q.date === undefined) throw bad('time needs a date.');

    const page = q.page ?? 1;
    const pageSize = q.pageSize ?? DISCOVERY_LIMITS.defaultPageSize;
    const sort: DiscoverySort = q.sort ?? (located ? 'nearest' : 'name');

    let availOn: string | null = null;
    let availAt: number | null = null;
    let availFrom = 0;
    const today = this.listing.today(now);
    if (q.date !== undefined) {
      if (!isIsoDateText(q.date)) throw bad('date must be a real calendar date (YYYY-MM-DD).');
      if (q.date < today || q.date > addDaysIso(today, DISCOVERY_LIMITS.horizonDays - 1)) {
        throw bad(`date must be between today and ${DISCOVERY_LIMITS.horizonDays - 1} days from today.`);
      }
      availOn = q.date;
      availFrom = q.date === today ? notBeforeToday(nowMinute) : 0;
      if (q.time !== undefined) availAt = parseClock(q.time);
    }

    const radiusKm = q.radiusKm;
    const base: Omit<SearchParams, 'trialDays'> = {
      today,
      q: q.q ? likePattern(q.q) : null,
      city: q.city ?? null,
      area: q.area ?? null,
      type: q.type ?? null,
      service: q.service ? likePattern(q.service) : null,
      staff: q.staff ? likePattern(q.staff) : null,
      minPrice: q.minPrice ?? null,
      maxPrice: q.maxPrice ?? null,
      availOn,
      availFrom,
      availAt,
      lat: located ? (q.lat as number) : null,
      lng: located ? (q.lng as number) : null,
      box: located && radiusKm !== undefined ? boundingBox(q.lat as number, q.lng as number, radiusKm) : null,
      radiusM: located && radiusKm !== undefined ? radiusKm * 1000 : null,
      sort,
      limit: pageSize,
      offset: (page - 1) * pageSize,
    };

    const data = await this.tenant.withPublicRead(async (tx: Tx) => {
      const p = { ...base, trialDays: await this.listing.trialDays(tx) };
      let rows = await this.repo.search(tx, p);
      let total = rows[0]?.total ?? 0;
      if (rows.length === 0 && page > 1) total = await this.repo.firstPageTotal(tx, p);
      const ids = rows.map((r) => r.id);
      const staffIds = [...new Set(rows.flatMap((r) => r.staffIds))];
      const covers = await this.repo.coverKeys(tx, ids);
      const hours = await this.repo.hoursForSalons(tx, ids);
      const weeks = await this.repo.staffWeeks(tx, staffIds, today, addDaysIso(today, DISCOVERY_LIMITS.horizonDays));
      rows = rows.slice();
      return { rows, total, covers, hours, weeks };
    });

    const items = await Promise.all(data.rows.map((r) => this.card(r, data.covers.get(r.id), data.hours.get(r.id) ?? {}, data.weeks, today, nowMinute)));
    return {
      items,
      total: data.total,
      page,
      pageSize,
      hasMore: base.offset + items.length < data.total,
      sort,
      /** true when the request carried a location (the server does not keep it). */
      locationUsed: located,
      imageUrlTtlSec: this.env.SIGNED_URL_TTL_SEC,
    };
  }

  private async card(r: SearchRow, coverKey: string | undefined, hours: WeekSpans, weeks: Map<string, StaffWeek & { salonId: string }>, today: string, nowMinute: number) {
    let coverUrl: string | null = null;
    if (coverKey) {
      try {
        coverUrl = await this.storage.signedUrl(coverKey, this.env.SIGNED_URL_TTL_SEC);
      } catch {
        this.logger.warn('Could not sign a cover photo URL');
      }
    }
    const staff = r.staffIds.map((id) => weeks.get(id)).filter((w): w is StaffWeek & { salonId: string } => !!w && w.salonId === r.id);
    return {
      id: r.id,
      name: r.name,
      salonType: r.salonType,
      city: r.city,
      area: r.area,
      addressLine: r.addressLine,
      coverUrl,
      distanceKm: distanceKm(r.distanceM),
      /** Ratings arrive with reviews (Phase 14): honest nulls instead of invented numbers. */
      rating: null,
      ratingCount: 0,
      priceFrom: r.priceFrom,
      priceTo: r.priceTo,
      serviceCount: r.serviceCount,
      /** Preview from working hours, breaks and leave. Bookings do not exist yet (Phase 8 subtracts them). */
      nextAvailable: nextAvailable(hours, staff, r.minDuration, today, nowMinute),
    };
  }

  // ------------------------------------------------------------------ availability preview + price comparison
  async availability(salonId: string, q: AvailabilityQuery) {
    const now = this.clock.now();
    const today = this.listing.today(now);
    const nowMinute = karachiMinute(now);
    if (!isIsoDateText(q.date)) throw bad('date must be a real calendar date (YYYY-MM-DD).');
    if (q.date < today || q.date > addDaysIso(today, DISCOVERY_LIMITS.horizonDays - 1)) {
      throw bad(`date must be between today and ${DISCOVERY_LIMITS.horizonDays - 1} days from today.`);
    }

    const data = await this.tenant.withPublicRead(async (tx: Tx) => {
      const p = await this.listing.params(tx);
      if (!(await this.repo.salonListed(tx, salonId, p.trialDays, p.today))) throw notFound('Salon');
      const rows = await this.repo.serviceStaff(tx, salonId, q.serviceIds);
      const found = new Set(rows.map((r) => r.serviceId));
      if (q.serviceIds.some((id) => !found.has(id))) throw notFound('Service');
      const staffIds = [...new Set(rows.map((r) => r.staffId))];
      const hours = (await this.repo.hoursForSalons(tx, [salonId])).get(salonId) ?? {};
      const weeks = await this.repo.staffWeeks(tx, staffIds, today, addDaysIso(today, DISCOVERY_LIMITS.horizonDays));
      return { rows, hours, weeks };
    });

    const services = new Map<string, { id: string; name: string; durationMinutes: number }>();
    for (const r of data.rows) services.set(r.serviceId, { id: r.serviceId, name: r.serviceName, durationMinutes: r.durationMinutes });
    const duration = [...services.values()].reduce((a, s) => a + s.durationMinutes, 0);

    // Only staff who perform EVERY chosen service can take the whole booking.
    const byStaff = new Map<string, typeof data.rows>();
    for (const r of data.rows) byStaff.set(r.staffId, [...(byStaff.get(r.staffId) ?? []), r]);
    let eligible = [...byStaff.entries()].filter(([, rs]) => new Set(rs.map((x) => x.serviceId)).size === services.size && rs.every((x) => x.price !== null));
    if (q.staffId) {
      eligible = eligible.filter(([id]) => id === q.staffId);
      if (eligible.length === 0) throw notFound('Staff member');
    }

    const notBefore = q.date === today ? notBeforeToday(nowMinute) : 0;
    const staff = eligible
      .map(([staffId, rs]) => {
        const week = data.weeks.get(staffId);
        const starts = week ? slotStarts(freeSpans(q.date, data.hours, week), duration, DISCOVERY_LIMITS.slotStepMinutes, notBefore) : [];
        return {
          staffId,
          name: rs[0].staffName,
          /** The exact total this staff member charges for the chosen services. */
          totalPrice: sumMoney(rs.map((x) => x.price as string)),
          lines: rs.map((x) => ({ serviceId: x.serviceId, price: x.price as string })),
          slots: starts.map(formatHm),
        };
      })
      .sort((a, b) => Number(a.totalPrice) - Number(b.totalPrice) || a.name.localeCompare(b.name));

    return {
      date: q.date,
      durationMinutes: duration,
      slotStepMinutes: DISCOVERY_LIMITS.slotStepMinutes,
      services: [...services.values()],
      /** Sorted by price, lowest first: the price comparison between staff. */
      staff,
      /** A preview is not a booking: only the booking itself (Phase 8) confirms a time. */
      preview: true,
    };
  }

  // ------------------------------------------------------------------ Super Admin setting
  async getSettings(u: AuthenticatedUser) {
    return this.tenant.withTenant(toTenantContext(u, null), async (tx: Tx) => ({ trialDays: await this.listing.trialDays(tx), defaultTrialDays: DEFAULT_TRIAL_DAYS, maxTrialDays: MAX_TRIAL_DAYS }));
  }

  async updateSettings(u: AuthenticatedUser, dto: UpdateDiscoverySettingsDto, meta: ClientContext) {
    return this.tenant.withTenant(toTenantContext(u, null), async (tx: Tx) => {
      const before = await this.listing.trialDays(tx);
      await this.repo.upsertTrialDays(tx, dto.trialDays, u.id, this.clock.now());
      await insertAudit(tx, {
        actorUserId: u.id, actorRole: u.role, action: 'discovery.settings_updated', targetType: 'platform_setting', targetId: 'discovery',
        ipAddress: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId, metadata: { trialDaysBefore: before, trialDaysAfter: dto.trialDays },
      });
      return { trialDays: dto.trialDays, defaultTrialDays: DEFAULT_TRIAL_DAYS, maxTrialDays: MAX_TRIAL_DAYS };
    });
  }
}
