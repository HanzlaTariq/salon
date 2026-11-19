import { describe, expect, it } from 'vitest';
import { barPct, isoDaysAgo, monthLabel, moneyToNumber, num, pctText, presetRange, seriesMax } from './format';

describe('analytics format helpers', () => {
  it('labels months without time-zone surprises', () => {
    expect(monthLabel('2026-01')).toBe('Jan 26');
    expect(monthLabel('2026-12')).toBe('Dec 26');
    expect(monthLabel('nonsense')).toBe('nonsense');
    expect(monthLabel('2026-13')).toBe('2026-13');
  });
  it('formats percentages and numbers', () => {
    expect(pctText(57.1)).toBe('57.1%');
    expect(pctText(0)).toBe('0%');
    expect(pctText(null)).toBe('-');
    expect(num(1234567)).toBe('1,234,567');
    expect(num(12)).toBe('12');
  });
  it('builds inclusive date ranges', () => {
    const today = new Date(2026, 10, 19);
    expect(isoDaysAgo(today, 0)).toBe('2026-11-19');
    expect(isoDaysAgo(today, 19)).toBe('2026-10-31');
    expect(presetRange(today, 30)).toEqual({ from: '2026-10-21', to: '2026-11-19' });
    expect(presetRange(new Date(2028, 2, 1), 2)).toEqual({ from: '2028-02-29', to: '2028-03-01' });
  });
  it('scales bars safely', () => {
    expect(seriesMax([])).toBe(1);
    expect(seriesMax([0, 0])).toBe(1);
    expect(seriesMax([3, 9, 4])).toBe(9);
    expect(barPct(0, 10)).toBe(0);
    expect(barPct(5, 10)).toBe(50);
    expect(barPct(1, 1000)).toBe(2);
    expect(barPct(50, 10)).toBe(100);
  });
  it('turns money text into a chart height only', () => {
    expect(moneyToNumber('1234.50')).toBe(1234.5);
    expect(moneyToNumber('x')).toBe(0);
  });
});
