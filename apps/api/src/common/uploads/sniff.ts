export type SniffedType = 'jpeg' | 'png' | 'webp' | 'pdf';

/**
 * Identifies a file by its CONTENT (magic bytes). The client-supplied file name and Content-Type
 * are never trusted. Anything not on this short allow-list (SVG, GIF, HEIC, HTML, executables,
 * archives, ...) returns null and is rejected.
 */
export function sniffFileType(buf: Buffer): SniffedType | null {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  if (buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  return null;
}
