import { Injectable } from '@nestjs/common';
import { AuthenticatedUser } from '../../common/auth/authenticated-user';
import { sqlState } from '../../common/db/pg-errors';
import { AppException } from '../../common/errors/app-exception';
import { TenantDb } from '../../common/tenancy/tenant-db.service';
import { Clock } from '../../common/util/clock';
import { DiscoveryRepository } from '../discovery/discovery.repository';
import { addDaysIso } from '../discovery/discovery.types';
import { ListingPolicy } from '../listing/listing';
import { Tx } from '../salons/salons.repository';
import { BookingRepository } from './booking.repository';
import { canStartAt, dayStartMs, karachiParts } from './booking.types';
import { CustomerBookingService } from './customer-booking.service';
import { AnswerOfferDto, ArrivalDto } from './dto/queue.dto';
import { QueueRepository } from './queue.repository';
import { arrivalDecision, etaInstant, isValidEtaMinutes } from './queue.types';

const DAY_MS = 86_400_000;
const bad = (message: string) => new AppException('VALIDATION_FAILED', message, 400);
const notFound = (what: string) => new AppException('NOT_FOUND', `${what} not found.`, 404);
const conflict = (message: string, details?: unknown) => new AppException('CONFLICT', message, 409, details);

/**
 * Phase 9, customer side: tell the salon "I'm on my way / I'll be late" and answer an early-availability offer.
 * The customer is always the caller. The customer can write ONLY their own arrival report (a database trigger enforces it); the
 * salon's estimate and the progress of the service are never writable from here.
 */
@Injectable()
export class CustomerLiveService {
  constructor(
    private readonly tenant: TenantDb,
    private readonly repo: BookingRepository,
    private readonly q: QueueRepository,
    private readonly discovery: DiscoveryRepository,
    private readonly listing: ListingPolicy,
    private readonly bookings: CustomerBookingService,
    private readonly clock: Clock,
  ) {}

  /** "I'm on my way" (ETA optional) or "I'll be late" (ETA required). The ETA is "arriving in N minutes" from now. */
  async arrival(user: AuthenticatedUser, id: string, dto: ArrivalDto) {
    const now = this.clock.now();
    if (dto.etaMinutes !== undefined && !isValidEtaMinutes(dto.etaMinutes)) throw bad('etaMinutes must be a whole number from 1 to 120.');
    if (dto.state === 'RUNNING_LATE' && dto.etaMinutes === undefined) throw bad('Please tell the salon in how many minutes you will arrive.');
    await this.tenant.withCustomer(user.id, async (tx: Tx) => {
      await this.repo.lockCustomer(tx, user.id);
      const a = await this.repo.findForCustomer(tx, user.id, id);
      if (!a) throw notFound('Booking');
      const d = arrivalDecision(a.status, a.startsAt.getTime(), now.getTime(), a.arrivalUpdates);
      if (!d.allowed) {
        const msg: Record<string, string> = {
          STATUS: `This booking is ${a.status.toLowerCase().replace('_', ' ')}.`,
          TOO_EARLY: 'It is too early to report your arrival for this booking.',
          TOO_LATE: 'This booking is too long past to report your arrival. Please contact the salon.',
          LIMIT: 'You reported your arrival too many times for this booking. Please contact the salon.',
        };
        throw conflict(msg[d.reason], { rule: `ARRIVAL_${d.reason}` });
      }
      const etaAt = dto.etaMinutes === undefined ? null : new Date(etaInstant(now.getTime(), dto.etaMinutes));
      if (!(await this.q.setArrival(tx, user.id, id, dto.state, etaAt, now))) throw conflict('This booking was just changed. Please refresh and try again.');
      await this.repo.insertHistory(tx, {
        salonId: a.salonId, appointmentId: a.id, event: 'ARRIVAL_UPDATE', fromStatus: a.status, toStatus: a.status, actorUserId: user.id, actorRole: 'CUSTOMER',
        reason: dto.state, oldStartsAt: null, newStartsAt: etaAt,
      });
    });
    return this.bookings.get(user, id);
  }

