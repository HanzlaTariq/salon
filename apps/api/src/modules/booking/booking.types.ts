import { createHash } from 'crypto';
import { formatHm } from '../salons/opening-hours';
import { DISCOVERY_LIMITS, Span, StaffWeek, WeekSpans, addDaysIso, freeSpans, slotStarts } from '../discovery/discovery.types';

/**
 * Phase 8 pure rules (no I/O): booking limits and policy, Asia/Karachi time conversion, the REAL slot engine
 * (salon hours + staff hours - breaks - leave - existing appointments - buffer - minimum notice) and the cancellation /
 * reschedule rules. The same functions serve the public availability endpoint, the search cards and the booking
 * transaction, so what a customer is shown and what the server accepts can never drift apart.
 *
 * The slot engine is a convenience for the customer. The ONLY authority against double booking is the PostgreSQL
 * exclusion constraint on appointments (migration 20261115000000): a start time that passes `canStartAt` can still be
 * refused with SLOT_TAKEN if another customer got there first.
 */
export const BOOKING_LIMITS = {
  maxServices: DISCOVERY_LIMITS.maxServicesPerPreview,
  /** One appointment must fit inside one day. */
  maxTotalDurationMinutes: 720,
  /** Anti-hoarding: open (upcoming) appointments one customer may hold. */
  maxActivePerCustomer: 10,
  maxActivePerCustomerPerSalon: 3,
  noteMaxLength: 300,
  reasonMinLength: 3,
  reasonMaxLength: 300,
  slotStepMinutes: DISCOVERY_LIMITS.slotStepMinutes,
  defaultPageSize: 20,
  maxPageSize: 50,
  /** Owner / staff calendar queries cover at most this many days at once. */
  maxRangeDays: 31,
} as const;

/** Rules a salon owner may change (ranges mirror the CHECK constraints of salon_booking_policies). */
export interface BookingPolicy {
  /** Cleaning / preparation time kept free after every appointment. */
  bufferMinutes: number;
  /** How far ahead of the start a customer must book. */
  minNoticeMinutes: number;
  /** Booking window in days, counting today (14 = today + 13 days). */
  advanceDays: number;
  /** A customer can cancel on their own until this long before the start. */
  cancelCutoffMinutes: number;
  /** A customer can move the appointment on their own until this long before the start. */
  rescheduleCutoffMinutes: number;
  /** How many times a customer may move one appointment (0 = never). */
  maxReschedules: number;
}

export const BOOKING_POLICY_DEFAULTS: Readonly<BookingPolicy> = {
  bufferMinutes: 0,
  minNoticeMinutes: 30,
  advanceDays: 14,
  cancelCutoffMinutes: 120,
  rescheduleCutoffMinutes: 120,
  maxReschedules: 2,
};

export const BOOKING_POLICY_RANGES = {
  bufferMinutes: { min: 0, max: 60, step: 5 },
  minNoticeMinutes: { min: 0, max: 1440 },
  advanceDays: { min: 1, max: 60 },
  cancelCutoffMinutes: { min: 0, max: 10_080 },
  rescheduleCutoffMinutes: { min: 0, max: 10_080 },
  maxReschedules: { min: 0, max: 5 },
} as const;

/** Statuses that occupy the staff member's time (must match the WHERE of the exclusion constraint). */
export const ACTIVE_STATUSES = ['PENDING', 'CONFIRMED', 'IN_PROGRESS', 'DELAYED'] as const;
export type AppointmentStatus = (typeof ACTIVE_STATUSES)[number] | 'COMPLETED' | 'CANCELLED' | 'NO_SHOW';

export const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_-]{8,64}$/;

