import { EMPTY_STARS, REVIEW_LIMITS, authorName, cleanText, editWindow, hasUnsafeText, isRating, reviewWindow, summarise } from './reviews.types';

describe('authorName', () => {
  it.each([
    ['Sara Khan', 'Sara K.'],
    ['sara', 'sara'],
    ['  Ali   Raza   Malik ', 'Ali M.'],
    ['', 'Customer'],
    [null, 'Customer'],
    ['<script>alert(1)</script>', 'script S.'],
    ['Zoë Çelik', 'Zoë Ç.'],
  ])('%j -> %j', (input, expected) => {
    expect(authorName(input as string | null)).toBe(expected);
  });

  it('never returns markup characters and is never longer than 60 characters', () => {
    const n = authorName('<b>' + 'x'.repeat(100) + '</b> & <i>Khan</i>');
    expect(n).not.toMatch(/[<>&]/);
    expect(n.length).toBeLessThanOrEqual(60);
  });
});

describe('cleanText', () => {
  it('trims, normalises line breaks and returns null for empty text', () => {
    expect(cleanText('  nice  ')).toBe('nice');
    expect(cleanText('a\r\n\r\n\r\n\r\nb')).toBe('a\n\nb');
    expect(cleanText('   \n ')).toBeNull();
    expect(cleanText(undefined)).toBeNull();
    expect(cleanText(null)).toBeNull();
  });
  it('flags angle brackets and control characters', () => {
    expect(hasUnsafeText('<b>x</b>')).toBe(true);
    expect(hasUnsafeText('bad\u0000text')).toBe(true);
    expect(hasUnsafeText('great service\nthank you')).toBe(false);
    expect(hasUnsafeText('اچھی سروس')).toBe(false);
  });
});

describe('ratings', () => {
  it('accepts only whole numbers from 1 to 5', () => {
    for (const ok of [1, 2, 3, 4, 5]) expect(isRating(ok)).toBe(true);
    for (const bad of [0, 6, 4.5, -1, NaN, '5', null, undefined]) expect(isRating(bad)).toBe(false);
  });
  it('summarises star counters like the database does', () => {
    expect(summarise(EMPTY_STARS)).toEqual({ average: null, count: 0, distribution: { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 } });
    expect(summarise([0, 0, 0, 1, 2])).toMatchObject({ average: 4.67, count: 3 });
    expect(summarise([1, 0, 0, 0, 1])).toMatchObject({ average: 3, count: 2 });
    expect(summarise([0, 0, 0, 0, 7])).toMatchObject({ average: 5, count: 7 });
    expect(summarise([1, 1, 1, 0, 0]).average).toBe(2);
  });
});

describe('windows', () => {
  const day = 86_400_000;
  const done = new Date('2026-11-01T10:00:00Z');
  it('review window is 30 days after completion and never before completion', () => {
    expect(reviewWindow(done, new Date(done.getTime() + 10 * day)).open).toBe(true);
    expect(reviewWindow(done, new Date(done.getTime() + REVIEW_LIMITS.reviewWindowDays * day)).open).toBe(true);
    expect(reviewWindow(done, new Date(done.getTime() + REVIEW_LIMITS.reviewWindowDays * day + 1)).open).toBe(false);
    expect(reviewWindow(done, new Date(done.getTime() - 1)).open).toBe(false);
  });
  it('edit window is 7 days after writing', () => {
    expect(editWindow(done, new Date(done.getTime() + 6 * day)).open).toBe(true);
    expect(editWindow(done, new Date(done.getTime() + 7 * day + 1)).open).toBe(false);
    expect(editWindow(done, done).closesAt.toISOString()).toBe('2026-11-08T10:00:00.000Z');
  });
});
