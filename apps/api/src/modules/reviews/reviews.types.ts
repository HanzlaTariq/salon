/**
 * Phase 14 pure rules (no I/O): limits, rating maths, display names, text clean-up and the review / edit windows.
 * The database repeats the important ones (30-day review window, 7-day edit window, one review per appointment) in
 * `reviews_guard()`; these helpers exist so the API can answer with a clear message and the apps can show the same numbers.
 */
export const REVIEW_LIMITS = {
  commentMax: 1000,
  responseMax: 500,
  reportDetailsMax: 500,
  hiddenReasonMin: 3,
  hiddenReasonMax: 300,
  noteMax: 300,
  /** A customer can review an appointment up to this many days after it was completed. */
  reviewWindowDays: 30,
  /** A customer can edit a review up to this many days after writing it. */
  editWindowDays: 7,
  defaultPageSize: 20,
  maxPageSize: 50,
  maxServiceRatings: 10,
  favouritesMax: 200,
  customersPageSize: 20,
  historyAppointments: 50,
} as const;

export const REVIEW_SORTS = ['recent', 'highest', 'lowest'] as const;
export type ReviewSort = (typeof REVIEW_SORTS)[number];

export const REVIEW_STATUSES = ['PUBLISHED', 'HIDDEN'] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

export const REPORT_REASONS = ['OFFENSIVE', 'SPAM', 'FAKE', 'PRIVATE_INFO', 'OTHER'] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

export const REPORT_STATUSES = ['OPEN', 'DISMISSED', 'ACTIONED'] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

export const REPORT_ACTIONS = ['DISMISS', 'HIDE_REVIEW'] as const;
export type ReportAction = (typeof REPORT_ACTIONS)[number];

export const CUSTOMER_SORTS = ['recent', 'visits', 'spent'] as const;
export type CustomerSort = (typeof CUSTOMER_SORTS)[number];

const DAY_MS = 86_400_000;

// ------------------------------------------------------------------ text

/** Control characters (except tab / line breaks) and angle brackets never belong in review text. */
const UNSAFE_TEXT = /[<>\u0000-\u0008\u000B\u000C\u000E-\u001F]/;

/** Trims, normalises line breaks, collapses 3+ blank lines. Returns null for empty text. Throws nothing: validation is separate. */
export function cleanText(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const text = value.replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return text.length === 0 ? null : text;
}

export const hasUnsafeText = (value: string): boolean => UNSAFE_TEXT.test(value);

/**
 * "Sara Khan" -> "Sara K.", "Sara" -> "Sara". The full name of a customer is never shown to other people.
 * Anything that is not a letter, digit, space, dot, hyphen or apostrophe is dropped (no markup can enter a name).
 */
export function authorName(fullName: string | null | undefined): string {
  const cleaned = (fullName ?? '').replace(/[^\p{L}\p{N} .'-]/gu, ' ').replace(/\s+/g, ' ').trim();
  if (!cleaned) return 'Customer';
  const parts = cleaned.split(' ').filter(Boolean);
  const first = parts[0].slice(0, 30);
  if (parts.length === 1) return first;
  const initial = Array.from(parts[parts.length - 1])[0]?.toUpperCase();
  return initial ? `${first} ${initial}.` : first;
}

// ------------------------------------------------------------------ ratings

export const isRating = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 5;

export type Stars = readonly [number, number, number, number, number];
export interface RatingSummary {
  /** Average with two decimals (e.g. 4.33); null when there is no review. */
  average: number | null;
  count: number;
  /** Number of reviews per star, keys "1" to "5". */
  distribution: Record<'1' | '2' | '3' | '4' | '5', number>;
}

/** Same maths as the generated columns in the database (round half up to two decimals). */
export function summarise(stars: Stars): RatingSummary {
  const count = stars.reduce((a, b) => a + b, 0);
  const sum = stars.reduce((a, n, i) => a + n * (i + 1), 0);
  return {
    average: count === 0 ? null : Math.round((sum / count) * 100 + 1e-9) / 100,
    count,
    distribution: { '1': stars[0], '2': stars[1], '3': stars[2], '4': stars[3], '5': stars[4] },
  };
}

export const EMPTY_STARS: Stars = [0, 0, 0, 0, 0];

// ------------------------------------------------------------------ windows

/** Can a customer still write a review for a visit that finished at `completedAt`? */
export function reviewWindow(completedAt: Date, now: Date): { open: boolean; closesAt: Date } {
  const closesAt = new Date(completedAt.getTime() + REVIEW_LIMITS.reviewWindowDays * DAY_MS);
  return { open: completedAt.getTime() <= now.getTime() && now.getTime() <= closesAt.getTime(), closesAt };
}

/** Can the author still edit a review that was written at `createdAt`? */
export function editWindow(createdAt: Date, now: Date): { open: boolean; closesAt: Date } {
  const closesAt = new Date(createdAt.getTime() + REVIEW_LIMITS.editWindowDays * DAY_MS);
  return { open: now.getTime() <= closesAt.getTime(), closesAt };
}
