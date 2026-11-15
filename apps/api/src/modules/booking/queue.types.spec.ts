import { slotMs } from './booking.types';
import {
  ProjectedItem, QueueItem, arrivalDecision, ceilToGrid, earlyOfferBounds, estimateChanged, etaInstant, isValidEtaMinutes, karachiDayBounds, noShowDecision,
  projectQueue, startDecision, walkInFingerprint,
} from './queue.types';

const MIN = 60_000;
const DAY = '2026-11-16'; // a Monday
const at = (minute: number) => slotMs(DAY, minute);
const item = (id: string, startMin: number, dur: number, extra: Partial<QueueItem> = {}): QueueItem => ({
  id, status: 'CONFIRMED', startsAtMs: at(startMin), durationMinutes: dur, bufferMinutes: 0, startedAtMs: null, customerEtaAtMs: null, ...extra,
});
const get = (items: ProjectedItem[], id: string) => items.find((i) => i.id === id) as ProjectedItem;

describe('projectQueue (delay propagation)', () => {
  it('a day that runs on time has no estimates', () => {
    const p = projectQueue([item('a', 600, 30), item('b', 630, 30)], at(590));
    expect(get(p.items, 'a').estimatedStartsAtMs).toBeNull();
    expect(get(p.items, 'b').delayMinutes).toBe(0);
  });

  it('an overrunning service pushes the next customers back (10 minutes late -> 10 minutes estimate), original time untouched', () => {
    const cur = item('cur', 600, 30, { status: 'IN_PROGRESS', startedAtMs: at(600) });
    const p = projectQueue([cur, item('b', 630, 30), item('c', 660, 30)], at(640)); // expected end 630, now 640
    expect(get(p.items, 'cur').overrunMinutes).toBe(10);
    expect(get(p.items, 'b').estimatedStartsAtMs).toBe(at(640));
    expect(get(p.items, 'b').delayMinutes).toBe(10);
    expect(get(p.items, 'c').estimatedStartsAtMs).toBe(at(670)); // chain: b runs 640-670
    expect(p.freeAtMs).toBe(ceilToGrid(at(640)));
  });

  it('a service started late ends late; started early frees time earlier', () => {
    const late = projectQueue([item('cur', 600, 30, { status: 'IN_PROGRESS', startedAtMs: at(615) }), item('b', 630, 30)], at(620));
    expect(get(late.items, 'b').estimatedStartsAtMs).toBe(at(645));
    const early = projectQueue([item('cur', 600, 30, { status: 'IN_PROGRESS', startedAtMs: at(590) }), item('b', 630, 30)], at(595));
    expect(get(early.items, 'b').estimatedStartsAtMs).toBeNull(); // never earlier than booked without consent
    expect(early.freeAtMs).toBe(at(620)); // but the staff member is free at 10:20 (an early offer is possible)
  });

  it('delays under 5 minutes are not published (judged before rounding to the grid)', () => {
    const cur = item('cur', 600, 30, { status: 'IN_PROGRESS', startedAtMs: at(600) });
    const small = projectQueue([cur, item('b', 630, 30)], at(633));
    expect(get(small.items, 'b').delayMinutes).toBe(3);
    expect(get(small.items, 'b').estimatedStartsAtMs).toBeNull();
    expect(get(projectQueue([cur, item('b', 630, 30)], at(630) + 20_000).items, 'b').estimatedStartsAtMs).toBeNull();
    const five = projectQueue([cur, item('b', 630, 30)], at(635));
    expect(get(five.items, 'b').estimatedStartsAtMs).toBe(at(635));
    const odd = projectQueue([cur, item('b', 630, 30)], at(636));
    expect(get(odd.items, 'b').estimatedStartsAtMs).toBe(at(640)); // published values sit on the 5-minute grid
  });

  it('the buffer is kept between customers', () => {
    const cur = { ...item('cur', 600, 30, { status: 'IN_PROGRESS', startedAtMs: at(600) }), bufferMinutes: 10 };
    const p = projectQueue([cur, item('b', 630, 30)], at(640));
    expect(get(p.items, 'b').projectedStartMs).toBe(at(650));
  });

  it("uses the customer's own ETA and never starts a customer before their booked time", () => {
    const p = projectQueue([item('b', 600, 30, { customerEtaAtMs: at(620) }), item('c', 630, 30)], at(605));
    expect(get(p.items, 'b').estimatedStartsAtMs).toBe(at(620));
    expect(get(p.items, 'c').estimatedStartsAtMs).toBe(at(650));
  });

  it('a customer who is late without any message is shown as delayed until staff mark a no-show', () => {
    const p = projectQueue([item('b', 600, 30), item('c', 630, 30)], at(615));
    expect(get(p.items, 'b').estimatedStartsAtMs).toBe(at(615));
    expect(get(p.items, 'c').estimatedStartsAtMs).toBe(at(645));
  });

  it('is empty-safe', () => {
    const p = projectQueue([], at(600));
    expect(p.items).toEqual([]);
    expect(p.freeAtMs).toBe(ceilToGrid(at(600)));
  });
});

