/**
 * Phase 10 pure rules: which notifications exist, which preference switch controls them, when a reminder is due, how a failed
 * event is retried, and how times are written for people in Pakistan. Nothing here touches a database, the network or the clock
 * (the callers pass `now`), so everything is unit-tested (notification.types.spec.ts).
 */

/** What the database outbox calls a fact. One fact can become different notifications for different people. */
export const EVENT_KINDS = [
  'BOOKING_CREATED', 'BOOKING_CANCELLED', 'BOOKING_RESCHEDULED', 'SERVICE_COMPLETED', 'NO_SHOW_RECORDED', 'DELAY_NOTICE',
  'ARRIVAL_UPDATE', 'EARLY_OFFER', 'EARLY_RESPONSE', 'APPOINTMENT_REMINDER', 'SALON_STATUS', 'PAYMENT_DECISION',
  'SUBSCRIPTION_NOTICE', 'STAFF_JOINED', 'STAFF_SCHEDULE',
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

/** What a person actually receives (the template key). */
export const NOTIFICATION_TYPES = [
  'BOOKING_CONFIRMED', 'BOOKING_NEW', 'BOOKING_CANCELLED_SALON', 'BOOKING_CANCELLED_STAFF', 'BOOKING_RESCHEDULED',
  'APPOINTMENT_REMINDER', 'EARLY_OFFER', 'EARLY_ACCEPTED', 'EARLY_DECLINED', 'ARRIVAL_ON_THE_WAY', 'ARRIVAL_RUNNING_LATE',
  'DELAY_NOTICE', 'SERVICE_COMPLETED', 'NO_SHOW_RECORDED',
  'SALON_APPROVED', 'SALON_REJECTED', 'SALON_SUSPENDED', 'SALON_REACTIVATED',
  'PAYMENT_APPROVED', 'PAYMENT_REJECTED', 'PAYMENT_NEEDS_INFO', 'SUBSCRIPTION_EXPIRING', 'SUBSCRIPTION_EXPIRED',
  'STAFF_JOINED', 'STAFF_SCHEDULE_UPDATED',
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

/** The preference switches. ACCOUNT has no switch: salon approval, payments and subscription notices are essential. */
export type Category = 'BOOKINGS' | 'REMINDERS' | 'QUEUE' | 'TEAM' | 'ACCOUNT';

export const CATEGORY_OF: Record<NotificationType, Category> = {
  BOOKING_CONFIRMED: 'BOOKINGS', BOOKING_NEW: 'BOOKINGS', BOOKING_CANCELLED_SALON: 'BOOKINGS', BOOKING_CANCELLED_STAFF: 'BOOKINGS',
  BOOKING_RESCHEDULED: 'BOOKINGS', SERVICE_COMPLETED: 'BOOKINGS', NO_SHOW_RECORDED: 'BOOKINGS',
  APPOINTMENT_REMINDER: 'REMINDERS',
  EARLY_OFFER: 'QUEUE', EARLY_ACCEPTED: 'QUEUE', EARLY_DECLINED: 'QUEUE', ARRIVAL_ON_THE_WAY: 'QUEUE', ARRIVAL_RUNNING_LATE: 'QUEUE', DELAY_NOTICE: 'QUEUE',
  STAFF_JOINED: 'TEAM', STAFF_SCHEDULE_UPDATED: 'TEAM',
  SALON_APPROVED: 'ACCOUNT', SALON_REJECTED: 'ACCOUNT', SALON_SUSPENDED: 'ACCOUNT', SALON_REACTIVATED: 'ACCOUNT',
  PAYMENT_APPROVED: 'ACCOUNT', PAYMENT_REJECTED: 'ACCOUNT', PAYMENT_NEEDS_INFO: 'ACCOUNT', SUBSCRIPTION_EXPIRING: 'ACCOUNT', SUBSCRIPTION_EXPIRED: 'ACCOUNT',
};

/** Where the app should go when the notification is tapped. The apps map these hints to their own screens. */
export type Route = 'booking' | 'queue' | 'salon' | 'billing' | 'team' | 'schedule';

export const LANGUAGES = ['en', 'ur'] as const;
export type Language = (typeof LANGUAGES)[number];

/** Minutes before the appointment (0 = at the appointment time: "please leave for the salon"). */
export const REMINDER_OFFSETS = [30, 20, 10, 0] as const;
export type ReminderOffset = (typeof REMINDER_OFFSETS)[number];

export interface Preferences {
  pushEnabled: boolean;
  language: Language;
  bookings: boolean;
  reminders: boolean;
  queue: boolean;
  team: boolean;
  reminderOffsets: number[];
}

export const DEFAULT_PREFERENCES: Preferences = {
  pushEnabled: true,
  language: 'en',
  bookings: true,
  reminders: true,
  queue: true,
  team: true,
  reminderOffsets: [...REMINDER_OFFSETS],
};

export const NOTIFICATION_LIMITS = {
  inboxPageSize: 30,
  inboxMaxPageSize: 50,
  /// A person keeps at most this many active devices; the least recently used are switched off.
  maxDevicesPerUser: 10,
  /// Events claimed per tick.
  claimBatch: 50,
  /// A round drains at most this many batches (a safety limit; the next round continues).
  maxBatchesPerTick: 10,
  /// A claimed event that is not finished within this time is claimed again (a crashed worker never loses an event).
  lockSeconds: 120,
  /// After this many tries an event is DEAD (kept for support, never retried).
  maxAttempts: 5,
  /// A reminder is still sent if the worker was late by at most this long (never after the appointment for "before" reminders).
  reminderLateToleranceMs: 5 * 60_000,
  /// Sweepers look this far ahead / back.
  reminderLookAheadMinutes: 31,
  reminderLookBackHours: 3,
  /// Delay notices: at most one per appointment per window, unless the forecast moved by at least `delayRenotifyDeltaMs`.
  delayThrottleMs: 10 * 60_000,
  delayRenotifyDeltaMs: 15 * 60_000,
  /// A staff member is told about schedule changes at most once per window (the app shows the current schedule anyway).
  scheduleThrottleMs: 10 * 60_000,
  /// Subscription expiry warnings are sent this many days before the paid period ends.
  subscriptionWarnDays: [7, 3, 1] as readonly number[],
  /// Retention (data-retention policy, section 20.5 of the brief).
  retainEventsDays: 30,
  retainNotificationsDays: 180,
  retainDevicesDays: 90,
  /// Sweepers that scan business tables run at most this often (they are idempotent, this only saves work).
  subscriptionSweepEveryMs: 10 * 60_000,
  purgeEveryMs: 60 * 60_000,
} as const;

// ------------------------------------------------------------------ preferences

export function allowsType(prefs: Preferences, type: NotificationType): boolean {
  switch (CATEGORY_OF[type]) {
    case 'BOOKINGS': return prefs.bookings;
    case 'REMINDERS': return prefs.reminders;
    case 'QUEUE': return prefs.queue;
    case 'TEAM': return prefs.team;
    default: return true; // ACCOUNT: essential, no switch
  }
}

/** Normalises a list of reminder offsets: only the allowed values, no duplicates, largest first. */
export function normaliseOffsets(input: readonly number[]): number[] {
  const allowed = new Set<number>(REMINDER_OFFSETS);
  return [...new Set(input.filter((n) => Number.isInteger(n) && allowed.has(n)))].sort((a, b) => b - a);
}

// ------------------------------------------------------------------ reminders

/**
 * Is the reminder `offsetMinutes` before the (effective) start due now?
 * Due from `start - offset` until the worker-lateness tolerance has passed. A "before" reminder (offset > 0) is never sent once the
 * appointment has started; the "now" reminder (offset 0) may be a few minutes late.
 */
export function reminderDue(startMs: number, offsetMinutes: number, nowMs: number): boolean {
  const dueMs = startMs - offsetMinutes * 60_000;
  if (nowMs < dueMs) return false;
  if (nowMs - dueMs > NOTIFICATION_LIMITS.reminderLateToleranceMs) return false;
  if (offsetMinutes > 0 && nowMs >= startMs) return false;
  return true;
}

/** The time a reminder is about: the salon's forecast when the day runs late, else the booked time. */
export const effectiveStartMs = (startsAt: Date, estimatedStartsAt: Date | null): number =>
  Math.max(startsAt.getTime(), estimatedStartsAt ? estimatedStartsAt.getTime() : 0);

/** Idempotency key of one reminder: once per appointment, booked time and offset (moving the booking makes new reminders valid). */
export const reminderDedupeKey = (appointmentId: string, startsAtMs: number, offsetMinutes: number): string =>
  `reminder:${appointmentId}:${Math.floor(startsAtMs / 1000)}:${offsetMinutes}`;

// ------------------------------------------------------------------ retry

/** Backoff after the n-th failed attempt (1-based): 30 s, 2 min, 10 min, 30 min, 2 h. */
export function retryDelayMs(attempt: number): number {
  const steps = [30_000, 120_000, 600_000, 1_800_000, 7_200_000];
  return steps[Math.min(Math.max(attempt, 1), steps.length) - 1];
}

export const isLastAttempt = (attempts: number): boolean => attempts >= NOTIFICATION_LIMITS.maxAttempts;

// ------------------------------------------------------------------ delay throttle

/** Should a delay notice be skipped because the customer was told recently and the forecast has not moved much? */
export function throttleDelayNotice(last: { createdAtMs: number; estimateMs: number | null } | null, newEstimateMs: number, nowMs: number): boolean {
  if (!last) return false;
  if (nowMs - last.createdAtMs >= NOTIFICATION_LIMITS.delayThrottleMs) return false;
  if (last.estimateMs !== null && Math.abs(newEstimateMs - last.estimateMs) >= NOTIFICATION_LIMITS.delayRenotifyDeltaMs) return false;
  return true;
}

// ------------------------------------------------------------------ Karachi time labels (UTC+5, no daylight saving)

const KARACHI_OFFSET_MS = 5 * 3_600_000;
const EN_WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const EN_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const UR_WEEKDAYS = ['اتوار', 'پیر', 'منگل', 'بدھ', 'جمعرات', 'جمعہ', 'ہفتہ'];
const UR_MONTHS = ['جنوری', 'فروری', 'مارچ', 'اپریل', 'مئی', 'جون', 'جولائی', 'اگست', 'ستمبر', 'اکتوبر', 'نومبر', 'دسمبر'];

export interface KarachiParts {
  year: number;
  month: number;
  day: number;
  weekday: number;
  hour: number;
  minute: number;
}

export function karachiParts(ms: number): KarachiParts {
  const d = new Date(ms + KARACHI_OFFSET_MS);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth(), day: d.getUTCDate(), weekday: d.getUTCDay(), hour: d.getUTCHours(), minute: d.getUTCMinutes() };
}

/** "3:05 PM" (English) or "دوپہر 3:05" (Urdu: morning / afternoon / evening / night word in front). */
export function timeLabel(ms: number, lang: Language): string {
  const p = karachiParts(ms);
  const mm = String(p.minute).padStart(2, '0');
  const h12 = p.hour % 12 === 0 ? 12 : p.hour % 12;
  if (lang === 'en') return `${h12}:${mm} ${p.hour < 12 ? 'AM' : 'PM'}`;
  const part = p.hour < 12 ? 'صبح' : p.hour < 16 ? 'دوپہر' : p.hour < 20 ? 'شام' : 'رات';
  return `${part} ${h12}:${mm}`;
}

/** "Mon 16 Nov" / "پیر 16 نومبر". */
export function dateLabel(ms: number, lang: Language): string {
  const p = karachiParts(ms);
  return lang === 'en' ? `${EN_WEEKDAYS[p.weekday]} ${p.day} ${EN_MONTHS[p.month]}` : `${UR_WEEKDAYS[p.weekday]} ${p.day} ${UR_MONTHS[p.month]}`;
}

/** "Mon 16 Nov, 3:05 PM". */
export const whenLabel = (ms: number, lang: Language): string => `${dateLabel(ms, lang)}${lang === 'en' ? ',' : '،'} ${timeLabel(ms, lang)}`;

/** Karachi calendar date "YYYY-MM-DD" of an instant. */
export function karachiIsoDate(ms: number): string {
  const p = karachiParts(ms);
  return `${p.year}-${String(p.month + 1).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** Label of a "YYYY-MM-DD" date. */
export function isoDateLabel(iso: string, lang: Language): string {
  const [y, m, d] = iso.split('-').map(Number);
  return dateLabel(Date.UTC(y, m - 1, d, 12) - KARACHI_OFFSET_MS, lang);
}

// ------------------------------------------------------------------ text hygiene

/** Names and reasons typed by people are shortened and stripped of control characters before they go into a message. */
export function clean(value: string | null | undefined, max: number): string {
  const s = (value ?? '').replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim();
  return s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/** Types a person may receive about their OWN action (everything else never goes to whoever caused the fact). */
export const SELF_NOTICE_TYPES: ReadonlySet<NotificationType> = new Set<NotificationType>(['BOOKING_CONFIRMED']);
