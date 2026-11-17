import PDFDocument from 'pdfkit';
import { BRAND, QUIET_ZONE, qrMatrix } from './qr.render';
import { PosterSize, PosterTheme, SALON_TYPE_LABEL, displayLink, hasPrintableName, toPosterText } from './qr.types';

export interface PosterInput {
  salonName: string;
  salonType: string;
  city: string;
  area: string;
  addressLine: string;
  phone: string;
  /** The full link encoded in the QR code. */
  link: string;
  brandName: string;
  size: PosterSize;
  theme: PosterTheme;
}

const PAGE: Record<PosterSize, [number, number]> = { A4: [595.28, 841.89], A5: [419.53, 595.28] };

/**
 * One-page printable poster (vector QR, built-in Helvetica, no external files). Every coordinate is designed on A4 and scaled,
 * all text is sanitised (see toPosterText) and long text is fitted or truncated, so the output is always exactly one page.
 */
export function renderPoster(input: PosterInput): Promise<Buffer> {
  const [W, H] = PAGE[input.size];
  const k = W / PAGE.A4[0];
  const dark = input.theme === 'dark';
  const text = dark ? BRAND.ivory : BRAND.ink;
  const muted = dark ? BRAND.mutedOnDark : BRAND.muted;

  const name = hasPrintableName(input.salonName) ? toPosterText(input.salonName) : 'Our Salon';
  const brand = toPosterText(input.brandName) || 'Salon Platform';
  const typeLabel = SALON_TYPE_LABEL[input.salonType] ?? 'Salon';
  const where = toPosterText(`${input.area}, ${input.city}`).slice(0, 90);
  const address = toPosterText(input.addressLine).slice(0, 160);
  const phone = toPosterText(input.phone).slice(0, 24);
  const link = displayLink(input.link);

  const doc = new PDFDocument({
    size: [W, H], margin: 0, autoFirstPage: true,
    info: { Title: `${name} - Scan to Book`, Author: brand, Subject: 'Salon booking poster' },
  });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const m = 48 * k;
  const inner = W - 2 * m;
  const centered = (t: string, y: number, font: string, size: number, color: string, extra: Record<string, unknown> = {}) => {
    doc.font(font).fontSize(size * k).fillColor(color).text(t, m, y, { width: inner, align: 'center', ...extra });
  };

  // background
  doc.rect(0, 0, W, H).fill(dark ? BRAND.ink : '#FFFFFF');

  // brand line + gold rule
  centered(brand.toUpperCase(), 44 * k, 'Helvetica-Bold', 10, BRAND.gold, { characterSpacing: 3, lineBreak: false });
  doc.moveTo(W / 2 - 22 * k, 68 * k).lineTo(W / 2 + 22 * k, 68 * k).lineWidth(1.5 * k).strokeColor(BRAND.gold).stroke();

  // salon name: the largest size (46 down to 20) that fits in two lines
  let nameSize = 46;
  for (; nameSize > 20; nameSize -= 2) {
    doc.font('Helvetica-Bold').fontSize(nameSize * k);
    if (doc.heightOfString(name, { width: inner }) <= nameSize * k * 2.4) break;
  }
  const nameY = 92 * k;
  doc.font('Helvetica-Bold').fontSize(nameSize * k).fillColor(text).text(name, m, nameY, { width: inner, align: 'center', height: nameSize * k * 2.4, ellipsis: true });
  const nameBottom = nameY + Math.min(doc.heightOfString(name, { width: inner }), nameSize * k * 2.4);
  centered(`${typeLabel}  ·  ${where}`, nameBottom + 10 * k, 'Helvetica', 13, muted, { lineBreak: false });

  // QR card (always white so the code scans on both themes)
  const card = 292 * k;
  const cardX = (W - card) / 2;
  const cardY = Math.max(nameBottom + 56 * k, 250 * k);
  doc.roundedRect(cardX, cardY, card, card, 14 * k).fillAndStroke('#FFFFFF', BRAND.gold);
  const qr = qrMatrix(input.link, 'Q');
  const cell = card / (qr.size + 2 * QUIET_ZONE);
  doc.fillColor(BRAND.ink);
  for (let r = 0; r < qr.size; r++) {
    for (let c = 0; c < qr.size; c++) {
      if (qr.at(r, c)) doc.rect(cardX + (c + QUIET_ZONE) * cell, cardY + (r + QUIET_ZONE) * cell, cell + 0.2, cell + 0.2).fill();
    }
  }

  // call to action + steps
  const ctaY = cardY + card + 26 * k;
  centered('SCAN TO BOOK YOUR APPOINTMENT', ctaY, 'Helvetica-Bold', 19, text, { lineBreak: false });
  const steps = ['Open your phone camera and point it at the code.', 'Choose your services and your stylist.', 'Pick a time and confirm. You pay the salon directly.'];
  steps.forEach((s, i) => centered(`${i + 1}.  ${s}`, ctaY + 38 * k + i * 20 * k, 'Helvetica', 12, muted, { lineBreak: false }));

  // bottom block, anchored to the bottom margin
  doc.font('Helvetica').fontSize(12 * k);
  const addrH = doc.heightOfString(address, { width: inner });
  const blockH = addrH + 18 * k + 16 * k + 14 * k;
  let y = H - 44 * k - blockH;
  centered(address, y, 'Helvetica', 12, text, { height: addrH + 2 });
  y += addrH + 6 * k;
  centered(phone, y, 'Helvetica-Bold', 12, text, { lineBreak: false });
  y += 22 * k;
  centered(`or visit  ${link}`, y, 'Helvetica', 9.5, muted, { lineBreak: false });
  centered(`Booking powered by ${brand}`, H - 34 * k, 'Helvetica', 8.5, muted, { lineBreak: false });

  doc.end();
  return done;
}
