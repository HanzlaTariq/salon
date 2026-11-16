import { Injectable } from '@nestjs/common';
import { Tx } from '../salons/salons.repository';
import { addDays } from '../billing/billing.types';
import { AppointmentFacts, EventRecord, NotificationRepository } from './notification.repository';
import { TemplateParams } from './notification.templates';
import { NotificationType, Route } from './notification.types';

/** One notification for one person, before preferences and language are applied. */
export interface Planned {
  userId: string;
  type: NotificationType;
  salonId: string | null;
  route: Route;
  params: TemplateParams;
  /** String data for the app (deep link). Values are ids and numbers only, never personal text. */
  data: Record<string, string>;
  /** Reminder offset in minutes; the person's reminder preference must include it. */
  reminderOffset?: number;
  /** Anti-spam rule applied before the history row is written. */
  throttle?: { kind: 'DELAY'; appointmentId: string; estimateMs: number } | { kind: 'SCHEDULE'; staffId: string };
}

const roundTo5 = (minutes: number): number => Math.max(5, Math.round(minutes / 5) * 5);
const unique = (ids: Array<string | null | undefined>): string[] => [...new Set(ids.filter((x): x is string => typeof x === 'string'))];

/**
 * Decides, from VERIFIED database facts, who must be told about an event. It re-reads the facts instead of trusting the event row, so a
 * stale event (the booking was cancelled meanwhile, the salon status changed again, the booking was moved) produces nothing.
 * The actor is never told about their own action; the dispatcher removes them and every account that is not ACTIVE.
 */
@Injectable()
export class NotificationPlanner {
  constructor(private readonly repo: NotificationRepository) {}

  async plan(tx: Tx, ev: EventRecord, now: Date): Promise<Planned[]> {
    switch (ev.kind) {
      case 'BOOKING_CREATED': case 'BOOKING_CANCELLED': case 'BOOKING_RESCHEDULED': case 'SERVICE_COMPLETED': case 'NO_SHOW_RECORDED':
      case 'DELAY_NOTICE': case 'ARRIVAL_UPDATE': case 'EARLY_OFFER': case 'EARLY_RESPONSE':
        return this.fromHistory(tx, ev, now);
      case 'APPOINTMENT_REMINDER': return this.reminder(tx, ev);
      case 'SALON_STATUS': return this.salonStatus(tx, ev);
      case 'PAYMENT_DECISION': return this.paymentDecision(tx, ev);
      case 'SUBSCRIPTION_NOTICE': return this.subscriptionNotice(tx, ev);
      case 'STAFF_JOINED': return this.staffJoined(tx, ev);
      case 'STAFF_SCHEDULE': return this.staffSchedule(tx, ev);
      default: return [];
    }
  }

  // ------------------------------------------------------------------ appointment events
  private team(a: AppointmentFacts, type: NotificationType, params: TemplateParams, extra: Record<string, string> = {}): Planned[] {
    return unique([a.staffUserId, a.ownerUserId]).map((userId) => ({
      userId, type, salonId: a.salonId, route: 'queue' as const, params, data: { appointmentId: a.id, ...extra },
    }));
  }

  private customer(a: AppointmentFacts, type: NotificationType, params: TemplateParams, extra: Record<string, string> = {}, throttle?: Planned['throttle']): Planned[] {
    if (!a.customerUserId) return []; // a walk-in has no app account
    return [{ userId: a.customerUserId, type, salonId: a.salonId, route: 'booking', params, data: { appointmentId: a.id, ...extra }, throttle }];
  }

