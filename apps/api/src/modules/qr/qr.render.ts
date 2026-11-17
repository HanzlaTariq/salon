import QRCode from 'qrcode';

/** Colours come from packages/design-tokens/tokens.json (ink, ivory, gold, mutedText). */
export const BRAND = { ink: '#0F0F12', ivory: '#FAF8F5', gold: '#B08D57', muted: '#5F5B54', mutedOnDark: '#B9B4AA' } as const;

/** Quiet zone (in modules) required around every QR code. */
export const QUIET_ZONE = 4;

export interface QrMatrix {
  size: number;
  /** true = dark module. */
  at: (row: number, col: number) => boolean;
}

/** Module matrix for vector drawing (the PDF poster draws squares, not a bitmap, so it stays sharp at any print size). */
export function qrMatrix(text: string, level: 'M' | 'Q' = 'Q'): QrMatrix {
  const qr = QRCode.create(text, { errorCorrectionLevel: level });
  const m = qr.modules;
  return { size: m.size, at: (r, c) => Boolean(m.get(r, c)) };
}

/** Black-on-white PNG. `widthPx` includes the quiet zone. */
export function qrPng(text: string, widthPx: number): Promise<Buffer> {
  return QRCode.toBuffer(text, {
    type: 'png', errorCorrectionLevel: 'M', margin: QUIET_ZONE, width: widthPx, color: { dark: BRAND.ink, light: '#FFFFFF' },
  });
}

/** Scalable SVG with the same colours and quiet zone. */
export function qrSvg(text: string): Promise<string> {
  return QRCode.toString(text, {
    type: 'svg', errorCorrectionLevel: 'M', margin: QUIET_ZONE, color: { dark: BRAND.ink, light: '#FFFFFF' },
  });
}
