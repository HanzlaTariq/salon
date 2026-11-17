import { LANDING_CSP, esc, renderLanding, renderNotAvailable } from './landing';

const salon = { name: 'Glow <b>Studio</b> & "Spa"', salonType: 'UNISEX', city: "L'ahore", area: 'Gulberg', addressLine: '<img src=x onerror=alert(1)>', phone: '0300 1234567' };

describe('landing page', () => {
  it('escapes every dynamic value (no markup injection)', () => {
    const html = renderLanding(salon, { brandName: '<i>Brand</i>', code: 'abcd2fgh3j' });
    expect(html).not.toContain('<b>Studio</b>');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<i>Brand');
    expect(html).toContain('Glow &lt;b&gt;Studio&lt;/b&gt; &amp; &quot;Spa&quot;');
    expect(html).toContain('L&#39;ahore');
    expect(html).toContain('abcd2fgh3j');
  });

  it('store buttons appear only when configured and are escaped', () => {
    expect(renderLanding(salon, { brandName: 'B', code: 'abcd2fgh3j' })).not.toContain('Get the Android app');
    const html = renderLanding(salon, { brandName: 'B', code: 'abcd2fgh3j', androidUrl: 'https://play.google.com/x?a=1&b="2"' });
    expect(html).toContain('Get the Android app');
    expect(html).toContain('a=1&amp;b=&quot;2&quot;');
  });

  it('has no script and the CSP forbids scripts and external resources', () => {
    expect(renderLanding(salon, { brandName: 'B', code: 'abcd2fgh3j' })).not.toMatch(/<script/i);
    expect(LANDING_CSP).toContain("default-src 'none'");
    expect(LANDING_CSP).not.toMatch(/script-src/);
    expect(renderNotAvailable('B')).toContain('not available');
    expect(esc(undefined)).toBe('');
  });
});
