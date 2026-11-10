import { AssignmentRecord, isCompleteOrdering, moneyText, planPricing, priceRange, toMoney } from './catalog.types';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const fixed = { mode: 'FIXED' as const, basePrice: '300.00' };
const staffBased = { mode: 'STAFF_BASED' as const, basePrice: null };
const asg = (staffId: string, price: string | null): AssignmentRecord => ({ serviceId: 's', staffId, price });

describe('money', () => {
  it('accepts valid amounts and normalises to two decimals', () => {
    expect(toMoney(300)).toBe('300.00');
    expect(toMoney(299.9)).toBe('299.90');
    expect(toMoney(0)).toBe('0.00');
    expect(toMoney(1_000_000)).toBe('1000000.00');
    expect(toMoney(0.1 + 0.2 - 0.3 + 100.25)).toBe('100.25');
  });
  it('rejects negatives, too many decimals, huge numbers and non-numbers', () => {
    for (const bad of [-1, 10.005, 1_000_000.01, NaN, Infinity, '300', null, undefined]) expect(toMoney(bad)).toBeNull();
  });
  it('moneyText normalises what PostgreSQL / Prisma return', () => {
    expect(moneyText('300.00')).toBe('300.00');
    expect(moneyText(300)).toBe('300.00');
    expect(moneyText({ valueOf: () => '12.5' })).toBe('12.50');
    expect(moneyText(null)).toBeNull();
  });
});

describe('planPricing', () => {
  it('create: FIXED needs a price; STAFF_BASED forbids one', () => {
    const base = { mode: 'FIXED' as const, basePrice: null };
    expect(planPricing(base, [], { pricing: { mode: 'FIXED' } }).ok).toBe(false);
    const ok = planPricing(base, [], { pricing: { mode: 'FIXED', price: 350 } });
    expect(ok).toMatchObject({ ok: true, mode: 'FIXED', basePrice: '350.00', assignments: [] });
    expect(planPricing(base, [], { pricing: { mode: 'STAFF_BASED', price: 350 } }).ok).toBe(false);
    expect(planPricing(base, [], { pricing: { mode: 'STAFF_BASED' } })).toMatchObject({ ok: true, mode: 'STAFF_BASED', basePrice: null });
  });

  it('staff-based services need a price for every assigned staff member (Ali 300, Ahmed 500, Usman 400)', () => {
    const base = { mode: 'FIXED' as const, basePrice: null };
    const p = planPricing(base, [], { pricing: { mode: 'STAFF_BASED' }, staff: [{ staffId: A, price: 300 }, { staffId: B, price: 500 }] });
    expect(p).toMatchObject({ ok: true, assignments: [{ staffId: A, price: '300.00' }, { staffId: B, price: '500.00' }], rewriteAssignments: true });
    expect(planPricing(base, [], { pricing: { mode: 'STAFF_BASED' }, staff: [{ staffId: A }] }).ok).toBe(false);
    expect(planPricing(base, [], { pricing: { mode: 'STAFF_BASED' }, staff: [{ staffId: A, price: -5 }] }).ok).toBe(false);
  });

  it('fixed services reject staff prices; duplicates are rejected', () => {
    expect(planPricing(fixed, [], { staff: [{ staffId: A, price: 100 }] }).ok).toBe(false);
    expect(planPricing(fixed, [], { staff: [{ staffId: A }, { staffId: A }] }).ok).toBe(false);
    expect(planPricing(fixed, [], { staff: [{ staffId: A }, { staffId: B }] })).toMatchObject({ ok: true, rewriteAssignments: true });
  });

  it('update without pricing/staff keeps everything as it was', () => {
    const existing = [asg(A, '300.00')];
    expect(planPricing(staffBased, existing, {})).toMatchObject({ ok: true, mode: 'STAFF_BASED', basePrice: null, rewriteAssignments: false, assignments: [{ staffId: A, price: '300.00' }] });
    expect(planPricing(fixed, [], { pricing: { mode: 'FIXED' } })).toMatchObject({ ok: true, basePrice: '300.00' }); // price omitted: keep
    expect(planPricing(fixed, [], { pricing: { mode: 'FIXED', price: 400 } })).toMatchObject({ ok: true, basePrice: '400.00' });
  });

  it('switching FIXED -> STAFF_BASED with assignments requires the new priced staff list', () => {
    const existing = [asg(A, null)];
    expect(planPricing(fixed, existing, { pricing: { mode: 'STAFF_BASED' } }).ok).toBe(false);
    expect(planPricing(fixed, existing, { pricing: { mode: 'STAFF_BASED' }, staff: [{ staffId: A, price: 450 }] })).toMatchObject({
      ok: true, mode: 'STAFF_BASED', basePrice: null, modeChanged: true, assignments: [{ staffId: A, price: '450.00' }],
    });
    expect(planPricing(fixed, [], { pricing: { mode: 'STAFF_BASED' } })).toMatchObject({ ok: true, rewriteAssignments: false });
  });

  it('switching STAFF_BASED -> FIXED needs a price and clears staff prices but keeps the assignments', () => {
    const existing = [asg(A, '300.00'), asg(B, '500.00')];
    expect(planPricing(staffBased, existing, { pricing: { mode: 'FIXED' } }).ok).toBe(false);
    expect(planPricing(staffBased, existing, { pricing: { mode: 'FIXED', price: 400 } })).toMatchObject({
      ok: true, mode: 'FIXED', basePrice: '400.00', modeChanged: true, rewriteAssignments: true,
      assignments: [{ staffId: A, price: null }, { staffId: B, price: null }],
    });
  });

  it('price range for customers', () => {
    expect(priceRange('FIXED', '300.00', [null])).toEqual({ from: '300.00', to: '300.00' });
    expect(priceRange('STAFF_BASED', null, ['500.00', '300.00', '400.00'])).toEqual({ from: '300.00', to: '500.00' });
    expect(priceRange('STAFF_BASED', null, [])).toBeNull();
    expect(priceRange('FIXED', null, [])).toBeNull();
  });
});

describe('isCompleteOrdering', () => {
  it('requires every id exactly once', () => {
    expect(isCompleteOrdering([A, B], [B, A])).toBe(true);
    expect(isCompleteOrdering([A], [A, B])).toBe(false);
    expect(isCompleteOrdering([A, A], [A, B])).toBe(false);
    expect(isCompleteOrdering([A, 'x'], [A, B])).toBe(false);
  });
});
