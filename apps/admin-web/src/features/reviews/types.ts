/** Phase 14: review moderation types and small pure helpers (no I/O). Mirrors the API contract of /admin/reviews. */
export type ReviewStatus = 'PUBLISHED' | 'HIDDEN';
export type ReportStatus = 'OPEN' | 'DISMISSED' | 'ACTIONED';
export type ReportReason = 'OFFENSIVE' | 'SPAM' | 'FAKE' | 'PRIVATE_INFO' | 'OTHER';

export const REASON_LABEL: Record<ReportReason, string> = {
  OFFENSIVE: 'Offensive or abusive', SPAM: 'Spam or advertising', FAKE: 'Fake or not a real visit', PRIVATE_INFO: 'Contains private information', OTHER: 'Other',
};

export interface AdminReview {
  id: string;
  salon: { id: string; name: string };
  staff: { id: string; name: string | null };
  authorName: string;
  visitAt: string | null;
  rating: number;
  staffRating: number | null;
  comment: string | null;
  services: Array<{ serviceId: string; name: string; rating: number }>;
  status: ReviewStatus;
  hiddenReason: string | null;
  hiddenAt: string | null;
  response: { text: string; at: string | null } | null;
  openReport: { id: string; reason: ReportReason; createdAt: string } | null;
  createdAt: string;
  edited: boolean;
}

export interface AdminReport {
  id: string;
  salonId: string;
  salonName: string;
  reviewId: string;
  reason: ReportReason;
  details: string | null;
  status: ReportStatus;
  resolutionNote: string | null;
  resolvedAt: string | null;
  createdAt: string;
  review?: { authorName: string; salonRating: number; staffRating: number | null; comment: string | null; status: ReviewStatus; staffName: string | null };
}

export interface Paged<T> { items: T[]; page: number; pageSize: number; total: number; hasMore: boolean }
export interface Counts { openReports: number; hidden: number; published: number }

/** "★★★★☆" for screen text; the numeric value is always shown next to it. Out-of-range values are clamped. */
export function stars(rating: number | null | undefined): string {
  if (rating === null || rating === undefined || !Number.isFinite(rating)) return '-';
  const n = Math.max(0, Math.min(5, Math.round(rating)));
  return '★'.repeat(n) + '☆'.repeat(5 - n);
}

export const pagesOf = (total: number, pageSize: number): number => Math.max(1, Math.ceil(total / Math.max(1, pageSize)));

const FORMAT = new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Karachi' });
export function when(iso: string | null | undefined): string {
  if (!iso) return '-';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '-' : FORMAT.format(d);
}

/** The reason a moderator types must be 3-300 characters after trimming (the API enforces the same). */
export const reasonError = (value: string): string | null => {
  const t = value.trim();
  if (t.length < 3) return 'Write a short reason (at least 3 characters).';
  if (t.length > 300) return 'The reason can have at most 300 characters.';
  if (/[<>]/.test(t)) return 'The reason cannot contain < or >.';
  return null;
};
