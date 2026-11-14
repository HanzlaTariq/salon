import { Injectable } from '@nestjs/common';
import { AuthenticatedUser } from '../../common/auth/authenticated-user';
import { sqlState } from '../../common/db/pg-errors';
import { AppException } from '../../common/errors/app-exception';
import { TenantDb } from '../../common/tenancy/tenant-db.service';
import { Clock } from '../../common/util/clock';
import { DiscoveryRepository } from '../discovery/discovery.repository';
import { addDaysIso, isIsoDateText, parseClock, sumMoney } from '../discovery/discovery.types';
import { ListingPolicy } from '../listing/listing';
import { Tx } from '../salons/salons.repository';
import { BookingRepository } from './booking.repository';
import {
  BOOKING_LIMITS, IDEMPOTENCY_KEY_RE, bookingFingerprint, canStartAt, cancelDecision, dayStartMs, rescheduleDecision, slotMs, withinWindow,
} from './booking.types';
import { customerView, policyView } from './booking.views';
import { CustomerCancelDto, CreateBookingDto, ListBookingsQuery, RescheduleBookingDto } from './dto/booking.dto';

const bad = (message: string) => new AppException('VALIDATION_FAILED', message, 400);
const notFound = (what: string) => new AppException('NOT_FOUND', `${what} not found.`, 404);
const conflict = (message: string, details?: unknown) => new AppException('CONFLICT', message, 409, details);
const slotTaken = () => new AppException('SLOT_TAKEN', 'That time is no longer available. Please pick another time.', 409);
const DAY_MS = 86_400_000;

/** SQLSTATE 23P01 = exclusion_violation: the database refused a second active appointment in the same staff time. */
const isExclusionViolation = (e: unknown): boolean => sqlState(e) === '23P01';

/**
 * Phase 8, customer side: create, list, read, cancel and reschedule OWN bookings.
 *
 * Trust rules: price, duration, staff and salon names come from the database, never from the request. The identity comes
 * from the verified session. A booking is accepted only when (1) the salon is APPROVED and listed (`salon_is_listed`),
 * (2) the staff member offers every chosen service, (3) the start passes the same slot engine the customer saw, and
 * (4) the exclusion constraint accepts the row. (4) is the only authority against races: it is mapped to SLOT_TAKEN.
 */
@Injectable()
export class CustomerBookingService {
  constructor(
    private readonly tenant: TenantDb,
    private readonly repo: BookingRepository,
    private readonly discovery: DiscoveryRepository,
    private readonly listing: ListingPolicy,
    private readonly clock: Clock,
  ) {}

