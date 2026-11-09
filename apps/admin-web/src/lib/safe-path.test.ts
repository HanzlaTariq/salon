import { describe, expect, it } from 'vitest';
import { safeInternalPath } from './safe-path';

describe('safeInternalPath', () => {
  it.each(['/', '/users', '/users?role=SUPPORT', '/security#mfa'])('accepts %s', (p) => expect(safeInternalPath(p)).toBe(p));

  it.each([
    '//evil.com',
    '///evil.com',
    '/\\evil.com',
    '/%5Cevil.com',
    '/%2F%2Fevil.com/x',
    'https://evil.com',
    'javascript:alert(1)',
    'evil.com',
    '/\tfoo',
    '/\nfoo',
    '/%0d%0aSet-Cookie:x=1',
    '',
    '/login',
    '/reset-password#token=abc',
    '/' + 'a'.repeat(400),
  ])('rejects %j', (p) => expect(safeInternalPath(p)).toBe('/'));

  it('handles null/undefined and custom fallback', () => {
    expect(safeInternalPath(null)).toBe('/');
    expect(safeInternalPath(undefined, '/home')).toBe('/home');
  });
});
