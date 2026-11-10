/**
 * Phase 5 domain types and PURE rules (no I/O): staff permissions, weekly working hours, breaks,
 * leave periods, invitation expiry and the billing summary. Everything here is unit-tested without a
 * database; the database enforces the same invariants again (CHECK constraints, exclusion constraints,
 * RLS). Times are minutes since midnight on a 5-minute grid, weekdays use ISO numbering (1 = Mon ... 7 = Sun).
 */

/** Granular, salon-level permissions an owner can grant to a staff member. Mirrors the DB CHECK constraint. */
export const STAFF_PERMISSIONS = ['walk_ins.create', 'schedule.manage_own'] as const;
export type StaffPermission = (typeof STAFF_PERMISSIONS)[number];

export const STAFF_LIMITS = {
  /** Recurring breaks per weekday for one staff member. */
  breaksPerDay: 5,
  /** Longest leave period (inclusive days). Mirrors the `staff_leaves_max_span` CHECK. */
  maxLeaveDays: 90,
  /** Upcoming leave rows returned on a profile view. */
  upcomingLeaveLimit: 60,
} as const;

export const INVITATION_TTL_MS = 72 * 60 * 60 * 1000;
export const TIME_GRID_MIN = 5;
export const MINUTES_PER_DAY = 1440;
export const SALON_TIMEZONE = 'Asia/Karachi';

export const WEEKDAY_NAMES: Readonly<Record<number, string>> = {
  1: 'Monday', 2: 'Tuesday', 3: 'Wednesday', 4: 'Thursday', 5: 'Friday', 6: 'Saturday', 7: 'Sunday',
};

export type Result<T> = { ok: true; value: T } | { ok: false; message: string };
const fail = <T = never>(message: string): Result<T> => ({ ok: false, message });
const ok = <T>(value: T): Result<T> => ({ ok: true, value });

export type LeaveStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';

// ------------------------------------------------------------------ time helpers

/** "HH:MM" -> minutes. "24:00" is accepted as an END time only. Must sit on the 5-minute grid. */
export function parseClock(v: unknown, asEnd = false): number | null {
  if (typeof v !== 'string') return null;
  if (asEnd && v === '24:00') return MINUTES_PER_DAY;
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(v);
  if (!m) return null;
  const minutes = Number(m[1]) * 60 + Number(m[2]);
  return minutes % TIME_GRID_MIN === 0 ? minutes : null;
}

export function formatClock(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

// ------------------------------------------------------------------ working hours

export interface HoursInput {
  weekday: number;
  off: boolean;
  startsAt?: string | null;
  endsAt?: string | null;
}

/** Salon opening window of one weekday (from salon_opening_hours). */
export interface SalonWindow {
  weekday: number;
  isClosed: boolean;
  opensMinute: number | null;
  closesMinute: number | null;
}

export interface StaffDayRow {
  weekday: number;
  off: boolean;
  startMinute: number | null;
  endMinute: number | null;
}

/**
 * Exactly seven distinct weekdays. A working day must lie INSIDE the salon's opening window of that
 * weekday: staff cannot be rostered when the salon is closed. Off days carry no times.
 */
export function validateStaffWeek(days: ReadonlyArray<HoursInput>, salon: ReadonlyArray<SalonWindow>): Result<StaffDayRow[]> {
  if (days.length !== 7) return fail('Send working hours for all seven days of the week.');
  const seen = new Set<number>();
  const rows: StaffDayRow[] = [];
  for (const d of [...days].sort((a, b) => a.weekday - b.weekday)) {
    if (!Number.isInteger(d.weekday) || d.weekday < 1 || d.weekday > 7) return fail('Weekday must be between 1 (Monday) and 7 (Sunday).');
    if (seen.has(d.weekday)) return fail('Each weekday may appear only once.');
    seen.add(d.weekday);
    const day = WEEKDAY_NAMES[d.weekday];
    if (d.off) {
      rows.push({ weekday: d.weekday, off: true, startMinute: null, endMinute: null });
      continue;
    }
    const start = parseClock(d.startsAt);
    const end = parseClock(d.endsAt, true);
    if (start === null || end === null) return fail(`${day}: enter start and end times as HH:MM (5-minute steps).`);
    if (end <= start) return fail(`${day}: the end time must be after the start time.`);
    const window = salon.find((w) => w.weekday === d.weekday);
    if (!window || window.isClosed || window.opensMinute === null || window.closesMinute === null) {
      return fail(`${day}: the salon is closed, so staff cannot work that day.`);
    }
    if (start < window.opensMinute || end > window.closesMinute) {
      return fail(`${day}: hours must fall within salon hours (${formatClock(window.opensMinute)}-${formatClock(window.closesMinute)}).`);
    }
    rows.push({ weekday: d.weekday, off: false, startMinute: start, endMinute: end });
  }
  return ok(rows);
}

// ------------------------------------------------------------------ breaks

export interface BreakInput {
  weekday: number;
  startsAt: string;
  endsAt: string;
  label?: string | null;
}

export interface BreakRow {
  weekday: number;
  startMinute: number;
  endMinute: number;
  label: string;
}

/** Breaks must sit inside a working interval of their weekday, must not overlap, max per day. */
export function validateBreaks(breaks: ReadonlyArray<BreakInput>, hours: ReadonlyArray<StaffDayRow>): Result<BreakRow[]> {
  const perDay = new Map<number, BreakRow[]>();
  for (const b of breaks) {
    if (!Number.isInteger(b.weekday) || b.weekday < 1 || b.weekday > 7) return fail('Break weekday must be between 1 and 7.');
    const day = WEEKDAY_NAMES[b.weekday];
    const start = parseClock(b.startsAt);
    const end = parseClock(b.endsAt, true);
    if (start === null || end === null || end <= start) return fail(`${day}: a break needs a valid start and end (HH:MM, 5-minute steps).`);
    const work = hours.find((h) => h.weekday === b.weekday);
    if (!work || work.off || work.startMinute === null || work.endMinute === null) {
      return fail(`${day}: set working hours for this day before adding a break.`);
    }
    if (start < work.startMinute || end > work.endMinute) return fail(`${day}: a break must fall inside working hours.`);
    const label = (b.label ?? '').trim() || 'Break';
    const list = perDay.get(b.weekday) ?? [];
    list.push({ weekday: b.weekday, startMinute: start, endMinute: end, label });
    perDay.set(b.weekday, list);
  }
  const out: BreakRow[] = [];
  for (const [weekday, list] of perDay) {
    const day = WEEKDAY_NAMES[weekday];
    if (list.length > STAFF_LIMITS.breaksPerDay) return fail(`${day}: at most ${STAFF_LIMITS.breaksPerDay} breaks per day.`);
    const sorted = [...list].sort((a, b) => a.startMinute - b.startMinute);
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].startMinute < sorted[i - 1].endMinute) return fail(`${day}: breaks cannot overlap.`);
    }
    out.push(...sorted);
  }
  return ok(out.sort((a, b) => a.weekday - b.weekday || a.startMinute - b.startMinute));
}