/** Defensive read of a policy row: anything out of range falls back to the default for that field. */
export function policyFromRow(row: Record<string, unknown> | null | undefined): BookingPolicy {
  const pick = (key: keyof BookingPolicy, column: string): number => {
    const v = row ? Number(row[column]) : NaN;
    const r = BOOKING_POLICY_RANGES[key];
    return Number.isInteger(v) && v >= r.min && v <= r.max ? v : BOOKING_POLICY_DEFAULTS[key];
  };
  return {
    bufferMinutes: pick('bufferMinutes', 'buffer_minutes'),
    minNoticeMinutes: pick('minNoticeMinutes', 'min_notice_minutes'),
    advanceDays: pick('advanceDays', 'advance_days'),
    cancelCutoffMinutes: pick('cancelCutoffMinutes', 'cancel_cutoff_minutes'),
    rescheduleCutoffMinutes: pick('rescheduleCutoffMinutes', 'reschedule_cutoff_minutes'),
    maxReschedules: pick('maxReschedules', 'max_reschedules'),
  };
}

// ------------------------------------------------------------------ time (Asia/Karachi, UTC+5, no daylight saving)

const MINUTE_MS = 60_000;
const KARACHI_OFFSET_MS = 5 * 3_600_000;

/** UTC instant (ms) of 00:00 Karachi time on `date` (YYYY-MM-DD). */
export const dayStartMs = (date: string): number => Date.parse(`${date}T00:00:00Z`) - KARACHI_OFFSET_MS;

/** UTC instant (ms) of `minute` minutes after midnight Karachi time on `date`. */
export const slotMs = (date: string, minute: number): number => dayStartMs(date) + minute * MINUTE_MS;

/** Karachi calendar date and minute-of-day of a UTC instant. */
export function karachiParts(ms: number): { date: string; minute: number } {
  const t = new Date(ms + KARACHI_OFFSET_MS);
  return { date: t.toISOString().slice(0, 10), minute: t.getUTCHours() * 60 + t.getUTCMinutes() };
}

/** Is `date` inside the booking window (today .. today + advanceDays - 1)? */
export const withinWindow = (date: string, today: string, advanceDays: number): boolean => date >= today && date <= addDaysIso(today, advanceDays - 1);

// ------------------------------------------------------------------ slot engine

/** Busy time of a staff member as absolute instants: [startMs, endMs) where endMs already includes the buffer (blocked_until). */
export interface AbsBusy {
  startMs: number;
  endMs: number;
}

/**
 * Busy intervals as minutes of `date`, each one extended BACKWARDS by the buffer. A new appointment of length D then
 * fits when [start, start + D) avoids every extended span, which is exactly "[start, start + D + buffer) does not
 * overlap an existing [start, blocked_until)" (the exclusion constraint) without demanding the buffer inside opening hours.
 */
export function busySpansFor(date: string, busy: ReadonlyArray<AbsBusy>, bufferMinutes: number): Span[] {
  const base = dayStartMs(date);
  const out: Span[] = [];
  for (const b of busy) {
    const start = Math.floor((b.startMs - base) / MINUTE_MS) - bufferMinutes;
    const end = Math.ceil((b.endMs - base) / MINUTE_MS);
    if (end <= 0 || start >= 1440) continue;
    out.push({ start: Math.max(0, start), end: Math.min(1440, end) });
  }
  return out;
}

/** Earliest minute of `date` that respects the minimum notice, rounded up to the next 5 minutes (can be >= 1440: no slot). */
export function notBeforeMinute(date: string, nowMs: number, minNoticeMinutes: number): number {
  const earliest = nowMs + minNoticeMinutes * MINUTE_MS;
  const minute = Math.ceil((earliest - dayStartMs(date)) / MINUTE_MS / 5) * 5;
  return Math.max(0, minute);
}

export interface SlotInput {
  date: string;
  salon: WeekSpans;
  staff: StaffWeek;
  busy: ReadonlyArray<AbsBusy>;
  policy: Pick<BookingPolicy, 'bufferMinutes' | 'minNoticeMinutes'>;
  durationMin: number;
  nowMs: number;
  stepMin?: number;
}

const freeFor = (i: SlotInput): Span[] => freeSpans(i.date, i.salon, i.staff, busySpansFor(i.date, i.busy, i.policy.bufferMinutes));