describe('estimateChanged', () => {
  it('only saves shifts of 5 minutes or more, or appearing / disappearing estimates', () => {
    expect(estimateChanged(null, null)).toBe(false);
    expect(estimateChanged(null, at(640))).toBe(true);
    expect(estimateChanged(at(640), null)).toBe(true);
    expect(estimateChanged(at(640), at(643))).toBe(false);
    expect(estimateChanged(at(640), at(645))).toBe(true);
  });
});

describe('start / no-show decisions', () => {
  it('start: only CONFIRMED, and not more than 60 minutes early', () => {
    expect(startDecision('CONFIRMED', at(700), at(640)).allowed).toBe(true);
    expect(startDecision('CONFIRMED', at(700), at(639)).reason).toBe('TOO_EARLY');
    expect(startDecision('COMPLETED', at(700), at(700)).reason).toBe('STATUS');
    expect(startDecision('IN_PROGRESS', at(700), at(700)).reason).toBe('STATUS');
  });

  it('no-show: never before the grace period, counted from the booked time or the later customer ETA', () => {
    const policy = { noShowGraceMinutes: 15 };
    expect(noShowDecision(policy, 'CONFIRMED', at(600), null, at(614)).reason).toBe('GRACE');
    expect(noShowDecision(policy, 'CONFIRMED', at(600), null, at(615)).allowed).toBe(true);
    expect(noShowDecision(policy, 'CONFIRMED', at(600), at(630), at(640)).reason).toBe('GRACE'); // ETA 10:30 + 15 = 10:45
    expect(noShowDecision(policy, 'CONFIRMED', at(600), at(630), at(645)).allowed).toBe(true);
    expect(noShowDecision(policy, 'IN_PROGRESS', at(600), null, at(700)).reason).toBe('STATUS');
    expect(noShowDecision(policy, 'CANCELLED', at(600), null, at(700)).allowed).toBe(false);
  });
});

describe('early offer bounds', () => {
  it('offers the first grid time after the staff member is free (and 5 minutes of reaction time), if it saves 10+ minutes', () => {
    const b = earlyOfferBounds(at(900), at(880), at(880));
    expect(b).toEqual({ earliestMs: at(885), gainMinutes: 15 });
  });
  it('no offer when the gain is smaller than 10 minutes', () => {
    expect(earlyOfferBounds(at(900), at(890), at(890))).toBeNull();
  });
  it('a staff member still busy pushes the offer later', () => {
    expect(earlyOfferBounds(at(900), at(870), at(860))?.earliestMs).toBe(at(870));
  });
});

describe('arrival decision and ETA', () => {
  it('window: 3 hours before to 4 hours after, CONFIRMED only, at most 10 reports', () => {
    expect(arrivalDecision('CONFIRMED', at(900), at(719), 0).reason).toBe('TOO_EARLY');
    expect(arrivalDecision('CONFIRMED', at(900), at(720), 0).allowed).toBe(true);
    expect(arrivalDecision('CONFIRMED', at(900), at(1141), 0).reason).toBe('TOO_LATE');
    expect(arrivalDecision('CONFIRMED', at(900), at(900), 10).reason).toBe('LIMIT');
    expect(arrivalDecision('NO_SHOW', at(900), at(900), 0).reason).toBe('STATUS');
  });
  it('ETA minutes: whole numbers 1..120; instant rounds up to the minute', () => {
    expect([0, 1, 120, 121, 2.5, NaN].map(isValidEtaMinutes)).toEqual([false, true, true, false, false, false]);
    expect(etaInstant(at(600) + 30_000, 10)).toBe(at(611));
  });
});

describe('misc', () => {
  it('Karachi day bounds', () => {
    const b = karachiDayBounds(Date.parse('2026-11-15T20:30:00Z')); // 01:30 on the 16th in Karachi
    expect(b.date).toBe(DAY);
    expect(b.dayStart.getTime()).toBe(slotMs(DAY, 0));
    expect(b.dayEnd.getTime() - b.dayStart.getTime()).toBe(1440 * MIN);
  });
  it('walk-in fingerprint ignores the order of services and differs for a different request', () => {
    const base = { staffId: 's', serviceIds: ['b', 'a'], name: 'Ali', phone: null, note: null };
    expect(walkInFingerprint(base)).toBe(walkInFingerprint({ ...base, serviceIds: ['a', 'b'] }));
    expect(walkInFingerprint(base)).not.toBe(walkInFingerprint({ ...base, name: 'Bilal' }));
  });
});