  // ------------------------------------------------------------------ create
  async create(user: AuthenticatedUser, dto: CreateBookingDto, idempotencyKey: string | undefined) {
    if (!isIsoDateText(dto.date)) throw bad('date must be a real calendar date (YYYY-MM-DD).');
    const minute = parseClock(dto.time);
    if (minute === null || minute % 5 !== 0) throw bad('time must be HH:MM on a 5-minute mark, for example 14:30.');
    if (idempotencyKey !== undefined && !IDEMPOTENCY_KEY_RE.test(idempotencyKey)) {
      throw bad('Idempotency-Key must be 8 to 64 characters: letters, digits, - and _.');
    }
    const note = dto.note && dto.note.trim().length > 0 ? dto.note.trim() : null;
    const fingerprint = bookingFingerprint({ salonId: dto.salonId, staffId: dto.staffId, serviceIds: dto.serviceIds, date: dto.date, time: dto.time, note });
    const now = this.clock.now();

    let id: string;
    try {
      id = await this.tenant.withCustomer(user.id, async (tx: Tx) => {
        await this.repo.lockCustomer(tx, user.id);

        if (idempotencyKey) {
          const prior = await this.repo.findByIdempotency(tx, user.id, idempotencyKey);
          if (prior) {
            if (prior.requestFingerprint !== fingerprint) throw conflict('This Idempotency-Key was already used for a different booking request.');
            return prior.id; // a retry of the same request: same booking, nothing new is created
          }
        }

        const params = await this.listing.params(tx);
        const salon = await this.repo.salonForBooking(tx, dto.salonId, params.trialDays, params.today);
        if (!salon) throw notFound('Salon');
        const { policy } = await this.repo.getPolicy(tx, salon.id);
        if (!withinWindow(dto.date, params.today, policy.advanceDays)) {
          throw bad(`date must be between today and ${policy.advanceDays - 1} days from today.`);
        }

        // Prices and durations always come from the catalogue as THIS staff member performs it.
        const rows = await this.repo.bookable(tx, salon.id, dto.staffId, dto.serviceIds);
        const byId = new Map(rows.map((r) => [r.serviceId, r]));
        if (dto.serviceIds.some((sid) => !byId.has(sid)) || rows.some((r) => r.price === null)) {
          throw conflict('This staff member does not offer all the chosen services.');
        }
        const lines = dto.serviceIds.map((sid, i) => ({ ...(byId.get(sid) as (typeof rows)[number]), position: i + 1 }));
        const durationMin = lines.reduce((a, l) => a + l.durationMinutes, 0);
        if (durationMin > BOOKING_LIMITS.maxTotalDurationMinutes) throw bad('The chosen services take too long for one appointment. Please book them separately.');
        const totalPrice = sumMoney(lines.map((l) => l.price as string));

        // Same slot engine as the availability screen.
        const hours = (await this.discovery.hoursForSalons(tx, [salon.id])).get(salon.id) ?? {};
        const week = (await this.discovery.staffWeeks(tx, [dto.staffId], params.today, addDaysIso(params.today, policy.advanceDays))).get(dto.staffId);
        if (!week) throw slotTaken();
        const base = dayStartMs(dto.date);
        const busy = await this.discovery.busyByStaff(tx, [dto.staffId], base - DAY_MS, base + 2 * DAY_MS);
        const ok = canStartAt({
          date: dto.date, salon: hours, staff: week, busy: busy.get(dto.staffId) ?? [], policy, durationMin, nowMs: now.getTime(), startMinute: minute,
        });
        if (!ok) throw slotTaken();

        // Anti-hoarding. Race-free: every booking of this customer runs under the advisory lock above.
        const active = await this.repo.countActive(tx, user.id, salon.id, now);
        if (active.inSalon >= BOOKING_LIMITS.maxActivePerCustomerPerSalon || active.total >= BOOKING_LIMITS.maxActivePerCustomer) {
          throw conflict('You already have the maximum number of upcoming bookings. Cancel one or wait until it is over.', {
            rule: 'ACTIVE_LIMIT', perSalon: BOOKING_LIMITS.maxActivePerCustomerPerSalon, total: BOOKING_LIMITS.maxActivePerCustomer,
          });
        }

        const startsAt = new Date(slotMs(dto.date, minute));
        const endsAt = new Date(startsAt.getTime() + durationMin * 60_000);
        const blockedUntil = new Date(endsAt.getTime() + policy.bufferMinutes * 60_000);
        const appointmentId = await this.repo.insertAppointment(tx, {
          salonId: salon.id, customerUserId: user.id, staffId: dto.staffId, startsAt, endsAt, bufferMinutes: policy.bufferMinutes, blockedUntil,
          totalDurationMinutes: durationMin, totalPrice, salonName: salon.name, staffName: lines[0].staffName, note,
          idempotencyKey: idempotencyKey ?? null, requestFingerprint: idempotencyKey ? fingerprint : null, now,
        });
        for (const l of lines) {
          await this.repo.insertLine(tx, salon.id, appointmentId, {
            serviceId: l.serviceId, position: l.position, serviceName: l.serviceName, durationMinutes: l.durationMinutes, price: l.price as string,
          });
        }
        await this.repo.insertHistory(tx, {
          salonId: salon.id, appointmentId, event: 'CREATED', fromStatus: null, toStatus: 'CONFIRMED', actorUserId: user.id, actorRole: 'CUSTOMER',
          reason: null, oldStartsAt: null, newStartsAt: startsAt,
        });
        return appointmentId;
      });
    } catch (e) {
      if (isExclusionViolation(e)) throw slotTaken();
      throw e;
    }
    return this.get(user, id);
  }

