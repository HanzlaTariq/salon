import { describe, expect, it } from 'vitest';
import { pagesOf, reasonError, stars, when } from './types';

describe('review moderation helpers', () => {
  it('draws stars and clamps odd values', () => {
    expect(stars(5)).toBe('★★★★★');
    expect(stars(3)).toBe('★★★☆☆');
    expect(stars(4.4)).toBe('★★★★☆');
    expect(stars(9)).toBe('★★★★★');
    expect(stars(-2)).toBe('☆☆☆☆☆');
    expect(stars(null)).toBe('-');
    expect(stars(Number.NaN)).toBe('-');
  });
  it('counts pages', () => {
    expect(pagesOf(0, 20)).toBe(1);
    expect(pagesOf(41, 20)).toBe(3);
    expect(pagesOf(5, 0)).toBe(5);
  });
  it('validates the moderator reason like the API', () => {
    expect(reasonError('  ')).not.toBeNull();
    expect(reasonError('ab')).not.toBeNull();
    expect(reasonError('Offensive language')).toBeNull();
    expect(reasonError('x'.repeat(301))).not.toBeNull();
    expect(reasonError('<b>bad</b>')).not.toBeNull();
  });
  it('formats times in Pakistan time and survives bad input', () => {
    expect(when('2026-11-20T10:00:00Z')).toContain('15:00');
    expect(when(null)).toBe('-');
    expect(when('nonsense')).toBe('-');
  });
});
