import jsQR from 'jsqr';
import sharp from 'sharp';
import { qrMatrix, qrPng, qrSvg } from './qr.render';

const LINK = 'https://book.example.com/s/abcd2fgh3j';

async function decode(png: Buffer): Promise<string | null> {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return jsQR(new Uint8ClampedArray(data), info.width, info.height)?.data ?? null;
}

describe('QR rendering', () => {
  it('a PNG decodes back to exactly the link, at small and large sizes', async () => {
    for (const px of [256, 512, 1024]) {
      const png = await qrPng(LINK, px);
      expect((await sharp(png).metadata()).format).toBe('png');
      expect(await decode(png)).toBe(LINK);
    }
  }, 60_000);

  it('the SVG is a valid standalone vector image', async () => {
    const svg = await qrSvg(LINK);
    expect(svg.startsWith('<?xml') || svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('</svg>');
    expect(svg).not.toMatch(/<script/i);
  });

  it('the module matrix (used by the poster) is square and holds the three finder patterns', () => {
    const m = qrMatrix(LINK, 'Q');
    expect(m.size).toBeGreaterThanOrEqual(21);
    for (const [r, c] of [[0, 0], [0, m.size - 1], [m.size - 1, 0]]) expect(m.at(r, c)).toBe(true);
  });
});