  /**
   * Accept: the appointment moves to the offered earlier time ONLY if the server still finds that time free (slot engine, then the
   * exclusion constraint). It does not count as a reschedule. "I am coming in N minutes" is stored as the customer's own ETA.
   * If the time was taken meanwhile, nothing changes and the original time stays.
   */
  async accept(user: AuthenticatedUser, id: string, dto: AnswerOfferDto) {
    const now = this.clock.now();
    const nowMs = now.getTime();
    if (dto.etaMinutes !== undefined && !isValidEtaMinutes(dto.etaMinutes)) throw bad('etaMinutes must be a whole number from 1 to 120.');
    try {
      await this.tenant.withCustomer(user.id, async (tx: Tx) => {
        await this.repo.lockCustomer(tx, user.id);
        const a = await this.repo.findForCustomer(tx, user.id, id);
        if (!a) throw notFound('Booking');
        const offer = await this.q.findOfferForCustomer(tx, user.id, id, dto.offerId);
        if (!offer) throw notFound('Offer');
        if (offer.status !== 'PENDING') throw conflict(`This offer is ${offer.status.toLowerCase()}.`, { rule: 'OFFER_CLOSED', status: offer.status });
        if (offer.expiresAt.getTime() <= nowMs) throw conflict('This offer has expired. Your original time is unchanged.', { rule: 'OFFER_EXPIRED' });
        if (a.status !== 'CONFIRMED') throw conflict(`This booking is ${a.status.toLowerCase().replace('_', ' ')}.`, { rule: 'STATUS', status: a.status });
        if (offer.offeredStart.getTime() >= a.startsAt.getTime()) throw conflict('This offer is no longer earlier than your booking.', { rule: 'OFFER_CLOSED' });

        const params = await this.listing.params(tx);
        const salon = await this.repo.salonForBooking(tx, a.salonId, params.trialDays, params.today);
        if (!salon) throw conflict('This salon is not taking bookings at the moment. Please contact the salon.');
        const date = karachiParts(offer.offeredStart.getTime()).date;
        const hours = (await this.discovery.hoursForSalons(tx, [a.salonId])).get(a.salonId) ?? {};
        const week = (await this.discovery.staffWeeks(tx, [a.staffId], params.today, addDaysIso(params.today, 1))).get(a.staffId);
        const base = dayStartMs(date);
        const busy = await this.discovery.busyByStaff(tx, [a.staffId], base - DAY_MS, base + 2 * DAY_MS, a.id);
        const free = week && canStartAt({
          date, salon: hours, staff: week, busy: busy.get(a.staffId) ?? [], policy: { bufferMinutes: a.bufferMinutes, minNoticeMinutes: 0 },
          durationMin: a.totalDurationMinutes, nowMs, startMinute: karachiParts(offer.offeredStart.getTime()).minute,
        });
        if (!free) throw new AppException('SLOT_TAKEN', 'That earlier time was just taken. Your original time is unchanged.', 409);

        // 1) record the answer (database clock), 2) move: the appointment trigger requires exactly this accepted offer.
        if (!(await this.q.answerOffer(tx, offer.id, 'ACCEPTED', dto.etaMinutes ?? null))) throw conflict('This offer was just changed. Please refresh.');
        const startsAt = offer.offeredStart;
        const endsAt = new Date(startsAt.getTime() + a.totalDurationMinutes * 60_000);
        const blockedUntil = new Date(endsAt.getTime() + a.bufferMinutes * 60_000);
        if (!(await this.q.moveEarly(tx, user.id, id, { startsAt, endsAt, blockedUntil }, now))) throw conflict('This booking was just changed. Please refresh.');
        await this.repo.insertHistory(tx, {
          salonId: a.salonId, appointmentId: a.id, event: 'EARLY_ACCEPTED', fromStatus: a.status, toStatus: a.status, actorUserId: user.id, actorRole: 'CUSTOMER',
          reason: null, oldStartsAt: a.startsAt, newStartsAt: startsAt,
        });
        if (dto.etaMinutes !== undefined) {
          const etaAt = new Date(etaInstant(nowMs, dto.etaMinutes));
          if (await this.q.setArrival(tx, user.id, id, 'ON_THE_WAY', etaAt, now)) {
            await this.repo.insertHistory(tx, {
              salonId: a.salonId, appointmentId: a.id, event: 'ARRIVAL_UPDATE', fromStatus: a.status, toStatus: a.status, actorUserId: user.id, actorRole: 'CUSTOMER',
              reason: 'ON_THE_WAY', oldStartsAt: null, newStartsAt: etaAt,
            });
          }
        }
      });
    } catch (e) {
      if (sqlState(e) === '23P01') throw new AppException('SLOT_TAKEN', 'That earlier time was just taken. Your original time is unchanged.', 409);
      throw e;
    }
    return this.bookings.get(user, id);
  }

  /** Decline: the original time stays, no penalty, no cancellation. */
  async decline(user: AuthenticatedUser, id: string, dto: AnswerOfferDto) {
    const now = this.clock.now();
    await this.tenant.withCustomer(user.id, async (tx: Tx) => {
      await this.repo.lockCustomer(tx, user.id);
      const a = await this.repo.findForCustomer(tx, user.id, id);
      if (!a) throw notFound('Booking');
      const offer = await this.q.findOfferForCustomer(tx, user.id, id, dto.offerId);
      if (!offer) throw notFound('Offer');
      if (offer.status !== 'PENDING') throw conflict(`This offer is ${offer.status.toLowerCase()}.`, { rule: 'OFFER_CLOSED', status: offer.status });
      if (offer.expiresAt.getTime() <= now.getTime()) throw conflict('This offer has already expired. Your original time is unchanged.', { rule: 'OFFER_EXPIRED' });
      if (!(await this.q.answerOffer(tx, offer.id, 'DECLINED', null))) throw conflict('This offer was just changed. Please refresh.');
      await this.repo.insertHistory(tx, {
        salonId: a.salonId, appointmentId: a.id, event: 'EARLY_DECLINED', fromStatus: a.status, toStatus: a.status, actorUserId: user.id, actorRole: 'CUSTOMER',
        reason: null, oldStartsAt: a.startsAt, newStartsAt: offer.offeredStart,
      });
    });
    return this.bookings.get(user, id);
  }
}
