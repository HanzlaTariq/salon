import { createHash } from 'crypto';
import { BookingPolicy, dayStartMs } from './booking.types';

/**
 * Phase 9 pure rules (no I/O): the live queue of ONE staff member, delay propagation (ETA), the no-show grace period, early
 * availability offers and the customer's arrival report. Everything is a function of (appointments, now), so the same
 * numbers can be shown to the salon, stored as the estimate and tested without a database.
 *
 * Three different times are kept apart on purpose (section 10 of the product brief):
 *   - ORIGINAL time   `startsAt`            what the customer booked and agreed to. Never changed by the salon.
 *   - ESTIMATED time  `estimatedStartsAt`   the salon's honest forecast when the day runs late (this file computes it).
 *   - CUSTOMER ETA    `customerEtaAt`       when the customer says they will arrive (written only by the customer).
 */
const MINUTE_MS = 60_000;

export const QUEUE_LIMITS = {
  /** A delay is published as an estimate from this many minutes on; smaller shifts are noise. */
  delayThresholdMinutes: 5,
  /** Estimates and offers live on a 5-minute grid (same as booking times). */
  gridMinutes: 5,
  /** Staff cannot start an appointment more than this long before its booked time (protects against a stray tap). */
  startEarlyLimitMinutes: 60,
  /** An early offer must save the customer at least this long. */
  earlyOfferMinGainMinutes: 10,
  /** The earliest an offer can start: the customer needs this long to react. */
  earlyOfferLeadMinutes: 5,
  /** Offers per appointment (anti-spam). */
  earlyOfferMaxPerAppointment: 3,
  /** The customer may report their arrival this long before the booked time ... */
  arrivalWindowBeforeMinutes: 180,
  /** ... and until this long after it (staff may mark a no-show after the grace period, and then it is over). */
  arrivalWindowAfterMinutes: 240,
  arrivalMaxUpdates: 10,
  arrivalEtaMinMinutes: 1,
  arrivalEtaMaxMinutes: 120,
  /** Quick choices in the customer app; any whole number from arrivalEtaMinMinutes to arrivalEtaMaxMinutes is accepted. */
  arrivalEtaChoices: [5, 10, 15, 20, 30],
  walkInNameMinLength: 2,
  walkInNameMaxLength: 80,
  walkInNoteMaxLength: 300,
  /** Anti-abuse / sanity: waiting walk-ins per staff member. */
  walkInMaxWaitingPerStaff: 15,
  /** Appointments from before today that are still open, shown to the salon so they can be closed (no-show / complete). */
  overdueListLimit: 20,
} as const;

const GRID_MS = QUEUE_LIMITS.gridMinutes * MINUTE_MS;

/** Rounds an instant UP to the 5-minute grid. Karachi is UTC+5 (a multiple of 5 minutes), so this is also the local clock grid. */
export const ceilToGrid = (ms: number): number => Math.ceil(ms / GRID_MS) * GRID_MS;

// ------------------------------------------------------------------ queue projection (delay / ETA)

export interface QueueItem {
  id: string;
  /** DELAYED is reserved in the database and never written in Phase 9; it is handled like CONFIRMED. */
  status: 'PENDING' | 'CONFIRMED' | 'IN_PROGRESS' | 'DELAYED';
  startsAtMs: number;
  durationMinutes: number;
  bufferMinutes: number;
  startedAtMs: number | null;
  /** The customer's own ETA (only while they reported ON_THE_WAY / RUNNING_LATE). */
  customerEtaAtMs: number | null;
}

export interface ProjectedItem {
  id: string;
  /** When the appointment can realistically start (equals the booked time when the day runs on time). */
  projectedStartMs: number;
  projectedEndMs: number;
  /** Whole minutes behind the booked time (0 when on time or earlier-bounded by the booking). */
  delayMinutes: number;
  /** Published estimate: set only when the delay reaches `delayThresholdMinutes`, else null. */
  estimatedStartsAtMs: number | null;
  /** Only for the appointment in service: minutes beyond its expected end (0 otherwise). */
  overrunMinutes: number;
}

export interface QueueProjection {
  /** The appointment in service first, then the waiting ones in booked order. */
  items: ProjectedItem[];
  byId: ReadonlyMap<string, ProjectedItem>;
  /** The earliest grid time the staff member can start someone NEW (after the current service and its buffer). */
  freeAtMs: number;
}

