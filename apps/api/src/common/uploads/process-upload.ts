import { createHash } from 'crypto';
import sharp from 'sharp';
import { AppException } from '../errors/app-exception';
import { sniffFileType } from './sniff';

export interface ProcessedUpload {
  body: Buffer;
  contentType: 'image/webp' | 'application/pdf';
  ext: 'webp' | 'pdf';
  sha256: string;
  sizeBytes: number;
}

const MAX_EDGE_PX = 2400;
const MIN_EDGE_PX = 200;
const MAX_INPUT_PIXELS = 40_000_000; // decompression-bomb guard (a 9000x9000 PNG is tiny on the wire)
const WEBP_QUALITY = 82;

/**
 * Tokens that make a PDF active (scripts, launch actions, embedded files, forms with scripts).
 * This is a HEURISTIC: object streams can hide dictionaries, so it only blocks the obvious. The real
 * mitigations are: documents are admin-only, served as a download (not rendered inline) from a
 * private bucket via a short-lived signed URL (see docs/PHASE3.md, risk R17).
 */
const PDF_ACTIVE_CONTENT = /\/(JavaScript|JS|Launch|EmbeddedFile|OpenAction|RichMedia|XFA|SubmitForm|ImportData)\b/;

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * Validates and NORMALISES an uploaded file:
 *  - type is decided from magic bytes (JPEG/PNG/WebP, plus PDF when `allowPdf`);
 *  - images are fully decoded and re-encoded as WebP (strips EXIF/GPS, polyglot payloads, trailing data),
 *    auto-rotated, capped at 2400px;
 *  - corrupt or truncated images are rejected instead of being stored.
 */
export async function processUpload(input: Buffer, opts: { allowPdf: boolean; maxBytes: number }): Promise<ProcessedUpload> {
  if (input.length === 0) throw new AppException('VALIDATION_FAILED', 'The file is empty.', 400);
  if (input.length > opts.maxBytes) throw new AppException('PAYLOAD_TOO_LARGE', 'The file is too large.', 413);

  const type = sniffFileType(input);
  if (!type) {
    throw new AppException('UNSUPPORTED_MEDIA_TYPE', `Unsupported file type. Allowed: JPEG, PNG, WebP${opts.allowPdf ? ', PDF' : ''}.`, 415);
  }

  if (type === 'pdf') {
    if (!opts.allowPdf) throw new AppException('UNSUPPORTED_MEDIA_TYPE', 'Photos must be JPEG, PNG or WebP images.', 415);
    if (PDF_ACTIVE_CONTENT.test(input.toString('latin1'))) {
      throw new AppException('VALIDATION_FAILED', 'This PDF contains active content and cannot be accepted. Upload a scan or photo instead.', 400);
    }
    return { body: input, contentType: 'application/pdf', ext: 'pdf', sha256: sha256(input), sizeBytes: input.length };
  }

  try {
    const { data, info } = await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' })
      .rotate() // honour EXIF orientation, then metadata is dropped on output
      .resize({ width: MAX_EDGE_PX, height: MAX_EDGE_PX, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: WEBP_QUALITY })
      .toBuffer({ resolveWithObject: true });
    if (info.width < MIN_EDGE_PX || info.height < MIN_EDGE_PX) {
      throw new AppException('VALIDATION_FAILED', `The image is too small (minimum ${MIN_EDGE_PX}x${MIN_EDGE_PX} pixels).`, 400);
    }
    return { body: data, contentType: 'image/webp', ext: 'webp', sha256: sha256(data), sizeBytes: data.length };
  } catch (err) {
    if (err instanceof AppException) throw err;
    throw new AppException('VALIDATION_FAILED', 'The image could not be read. It may be corrupt or too large in pixels.', 400);
  }
}
