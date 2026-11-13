import { formatHm } from '../salons/opening-hours';

/**
 * Phase 7 pure rules (no I/O): search limits, bounding box for nearby search, and the availability PREVIEW engine.
 *
 * The preview answers "when could someone be here?" from salon opening hours, staff working hours, recurring breaks and
 * approved leave. It deliberately takes `busy` spans (appointments) as an input: Phase 8 passes the booked intervals
 * (plus buffer) so the SAME function becomes the real slot engine. Today nothing can be booked yet, so busy is empty.
 * A preview is never a promise: only the booking transaction (Phase 8) confirms a slot.
 */
export const DISCOVERY_LIMITS = {
  defaultPageSize: 20,
  maxPageSize: 30,
  defaultRadiusKm: 10,
  maxRadiusKm: 100,
  /** Days ahead (including today) that availability can be previewed. */
  horizonDays: 14,
  slotStepMinutes: 15,
  maxServicesPerPreview: 10,
  maxPrice: 1_000_000,
} as const;

/** Supported sort orders. "highest rating" (Phase 14), "most popular" and "earliest available" (Phase 8) need data that does not exist yet and are not offered. */
export const DISCOVERY_SORTS = ['nearest', 'price_low', 'newest', 'name'] as const;
export type DiscoverySort = (typeof DISCOVERY_SORTS)[number];

// ------------------------------------------------------------------ nearby search

export interface BoundingBox {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
}

/** A box that surely contains the circle: used as an index-friendly prefilter before the exact PostGIS distance. */
export function boundingBox(lat: number, lng: number, radiusKm: number): BoundingBox {
  const kmPerDegree = 111.32;
  const dLat = radiusKm / kmPerDegree;
  const dLng = radiusKm / (kmPerDegree * Math.max(Math.cos((lat * Math.PI) / 180), 0.01));
  return {
    minLat: Math.max(-90, lat - dLat),
    maxLat: Math.min(90, lat + dLat),
    minLng: Math.max(-180, lng - dLng),
    maxLng: Math.min(180, lng + dLng),
  };
}

/** Metres -> kilometres with one decimal; null stays null. */
export const distanceKm = (metres: number | null): number | null => (metres === null ? null : Math.round(metres / 100) / 10);

// ------------------------------------------------------------------ dates and minutes (Asia/Karachi, no DST)

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDateText(v: unknown): v is string {
  if (typeof v !== 'string' || !ISO_DATE.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/** ISO weekday: 1 = Monday ... 7 = Sunday. */
export function isoWeekday(date: string): number {
  const d = new Date(`${date}T00:00:00Z`).getUTCDay();
  return d === 0 ? 7 : d;
}

export function addDaysIso(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Minutes since midnight in Karachi (UTC+5, Pakistan has no daylight saving time). */
export function karachiMinute(now: Date): number {
  const t = new Date(now.getTime() + 5 * 3_600_000);
  return t.getUTCHours() * 60 + t.getUTCMinutes();
}

/** "HH:MM" (24 h, never 24:00) -> minutes, else null. */
export function parseClock(v: unknown): number | null {
  if (typeof v !== 'string') return null;
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(v);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

// ------------------------------------------------------------------ availability preview

/** Half-open interval of minutes since midnight: [start, end). */
export interface Span {
  start: number;
  end: number;
}

/** Weekday (1-7) -> working interval, or null when closed / off that day. */
export type WeekSpans = Readonly<Record<number, Span | null | undefined>>;

export interface StaffWeek {
  staffId: string;
  name: string;
  hours: WeekSpans;
  /** Recurring weekly breaks by weekday. */
  breaks: Readonly<Record<number, ReadonlyArray<Span> | undefined>>;
  /** APPROVED leave, whole days, both ends inclusive (YYYY-MM-DD). */
  leaves: ReadonlyArray<{ startsOn: string; endsOn: string }>;
}

/** `base` minus every `cuts` interval. Result is sorted and has no empty or overlapping spans. */
export function subtractSpans(base: ReadonlyArray<Span>, cuts: ReadonlyArray<Span>): Span[] {
  const sortedCuts = [...cuts].filter((c) => c.end > c.start).sort((a, b) => a.start - b.start);
  let out: Span[] = base.filter((b) => b.end > b.start).map((b) => ({ ...b }));
  for (const c of sortedCuts) {
    const next: Span[] = [];
    for (const s of out) {
      if (c.end <= s.start || c.start >= s.end) {
        next.push(s);
        continue;
      }
      if (c.start > s.start) next.push({ start: s.start, end: c.start });
      if (c.end < s.end) next.push({ start: c.end, end: s.end });
    }
    out = next;
  }
  return out.sort((a, b) => a.start - b.start);
}

/** When is this staff member free on `date`? Salon hours AND staff hours, minus breaks, leave and busy time. */
export function freeSpans(date: string, salon: WeekSpans, staff: StaffWeek, busy: ReadonlyArray<Span> = []): Span[] {
  if (staff.leaves.some((l) => date >= l.startsOn && date <= l.endsOn)) return [];
  const weekday = isoWeekday(date);
  const open = salon[weekday];
  const work = staff.hours[weekday];
  if (!open || !work) return [];
  const start = Math.max(open.start, work.start);
  const end = Math.min(open.end, work.end);
  if (end <= start) return [];
  return subtractSpans([{ start, end }], [...(staff.breaks[weekday] ?? []), ...busy]);
}

/** Start times (minutes) where a service of `durationMin` fits, on a grid anchored at each free span's start. */
export function slotStarts(spans: ReadonlyArray<Span>, durationMin: number, stepMin: number, notBefore = 0): number[] {
  const out: number[] = [];
  if (durationMin <= 0 || stepMin <= 0) return out;
  for (const sp of spans) {
    const from = Math.max(sp.start, notBefore);
    const first = sp.start + Math.ceil((from - sp.start) / stepMin) * stepMin;
    for (let t = first; t + durationMin <= sp.end; t += stepMin) out.push(t);
  }
  return out;
}

/** Earliest minute today that can still be started: now, rounded up to the next 5 minutes. */
export const notBeforeToday = (nowMinute: number): number => Math.ceil(nowMinute / 5) * 5;

export interface NextAvailable {
  date: string;
  /** "HH:MM" */
  time: string;
}

/** First start time over the next `horizonDays` days for ANY of the given staff. Null when none in the horizon. */
export function nextAvailable(
  salon: WeekSpans,
  staff: ReadonlyArray<StaffWeek>,
  durationMin: number,
  today: string,
  nowMinute: number,
  horizonDays: number = DISCOVERY_LIMITS.horizonDays,
  stepMin: number = DISCOVERY_LIMITS.slotStepMinutes,
): NextAvailable | null {
  for (let i = 0; i < horizonDays; i += 1) {
    const date = addDaysIso(today, i);
    const notBefore = i === 0 ? notBeforeToday(nowMinute) : 0;
    let best: number | null = null;
    for (const s of staff) {
      const starts = slotStarts(freeSpans(date, salon, s), durationMin, stepMin, notBefore);
      if (starts.length > 0 && (best === null || starts[0] < best)) best = starts[0];
    }
    if (best !== null) return { date, time: formatHm(best) };
  }
  return null;
}

/** Sum of decimal money strings, exact to the paisa (no floating point drift). */
export function sumMoney(values: ReadonlyArray<string>): string {
  const paisa = values.reduce((acc, v) => acc + Math.round(Number(v) * 100), 0);
  return (paisa / 100).toFixed(2);
}

/** "300.00" style text from a numeric database value. */
export const moneyOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : Number(v).toFixed(2));
