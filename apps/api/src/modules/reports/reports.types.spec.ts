import {
  ReportInputError, annualize, averageMoney, changePct, defaultGroup, money, parseExpenseAmount, pct, previousRange, ratesOf, rangeOf,
  resolveGroup, resolveRange, sameExpense, subtractMoney, sumMoney,
} from './reports.types';

describe('report ranges (Asia/Karachi calendar days)', () => {
  const today = '2026-11-19';

  it('defaults to the last 30 days ending today', () => {
    const r = resolveRange({}, today);
    expect(r).toMatchObject({ from: '2026-10-21', to: '2026-11-19', days: 30 });
  });

  it('a range is inclusive and its instants are Karachi midnights (UTC+5)', () => {
    const r = rangeOf('2026-11-01', '2026-11-01');
    expect(r.days).toBe(1);
    expect(r.fromTs.toISOString()).toBe('2026-10-31T19:00:00.000Z');
    expect(r.toTs.toISOString()).toBe('2026-11-01T19:00:00.000Z');
  });

  it('counts leap days and month ends correctly', () => {
    expect(rangeOf('2028-02-28', '2028-03-01').days).toBe(3);
    expect(rangeOf('2026-01-01', '2026-12-31').days).toBe(365);
  });

  it('rejects bad dates, future ends, inverted ranges and ranges that are too long', () => {
    expect(() => resolveRange({ from: '2026-13-01' }, today)).toThrow(ReportInputError);
    expect(() => resolveRange({ to: '2026-02-30' }, today)).toThrow(ReportInputError);
    expect(() => resolveRange({ from: 'yesterday' }, today)).toThrow(ReportInputError);
    expect(() => resolveRange({ to: '2026-11-20' }, today)).toThrow(/after today/);
    expect(() => resolveRange({ from: '2026-11-10', to: '2026-11-09' }, today)).toThrow(/after to/);
    expect(() => resolveRange({ from: '2025-01-01', to: '2026-11-19' }, today)).toThrow(/at most 366/);
    expect(resolveRange({ from: '2025-11-19', to: '2026-11-19' }, today).days).toBe(366);
  });

  it('the previous period has the same length and ends the day before', () => {
    const r = resolveRange({ from: '2026-11-10', to: '2026-11-19' }, today);
    expect(previousRange(r)).toMatchObject({ from: '2026-10-31', to: '2026-11-09', days: 10 });
    const one = resolveRange({ from: today, to: today }, today);
    expect(previousRange(one)).toMatchObject({ from: '2026-11-18', to: '2026-11-18', days: 1 });
  });
});

describe('trend buckets', () => {
  it('picks a readable default', () => {
    expect(defaultGroup(7)).toBe('day');
    expect(defaultGroup(31)).toBe('day');
    expect(defaultGroup(90)).toBe('week');
    expect(defaultGroup(180)).toBe('week');
    expect(defaultGroup(366)).toBe('month');
  });

  it('refuses daily buckets for long ranges but allows week and month', () => {
    expect(resolveGroup('day', 93)).toBe('day');
    expect(() => resolveGroup('day', 94)).toThrow(ReportInputError);
    expect(resolveGroup('week', 366)).toBe('week');
    expect(resolveGroup(undefined, 366)).toBe('month');
  });
});

describe('rates', () => {
  it('pct rounds to one decimal and never divides by zero', () => {
    expect(pct(3, 8)).toBe(37.5);
    expect(pct(1, 3)).toBe(33.3);
    expect(pct(0, 5)).toBe(0);
    expect(pct(5, 0)).toBeNull();
    expect(pct(Number.NaN, 5)).toBeNull();
  });

  it('rates are taken over resolved appointments only', () => {
    expect(ratesOf({ completed: 6, cancelled: 2, noShow: 2 })).toEqual({ resolved: 10, completionRate: 60, cancellationRate: 20, noShowRate: 20 });
    expect(ratesOf({ completed: 0, cancelled: 0, noShow: 0 })).toEqual({ resolved: 0, completionRate: null, cancellationRate: null, noShowRate: null });
  });
});

describe('money (integer paisa, never floating point)', () => {
  it('normalises database numerics', () => {
    expect(money('1234.5')).toBe('1234.50');
    expect(money(300)).toBe('300.00');
    expect(money(null)).toBe('0.00');
    expect(money('abc')).toBe('0.00');
  });

  it('sums without floating point drift', () => {
    expect(sumMoney(['0.10', '0.20'])).toBe('0.30');
    expect(sumMoney(['300.00', '500.00', '150.00'])).toBe('950.00');
    expect(sumMoney([])).toBe('0.00');
  });

  it('subtracts, allowing a loss', () => {
    expect(subtractMoney('1000.00', '250.50')).toBe('749.50');
    expect(subtractMoney('100.00', '250.50')).toBe('-150.50');
  });

  it('averages to the nearest paisa and handles zero', () => {
    expect(averageMoney('1000.00', 3)).toBe('333.33');
    expect(averageMoney('100.00', 0)).toBeNull();
  });

  it('computes change against the previous period', () => {
    expect(changePct('1200.00', '1000.00')).toBe(20);
    expect(changePct('800.00', '1000.00')).toBe(-20);
    expect(changePct('800.00', '0.00')).toBeNull();
    expect(changePct(15, 10)).toBe(50);
  });

  it('annualises the monthly recurring revenue', () => {
    expect(annualize('600.00')).toBe('7200.00');
  });
});

describe('expense input', () => {
  it('accepts plain amounts and normalises them', () => {
    expect(parseExpenseAmount('1500')).toBe('1500.00');
    expect(parseExpenseAmount('1500.5')).toBe('1500.50');
    expect(parseExpenseAmount('0.01')).toBe('0.01');
    expect(parseExpenseAmount('100000000')).toBe('100000000.00');
  });

  it('rejects zero, negatives, too many decimals, exponents, junk and huge values', () => {
    for (const bad of ['0', '0.00', '-5', '1.234', '1e3', 'abc', '', ' 5', '1,500', '100000000.01', '1234567890']) {
      expect(() => parseExpenseAmount(bad)).toThrow(ReportInputError);
    }
  });

  it('recognises a retried request as the same expense', () => {
    const a = { category: 'RENT', amount: '50000', expenseDate: '2026-11-01', description: null };
    expect(sameExpense(a, { ...a, amount: '50000.00' })).toBe(true);
    expect(sameExpense(a, { ...a, amount: '50001.00' })).toBe(false);
    expect(sameExpense(a, { ...a, description: 'x' })).toBe(false);
    expect(sameExpense(a, { ...a, category: 'OTHER' })).toBe(false);
    expect(sameExpense(a, { ...a, expenseDate: '2026-11-02' })).toBe(false);
  });
});