/**
 * Forecasts the day of one staff member.
 *
 *  - A service in progress is expected to take its booked duration from the moment it ACTUALLY started; if that moment has
 *    passed it is assumed to finish right now (the forecast grows as time passes).
 *  - A waiting appointment cannot start before its booked time (never earlier without the customer's consent), before the staff
 *    member is free, before the customer's own ETA, and not in the past.
 *  - A waiting appointment whose time has passed without a customer signal is projected at "now": the salon has not marked a
 *    no-show yet, so the delay is shown honestly instead of hidden.
 */
export function projectQueue(items: ReadonlyArray<QueueItem>, nowMs: number): QueueProjection {
  const current = items.find((i) => i.status === 'IN_PROGRESS') ?? null;
  const waiting = items
    .filter((i) => i !== current)
    .sort((a, b) => a.startsAtMs - b.startsAtMs || a.id.localeCompare(b.id));

  const out: ProjectedItem[] = [];
  let cursor = 0;
  let freeAtMs = ceilToGrid(nowMs);

  if (current) {
    const startedAt = current.startedAtMs ?? current.startsAtMs;
    const expectedEnd = startedAt + current.durationMinutes * MINUTE_MS;
    const projectedEnd = Math.max(expectedEnd, nowMs);
    cursor = projectedEnd + current.bufferMinutes * MINUTE_MS;
    freeAtMs = ceilToGrid(cursor);
    out.push({
      id: current.id, projectedStartMs: startedAt, projectedEndMs: projectedEnd, delayMinutes: 0, estimatedStartsAtMs: null,
      overrunMinutes: Math.max(0, Math.floor((nowMs - expectedEnd) / MINUTE_MS)),
    });
  }

  for (const a of waiting) {
    const notInThePast = a.startsAtMs <= nowMs ? nowMs : 0;
    const rawStart = Math.max(a.startsAtMs, cursor, notInThePast, a.customerEtaAtMs ?? 0);
    // The shift is judged BEFORE rounding, so a few seconds of overrun are not turned into a 5-minute delay by the grid.
    const published = (rawStart - a.startsAtMs) / MINUTE_MS >= QUEUE_LIMITS.delayThresholdMinutes;
    const start = published ? ceilToGrid(rawStart) : rawStart;
    const delayMinutes = Math.max(0, Math.round((start - a.startsAtMs) / MINUTE_MS));
    const end = start + a.durationMinutes * MINUTE_MS;
    cursor = end + a.bufferMinutes * MINUTE_MS;
    out.push({
      id: a.id, projectedStartMs: start, projectedEndMs: end, delayMinutes,
      estimatedStartsAtMs: published ? start : null,
      overrunMinutes: 0,
    });
  }
  return { items: out, byId: new Map(out.map((p) => [p.id, p])), freeAtMs };
}

/** Does the new estimate differ enough from the stored one to be worth saving (and telling the customer in Phase 10)? */
export function estimateChanged(oldMs: number | null, newMs: number | null): boolean {
  if (oldMs === null && newMs === null) return false;
  if (oldMs === null || newMs === null) return true;
  return Math.abs(newMs - oldMs) >= QUEUE_LIMITS.delayThresholdMinutes * MINUTE_MS;
}

// ------------------------------------------------------------------ Karachi day bounds

/** [00:00 today, 00:00 tomorrow) in Asia/Karachi as UTC instants. */
export function karachiDayBounds(nowMs: number): { dayStart: Date; dayEnd: Date; date: string } {
  const date = new Date(nowMs + 5 * 3_600_000).toISOString().slice(0, 10);
  const start = dayStartMs(date);
  return { dayStart: new Date(start), dayEnd: new Date(start + 86_400_000), date };
}

// ------------------------------------------------------------------ start / no-show decisions

export type StartReason = 'OK' | 'STATUS' | 'TOO_EARLY';
export interface StartDecision {
  allowed: boolean;
  reason: StartReason;
  /** The earliest instant the appointment may be started. */
  earliestMs: number;
}

export function startDecision(status: string, startsAtMs: number, nowMs: number): StartDecision {
  const earliestMs = startsAtMs - QUEUE_LIMITS.startEarlyLimitMinutes * MINUTE_MS;
  if (status !== 'CONFIRMED') return { allowed: false, reason: 'STATUS', earliestMs };
  return nowMs >= earliestMs ? { allowed: true, reason: 'OK', earliestMs } : { allowed: false, reason: 'TOO_EARLY', earliestMs };
}

