/** Pure helpers for the analytics page (unit-tested in format.test.ts). */

/** "2026-11" -> "Nov 26" (no time-zone shifts: the month is parsed as text). */
export function monthLabel(month: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) return month;
  const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const idx = Number(m[2]) - 1;
  return idx >= 0 && idx < 12 ? `${names[idx]} ${m[1].slice(2)}` : month;
}

/** Percentage or a dash when there is nothing to divide by. */
export const pctText = (v: number | null | undefined): string => (v === null || v === undefined ? '-' : `${v}%`);

/** Whole-number grouping: 12345 -> "12,345". */
export const num = (n: number): string => String(Math.trunc(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/** Calendar date (YYYY-MM-DD) of `today` minus `days`, using the local clock of the browser. */
export function isoDaysAgo(today: Date, days: number): string {
  const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** "Last N days" ends today and starts N-1 days ago (inclusive, so it is exactly N days). */
export function presetRange(today: Date, days: number): { from: string; to: string } {
  return { from: isoDaysAgo(today, days - 1), to: isoDaysAgo(today, 0) };
}

/** Largest value of a series, never below 1 (so an all-zero chart does not divide by zero). */
export const seriesMax = (values: ReadonlyArray<number>): number => Math.max(1, ...values);

/** Bar height in percent of the plot (0-100). A non-zero value always gets at least 2% so it stays visible. */
export function barPct(value: number, max: number): number {
  if (value <= 0 || max <= 0) return 0;
  return Math.max(2, Math.min(100, (value / max) * 100));
}

/** Money text ("1234.50") as a plain number for chart HEIGHTS only. Never use it for arithmetic that is shown as money. */
export const moneyToNumber = (v: string): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
