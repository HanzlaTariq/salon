import sharp from 'sharp';
import { AppException } from '../errors/app-exception';
import { processUpload } from './process-upload';
import { sniffFileType } from './sniff';

const OPTS = { allowPdf: true, maxBytes: 5 * 1024 * 1024 };
const png = (w = 400, h = 300) =>
  sharp({ create: { width: w, height: h, channels: 3, background: { r: 200, g: 120, b: 60 } } }).png().toBuffer();

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof AppException) return e.code;
    throw e;
  }
  return 'NO_ERROR';
}

describe('sniffFileType', () => {
  it('detects real types by content and ignores everything else', async () => {
    expect(sniffFileType(await png())).toBe('png');
    expect(sniffFileType(await sharp({ create: { width: 8, height: 8, channels: 3, background: '#fff' } }).jpeg().toBuffer())).toBe('jpeg');
    expect(sniffFileType(await sharp({ create: { width: 8, height: 8, channels: 3, background: '#fff' } }).webp().toBuffer())).toBe('webp');
    expect(sniffFileType(Buffer.from('%PDF-1.7\n%....'))).toBe('pdf');
    expect(sniffFileType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'))).toBeNull();
    expect(sniffFileType(Buffer.from('<html><script>alert(1)</script></html>'))).toBeNull();
    expect(sniffFileType(Buffer.from('GIF89a\x01\x00\x01\x00\x80\x00\x00\xff\xff\xff'))).toBeNull();
    expect(sniffFileType(Buffer.from('MZ\x90\x00\x03\x00\x00\x00\x04\x00\x00\x00\xff\xff'))).toBeNull();
    expect(sniffFileType(Buffer.from('PK\x03\x04\x14\x00\x00\x00\x08\x00\x00\x00'))).toBeNull();
    expect(sniffFileType(Buffer.alloc(0))).toBeNull();
  });
});

describe('processUpload', () => {
  it('re-encodes images as WebP, with a hash and size of the stored bytes', async () => {
    const out = await processUpload(await png(), OPTS);
    expect(out.contentType).toBe('image/webp');
    expect(out.ext).toBe('webp');
    expect(sniffFileType(out.body)).toBe('webp');
    expect(out.sizeBytes).toBe(out.body.length);
    expect(out.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('strips EXIF/GPS metadata', async () => {
    const withExif = await sharp({ create: { width: 400, height: 300, channels: 3, background: '#888' } })
      .jpeg()
      .withExif({ IFD0: { Copyright: 'secret-owner-gps-marker' } })
      .toBuffer();
    expect(withExif.toString('latin1')).toContain('secret-owner-gps-marker');
    const out = await processUpload(withExif, OPTS);
    expect(out.body.toString('latin1')).not.toContain('secret-owner-gps-marker');
    expect((await sharp(out.body).metadata()).exif).toBeUndefined();
  });

  it('drops trailing payloads appended to a valid image (polyglot files)', async () => {
    const polyglot = Buffer.concat([await png(), Buffer.from('<?php system($_GET["c"]); ?>')]);
    const out = await processUpload(polyglot, OPTS);
    expect(out.body.toString('latin1')).not.toContain('<?php');
  });

  it('downsizes very large images', async () => {
    const out = await processUpload(await png(3000, 1000), OPTS);
    expect((await sharp(out.body).metadata()).width).toBe(2400);
  });

  it('rejects SVG, HTML, GIF, executables and text renamed as images (415)', async () => {
    for (const bad of ['<svg xmlns="http://www.w3.org/2000/svg"/>', '<html></html>', 'GIF89a\x01\x00\x01\x00\x80\x00\x00', 'just some text pretending to be a jpg']) {
      expect(await code(processUpload(Buffer.from(bad.padEnd(40, ' ')), OPTS))).toBe('UNSUPPORTED_MEDIA_TYPE');
    }
  });

  it('rejects corrupt/truncated images instead of storing them (400)', async () => {
    const whole = await png();
    expect(await code(processUpload(whole.subarray(0, Math.floor(whole.length / 2)), OPTS))).toBe('VALIDATION_FAILED');
    const header = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 1)]);
    expect(await code(processUpload(header, OPTS))).toBe('VALIDATION_FAILED');
  });

  it('rejects decompression bombs (huge pixel count, tiny file)', async () => {
    const bomb = await sharp({ create: { width: 9000, height: 9000, channels: 3, background: '#000' } }).png({ compressionLevel: 9 }).toBuffer();
    expect(bomb.length).toBeLessThan(5 * 1024 * 1024);
    expect(await code(processUpload(bomb, OPTS))).toBe('VALIDATION_FAILED');
  }, 30_000);

  it('rejects tiny images and empty / oversized files', async () => {
    expect(await code(processUpload(await png(50, 50), OPTS))).toBe('VALIDATION_FAILED');
    expect(await code(processUpload(Buffer.alloc(0), OPTS))).toBe('VALIDATION_FAILED');
    expect(await code(processUpload(await png(), { ...OPTS, maxBytes: 100 }))).toBe('PAYLOAD_TOO_LARGE');
  });

  it('accepts a clean PDF only where PDFs are allowed, and refuses active content', async () => {
    const pdf = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF');
    expect((await processUpload(pdf, OPTS)).contentType).toBe('application/pdf');
    expect(await code(processUpload(pdf, { ...OPTS, allowPdf: false }))).toBe('UNSUPPORTED_MEDIA_TYPE');
    for (const evil of ['/JavaScript', '/JS (app.alert(1))', '/Launch', '/OpenAction', '/EmbeddedFile']) {
      const bad = Buffer.from(`%PDF-1.4\n1 0 obj<</Type/Catalog ${evil}>>endobj\n%%EOF`);
      expect(await code(processUpload(bad, OPTS))).toBe('VALIDATION_FAILED');
    }
  });
});
