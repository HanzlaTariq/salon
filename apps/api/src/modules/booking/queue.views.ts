import { AppointmentRecord, HistoryRecord, LineRecord } from './booking.repository';
import { BookingPolicy } from './booking.types';
import { offerView, salonView } from './booking.views';
import type { OfferRecord, StaffLaneRecord, TodayCounts } from './queue.repository';
import { EarlyBounds, ProjectedItem, noShowDecision, startDecision } from './queue.types';
import { formatHm } from '../salons/opening-hours';
import { karachiParts } from './booking.types';

const iso = (ms: number) => new Date(ms).toISOString();
const clock = (ms: number) => formatHm(karachiParts(ms).minute);

/** One appointment as the salon (owner or the assigned staff member) sees it in the live queue. */
export function queueItemView(
  a: AppointmentRecord,
  lines: ReadonlyArray<LineRecord>,
  p: ProjectedItem | undefined,
  ctx: { position: number | null; offer: OfferRecord | null; policy: BookingPolicy; nowMs: number },
  history?: ReadonlyArray<HistoryRecord>,
) {
  const start = startDecision(a.status, a.startsAt.getTime(), ctx.nowMs);
  const ns = noShowDecision(ctx.policy, a.status, a.startsAt.getTime(), a.arrivalState === 'NONE' ? null : a.customerEtaAt?.getTime() ?? null, ctx.nowMs);
  return {
    ...salonView(a, lines, history),
    /** 1 = next to be served. Null for the appointment in service and for anything that is not waiting. */
    position: ctx.position,
    delayMinutes: p?.delayMinutes ?? 0,
    overrunMinutes: p?.overrunMinutes ?? 0,
    /** Forecast start, recalculated on every read (the stored estimate only changes when the shift reaches 5 minutes). */
    projectedStart: p ? iso(p.projectedStartMs) : null,
    canStart: start.allowed,
    startAllowedFrom: iso(start.earliestMs),
    noShow: { allowed: ns.allowed, allowedFrom: iso(ns.allowedFromMs), graceMinutes: ctx.policy.noShowGraceMinutes },
    earlyOffer: ctx.offer && a.customerUserId ? offerView(ctx.offer, a) : null,
  };
}

export type QueueItemView = ReturnType<typeof queueItemView>;

export interface LaneParts {
  staff: StaffLaneRecord;
  items: QueueItemView[];
  overdue: QueueItemView[];
  freeAtMs: number;
  counts: TodayCounts | undefined;
  candidate: { appointmentId: string; bounds: EarlyBounds } | null;
  canAddWalkIn: boolean;
}

export function laneView(l: LaneParts) {
  const current = l.items.find((i) => i.status === 'IN_PROGRESS') ?? null;
  const waiting = l.items.filter((i) => i.status !== 'IN_PROGRESS');
  return {
    staff: { id: l.staff.id, name: l.staff.name, isOwner: l.staff.isOwner },
    current,
    waiting,
    overdue: l.overdue,
    /** The earliest time this staff member can start someone new. */
    freeAt: iso(l.freeAtMs),
    freeAtTime: clock(l.freeAtMs),
    /** A waiting customer who could be asked to come earlier (null when nobody can). */
    earlyOfferCandidate: l.candidate
      ? { appointmentId: l.candidate.appointmentId, earliestStart: iso(l.candidate.bounds.earliestMs), earliestTime: clock(l.candidate.bounds.earliestMs), savesMinutes: l.candidate.bounds.gainMinutes }
      : null,
    today: { completed: l.counts?.completed ?? 0, noShows: l.counts?.noShows ?? 0, waiting: waiting.length },
    canAddWalkIn: l.canAddWalkIn,
  };
}

export type LaneView = ReturnType<typeof laneView>;
