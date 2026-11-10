/**
 * Opening hours: one entry per weekday, ISO numbering (1 = Monday ... 7 = Sunday), stored as minutes since
 * midnight. Same-day intervals only: the closing time must be after the opening time ("24:00" is allowed).
 * Pure functions (no I/O) so the rules are unit-tested without a database.
 */
export const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;

export interface DayHours {
  weekday: number;
  closed: boolean;
  /** "HH:MM" (24 h), null when closed. */
  opensAt: string | null;
  closesAt: string | null;
}

export interface HourRow {
  weekday: number;
  isClosed: boolean;
  opensMinute: number | null;
  closesMinute: number | null;
}

/** "HH:MM" -> minutes since midnight; "24:00" -> 1440. Null when malformed. */
export function parseHm(v: unknown): number | null {
  if (typeof v !== 'string') return null;
  if (v === '24:00') return 1440;
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(v);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

export function formatHm(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export type WeekValidation = { ok: true; rows: HourRow[] } | { ok: false; message: string };

/** Exactly seven distinct weekdays; closed days carry no times; open days need opens < closes. */
export function validateWeek(days: ReadonlyArray<{ weekday: number; closed: boolean; opensAt?: string | null; closesAt?: string | null }>): WeekValidation {
  if (days.length !== 7) return { ok: false, message: 'Provide opening hours for all seven days of the week.' };
  const seen = new Set<number>();
  const rows: HourRow[] = [];
  for (const d of days) {
    if (!Number.isInteger(d.weekday) || d.weekday < 1 || d.weekday > 7) return { ok: false, message: 'weekday must be 1 (Monday) to 7 (Sunday).' };
    if (seen.has(d.weekday)) return { ok: false, message: 'Each weekday may appear only once.' };
    seen.add(d.weekday);
    if (d.closed) {
      if (d.opensAt != null || d.closesAt != null) return { ok: false, message: 'A closed day must not have opening or closing times.' };
      rows.push({ weekday: d.weekday, isClosed: true, opensMinute: null, closesMinute: null });
      continue;
    }
    const open = parseHm(d.opensAt);
    const close = parseHm(d.closesAt);
    if (open === null || close === null) return { ok: false, message: 'Open days need opening and closing times as HH:MM.' };
    if (open > 1439) return { ok: false, message: 'The opening time must be before 24:00.' };
    if (close <= open) return { ok: false, message: 'The closing time must be after the opening time (overnight hours are not supported).' };
    rows.push({ weekday: d.weekday, isClosed: false, opensMinute: open, closesMinute: close });
  }
  rows.sort((a, b) => a.weekday - b.weekday);
  return { ok: true, rows };
}

/** Always returns seven days; weekdays without a row are reported as closed. */
export function weekFromRows(rows: ReadonlyArray<HourRow>): DayHours[] {
  const byDay = new Map(rows.map((r) => [r.weekday, r]));
  return WEEKDAYS.map((weekday) => {
    const r = byDay.get(weekday);
    if (!r || r.isClosed || r.opensMinute === null || r.closesMinute === null) return { weekday, closed: true, opensAt: null, closesAt: null };
    return { weekday, closed: false, opensAt: formatHm(r.opensMinute), closesAt: formatHm(r.closesMinute) };
  });
}
