import {
  StaffWeek, WeekSpans, addDaysIso, boundingBox, distanceKm, freeSpans, isIsoDateText, isoWeekday, karachiMinute, nextAvailable,
  notBeforeToday, parseClock, slotStarts, subtractSpans, sumMoney,
} from './discovery.types';

const h = (a: number, b: number) => ({ start: a * 60, end: b * 60 });
/** Salon open Mon-Sat 10:00-21:00, closed Sunday. */
const salon: WeekSpans = { 1: h(10, 21), 2: h(10, 21), 3: h(10, 21), 4: h(10, 21), 5: h(10, 21), 6: h(10, 21), 7: null };
const ali = (over: Partial<StaffWeek> = {}): StaffWeek => ({
  staffId: 'ali', name: 'Ali',
  hours: { 1: h(10, 18), 2: h(10, 18), 3: h(10, 18), 4: h(10, 18), 5: h(10, 18), 6: null, 7: null },
  breaks: { 1: [h(13, 14)], 2: [h(13, 14)], 3: [h(13, 14)], 4: [h(13, 14)], 5: [h(13, 14)] },
  leaves: [],
  ...over,
});
// 2026-11-16 is a Monday.
const MON = '2026-11-16';

describe('dates', () => {
  it('ISO weekday, date arithmetic and validation', () => {
    expect(isoWeekday('2026-11-16')).toBe(1);
    expect(isoWeekday('2026-11-22')).toBe(7);
    expect(addDaysIso('2026-12-30', 3)).toBe('2027-01-02');
    expect(isIsoDateText('2026-02-30')).toBe(false);
    expect(isIsoDateText('2026-11-16')).toBe(true);
    expect(isIsoDateText('16-11-2026')).toBe(false);
  });
  it('Karachi minute of day is UTC+5', () => {
    expect(karachiMinute(new Date('2026-11-16T07:30:00Z'))).toBe(12 * 60 + 30);
    expect(karachiMinute(new Date('2026-11-16T20:00:00Z'))).toBe(60); // 01:00 next day
  });
  it('parseClock accepts HH:MM only', () => {
    expect(parseClock('09:05')).toBe(545);
    for (const bad of ['24:00', '9:05', '09:5', '', null, 5]) expect(parseClock(bad)).toBeNull();
  });
});

describe('nearby search helpers', () => {
  it('the bounding box contains the whole circle and shrinks with the radius', () => {
    const b = boundingBox(31.5204, 74.3587, 10);
    expect(b.minLat).toBeLessThan(31.5204 - 0.089);
    expect(b.maxLat).toBeGreaterThan(31.5204 + 0.089);
    expect(b.maxLng - b.minLng).toBeGreaterThan(0.2);
    expect(boundingBox(31.5204, 74.3587, 1).maxLat - 31.5204).toBeLessThan(0.01);
  });
  it('never leaves the valid coordinate range', () => {
    const b = boundingBox(89.9, 179.9, 100);
    expect(b.maxLat).toBeLessThanOrEqual(90);
    expect(b.maxLng).toBeLessThanOrEqual(180);
  });
  it('distance text', () => {
    expect(distanceKm(1234)).toBe(1.2);
    expect(distanceKm(49)).toBe(0);
    expect(distanceKm(null)).toBeNull();
  });
});

describe('subtractSpans', () => {
  it('splits, trims and removes', () => {
    expect(subtractSpans([{ start: 0, end: 100 }], [{ start: 40, end: 60 }])).toEqual([{ start: 0, end: 40 }, { start: 60, end: 100 }]);
    expect(subtractSpans([{ start: 0, end: 100 }], [{ start: -5, end: 10 }, { start: 90, end: 200 }])).toEqual([{ start: 10, end: 90 }]);
    expect(subtractSpans([{ start: 0, end: 100 }], [{ start: 0, end: 100 }])).toEqual([]);
    expect(subtractSpans([{ start: 0, end: 100 }], [{ start: 50, end: 50 }])).toEqual([{ start: 0, end: 100 }]);
  });
  it('handles overlapping and unsorted cuts', () => {
    expect(subtractSpans([{ start: 0, end: 100 }], [{ start: 60, end: 80 }, { start: 10, end: 30 }, { start: 20, end: 40 }]))
      .toEqual([{ start: 0, end: 10 }, { start: 40, end: 60 }, { start: 80, end: 100 }]);
  });
});

