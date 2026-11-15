import { formatHm } from '../salons/opening-hours';
import { AppointmentRecord, HistoryRecord, LineRecord } from './booking.repository';
import type { OfferRecord } from './queue.repository';
import { BookingPolicy, cancelDecision, karachiParts, rescheduleDecision } from './booking.types';

const lineView = (l: LineRecord) => ({ serviceId: l.serviceId, name: l.serviceName, durationMinutes: l.durationMinutes, price: l.price });

const timeParts = (a: AppointmentRecord) => {
  const s = karachiParts(a.startsAt.getTime());
  const e = karachiParts(a.endsAt.getTime());
  return {
    startsAt: a.startsAt.toISOString(),
    endsAt: a.endsAt.toISOString(),
    /** Karachi calendar date and clock of the start / end. */
    date: s.date,
    time: formatHm(s.minute),
    endTime: formatHm(e.minute),
  };
};

const hm = (d: Date | null): string | null => (d ? formatHm(karachiParts(d.getTime()).minute) : null);

/** The three kinds of time, kept apart: ORIGINAL (`startsAt`), the salon's ESTIMATE and the customer's own ETA. */
const progressParts = (a: AppointmentRecord) => ({
  startedAt: a.startedAt?.toISOString() ?? null,
  completedAt: a.completedAt?.toISOString() ?? null,
  estimate: a.estimatedStartsAt
    ? {
        startsAt: a.estimatedStartsAt.toISOString(), time: hm(a.estimatedStartsAt),
        delayMinutes: Math.round((a.estimatedStartsAt.getTime() - a.startsAt.getTime()) / 60_000), updatedAt: a.etaUpdatedAt?.toISOString() ?? null,
      }
    : null,
  customerEta: a.arrivalState === 'NONE'
    ? null
    : { state: a.arrivalState, etaAt: a.customerEtaAt?.toISOString() ?? null, etaTime: hm(a.customerEtaAt), updatedAt: a.arrivalUpdatedAt?.toISOString() ?? null },
});

export const offerView = (o: OfferRecord, a: AppointmentRecord) => ({
  id: o.id, offeredStart: o.offeredStart.toISOString(), offeredTime: hm(o.offeredStart), expiresAt: o.expiresAt.toISOString(),
  originalStart: a.startsAt.toISOString(), originalTime: hm(a.startsAt), savesMinutes: Math.round((a.startsAt.getTime() - o.offeredStart.getTime()) / 60_000),
});

const historyView = (h: HistoryRecord) => ({
  event: h.event, fromStatus: h.fromStatus, toStatus: h.toStatus, by: h.actorRole === 'CUSTOMER' ? 'CUSTOMER' : 'SALON',
  reason: h.reason, oldStartsAt: h.oldStartsAt?.toISOString() ?? null, newStartsAt: h.newStartsAt?.toISOString() ?? null, at: h.createdAt.toISOString(),
});

/** What a CUSTOMER sees of their own booking. Buffer minutes and internal ids of other people are never included. */
export function customerView(a: AppointmentRecord, lines: ReadonlyArray<LineRecord>, policy: BookingPolicy, nowMs: number, history?: ReadonlyArray<HistoryRecord>, openOffer?: OfferRecord | null) {
  const startMs = a.startsAt.getTime();
  const cancel = cancelDecision(policy, a.status, startMs, nowMs);
  const move = rescheduleDecision(policy, a.status, startMs, nowMs, a.rescheduleCount);
  return {
    id: a.id,
    status: a.status,
    salon: { id: a.salonId, name: a.salonName },
    staff: { id: a.staffId, name: a.staffName },
    ...timeParts(a),
    durationMinutes: a.totalDurationMinutes,
    totalPrice: a.totalPrice,
    currency: 'PKR',
    services: lines.map(lineView),
    note: a.customerNote,
    rescheduleCount: a.rescheduleCount,
    canCancel: cancel.allowed,
    cancelBefore: a.status === 'CONFIRMED' ? new Date(cancel.deadlineMs).toISOString() : null,
    canReschedule: move.allowed,
    rescheduleBefore: a.status === 'CONFIRMED' ? new Date(startMs - policy.rescheduleCutoffMinutes * 60_000).toISOString() : null,
    reschedulesLeft: Math.max(0, policy.maxReschedules - a.rescheduleCount),
    cancellation: a.status === 'CANCELLED' ? { at: a.cancelledAt?.toISOString() ?? null, by: a.cancelledByRole, reason: a.cancellationReason } : null,
    createdAt: a.createdAt.toISOString(),
    ...progressParts(a),
    /** An offer to come earlier that the customer may accept or decline (null when none is open or it has run out). */
    earlyOffer: openOffer && openOffer.expiresAt.getTime() > nowMs && a.status === 'CONFIRMED' ? offerView(openOffer, a) : null,
    ...(history ? { history: history.map(historyView) } : {}),
  };
}

/** What the SALON (owner, or the assigned staff member) sees. Staff never get the phone number (the query leaves it NULL). */
export function salonView(a: AppointmentRecord, lines: ReadonlyArray<LineRecord>, history?: ReadonlyArray<HistoryRecord>) {
  return {
    id: a.id,
    status: a.status,
    source: a.source,
    staff: { id: a.staffId, name: a.staffName },
    walkIn: a.source === 'WALK_IN',
    customer: { name: a.customerName, phone: a.customerPhone },
    ...timeParts(a),
    ...progressParts(a),
    durationMinutes: a.totalDurationMinutes,
    totalPrice: a.totalPrice,
    currency: 'PKR',
    services: lines.map(lineView),
    note: a.customerNote,
    rescheduleCount: a.rescheduleCount,
    cancellation: a.status === 'CANCELLED' ? { at: a.cancelledAt?.toISOString() ?? null, by: a.cancelledByRole, reason: a.cancellationReason } : null,
    createdAt: a.createdAt.toISOString(),
    ...(history ? { history: history.map(historyView) } : {}),
  };
}

export const policyView = (policy: BookingPolicy, customized: boolean) => ({ ...policy, customized });
