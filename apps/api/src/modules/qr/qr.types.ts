/**
 * Phase 11: pure rules for the permanent salon link. No I/O here, so everything is unit-tested.
 *
 * The code is created by the database (`salon_qr_new_code()`): 10 characters from a 31-character alphabet without
 * look-alikes (no i, l, o, 0, 1). It is random and unrelated to the salon, so it cannot be guessed from a name or an id.
 */
export const QR_CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
export const QR_CODE_RE = /^[a-hj-km-np-z2-9]{10}$/;

/** People type and print codes in any case; the stored form is lower case. Returns null when it cannot be a code. */
export function normalizeCode(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const c = input.trim().toLowerCase();
  return QR_CODE_RE.test(c) ? c : null;
}

/** <base>/s/<code>. The base comes from PUBLIC_LINK_BASE_URL (server configuration), never from a request. */
export function salonLink(base: string, code: string): string {
  return `${base.replace(/\/+$/, '')}/s/${code}`;
}

/** Link without the scheme, for printing as plain text on a poster ("book.example.com/s/abcd2fgh3j"). */
export function displayLink(link: string): string {
  return link.replace(/^https?:\/\//, '');
}

export const POSTER_SIZES = ['A4', 'A5'] as const;
export type PosterSize = (typeof POSTER_SIZES)[number];
export const POSTER_THEMES = ['light', 'dark'] as const;
export type PosterTheme = (typeof POSTER_THEMES)[number];
export const QR_IMAGE_FORMATS = ['png', 'svg'] as const;
export type QrImageFormat = (typeof QR_IMAGE_FORMATS)[number];

export const QR_LIMITS = { minPx: 256, maxPx: 2048, defaultPx: 1024 } as const;

const PUNCTUATION: Record<string, string> = {
  '‘': "'", '’': "'", '“': '"', '”': '"', '–': '-', '—': '-', '…': '...', ' ': ' ',
};

/**
 * The poster uses the built-in PDF fonts (Helvetica), which hold Latin letters only. Anything else (Urdu, emoji, control characters)
 * is replaced by "?" so the PDF can never fail or render garbage because of a salon's text. See risk R109.
 */
export function toPosterText(input: string): string {
  let out = '';
  for (const ch of input.normalize('NFC')) {
    const mapped = PUNCTUATION[ch] ?? ch;
    for (const c of mapped) {
      const n = c.codePointAt(0)!;
      out += n === 0x09 || n === 0x0a || n === 0x0d ? ' ' : (n >= 0x20 && n <= 0x7e) || (n >= 0xa1 && n <= 0xff) ? c : '?';
    }
  }
  return out.replace(/\s+/g, ' ').trim();
}

/** True when at least two letters or digits of the text survive toPosterText. */
export function hasPrintableName(text: string): boolean {
  return (toPosterText(text).match(/[A-Za-z0-9À-ÿ]/g) ?? []).length >= 2;
}

export const SALON_TYPE_LABEL: Record<string, string> = { MEN: "Men's Salon", LADIES: 'Ladies Salon', UNISEX: 'Unisex Salon' };

/** ASCII file name for downloads, e.g. "glow-studio". */
export function fileSlug(name: string): string {
  const s = toPosterText(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return s || 'salon';
}
