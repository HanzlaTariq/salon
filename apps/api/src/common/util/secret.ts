import { createHash, timingSafeEqual } from 'crypto';

/** Constant-time comparison of a shared secret (SHA-256 first, so both sides always have the same length). */
export function secretMatches(expected: string | undefined, given: string | undefined): boolean {
  if (!expected || !given) return false;
  const a = createHash('sha256').update(expected).digest();
  const b = createHash('sha256').update(given).digest();
  return timingSafeEqual(a, b);
}