describe('freeSpans', () => {
  it('intersects salon and staff hours and removes the break', () => {
    expect(freeSpans(MON, salon, ali())).toEqual([h(10, 13), h(14, 18)]);
  });
  it('is empty on the staff day off, a closed salon day, and during approved leave', () => {
    expect(freeSpans('2026-11-21', salon, ali())).toEqual([]); // Saturday: staff off
    expect(freeSpans('2026-11-22', salon, ali({ hours: { 7: h(10, 18) } }))).toEqual([]); // Sunday: salon closed
    expect(freeSpans(MON, salon, ali({ leaves: [{ startsOn: '2026-11-15', endsOn: '2026-11-16' }] }))).toEqual([]);
    expect(freeSpans('2026-11-17', salon, ali({ leaves: [{ startsOn: '2026-11-15', endsOn: '2026-11-16' }] }))).toEqual([h(10, 13), h(14, 18)]);
  });
  it('clips to the salon window when staff hours are wider (R36: hours changed later)', () => {
    expect(freeSpans(MON, salon, ali({ hours: { 1: h(8, 23) }, breaks: {} }))).toEqual([h(10, 21)]);
  });
  it('subtracts busy intervals (Phase 8 hook)', () => {
    expect(freeSpans(MON, salon, ali(), [{ start: 11 * 60, end: 12 * 60 }])).toEqual([h(10, 11), h(12, 13), h(14, 18)]);
  });
});

describe('slotStarts', () => {
  it('lists starts that fit the whole service before the span ends', () => {
    expect(slotStarts([h(10, 11)], 30, 15)).toEqual([600, 615, 630]);
    expect(slotStarts([h(10, 11)], 45, 15)).toEqual([600, 615]);
    expect(slotStarts([h(10, 11)], 61, 15)).toEqual([]);
  });
  it('never starts before notBefore and stays on the span grid', () => {
    expect(slotStarts([h(10, 12)], 30, 15, 10 * 60 + 20)).toEqual([630, 645, 660, 675, 690]);
    expect(slotStarts([h(10, 12)], 30, 15, 13 * 60)).toEqual([]);
  });
  it('does not let a service straddle a break', () => {
    const spans = freeSpans(MON, salon, ali());
    const starts = slotStarts(spans, 60, 15);
    expect(starts).toContain(12 * 60); // 12:00-13:00 fits exactly
    expect(starts).not.toContain(12 * 60 + 15); // would run into the 13:00 break
  });
  it('rounds "now" up to the next 5 minutes', () => {
    expect(notBeforeToday(12 * 60 + 1)).toBe(12 * 60 + 5);
    expect(notBeforeToday(12 * 60)).toBe(12 * 60);
  });
});

describe('nextAvailable', () => {
  it('today when a slot is still ahead', () => {
    expect(nextAvailable(salon, [ali()], 30, MON, 9 * 60 + 30)).toEqual({ date: MON, time: '10:00' });
    expect(nextAvailable(salon, [ali()], 30, MON, 11 * 60 + 2)).toEqual({ date: MON, time: '11:15' });
  });
  it('skips to the next working day when today is over', () => {
    expect(nextAvailable(salon, [ali()], 30, MON, 17 * 60 + 45)).toEqual({ date: '2026-11-17', time: '10:00' });
  });
  it('skips weekends and leave; picks the earliest staff member', () => {
    const fri = '2026-11-20';
    expect(nextAvailable(salon, [ali()], 30, fri, 18 * 60)).toEqual({ date: '2026-11-23', time: '10:00' }); // Sat off, Sun closed
    const bob: StaffWeek = { ...ali({ staffId: 'bob', name: 'Bob' }), hours: { 1: h(9, 12) } };
    expect(nextAvailable(salon, [ali({ leaves: [{ startsOn: MON, endsOn: MON }] }), bob], 30, MON, 0)).toEqual({ date: MON, time: '10:00' });
  });
  it('null when nothing fits inside the horizon', () => {
    expect(nextAvailable(salon, [ali()], 600, MON, 0)).toBeNull();
    expect(nextAvailable(salon, [], 30, MON, 0)).toBeNull();
  });
});

describe('sumMoney', () => {
  it('is exact to the paisa', () => {
    expect(sumMoney(['0.10', '0.20'])).toBe('0.30');
    expect(sumMoney(['300.00', '150.50'])).toBe('450.50');
  });
});