  // ------------------------------------------------------------------ read
  async get(user: AuthenticatedUser, id: string) {
    const nowMs = this.clock.now().getTime();
    return this.tenant.withCustomer(user.id, async (tx: Tx) => {
      const a = await this.repo.findForCustomer(tx, user.id, id);
      if (!a) throw notFound('Booking');
      const lines = (await this.repo.linesFor(tx, [a.id])).get(a.id) ?? [];
      const history = await this.repo.historyFor(tx, a.id);
      const { policy } = await this.repo.getPolicy(tx, a.salonId);
      return customerView(a, lines, policy, nowMs, history);
    });
  }

  async list(user: AuthenticatedUser, q: ListBookingsQuery) {
    const now = this.clock.now();
    const page = q.page ?? 1;
    const pageSize = q.pageSize ?? BOOKING_LIMITS.defaultPageSize;
    const scope = q.scope ?? 'upcoming';
    return this.tenant.withCustomer(user.id, async (tx: Tx) => {
      const res = await this.repo.listForCustomer(tx, user.id, { scope, now, limit: pageSize, offset: (page - 1) * pageSize });
      const lines = await this.repo.linesFor(tx, res.items.map((a) => a.id));
      const policies = await this.discovery.policies(tx, [...new Set(res.items.map((a) => a.salonId))]);
      const items = res.items.map((a) => customerView(a, lines.get(a.id) ?? [], policies.get(a.salonId) as never, now.getTime()));
      return { items, total: res.total, page, pageSize, hasMore: (page - 1) * pageSize + items.length < res.total, scope };
    });
  }

  /** Cancellation and notice rules of a salon, shown before booking. Public. */
  async publicPolicy(salonId: string) {
    return this.tenant.withPublicRead(async (tx: Tx) => {
      const p = await this.listing.params(tx);
      const salon = await this.repo.salonForBooking(tx, salonId, p.trialDays, p.today);
      if (!salon) throw notFound('Salon');
      const { policy, customized } = await this.repo.getPolicy(tx, salon.id);
      return policyView(policy, customized);
    });
  }

  // ------------------------------------------------------------------ cancel
  async cancel(user: AuthenticatedUser, id: string, dto: CustomerCancelDto) {
    const now = this.clock.now();
    const reason = dto.reason && dto.reason.trim().length > 0 ? dto.reason.trim() : null;
    await this.tenant.withCustomer(user.id, async (tx: Tx) => {
      await this.repo.lockCustomer(tx, user.id);
      const a = await this.repo.findForCustomer(tx, user.id, id);
      if (!a) throw notFound('Booking');
      const { policy } = await this.repo.getPolicy(tx, a.salonId);
      const d = cancelDecision(policy, a.status, a.startsAt.getTime(), now.getTime());
      if (!d.allowed) {
        if (d.reason === 'STATUS') throw conflict(`This booking is ${a.status.toLowerCase().replace('_', ' ')} and cannot be cancelled.`, { rule: 'STATUS', status: a.status });
        throw conflict('This booking can no longer be cancelled online. Please contact the salon.', {
          rule: 'CANCEL_CUTOFF', cutoffMinutes: policy.cancelCutoffMinutes, deadline: new Date(d.deadlineMs).toISOString(),
        });
      }
      if (!(await this.repo.cancelByCustomer(tx, user.id, id, reason, now))) throw conflict('This booking was just changed. Please refresh and try again.');
      await this.repo.insertHistory(tx, {
        salonId: a.salonId, appointmentId: a.id, event: 'CANCELLED', fromStatus: a.status, toStatus: 'CANCELLED', actorUserId: user.id,
        actorRole: 'CUSTOMER', reason, oldStartsAt: a.startsAt, newStartsAt: null,
      });
    });
    return this.get(user, id);
  }