/** Start times (minutes) the customer can pick for one staff member on one day. */
export function openStarts(i: SlotInput): number[] {
  return slotStarts(freeFor(i), i.durationMin, i.stepMin ?? BOOKING_LIMITS.slotStepMinutes, notBeforeMinute(i.date, i.nowMs, i.policy.minNoticeMinutes));
}

/** Would a booking starting at exactly `startMinute` be valid right now? (5-minute grid, notice, hours, breaks, leave, busy.) */
export function canStartAt(i: SlotInput & { startMinute: number }): boolean {
  if (!Number.isInteger(i.startMinute) || i.startMinute < 0 || i.startMinute % 5 !== 0) return false;
  if (i.startMinute < notBeforeMinute(i.date, i.nowMs, i.policy.minNoticeMinutes)) return false;
  return freeFor(i).some((sp) => i.startMinute >= sp.start && i.startMinute + i.durationMin <= sp.end);
}

/** First free start over the booking window for ANY of the given staff (bookings and buffer included). */
export function nextAvailableBooked(
  salon: WeekSpans,
  staff: ReadonlyArray<StaffWeek>,
  busyByStaff: ReadonlyMap<string, ReadonlyArray<AbsBusy>>,
  policy: BookingPolicy,
  durationMin: number,
  nowMs: number,
  horizonDays: number = DISCOVERY_LIMITS.horizonDays,
): { date: string; time: string } | null {
  const today = karachiParts(nowMs).date;
  const days = Math.min(horizonDays, policy.advanceDays);
  for (let d = 0; d < days; d += 1) {
    const date = addDaysIso(today, d);
    let best: number | null = null;
    for (const s of staff) {
      const starts = openStarts({ date, salon, staff: s, busy: busyByStaff.get(s.staffId) ?? [], policy, durationMin, nowMs });
      if (starts.length > 0 && (best === null || starts[0] < best)) best = starts[0];
    }
    if (best !== null) return { date, time: formatHm(best) };
  }
  return null;
}

// ------------------------------------------------------------------ cancellation and rescheduling by the customer

export type CustomerActionReason = 'OK' | 'STATUS' | 'CUTOFF' | 'LIMIT';

export interface CustomerActionDecision {
  allowed: boolean;
  reason: CustomerActionReason;
  /** Last instant (ms) the customer may still do it; for STATUS it is meaningless. */
  deadlineMs: number;
}

export function cancelDecision(policy: BookingPolicy, status: string, startsAtMs: number, nowMs: number): CustomerActionDecision {
  const deadlineMs = startsAtMs - policy.cancelCutoffMinutes * MINUTE_MS;
  if (status !== 'CONFIRMED') return { allowed: false, reason: 'STATUS', deadlineMs };
  return nowMs <= deadlineMs ? { allowed: true, reason: 'OK', deadlineMs } : { allowed: false, reason: 'CUTOFF', deadlineMs };
}

export function rescheduleDecision(policy: BookingPolicy, status: string, startsAtMs: number, nowMs: number, rescheduleCount: number): CustomerActionDecision {
  const deadlineMs = startsAtMs - policy.rescheduleCutoffMinutes * MINUTE_MS;
  if (status !== 'CONFIRMED') return { allowed: false, reason: 'STATUS', deadlineMs };
  if (rescheduleCount >= policy.maxReschedules) return { allowed: false, reason: 'LIMIT', deadlineMs };
  return nowMs <= deadlineMs ? { allowed: true, reason: 'OK', deadlineMs } : { allowed: false, reason: 'CUTOFF', deadlineMs };
}

// ------------------------------------------------------------------ idempotent retries

/** Same request => same fingerprint. A retried POST with the same Idempotency-Key returns the original booking. */
export function bookingFingerprint(i: { salonId: string; staffId: string; serviceIds: ReadonlyArray<string>; date: string; time: string; note: string | null }): string {
  const canonical = JSON.stringify([i.salonId, i.staffId, [...i.serviceIds].sort(), i.date, i.time, i.note ?? '']);
  return createHash('sha256').update(canonical).digest('hex');
}
