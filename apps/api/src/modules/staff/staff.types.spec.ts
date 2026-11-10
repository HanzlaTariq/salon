import {
  BreakInput, STAFF_LIMITS, SalonWindow, billingSummary, breaksStillFit, invitationExpiresAt, inclusiveDays, isExpired,
  maskEmail, normalizePermissions, parseClock, todayInSalonTz, validateBreaks, validateLeavePeriod, validateStaffWeek,
  HoursInput, StaffDayRow,
} from './staff.types';

/** Mon-Sat 10:00-21:00, Sunday closed. */
const SALON: SalonWindow[] = [
  ...[1, 2, 3, 4, 5, 6].map((weekday): SalonWindow => ({ weekday, isClosed: false, opensMinute: 600, closesMinute: 1260 })),
  { weekday: 7, isClosed: true, opensMinute: null, closesMinute: null },
];

const fullWeek = (over: Partial<Record<number, HoursInput>> = {}): HoursInput[] =>
  [1, 2, 3, 4, 5, 6, 7].map((weekday) => over[weekday] ?? { weekday, off: weekday === 7, startsAt: '11:00', endsAt: '19:00' });

describe('parseClock', () => {
  it('accepts HH:MM on the 5-minute grid and 24:00 only as an end time', () => {
    expect(parseClock('10:00')).toBe(600);
    expect(parseClock('09:55')).toBe(595);
    expect(parseClock('24:00', true)).toBe(1440);
    expect(parseClock('24:00', false)).toBeNull();
    expect(parseClock('10:03')).toBeNull(); // off grid
    expect(parseClock('25:00')).toBeNull();
    expect(parseClock('9:00')).toBeNull();
    expect(parseClock(900)).toBeNull();
  });
});

describe('validateStaffWeek', () => {
  it('requires exactly seven distinct weekdays', () => {
    expect(validateStaffWeek(fullWeek().slice(0, 6), SALON).ok).toBe(false);
    const dup = fullWeek();
    dup[1] = { weekday: 1, off: false, startsAt: '11:00', endsAt: '12:00' };
    expect(validateStaffWeek(dup, SALON)).toMatchObject({ ok: false, message: expect.stringContaining('only once') });
  });

  it('keeps working hours inside the salon opening window', () => {
    const r = validateStaffWeek(fullWeek({ 1: { weekday: 1, off: false, startsAt: '09:00', endsAt: '12:00' } }), SALON);
    expect(r).toMatchObject({ ok: false, message: expect.stringContaining('within salon hours (10:00-21:00)') });
    const late = validateStaffWeek(fullWeek({ 2: { weekday: 2, off: false, startsAt: '18:00', endsAt: '21:30' } }), SALON);
    expect(late.ok).toBe(false);
  });

  it('refuses rostering on a day the salon is closed', () => {
    const r = validateStaffWeek(fullWeek({ 7: { weekday: 7, off: false, startsAt: '11:00', endsAt: '12:00' } }), SALON);
    expect(r).toMatchObject({ ok: false, message: expect.stringContaining('salon is closed') });
  });

  it('rejects end before start and returns normalised rows (off days carry no times)', () => {
    expect(validateStaffWeek(fullWeek({ 3: { weekday: 3, off: false, startsAt: '15:00', endsAt: '14:00' } }), SALON).ok).toBe(false);
    const ok = validateStaffWeek(fullWeek({ 4: { weekday: 4, off: true, startsAt: '11:00', endsAt: '12:00' } }), SALON);
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.value.find((d) => d.weekday === 4)).toEqual({ weekday: 4, off: true, startMinute: null, endMinute: null });
      expect(ok.value[0]).toEqual({ weekday: 1, off: false, startMinute: 660, endMinute: 1140 });
    }
  });
});

describe('breaks', () => {
  const hours: StaffDayRow[] = [1, 2, 3, 4, 5, 6, 7].map((weekday) =>
    weekday === 7 ? { weekday, off: true, startMinute: null, endMinute: null } : { weekday, off: false, startMinute: 660, endMinute: 1140 });

  const b = (weekday: number, startsAt: string, endsAt: string, label?: string): BreakInput => ({ weekday, startsAt, endsAt, label });

  it('must sit inside working hours and on a day with hours', () => {
    expect(validateBreaks([b(1, '11:30', '12:00')], hours).ok).toBe(true);
    expect(validateBreaks([b(1, '10:00', '10:30')], hours).ok).toBe(false);
    expect(validateBreaks([b(7, '11:00', '11:30')], hours)).toMatchObject({ ok: false, message: expect.stringContaining('set working hours') });
  });

  it('refuses overlapping breaks on the same day but allows the same time on another day', () => {
    expect(validateBreaks([b(2, '12:00', '13:00'), b(2, '12:30', '13:30')], hours).ok).toBe(false);
    expect(validateBreaks([b(2, '12:00', '13:00'), b(3, '12:00', '13:00')], hours).ok).toBe(true);
  });

  it('caps breaks per day and defaults the label', () => {
    const many = Array.from({ length: STAFF_LIMITS.breaksPerDay + 1 }, (_, i) => b(2, `${String(11 + Math.floor(i / 6)).padStart(2, '0')}:${String((i % 6) * 10).padStart(2, '0')}`, `${String(11 + Math.floor(i / 6)).padStart(2, '0')}:${String((i % 6) * 10 + 5).padStart(2, '0')}`));
    expect(validateBreaks(many, hours)).toMatchObject({ ok: false });
    const r = validateBreaks([b(2, '12:00', '12:15', '   ')], hours);
    expect(r.ok && r.value[0].label).toBe('Break');
  });

  it('detects breaks that stop fitting after a working-hours change', () => {
    const r = validateBreaks([b(1, '11:00', '11:30')], hours);
    if (!r.ok) throw new Error('setup');
    const shorter: StaffDayRow[] = hours.map((h) => (h.weekday === 1 ? { ...h, endMinute: 1080 } : h));
    expect(breaksStillFit(r.value, hours)).toBeNull();
    expect(breaksStillFit(r.value, shorter)).toBeNull(); // 11:00-11:30 still inside 11:00-18:00
    const moved: StaffDayRow[] = hours.map((h) => (h.weekday === 1 ? { ...h, startMinute: 720 } : h));
    expect(breaksStillFit(r.value, moved)).toContain('outside the new working hours');
  });
});

