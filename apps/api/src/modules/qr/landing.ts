import { SALON_TYPE_LABEL } from './qr.types';

/** HTML-escapes text for element content and double-quoted attributes. Every dynamic value below goes through it. */
export const esc = (v: unknown): string =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Page CSP: no scripts, no external resources, inline <style> only. Set on this route only (the API default is default-src 'none'). */
export const LANDING_CSP = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

export interface LandingSalon {
  name: string; salonType: string; city: string; area: string; addressLine: string; phone: string;
}
export interface LandingOptions { brandName: string; code: string; androidUrl?: string; iosUrl?: string }

const CSS = `
:root{--ink:#0F0F12;--ivory:#FAF8F5;--sand:#EFEAE2;--gold:#B08D57;--muted:#5F5B54;--border:#E3DDD2}
@media (prefers-color-scheme:dark){:root{--ink:#FAF8F5;--ivory:#0F0F12;--sand:#16161A;--muted:#B9B4AA;--border:#2A2A30}}
*{box-sizing:border-box}body{margin:0;background:var(--ivory);color:var(--ink);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:30rem;margin:0 auto;padding:2.5rem 1rem 3rem}
.brand{font-size:.75rem;letter-spacing:.2em;text-transform:uppercase;color:var(--gold);font-weight:700;text-align:center}
.rule{width:2.5rem;height:2px;background:var(--gold);margin:.75rem auto 1.5rem}
h1{font:700 2rem/1.15 Georgia,"Times New Roman",serif;text-align:center;margin:0 0 .5rem;overflow-wrap:anywhere}
.sub{color:var(--muted);text-align:center;margin:0 0 1.5rem}
.card{background:var(--sand);border:1px solid var(--border);border-radius:12px;padding:1rem 1.25rem;margin-bottom:1rem;overflow-wrap:anywhere}
.card b{display:block;font-size:.75rem;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin-bottom:.25rem}
a.btn{display:block;text-align:center;padding:.9rem 1rem;border-radius:8px;background:var(--ink);color:var(--ivory);text-decoration:none;font-weight:600;margin-bottom:.75rem;min-height:44px}
a.btn.alt{background:transparent;color:var(--ink);border:1px solid var(--border)}
.code{font:700 1.5rem/1 ui-monospace,Menlo,Consolas,monospace;letter-spacing:.15em;text-align:center;margin:.5rem 0}
.hint{color:var(--muted);font-size:.875rem;text-align:center}`;

function shell(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<meta name="referrer" content="no-referrer"><title>${esc(title)}</title><style>${CSS}</style></head><body><main>${body}</main></body></html>`;
}

export function renderLanding(s: LandingSalon, o: LandingOptions): string {
  const buttons = [
    o.androidUrl ? `<a class="btn" href="${esc(o.androidUrl)}" rel="noopener">Get the Android app</a>` : '',
    o.iosUrl ? `<a class="btn" href="${esc(o.iosUrl)}" rel="noopener">Get the iPhone app</a>` : '',
  ].join('');
  const tel = s.phone.replace(/[^\d+]/g, '');
  return shell(`${s.name} - Book online`, `
<div class="brand">${esc(o.brandName)}</div><div class="rule"></div>
<h1>${esc(s.name)}</h1>
<p class="sub">${esc(SALON_TYPE_LABEL[s.salonType] ?? 'Salon')} &middot; ${esc(s.area)}, ${esc(s.city)}</p>
<div class="card"><b>Address</b>${esc(s.addressLine)}</div>
<div class="card"><b>Phone</b><a href="tel:${esc(tel)}" style="color:inherit">${esc(s.phone)}</a></div>
${buttons}
<p class="hint">Already have the app? Open it, tap <b>Scan salon QR</b> and enter this code:</p>
<div class="code">${esc(o.code)}</div>
<p class="hint">You pay the salon directly. Booking is free for customers.</p>`);
}

export function renderNotAvailable(brandName: string): string {
  return shell('Salon not available', `
<div class="brand">${esc(brandName)}</div><div class="rule"></div>
<h1>This salon is not available</h1>
<p class="sub">The link may be wrong, or the salon is not taking online bookings right now.</p>`);
}