  private async fromHistory(tx: Tx, ev: EventRecord, now: Date): Promise<Planned[]> {
    const h = await this.repo.history(tx, ev.refId);
    if (!h) return [];
    const a = await this.repo.appointment(tx, h.appointmentId);
    if (!a) return [];
    const base: TemplateParams = { salon: a.salonName, staff: a.staffName, customer: a.customerName, startsAtMs: a.startsAt.getTime() };

    switch (ev.kind) {
      case 'BOOKING_CREATED':
        if (a.source !== 'ONLINE' || a.status === 'CANCELLED') return [];
        return [...this.customer(a, 'BOOKING_CONFIRMED', base), ...this.team(a, 'BOOKING_NEW', base)];

      case 'BOOKING_CANCELLED': {
        const params = { ...base, reason: a.cancellationReason };
        const toCustomer = a.cancelledByRole === 'SALON' ? this.customer(a, 'BOOKING_CANCELLED_SALON', params) : [];
        return [...toCustomer, ...this.team(a, 'BOOKING_CANCELLED_STAFF', params)];
      }

      case 'BOOKING_RESCHEDULED':
        if (!h.oldStartsAt || !h.newStartsAt) return [];
        return this.team(a, 'BOOKING_RESCHEDULED', { ...base, oldStartsAtMs: h.oldStartsAt.getTime(), newStartsAtMs: h.newStartsAt.getTime() });

      case 'SERVICE_COMPLETED': return this.customer(a, 'SERVICE_COMPLETED', base);
      case 'NO_SHOW_RECORDED': return this.customer(a, 'NO_SHOW_RECORDED', base);

      case 'DELAY_NOTICE': {
        // The forecast may have changed again since: always speak about the CURRENT one. Nothing to say when the day is back on time.
        if (a.status !== 'CONFIRMED' || !a.estimatedStartsAt) return [];
        const estimateMs = a.estimatedStartsAt.getTime();
        const minutes = roundTo5((estimateMs - a.startsAt.getTime()) / 60_000);
        return this.customer(a, 'DELAY_NOTICE', { ...base, estimateMs, minutes }, { estimateMs: String(estimateMs) }, { kind: 'DELAY', appointmentId: a.id, estimateMs });
      }

      case 'ARRIVAL_UPDATE': {
        if (h.reason !== 'ON_THE_WAY' && h.reason !== 'RUNNING_LATE') return [];
        const etaMs = h.newStartsAt?.getTime();
        const minutes = etaMs ? Math.max(0, Math.round((etaMs - h.createdAt.getTime()) / 60_000)) : 0;
        return this.team(a, h.reason === 'ON_THE_WAY' ? 'ARRIVAL_ON_THE_WAY' : 'ARRIVAL_RUNNING_LATE', { ...base, etaMs, minutes });
      }

      case 'EARLY_OFFER': {
        const offer = await this.repo.pendingOffer(tx, a.id);
        if (!offer || offer.expiresAt.getTime() <= now.getTime() || a.status !== 'CONFIRMED') return [];
        return this.customer(a, 'EARLY_OFFER', { ...base, offeredMs: offer.offeredStart.getTime() }, { offerId: offer.id });
      }

      case 'EARLY_RESPONSE': {
        if (h.event === 'EARLY_ACCEPTED') {
          const minutes = (await this.repo.acceptedOfferMinutes(tx, a.id)) ?? 0;
          return this.team(a, 'EARLY_ACCEPTED', { ...base, newStartsAtMs: (h.newStartsAt ?? a.startsAt).getTime(), minutes });
        }
        if (h.event === 'EARLY_DECLINED') return this.team(a, 'EARLY_DECLINED', base);
        return [];
      }
      default: return [];
    }
  }

  private async reminder(tx: Tx, ev: EventRecord): Promise<Planned[]> {
    const a = await this.repo.appointment(tx, ev.refId);
    const offset = Number(ev.payload.offset);
    const startsAtMs = Number(ev.payload.startsAtMs);
    if (!a || !Number.isInteger(offset) || a.status !== 'CONFIRMED' || a.startsAt.getTime() !== startsAtMs) return []; // cancelled or moved since
    const params: TemplateParams = {
      salon: a.salonName, staff: a.staffName, startsAtMs, minutes: offset,
      estimateMs: a.estimatedStartsAt && a.estimatedStartsAt.getTime() > startsAtMs ? a.estimatedStartsAt.getTime() : undefined,
    };
    return this.customer(a, 'APPOINTMENT_REMINDER', params, { offset: String(offset) }).map((p) => ({ ...p, reminderOffset: offset }));
  }

