import { describe, expect, it } from 'vitest';
import { pkr } from './types';

describe('pkr()', () => {
  it('formats decimal strings without floating point', () => {
    expect(pkr('600.00')).toBe('Rs. 600.00');
    expect(pkr('1234567.5')).toBe('Rs. 1,234,567.50');
    expect(pkr('0.07')).toBe('Rs. 0.07');
    expect(pkr('-25.00')).toBe('-Rs. 25.00');
    expect(pkr('9999999999999999.99')).toBe('Rs. 9,999,999,999,999,999.99'); // would lose precision as a float
  });
  it('shows a dash for missing values', () => {
    expect(pkr(null)).toBe('-');
    expect(pkr(undefined)).toBe('-');
  });
});