export type NoShowReason = 'OK' | 'STATUS' | 'GRACE';
export interface NoShowDecision {
  allowed: boolean;
  reason: NoShowReason;
  /** First instant a no-show may be marked: the later of the booked time and the customer's own ETA, plus the salon's grace period. */
  allowedFromMs: number;
}

/** The salon's policy is always applied: a no-show is never marked early and never automatically. */
export function noShowDecision(policy: Pick<BookingPolicy, 'noShowGraceMinutes'>, status: string, startsAtMs: number, customerEtaAtMs: number | null, nowMs: number): NoShowDecision {
  const allowedFromMs = Math.max(startsAtMs, customerEtaAtMs ?? 0) + policy.noShowGraceMinutes * MINUTE_MS;
  if (status !== 'CONFIRMED') return { allowed: false, reason: 'STATUS', allowedFromMs };
  return nowMs >= allowedFromMs ? { allowed: true, reason: 'OK', allowedFromMs } : { allowed: false, reason: 'GRACE', allowedFromMs };
}

// ------------------------------------------------------------------ early availability offer

export interface EarlyBounds {
  /** The earliest start the salon can offer. */
  earliestMs: number;
  /** How many minutes earlier than the booked time that is. */
  gainMinutes: number;
}

/**
 * Could this appointment be brought forward? The offered start must be after the staff member is free, give the customer time
 * to react, and save at least `earlyOfferMinGainMinutes`. This is only the time arithmetic; the slot engine and the exclusion
 * constraint still decide whether that time is really free.
 */
export function earlyOfferBounds(startsAtMs: number, freeAtMs: number, nowMs: number): EarlyBounds | null {
  const earliestMs = ceilToGrid(Math.max(freeAtMs, nowMs + QUEUE_LIMITS.earlyOfferLeadMinutes * MINUTE_MS));
  const gainMinutes = Math.floor((startsAtMs - earliestMs) / MINUTE_MS);
  return gainMinutes >= QUEUE_LIMITS.earlyOfferMinGainMinutes ? { earliestMs, gainMinutes } : null;
}

// ------------------------------------------------------------------ customer arrival report

export type ArrivalState = 'NONE' | 'ON_THE_WAY' | 'RUNNING_LATE';
export type ArrivalReason = 'OK' | 'STATUS' | 'TOO_EARLY' | 'TOO_LATE' | 'LIMIT';

export interface ArrivalDecision {
  allowed: boolean;
  reason: ArrivalReason;
}

export function arrivalDecision(status: string, startsAtMs: number, nowMs: number, updatesSoFar: number): ArrivalDecision {
  if (status !== 'CONFIRMED') return { allowed: false, reason: 'STATUS' };
  if (nowMs < startsAtMs - QUEUE_LIMITS.arrivalWindowBeforeMinutes * MINUTE_MS) return { allowed: false, reason: 'TOO_EARLY' };
  if (nowMs > startsAtMs + QUEUE_LIMITS.arrivalWindowAfterMinutes * MINUTE_MS) return { allowed: false, reason: 'TOO_LATE' };
  if (updatesSoFar >= QUEUE_LIMITS.arrivalMaxUpdates) return { allowed: false, reason: 'LIMIT' };
  return { allowed: true, reason: 'OK' };
}

export const isValidEtaMinutes = (v: unknown): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= QUEUE_LIMITS.arrivalEtaMinMinutes && v <= QUEUE_LIMITS.arrivalEtaMaxMinutes;

/** "I will be there in N minutes" -> an absolute instant (rounded up to the whole minute). */
export const etaInstant = (nowMs: number, minutes: number): number => Math.ceil(nowMs / MINUTE_MS) * MINUTE_MS + minutes * MINUTE_MS;

// ------------------------------------------------------------------ walk-ins

/** Same request => same fingerprint: a retried walk-in with the same Idempotency-Key returns the original walk-in. */
export function walkInFingerprint(i: { staffId: string; serviceIds: ReadonlyArray<string>; name: string; phone: string | null; note: string | null }): string {
  const canonical = JSON.stringify([i.staffId, [...i.serviceIds].sort(), i.name, i.phone ?? '', i.note ?? '']);
  return createHash('sha256').update(canonical).digest('hex');
}