  // ------------------------------------------------------------------ salon, payment, subscription, staff
  private async salonStatus(tx: Tx, ev: EventRecord): Promise<Planned[]> {
    const s = await this.repo.salon(tx, ev.refId);
    if (!s || s.status !== ev.payload.status) return [];
    const from = String(ev.payload.from ?? '');
    const type: NotificationType | null =
      s.status === 'APPROVED' ? (from === 'SUSPENDED' ? 'SALON_REACTIVATED' : 'SALON_APPROVED') : s.status === 'REJECTED' ? 'SALON_REJECTED' : s.status === 'SUSPENDED' ? 'SALON_SUSPENDED' : null;
    if (!type) return [];
    const reason = s.status === 'REJECTED' ? s.rejectionReason : s.status === 'SUSPENDED' ? s.suspendedReason : null;
    return [{ userId: s.ownerUserId, type, salonId: s.id, route: 'salon', params: { salon: s.name, reason }, data: { salonId: s.id } }];
  }

  private async paymentDecision(tx: Tx, ev: EventRecord): Promise<Planned[]> {
    const p = await this.repo.payment(tx, ev.refId);
    if (!p || p.status !== ev.payload.status) return [];
    const type: NotificationType | null = p.status === 'APPROVED' ? 'PAYMENT_APPROVED' : p.status === 'REJECTED' ? 'PAYMENT_REJECTED' : p.status === 'NEEDS_INFO' ? 'PAYMENT_NEEDS_INFO' : null;
    if (!type) return [];
    return [{ userId: p.ownerUserId, type, salonId: p.salonId, route: 'billing', params: { invoiceNo: p.invoiceNo, reason: p.status === 'APPROVED' ? null : p.reviewReason }, data: { paymentId: p.id } }];
  }

  private async subscriptionNotice(tx: Tx, ev: EventRecord): Promise<Planned[]> {
    const s = await this.repo.subscription(tx, ev.refId);
    // A renewal (new period end) or a suspension since the sweep makes the warning wrong: say nothing.
    if (!s || s.status !== 'ACTIVE' || s.periodEnd !== ev.payload.periodEnd) return [];
    if (ev.payload.when === 'EXPIRING') {
      const days = Number(ev.payload.days);
      return [{ userId: s.ownerUserId, type: 'SUBSCRIPTION_EXPIRING', salonId: s.salonId, route: 'billing', params: { days, periodEnd: s.periodEnd }, data: { salonId: s.salonId } }];
    }
    if (ev.payload.when === 'EXPIRED') {
      const graceEnd = s.graceDays > 0 ? addDays(s.periodEnd, s.graceDays) : null;
      return [{ userId: s.ownerUserId, type: 'SUBSCRIPTION_EXPIRED', salonId: s.salonId, route: 'billing', params: { periodEnd: s.periodEnd, graceEnd }, data: { salonId: s.salonId } }];
    }
    return [];
  }

  private async staffJoined(tx: Tx, ev: EventRecord): Promise<Planned[]> {
    const inv = await this.repo.invitation(tx, ev.refId);
    if (!inv || inv.status !== 'ACCEPTED') return [];
    const staff = await this.repo.staff(tx, inv.staffId);
    if (!staff) return [];
    return [{ userId: staff.ownerUserId, type: 'STAFF_JOINED', salonId: staff.salonId, route: 'team', params: { staff: staff.displayName }, data: { staffId: staff.id } }];
  }

  private async staffSchedule(tx: Tx, ev: EventRecord): Promise<Planned[]> {
    const staff = await this.repo.staff(tx, ev.refId);
    if (!staff || !staff.userId || !staff.isActive) return [];
    return [{ userId: staff.userId, type: 'STAFF_SCHEDULE_UPDATED', salonId: staff.salonId, route: 'schedule', params: {}, data: { staffId: staff.id }, throttle: { kind: 'SCHEDULE', staffId: staff.id } }];
  }
}
