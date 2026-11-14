import {
  BOOKING_POLICY_DEFAULTS, bookingFingerprint, busySpansFor, canStartAt, cancelDecision, dayStartMs, karachiParts, nextAvailableBooked, notBeforeMinute,
  openStarts, policyFromRow, rescheduleDecision, slotMs, withinWindow,
} from './booking.types';

// 2026-11-16 is a Monday (ISO weekday 1).
const MON = '2026-11-16';
const salon = { 1: { start: 600, end: 1260 }, 2: { start: 600, end: 1260 } };
const staff = { staffId: 's1', name: 'Ali', hours: { 1: { start: 600, end: 1080 }, 2: { start: 600, end: 1080 } }, breaks: { 1: [{ start: 780, end: 840 }] }, leaves: [] };
const NOW = Date.parse('2026-11-14T05:00:00Z');
const base = { date: MON, salon, staff, busy: [], policy: { bufferMinutes: 0, minNoticeMinutes: 30 }, durationMin: 30, nowMs: NOW };
const busyAt = (from: number, to: number) => ({ startMs: slotMs(MON, from), endMs: slotMs(MON, to) });

describe('Karachi time conversion', () => {
  it('converts clock minutes to UTC instants and back (UTC+5, no daylight saving)', () => {
    expect(new Date(slotMs(MON, 600)).toISOString()).toBe('2026-11-16T05:00:00.000Z');
    expect(karachiParts(slotMs(MON, 600))).toEqual({ date: MON, minute: 600 });
    expect(karachiParts(Date.parse('2026-11-15T20:30:00Z'))).toEqual({ date: MON, minute: 90 });
    expect(dayStartMs(MON)).toBe(Date.parse('2026-11-15T19:00:00Z'));
  });
  it('booking window counts today as day one', () => {
    expect(withinWindow('2026-11-29', MON, 14)).toBe(true);
    expect(withinWindow('2026-11-30', MON, 14)).toBe(false);
    expect(withinWindow('2026-11-15', MON, 14)).toBe(false);
    expect(withinWindow(MON, MON, 1)).toBe(true);
    expect(withinWindow('2026-11-17', MON, 1)).toBe(false);
  });
});

describe('slot engine', () => {
  it('offers the 15-minute grid inside staff hours and never inside a break or past the end', () => {
    const starts = openStarts(base);
    expect(starts[0]).toBe(600);
    expect(starts).not.toContain(780);
    expect(starts).not.toContain(795);
    expect(starts).toContain(840);
    expect(starts[starts.length - 1]).toBe(1050);
  });

  it('subtracts existing appointments', () => {
    const starts = openStarts({ ...base, busy: [busyAt(660, 690)] });
    expect(starts).not.toContain(660);
    expect(starts).not.toContain(645);
    expect(starts).toContain(630);
    expect(starts).toContain(690);
  });

  it('keeps the buffer free on both sides (exclusion-constraint semantics)', () => {
    const policy = { bufferMinutes: 10, minNoticeMinutes: 30 };
    const busy = [busyAt(660, 700)]; // booked 11:00-11:30 with a 10-minute buffer: blocked until 11:40
    const ok = (startMinute: number) => canStartAt({ ...base, busy, policy, startMinute });
    expect(ok(620)).toBe(true); // 10:20-10:50 + 10 buffer = 11:00
    expect(ok(625)).toBe(false);
    expect(ok(690)).toBe(false);
    expect(ok(700)).toBe(true); // starts when the blocked time ends
  });

  it('canStartAt: 5-minute grid, breaks, closing time, staff hours', () => {
    expect(canStartAt({ ...base, startMinute: 602 })).toBe(false);
    expect(canStartAt({ ...base, startMinute: 780 })).toBe(false);
    expect(canStartAt({ ...base, startMinute: 750 })).toBe(true); // ends exactly at the break
    expect(canStartAt({ ...base, startMinute: 1050 })).toBe(true); // ends exactly at closing
    expect(canStartAt({ ...base, startMinute: 1055 })).toBe(false);
    expect(canStartAt({ ...base, startMinute: 595 })).toBe(false);
  });

  it('minimum notice rounds up to the next 5 minutes and can push past midnight', () => {
    const now = slotMs(MON, 607); // 10:07
    expect(notBeforeMinute(MON, now, 30)).toBe(640);
    expect(openStarts({ ...base, nowMs: now })[0]).toBeGreaterThanOrEqual(640);
    expect(notBeforeMinute(MON, slotMs(MON, 1430), 30)).toBeGreaterThanOrEqual(1440);
    expect(openStarts({ ...base, nowMs: slotMs(MON, 1430) })).toEqual([]);
  });

  it('busy spans are clipped to the day and extended backwards by the buffer', () => {
    expect(busySpansFor(MON, [busyAt(660, 700)], 10)).toEqual([{ start: 650, end: 700 }]);
    expect(busySpansFor(MON, [{ startMs: slotMs(MON, -30), endMs: slotMs(MON, 20) }], 0)).toEqual([{ start: 0, end: 20 }]);
    expect(busySpansFor(MON, [{ startMs: slotMs(MON, 1500), endMs: slotMs(MON, 1560) }], 0)).toEqual([]);
  });

  it('nextAvailableBooked skips a fully booked day', () => {
    const full = [{ startMs: slotMs(MON, 0), endMs: slotMs(MON, 1440) }];
    const next = nextAvailableBooked(salon, [staff], new Map([['s1', full]]), BOOKING_POLICY_DEFAULTS, 30, Date.parse('2026-11-15T20:00:00Z'));
    expect(next).toEqual({ date: '2026-11-17', time: '10:00' });
  });

  it('nextAvailableBooked respects the salon booking window', () => {
    const next = nextAvailableBooked(salon, [staff], new Map(), { ...BOOKING_POLICY_DEFAULTS, advanceDays: 1 }, 30, slotMs(MON, 1200));
    expect(next).toBeNull(); // only today is bookable and the staff day is over
  });
});