describe('leave periods', () => {
  const TODAY = '2026-11-10';

  it('validates format, order, span and that the period is not already over', () => {
    expect(validateLeavePeriod({ startsOn: '2026-11-12', endsOn: '2026-11-11' }, TODAY, { forStaff: false }).ok).toBe(false);
    expect(validateLeavePeriod({ startsOn: '2026-02-30', endsOn: '2026-03-01' }, TODAY, { forStaff: false }).ok).toBe(false);
    expect(validateLeavePeriod({ startsOn: '10/11/2026', endsOn: '2026-11-11' }, TODAY, { forStaff: false }).ok).toBe(false);
    expect(validateLeavePeriod({ startsOn: '2026-11-01', endsOn: '2026-11-09' }, TODAY, { forStaff: false })).toMatchObject({ ok: false, message: expect.stringContaining('already ended') });
    expect(validateLeavePeriod({ startsOn: '2026-11-01', endsOn: '2026-11-12' }, TODAY, { forStaff: false }).ok).toBe(true);
  });

  it('caps the span at the configured maximum (inclusive)', () => {
    expect(inclusiveDays('2026-11-10', '2026-11-10')).toBe(1);
    expect(validateLeavePeriod({ startsOn: '2026-11-10', endsOn: '2027-02-07' }, TODAY, { forStaff: true }).ok).toBe(true); // 90 days
    expect(validateLeavePeriod({ startsOn: '2026-11-10', endsOn: '2027-02-08' }, TODAY, { forStaff: true }).ok).toBe(false); // 91 days
  });

  it('lets staff request only from today onwards; owners may record leave that is still running', () => {
    expect(validateLeavePeriod({ startsOn: '2026-11-09', endsOn: '2026-11-12' }, TODAY, { forStaff: true })).toMatchObject({ ok: false });
    expect(validateLeavePeriod({ startsOn: '2026-11-09', endsOn: '2026-11-12' }, TODAY, { forStaff: false }).ok).toBe(true);
  });

  it('computes "today" in the salon timezone (Asia/Karachi, UTC+5)', () => {
    // 2026-11-10 20:30 UTC is already 2026-11-11 01:30 in Karachi.
    expect(todayInSalonTz(new Date('2026-11-10T20:30:00Z'))).toBe('2026-11-11');
    expect(todayInSalonTz(new Date('2026-11-10T10:00:00Z'))).toBe('2026-11-10');
  });
});

describe('permissions', () => {
  it('accepts known permissions only, removes duplicates and sorts', () => {
    expect(normalizePermissions(['schedule.manage_own', 'walk_ins.create', 'walk_ins.create'])).toEqual({
      ok: true, value: ['schedule.manage_own', 'walk_ins.create'].sort(),
    });
    expect(normalizePermissions(['users.delete'])).toMatchObject({ ok: false });
    expect(normalizePermissions(undefined)).toEqual({ ok: true, value: [] });
  });
});

describe('invitations', () => {
  it('expire 72 hours after creation and reject exactly at the deadline', () => {
    const now = new Date('2026-11-10T10:00:00Z');
    const exp = invitationExpiresAt(now);
    expect(exp.getTime() - now.getTime()).toBe(72 * 60 * 60 * 1000);
    expect(isExpired(exp, new Date(exp.getTime() - 1))).toBe(false);
    expect(isExpired(exp, exp)).toBe(true);
  });

  it('masks the address in public previews', () => {
    expect(maskEmail('ali.khan@example.com')).toBe('a*******@example.com');
    expect(maskEmail('a@example.com')).toBe('a**@example.com');
    expect(maskEmail('not-an-email')).toBe('***');
  });
});

describe('billing summary', () => {
  it('counts only active, performing staff; the owner counts once; managers-only owners do not', () => {
    const s = billingSummary([
      { isOwner: true, isActive: true, performsServices: true },   // owner who works: 1
      { isOwner: false, isActive: true, performsServices: true },  // 2
      { isOwner: false, isActive: true, performsServices: true },  // 3
      { isOwner: false, isActive: false, performsServices: true }, // inactive: excluded
      { isOwner: false, isActive: true, performsServices: false }, // receptionist: not billable
    ]);
    expect(s).toEqual({ billableStaff: 3, activeNonPerforming: 1, inactive: 1, ownerBillable: true });
    expect(billingSummary([{ isOwner: true, isActive: true, performsServices: false }])).toEqual({
      billableStaff: 0, activeNonPerforming: 1, inactive: 0, ownerBillable: false,
    });
  });
});
