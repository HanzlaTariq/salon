import {
  CATEGORY_OF, DEFAULT_PREFERENCES, NOTIFICATION_LIMITS, NOTIFICATION_TYPES, allowsType, clean, dateLabel, effectiveStartMs, isLastAttempt, karachiIsoDate,
  normaliseOffsets, reminderDedupeKey, reminderDue, retryDelayMs, throttleDelayNotice, timeLabel, whenLabel,
} from './notification.types';

const MIN = 60_000;
// Monday 16 November 2026, 15:05 in Karachi = 10:05 UTC.
const T = Date.UTC(2026, 10, 16, 10, 5);

describe('Phase 10 rules: categories and preferences', () => {
  it('every notification type has a category', () => {
    for (const t of NOTIFICATION_TYPES) expect(CATEGORY_OF[t]).toBeDefined();
  });
  it('a switched-off category blocks its types, but ACCOUNT notices have no switch', () => {
    const off = { ...DEFAULT_PREFERENCES, bookings: false, reminders: false, queue: false, team: false };
    expect(allowsType(off, 'BOOKING_CONFIRMED')).toBe(false);
    expect(allowsType(off, 'APPOINTMENT_REMINDER')).toBe(false);
    expect(allowsType(off, 'DELAY_NOTICE')).toBe(false);
    expect(allowsType(off, 'STAFF_SCHEDULE_UPDATED')).toBe(false);
    expect(allowsType(off, 'SALON_APPROVED')).toBe(true);
    expect(allowsType(off, 'PAYMENT_REJECTED')).toBe(true);
    expect(allowsType(off, 'SUBSCRIPTION_EXPIRED')).toBe(true);
  });
  it('reminder offsets keep only 30/20/10/0, without duplicates, largest first', () => {
    expect(normaliseOffsets([0, 10, 10, 45, -1, 30, 20.5])).toEqual([30, 10, 0]);
    expect(normaliseOffsets([])).toEqual([]);
  });
});

describe('Phase 10 rules: reminders', () => {
  it('a reminder is due from start - offset until the lateness tolerance has passed', () => {
    expect(reminderDue(T, 30, T - 31 * MIN)).toBe(false);
    expect(reminderDue(T, 30, T - 30 * MIN)).toBe(true);
    expect(reminderDue(T, 30, T - 26 * MIN)).toBe(true);
    expect(reminderDue(T, 30, T - 24 * MIN)).toBe(false); // the worker was more than 5 minutes late: stale
  });
  it('a "before" reminder is never sent once the appointment has started; the "now" reminder may be a little late', () => {
    expect(reminderDue(T, 10, T)).toBe(false);
    expect(reminderDue(T, 0, T)).toBe(true);
    expect(reminderDue(T, 0, T + 4 * MIN)).toBe(true);
    expect(reminderDue(T, 0, T + 6 * MIN)).toBe(false);
  });
  it('the effective start is the later of the booked time and the salon forecast', () => {
    expect(effectiveStartMs(new Date(T), null)).toBe(T);
    expect(effectiveStartMs(new Date(T), new Date(T + 15 * MIN))).toBe(T + 15 * MIN);
  });
  it('the reminder key changes when the booking is moved or the offset differs', () => {
    expect(reminderDedupeKey('a', T, 30)).toBe(reminderDedupeKey('a', T, 30));
    expect(reminderDedupeKey('a', T, 30)).not.toBe(reminderDedupeKey('a', T, 20));
    expect(reminderDedupeKey('a', T, 30)).not.toBe(reminderDedupeKey('a', T + 600_000, 30));
  });
});

describe('Phase 10 rules: retry and throttles', () => {
  it('backs off 30 s, 2 min, 10 min, 30 min, 2 h and then stays at 2 h', () => {
    expect([1, 2, 3, 4, 5, 9].map(retryDelayMs)).toEqual([30_000, 120_000, 600_000, 1_800_000, 7_200_000, 7_200_000]);
  });
  it('the last attempt is the fifth', () => {
    expect(isLastAttempt(NOTIFICATION_LIMITS.maxAttempts - 1)).toBe(false);
    expect(isLastAttempt(NOTIFICATION_LIMITS.maxAttempts)).toBe(true);
  });
  it('a second delay notice within 10 minutes is skipped unless the forecast moved by 15 minutes or more', () => {
    const last = { createdAtMs: T, estimateMs: T + 10 * MIN };
    expect(throttleDelayNotice(null, T + 20 * MIN, T)).toBe(false);
    expect(throttleDelayNotice(last, T + 15 * MIN, T + 5 * MIN)).toBe(true);
    expect(throttleDelayNotice(last, T + 30 * MIN, T + 5 * MIN)).toBe(false);
    expect(throttleDelayNotice(last, T + 15 * MIN, T + 11 * MIN)).toBe(false);
  });
});

describe('Phase 10 rules: Pakistan time labels', () => {
  it('writes Karachi time (UTC+5)', () => {
    expect(timeLabel(T, 'en')).toBe('3:05 PM');
    expect(timeLabel(Date.UTC(2026, 10, 16, 19, 0), 'en')).toBe('12:00 AM');
    expect(timeLabel(Date.UTC(2026, 10, 16, 7, 0), 'en')).toBe('12:00 PM');
    expect(dateLabel(T, 'en')).toBe('Mon 16 Nov');
    expect(whenLabel(T, 'en')).toBe('Mon 16 Nov, 3:05 PM');
    expect(karachiIsoDate(Date.UTC(2026, 10, 16, 20, 0))).toBe('2026-11-17'); // 01:00 on the 17th in Karachi
  });
  it('writes Urdu day parts and names', () => {
    expect(timeLabel(T, 'ur')).toBe('دوپہر 3:05');
    expect(timeLabel(Date.UTC(2026, 10, 16, 13, 30), 'ur')).toBe('شام 6:30');
    expect(timeLabel(Date.UTC(2026, 10, 16, 4, 0), 'ur')).toBe('صبح 9:00');
    expect(timeLabel(Date.UTC(2026, 10, 16, 17, 0), 'ur')).toBe('رات 10:00');
    expect(dateLabel(T, 'ur')).toBe('پیر 16 نومبر');
  });
});

describe('Phase 10 rules: text hygiene', () => {
  it('removes control characters, collapses spaces and shortens', () => {
    expect(clean('  Ali\n\tKhan\u0000  ', 40)).toBe('Ali Khan');
    expect(clean('x'.repeat(100), 10)).toBe(`${'x'.repeat(9)}…`);
    expect(clean(null, 10)).toBe('');
  });
});