  // ------------------------------------------------------------------ reschedule (customer only: the salon can never move a booking)
  async reschedule(user: AuthenticatedUser, id: string, dto: RescheduleBookingDto) {
    if (!isIsoDateText(dto.date)) throw bad('date must be a real calendar date (YYYY-MM-DD).');
    const minute = parseClock(dto.time);
    if (minute === null || minute % 5 !== 0) throw bad('time must be HH:MM on a 5-minute mark, for example 14:30.');
    const now = this.clock.now();

    try {
      await this.tenant.withCustomer(user.id, async (tx: Tx) => {
        await this.repo.lockCustomer(tx, user.id);
        const a = await this.repo.findForCustomer(tx, user.id, id);
        if (!a) throw notFound('Booking');

        const params = await this.listing.params(tx);
        const salon = await this.repo.salonForBooking(tx, a.salonId, params.trialDays, params.today);
        if (!salon) throw conflict('This salon is not taking bookings at the moment. Please contact the salon.');
        const { policy } = await this.repo.getPolicy(tx, a.salonId);

        const d = rescheduleDecision(policy, a.status, a.startsAt.getTime(), now.getTime(), a.rescheduleCount);
        if (!d.allowed) {
          if (d.reason === 'STATUS') throw conflict(`This booking is ${a.status.toLowerCase().replace('_', ' ')} and cannot be moved.`, { rule: 'STATUS', status: a.status });
          if (d.reason === 'LIMIT') throw conflict('This booking was already moved the maximum number of times.', { rule: 'RESCHEDULE_LIMIT', max: policy.maxReschedules });
          throw conflict('This booking can no longer be moved online. Please contact the salon.', {
            rule: 'RESCHEDULE_CUTOFF', cutoffMinutes: policy.rescheduleCutoffMinutes, deadline: new Date(d.deadlineMs).toISOString(),
          });
        }
        if (!withinWindow(dto.date, params.today, policy.advanceDays)) throw bad(`date must be between today and ${policy.advanceDays - 1} days from today.`);

        const startsAt = new Date(slotMs(dto.date, minute));
        if (startsAt.getTime() === a.startsAt.getTime()) throw bad('Please choose a different time from the current one.');

        const hours = (await this.discovery.hoursForSalons(tx, [a.salonId])).get(a.salonId) ?? {};
        const week = (await this.discovery.staffWeeks(tx, [a.staffId], params.today, addDaysIso(params.today, policy.advanceDays))).get(a.staffId);
        if (!week) throw slotTaken();
        const base = dayStartMs(dto.date);
        // The booking's own old slot must not block its new one.
        const busy = await this.discovery.busyByStaff(tx, [a.staffId], base - DAY_MS, base + 2 * DAY_MS, a.id);
        const ok = canStartAt({
          date: dto.date, salon: hours, staff: week, busy: busy.get(a.staffId) ?? [], policy: { ...policy, bufferMinutes: a.bufferMinutes },
          durationMin: a.totalDurationMinutes, nowMs: now.getTime(), startMinute: minute,
        });
        if (!ok) throw slotTaken();

        const endsAt = new Date(startsAt.getTime() + a.totalDurationMinutes * 60_000);
        const blockedUntil = new Date(endsAt.getTime() + a.bufferMinutes * 60_000);
        if (!(await this.repo.reschedule(tx, user.id, id, a.rescheduleCount, { startsAt, endsAt, blockedUntil }, now))) {
          throw conflict('This booking was just changed. Please refresh and try again.');
        }
        await this.repo.insertHistory(tx, {
          salonId: a.salonId, appointmentId: a.id, event: 'RESCHEDULED', fromStatus: a.status, toStatus: a.status, actorUserId: user.id,
          actorRole: 'CUSTOMER', reason: null, oldStartsAt: a.startsAt, newStartsAt: startsAt,
        });
      });
    } catch (e) {
      if (isExclusionViolation(e)) throw slotTaken();
      throw e;
    }
    return this.get(user, id);
  }
}
