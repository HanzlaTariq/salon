import { formatHm, parseHm, validateWeek, weekFromRows } from './opening-hours';

const open = (weekday: number) => ({ weekday, closed: false, opensAt: '09:00', closesAt: '21:30' });
const week = [1, 2, 3, 4, 5, 6].map(open).concat([{ weekday: 7, closed: true, opensAt: null as never, closesAt: null as never }]);

describe('opening hours', () => {
  it('parses and formats HH:MM', () => {
    expect(parseHm('00:00')).toBe(0);
    expect(parseHm('09:30')).toBe(570);
    expect(parseHm('23:59')).toBe(1439);
    expect(parseHm('24:00')).toBe(1440);
    for (const bad of ['9:30', '24:01', '12:60', '', 'ab:cd', null, undefined, 930]) expect(parseHm(bad)).toBeNull();
    expect(formatHm(570)).toBe('09:30');
    expect(formatHm(1440)).toBe('24:00');
  });

  it('accepts a full valid week and returns it sorted', () => {
    const v = validateWeek([...week].reverse());
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.rows.map((r) => r.weekday)).toEqual([1, 2, 3, 4, 5, 6, 7]);
      expect(v.rows[0]).toEqual({ weekday: 1, isClosed: false, opensMinute: 540, closesMinute: 1290 });
      expect(v.rows[6]).toEqual({ weekday: 7, isClosed: true, opensMinute: null, closesMinute: null });
    }
  });

  it('rejects incomplete, duplicated and out-of-range weeks', () => {
    expect(validateWeek(week.slice(0, 6)).ok).toBe(false);
    expect(validateWeek([...week.slice(0, 6), open(6)]).ok).toBe(false);
    expect(validateWeek([...week.slice(0, 6), { ...open(7), weekday: 8 }]).ok).toBe(false);
    expect(validateWeek([...week.slice(0, 6), { ...open(7), weekday: 0 }]).ok).toBe(false);
  });

  it('rejects impossible intervals and times on closed days', () => {
    const base = week.slice(0, 6);
    expect(validateWeek([...base, { weekday: 7, closed: false, opensAt: '22:00', closesAt: '02:00' }]).ok).toBe(false); // overnight
    expect(validateWeek([...base, { weekday: 7, closed: false, opensAt: '10:00', closesAt: '10:00' }]).ok).toBe(false);
    expect(validateWeek([...base, { weekday: 7, closed: false, opensAt: '24:00', closesAt: '24:00' }]).ok).toBe(false);
    expect(validateWeek([...base, { weekday: 7, closed: false, opensAt: '10:00' }]).ok).toBe(false);
    expect(validateWeek([...base, { weekday: 7, closed: true, opensAt: '10:00', closesAt: '12:00' }]).ok).toBe(false);
    expect(validateWeek([...base, { weekday: 7, closed: false, opensAt: '00:00', closesAt: '24:00' }]).ok).toBe(true);
  });

  it('weekFromRows always returns seven days and reports missing days as closed', () => {
    const days = weekFromRows([{ weekday: 3, isClosed: false, opensMinute: 600, closesMinute: 1200 }]);
    expect(days).toHaveLength(7);
    expect(days[2]).toEqual({ weekday: 3, closed: false, opensAt: '10:00', closesAt: '20:00' });
    expect(days.filter((d) => d.closed)).toHaveLength(6);
    expect(weekFromRows([])).toHaveLength(7);
  });
});
