import { DEFAULT_TRIAL_DAYS, listingState, parseTrialDays } from './listing';

const approvedAt = new Date('2026-11-10T08:00:00Z'); // 13:00 in Karachi, 2026-11-10
const base = { status: 'APPROVED', approvedAt, subscription: null, trialDays: 14 };

describe('listing rule', () => {
  it('only APPROVED salons are ever listed', () => {
    for (const status of ['DRAFT', 'PENDING', 'REJECTED', 'SUSPENDED']) {
      expect(listingState({ ...base, status, today: '2026-11-11' })).toMatchObject({ listed: false, reason: 'NOT_APPROVED' });
    }
  });

  it('a never-subscribed salon is listed for exactly trialDays calendar days from approval (Karachi date)', () => {
    expect(listingState({ ...base, today: '2026-11-10' })).toEqual({ listed: true, reason: 'TRIAL', trialEndsOn: '2026-11-23' });
    expect(listingState({ ...base, today: '2026-11-23' }).listed).toBe(true); // 14th day
    expect(listingState({ ...base, today: '2026-11-24' })).toMatchObject({ listed: false, reason: 'TRIAL_ENDED' });
  });

  it('uses the Karachi calendar day, not UTC (approved 22:00 UTC = next day in Karachi)', () => {
    const late = new Date('2026-11-10T22:00:00Z'); // 2026-11-11 03:00 PKT
    expect(listingState({ ...base, approvedAt: late, trialDays: 1, today: '2026-11-11' }).listed).toBe(true);
    expect(listingState({ ...base, approvedAt: late, trialDays: 1, today: '2026-11-12' }).listed).toBe(false);
  });

  it('trialDays 0 means no trial at all', () => {
    expect(listingState({ ...base, trialDays: 0, today: '2026-11-10' })).toMatchObject({ listed: false, reason: 'TRIAL_ENDED', trialEndsOn: null });
  });

  it('once a subscription exists the trial no longer applies: ACTIVE or GRACE lists, expired or suspended does not', () => {
    const sub = { status: 'ACTIVE', periodEnd: '2026-12-01', graceDays: 3 };
    expect(listingState({ ...base, subscription: sub, today: '2026-11-30' })).toMatchObject({ listed: true, reason: 'SUBSCRIPTION' });
    expect(listingState({ ...base, subscription: sub, today: '2026-12-03' }).listed).toBe(true); // grace: 1, 2, 3 Dec
    expect(listingState({ ...base, subscription: sub, today: '2026-12-04' })).toMatchObject({ listed: false, reason: 'SUBSCRIPTION_ENDED' });
    // an expired subscription does NOT fall back to a still-running trial
    expect(listingState({ ...base, trialDays: 90, subscription: { status: 'ACTIVE', periodEnd: '2026-11-11', graceDays: 0 }, today: '2026-11-12' }).listed).toBe(false);
    expect(listingState({ ...base, subscription: { ...sub, status: 'SUSPENDED' }, today: '2026-11-11' })).toMatchObject({ listed: false, reason: 'SUBSCRIPTION_SUSPENDED' });
  });

  it('parseTrialDays accepts only integers 0..90 and otherwise falls back to the default', () => {
    expect(parseTrialDays({ trialDays: 7 })).toBe(7);
    expect(parseTrialDays({ trialDays: 0 })).toBe(0);
    for (const bad of [undefined, null, 'x', {}, { trialDays: -1 }, { trialDays: 91 }, { trialDays: 1.5 }, { trialDays: '7' }]) {
      expect(parseTrialDays(bad)).toBe(DEFAULT_TRIAL_DAYS);
    }
  });
});
