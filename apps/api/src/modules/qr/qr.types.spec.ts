import { QR_CODE_ALPHABET, QR_CODE_RE, displayLink, fileSlug, hasPrintableName, normalizeCode, salonLink, toPosterText } from './qr.types';

describe('salon link rules', () => {
  it('the alphabet has 31 characters and no look-alikes', () => {
    expect(QR_CODE_ALPHABET).toHaveLength(31);
    expect(new Set(QR_CODE_ALPHABET).size).toBe(31);
    for (const bad of 'ilo01') expect(QR_CODE_ALPHABET).not.toContain(bad);
    expect(QR_CODE_RE.test('abcdefghjk')).toBe(true);
  });

  it('normalizeCode accepts any case and spaces, rejects everything else', () => {
    expect(normalizeCode('  ABCD2FGH3J ')).toBe('abcd2fgh3j');
    for (const bad of ['', 'abc', 'abcd2fgh3jk', 'abcd2fgh3i', 'abcd2fgh30', "abcd2fgh3';", 'abcd2fgh3\n', null, undefined, 42, {}]) {
      expect(normalizeCode(bad)).toBeNull();
    }
  });

  it('builds the link from the configured base only', () => {
    expect(salonLink('https://book.example.com/', 'abcd2fgh3j')).toBe('https://book.example.com/s/abcd2fgh3j');
    expect(salonLink('https://book.example.com', 'abcd2fgh3j')).toBe('https://book.example.com/s/abcd2fgh3j');
    expect(displayLink('https://book.example.com/s/abcd2fgh3j')).toBe('book.example.com/s/abcd2fgh3j');
  });
});

describe('poster text safety', () => {
  it('keeps Latin text and maps typographic punctuation', () => {
    expect(toPosterText('Glow Studio')).toBe('Glow Studio');
    expect(toPosterText('Café “Noor” – Salon')).toBe('Café "Noor" - Salon');
  });
  it('replaces anything a built-in PDF font cannot draw and collapses whitespace and control characters', () => {
    expect(toPosterText('سیلون')).toBe('?????');
    expect(toPosterText('A\u0000B\n\tC 💇')).toBe('A?B C ?');
    expect(toPosterText('  a   b  ')).toBe('a b');
  });
  it('detects names that cannot be printed', () => {
    expect(hasPrintableName('Glow')).toBe(true);
    expect(hasPrintableName('سیلون')).toBe(false);
    expect(hasPrintableName('💇💇')).toBe(false);
  });
  it('file slugs are safe ASCII', () => {
    expect(fileSlug('Glow Studio & Spa!')).toBe('glow-studio-spa');
    expect(fileSlug('../../etc/passwd')).toBe('etc-passwd');
    expect(fileSlug('سیلون')).toBe('salon');
    expect(fileSlug('x'.repeat(200)).length).toBeLessThanOrEqual(40);
  });
});