/** After a working-hours change: every existing break must still fit inside the new hours. */
export function breaksStillFit(breaks: ReadonlyArray<BreakRow>, hours: ReadonlyArray<StaffDayRow>): string | null {
  for (const b of breaks) {
    const work = hours.find((h) => h.weekday === b.weekday);
    const day = WEEKDAY_NAMES[b.weekday];
    if (!work || work.off || work.startMinute === null || work.endMinute === null) return `${day} has breaks but no working hours.`;
    if (b.startMinute < work.startMinute || b.endMinute > work.endMinute) return `A break on ${day} would fall outside the new working hours.`;
  }
  return null;
}

// ------------------------------------------------------------------ leave

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDate(v: unknown): v is string {
  if (typeof v !== 'string' || !DATE_RE.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/** Inclusive number of days between two ISO dates (same day = 1). */
export function inclusiveDays(startsOn: string, endsOn: string): number {
  const ms = Date.parse(`${endsOn}T00:00:00Z`) - Date.parse(`${startsOn}T00:00:00Z`);
  return Math.round(ms / 86_400_000) + 1;
}

/**
 * Leave periods: valid dates, end on or after start, at most `maxLeaveDays` days, and not already over.
 * Staff requests must also start today or later (owners may record leave that started earlier but still runs).
 */
export function validateLeavePeriod(
  input: { startsOn: unknown; endsOn: unknown },
  today: string,
  opts: { forStaff: boolean },
): Result<{ startsOn: string; endsOn: string; days: number }> {
  if (!isIsoDate(input.startsOn) || !isIsoDate(input.endsOn)) return fail('Dates must be in YYYY-MM-DD format.');
  if (input.endsOn < input.startsOn) return fail('The end date cannot be before the start date.');
  const days = inclusiveDays(input.startsOn, input.endsOn);
  if (days > STAFF_LIMITS.maxLeaveDays) return fail(`A leave period can be at most ${STAFF_LIMITS.maxLeaveDays} days.`);
  if (input.endsOn < today) return fail('This leave has already ended.');
  if (opts.forStaff && input.startsOn < today) return fail('Leave requests must start today or later.');
  return ok({ startsOn: input.startsOn, endsOn: input.endsOn, days });
}

/** Today's calendar date in the salon timezone (Asia/Karachi), as YYYY-MM-DD. */
export function todayInSalonTz(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: SALON_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

// ------------------------------------------------------------------ permissions

/** Validates and normalises a permission list: known keys only, no duplicates, stable order. */
export function normalizePermissions(input: ReadonlyArray<string> | null | undefined): Result<StaffPermission[]> {
  const list = input ?? [];
  const known = new Set<string>(STAFF_PERMISSIONS);
  const unknown = list.filter((p) => !known.has(p));
  if (unknown.length > 0) return fail(`Unknown permission: ${unknown[0]}.`);
  return ok([...new Set(list)].sort() as StaffPermission[]);
}

// ------------------------------------------------------------------ invitations

export function invitationExpiresAt(now: Date): Date {
  return new Date(now.getTime() + INVITATION_TTL_MS);
}

export function isExpired(expiresAt: Date, now: Date): boolean {
  return expiresAt.getTime() <= now.getTime();
}

/** "a***@example.com": enough to recognise the address, never the full value (for public previews). */
export function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at <= 0) return '***';
  const local = email.slice(0, at);
  return `${local.slice(0, 1)}${'*'.repeat(Math.max(2, local.length - 1))}${email.slice(at)}`;
}

// ------------------------------------------------------------------ billing

export interface BillableCandidate {
  isActive: boolean;
  performsServices: boolean;
  isOwner: boolean;
}

/**
 * Subscription basis (Phase 6 bills it): only ACTIVE staff who PERFORM services are billable. The owner
 * is one row like everyone else, so an owner who also works counts exactly once; an owner who only
 * manages the business is not billable. Inactive and deleted profiles never count.
 */
export function billingSummary(staff: ReadonlyArray<BillableCandidate>) {
  let billableStaff = 0;
  let activeNonPerforming = 0;
  let inactive = 0;
  for (const s of staff) {
    if (!s.isActive) inactive++;
    else if (s.performsServices) billableStaff++;
    else activeNonPerforming++;
  }
  const ownerBillable = staff.some((s) => s.isOwner && s.isActive && s.performsServices);
  return { billableStaff, activeNonPerforming, inactive, ownerBillable };
}
