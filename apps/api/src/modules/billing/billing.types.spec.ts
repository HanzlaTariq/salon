import {
  addDays, addMonths, bestPromotion, computeMainInvoice, computeRemovalCredit, computeTopUp, diffDays, floorDiv, fromPaisa, isOperational,
  nextPeriod, phaseOf, planReconcile, prorationWindow, roundDiv, toPaisa, topUpSettlement,
} from './billing.types';

describe('money', () => {
  it('parses and formats without floats', () => {
    expect(toPaisa('1234.5')).toBe(123450);
    expect(toPaisa('0.07')).toBe(7);
    expect(toPaisa('300')).toBe(30000);
    expect(fromPaisa(123450)).toBe('1234.50');
    expect(fromPaisa(7)).toBe('0.07');
    expect(fromPaisa(-250)).toBe('-2.50');
  });
  it('rejects malformed values', () => {
    for (const bad of ['', '1.234', 'abc', '1e5', ' 5', '5,00', '--1']) expect(() => toPaisa(bad)).toThrow();
  });
  it('rounds half up and floors', () => {
    expect(roundDiv(5, 2)).toBe(3);
    expect(roundDiv(4, 3)).toBe(1);
    expect(roundDiv(10, 4)).toBe(3);
    expect(floorDiv(5, 2)).toBe(2);
    expect(floorDiv(6, 3)).toBe(2);
  });
});

describe('dates and periods', () => {
  it('clamps month ends and handles leap years', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2028-01-31', 1)).toBe('2028-02-29');
    expect(addMonths('2028-02-29', 12)).toBe('2029-02-28');
    expect(addMonths('2026-11-13', 1)).toBe('2026-12-13');
    expect(addMonths('2026-12-15', 1)).toBe('2027-01-15');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(diffDays('2026-11-13', '2026-12-13')).toBe(30);
  });
  it('early renewal continues the paid period; late renewal starts today', () => {
    expect(nextPeriod('MONTHLY', '2026-12-13', '2026-12-10')).toEqual({ start: '2026-12-13', end: '2027-01-13' });
    expect(nextPeriod('MONTHLY', '2026-12-13', '2026-12-20')).toEqual({ start: '2026-12-20', end: '2027-01-20' });
    expect(nextPeriod('YEARLY', null, '2026-11-13')).toEqual({ start: '2026-11-13', end: '2027-11-13' });
  });
  it('derives phases from dates, grace and suspension', () => {
    const sub = { status: 'ACTIVE' as const, periodStart: '2026-11-13', periodEnd: '2026-12-13', graceDays: 3 };
    expect(phaseOf(null, '2026-11-13')).toBe('NONE');
    expect(phaseOf(sub, '2026-12-12')).toBe('ACTIVE');
    expect(phaseOf(sub, '2026-12-13')).toBe('GRACE');
    expect(phaseOf(sub, '2026-12-15')).toBe('GRACE');
    expect(phaseOf(sub, '2026-12-16')).toBe('EXPIRED');
    expect(phaseOf({ ...sub, graceDays: 0 }, '2026-12-13')).toBe('EXPIRED');
    expect(phaseOf({ ...sub, status: 'SUSPENDED' }, '2026-11-20')).toBe('SUSPENDED');
    expect(isOperational('GRACE')).toBe(true);
    expect(isOperational('EXPIRED')).toBe(false);
  });
});