describe('cancellation and rescheduling rules', () => {
  const p = BOOKING_POLICY_DEFAULTS;
  const start = Date.parse('2026-11-20T10:00:00Z');
  it('cancel: allowed until the cutoff, then refused; only CONFIRMED bookings', () => {
    expect(cancelDecision(p, 'CONFIRMED', start, start - 3 * 3_600_000).allowed).toBe(true);
    expect(cancelDecision(p, 'CONFIRMED', start, start - 120 * 60_000).allowed).toBe(true);
    expect(cancelDecision(p, 'CONFIRMED', start, start - 119 * 60_000).reason).toBe('CUTOFF');
    expect(cancelDecision(p, 'COMPLETED', start, start - 9e6).reason).toBe('STATUS');
    expect(cancelDecision({ ...p, cancelCutoffMinutes: 0 }, 'CONFIRMED', start, start).allowed).toBe(true);
    expect(cancelDecision({ ...p, cancelCutoffMinutes: 0 }, 'CONFIRMED', start, start + 1).allowed).toBe(false);
  });
  it('reschedule: limit, cutoff and status', () => {
    expect(rescheduleDecision(p, 'CONFIRMED', start, start - 9e6, 1).allowed).toBe(true);
    expect(rescheduleDecision(p, 'CONFIRMED', start, start - 9e6, 2).reason).toBe('LIMIT');
    expect(rescheduleDecision({ ...p, maxReschedules: 0 }, 'CONFIRMED', start, start - 9e6, 0).reason).toBe('LIMIT');
    expect(rescheduleDecision(p, 'CONFIRMED', start, start - 60 * 60_000, 0).reason).toBe('CUTOFF');
    expect(rescheduleDecision(p, 'CANCELLED', start, start - 9e6, 0).reason).toBe('STATUS');
  });
});

describe('policy and idempotency helpers', () => {
  it('policyFromRow falls back per field for missing or out-of-range values', () => {
    expect(policyFromRow(null)).toEqual(BOOKING_POLICY_DEFAULTS);
    const p = policyFromRow({ buffer_minutes: 15, advance_days: 999, min_notice_minutes: 'x', max_reschedules: 5 });
    expect(p.bufferMinutes).toBe(15);
    expect(p.advanceDays).toBe(14);
    expect(p.minNoticeMinutes).toBe(30);
    expect(p.maxReschedules).toBe(5);
  });
  it('fingerprint ignores service order and differs for any other change', () => {
    const a = { salonId: 'a', staffId: 'b', serviceIds: ['2', '1'], date: MON, time: '10:00', note: null };
    expect(bookingFingerprint(a)).toBe(bookingFingerprint({ ...a, serviceIds: ['1', '2'] }));
    expect(bookingFingerprint(a)).not.toBe(bookingFingerprint({ ...a, time: '10:05' }));
    expect(bookingFingerprint(a)).not.toBe(bookingFingerprint({ ...a, note: 'x' }));
    expect(bookingFingerprint(a)).toMatch(/^[0-9a-f]{64}$/);
  });
});
