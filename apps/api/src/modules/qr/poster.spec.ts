import { renderPoster, PosterInput } from './poster';

const base: PosterInput = {
  salonName: 'Glow Studio', salonType: 'LADIES', city: 'Lahore', area: 'Gulberg', addressLine: '12 Main Boulevard, Gulberg III',
  phone: '0300 1234567', link: 'https://book.example.com/s/abcd2fgh3j', brandName: 'Salon Platform', size: 'A4', theme: 'light',
};
const pages = (pdf: Buffer) => (pdf.toString('latin1').match(/\/Type \/Page(?!s)/g) ?? []).length;
const mediaBox = (pdf: Buffer) => /\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/.exec(pdf.toString('latin1'))!.slice(1).map(Number);

describe('poster PDF', () => {
  it('is a valid one-page A4 PDF', async () => {
    const pdf = await renderPoster(base);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.subarray(-8).toString()).toContain('%%EOF');
    expect(pages(pdf)).toBe(1);
    const [w, h] = mediaBox(pdf);
    expect(Math.round(w)).toBe(595);
    expect(Math.round(h)).toBe(842);
    expect(pdf.length).toBeGreaterThan(1500);
    expect(pdf.length).toBeLessThan(150_000);
  });

  it('A5 and the dark theme are also one page, with their own size', async () => {
    const pdf = await renderPoster({ ...base, size: 'A5', theme: 'dark' });
    expect(pages(pdf)).toBe(1);
    expect(Math.round(mediaBox(pdf)[0])).toBe(420);
  });

  it('hostile or extreme salon text never breaks the layout (always exactly one page)', async () => {
    const cases: Array<Partial<PosterInput>> = [
      { salonName: 'A'.repeat(120), addressLine: 'B'.repeat(250), area: 'C'.repeat(80), phone: '9'.repeat(40) },
      { salonName: 'سیلون', addressLine: 'لاہور', area: 'گلبرگ', city: 'لاہور' },
      { salonName: '(a) \\ ) ( 💇 <script>alert(1)</script>', addressLine: 'x\ny\tz\u0000' },
      { salonName: 'Word '.repeat(40), salonType: 'UNKNOWN' },
    ];
    for (const c of cases) {
      for (const size of ['A4', 'A5'] as const) {
        const pdf = await renderPoster({ ...base, ...c, size });
        expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
        expect(pages(pdf)).toBe(1);
      }
    }
  });
});