describe('promotions and invoice amounts', () => {
  const promo = (o: Partial<Parameters<typeof bestPromotion>[0][0]>) => ({ id: 'a', name: 'P', percentOff: 10, appliesTo: 'ANY' as const, startsOn: '2026-11-01', endsOn: null, isActive: true, ...o });
  it('picks the biggest usable promotion only', () => {
    const list = [promo({ id: '1', percentOff: 10 }), promo({ id: '2', percentOff: 25, appliesTo: 'YEARLY' }), promo({ id: '3', percentOff: 50, isActive: false }), promo({ id: '4', percentOff: 40, endsOn: '2026-11-05' })];
    expect(bestPromotion(list, 'MONTHLY', '2026-11-13')?.id).toBe('1');
    expect(bestPromotion(list, 'YEARLY', '2026-11-13')?.id).toBe('2');
    expect(bestPromotion(list, 'MONTHLY', '2026-10-31')).toBeNull();
  });
  it('the example from the brief: Rs. 300 x 2 staff = Rs. 600', () => {
    const a = computeMainInvoice({ unitPaisa: 30000, staff: 2, discountPercent: 0, creditBalancePaisa: 0 });
    expect(fromPaisa(a.total)).toBe('600.00');
  });
  it('applies the discount per staff and then spends credit, never below zero', () => {
    const a = computeMainInvoice({ unitPaisa: 30000, staff: 3, discountPercent: 10, creditBalancePaisa: 5000 });
    expect([a.subtotal, a.discountAmount, a.creditApplied, a.total]).toEqual([90000, 9000, 5000, 76000]);
    const b = computeMainInvoice({ unitPaisa: 30000, staff: 1, discountPercent: 0, creditBalancePaisa: 99999 });
    expect([b.creditApplied, b.total]).toEqual([30000, 0]);
    expect(computeMainInvoice({ unitPaisa: 30000, staff: 1, discountPercent: 100, creditBalancePaisa: 0 }).total).toBe(0);
    expect(() => computeMainInvoice({ unitPaisa: 1, staff: 0, discountPercent: 0, creditBalancePaisa: 0 })).toThrow();
  });
  it('amount identity always holds', () => {
    for (const pct of [0, 5, 12.5, 33.33, 100]) {
      for (const staff of [1, 2, 7]) {
        const a = computeMainInvoice({ unitPaisa: 29999, staff, discountPercent: pct, creditBalancePaisa: 1234 });
        expect(a.total).toBe(a.subtotal - a.discountAmount - a.creditApplied);
        expect(a.total).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

describe('proration', () => {
  const sub = { periodStart: '2026-11-13', periodEnd: '2026-12-13' };
  it('counts today as a remaining day', () => {
    expect(prorationWindow(sub, '2026-11-13')).toEqual({ remainingDays: 30, totalDays: 30 });
    expect(prorationWindow(sub, '2026-11-28')).toEqual({ remainingDays: 15, totalDays: 30 });
    expect(prorationWindow(sub, '2026-12-12')).toEqual({ remainingDays: 1, totalDays: 30 });
    expect(prorationWindow(sub, '2026-11-01')).toEqual({ remainingDays: 30, totalDays: 30 });
  });
  it('top-up charges the remaining part at the locked price (half up)', () => {
    const t = computeTopUp({ unitPaisa: 30000, staff: 2, discountPercent: 0, remainingDays: 15, totalDays: 30, creditBalancePaisa: 0 });
    expect(fromPaisa(t.total)).toBe('300.00');
    const odd = computeTopUp({ unitPaisa: 30000, staff: 1, discountPercent: 0, remainingDays: 10, totalDays: 31, creditBalancePaisa: 0 });
    expect(odd.total).toBe(roundDiv(30000 * 10, 31));
    const d = computeTopUp({ unitPaisa: 30000, staff: 1, discountPercent: 10, remainingDays: 15, totalDays: 30, creditBalancePaisa: 0 });
    expect([d.subtotal, d.discountAmount, d.total]).toEqual([15000, 1500, 13500]);
    expect(d.total).toBe(d.subtotal - d.discountAmount - d.creditApplied);
  });
  it('removal credit rounds down and never exceeds the top-up for the same days', () => {
    const credit = computeRemovalCredit({ unitPaisa: 30000, discountPercent: 0, removed: 1, remainingDays: 10, totalDays: 31 });
    expect(credit).toBe(floorDiv(30000 * 10, 31));
    const charge = computeTopUp({ unitPaisa: 30000, staff: 1, discountPercent: 0, remainingDays: 10, totalDays: 31, creditBalancePaisa: 0 }).total;
    expect(credit).toBeLessThanOrEqual(charge);
  });
});

describe('planReconcile', () => {
  const sub = { status: 'ACTIVE' as const, periodStart: '2026-11-13', periodEnd: '2026-12-13', coveredStaff: 2 };
  const top = (o: Partial<{ id: string; staffCount: number; periodStart: string; periodEnd: string; hasLivePayment: boolean }> = {}) => ({
    id: 't1', staffCount: 1, periodStart: sub.periodStart, periodEnd: sub.periodEnd, hasLivePayment: false, ...o,
  });
  const run = (o: Partial<Parameters<typeof planReconcile>[0]>) => planReconcile({ today: '2026-11-20', sub, billable: 2, openTopUp: null, ...o });

  it('does nothing when counts match, without a subscription, when suspended, or after the period', () => {
    expect(run({})).toEqual([]);
    expect(run({ sub: null, billable: 5 })).toEqual([]);
    expect(run({ sub: { ...sub, status: 'SUSPENDED' }, billable: 5 })).toEqual([]);
    expect(run({ today: '2026-12-13', billable: 5 })).toEqual([]);
  });
  it('creates one top-up for added staff and keeps a matching unpaid one', () => {
    expect(run({ billable: 3 })).toEqual([{ type: 'CREATE_TOPUP', staff: 1 }]);
    expect(run({ billable: 3, openTopUp: top() })).toEqual([]);
  });
  it('replaces an unpaid top-up whose size is stale or whose period changed', () => {
    expect(run({ billable: 4, openTopUp: top() })).toEqual([{ type: 'VOID_TOPUP', invoiceId: 't1' }, { type: 'CREATE_TOPUP', staff: 2 }]);
    expect(run({ billable: 3, openTopUp: top({ periodEnd: '2026-11-13' }) })).toEqual([{ type: 'VOID_TOPUP', invoiceId: 't1' }, { type: 'CREATE_TOPUP', staff: 1 }]);
  });
  it('voids the top-up when staff drop back, and credits when below the covered count', () => {
    expect(run({ billable: 2, openTopUp: top() })).toEqual([{ type: 'VOID_TOPUP', invoiceId: 't1' }]);
    expect(run({ billable: 1 })).toEqual([{ type: 'GRANT_CREDIT', removed: 1, newCovered: 1 }]);
    expect(run({ billable: 0, openTopUp: top() })).toEqual([{ type: 'VOID_TOPUP', invoiceId: 't1' }, { type: 'GRANT_CREDIT', removed: 2, newCovered: 0 }]);
  });
  it('waits while a reviewer is looking at a payment for the open top-up', () => {
    expect(run({ billable: 5, openTopUp: top({ hasLivePayment: true }) })).toEqual([]);
    expect(run({ billable: 1, openTopUp: top({ hasLivePayment: true }) })).toEqual([]);
  });
  it('a stale paid top-up becomes credit, a current one is applied', () => {
    expect(topUpSettlement({ periodStart: 'a', periodEnd: 'b' }, { periodStart: 'a', periodEnd: 'b' })).toBe('APPLY');
    expect(topUpSettlement({ periodStart: 'a', periodEnd: 'c' }, { periodStart: 'a', periodEnd: 'b' })).toBe('CREDIT');
    expect(topUpSettlement(null, { periodStart: 'a', periodEnd: 'b' })).toBe('CREDIT');
  });
});
