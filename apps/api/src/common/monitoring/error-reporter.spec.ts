import { NullErrorReporter, SentryReporter, parseDsn, parseStack, scrubText } from './error-reporter';

describe('scrubText', () => {
  it('removes e-mail addresses, uuids, tokens and phone numbers and caps the length', () => {
    const out = scrubText('duplicate key (email)=(sara@example.com) for 3f2b8c1e-1a2b-4c3d-8e4f-0123456789ab, Bearer abc.def-123, call +92 300 1234567');
    expect(out).not.toMatch(/sara@example\.com/);
    expect(out).not.toMatch(/3f2b8c1e/);
    expect(out).not.toMatch(/abc\.def/);
    expect(out).not.toMatch(/1234567/);
    expect(out).toContain('[email]');
    expect(out).toContain('[uuid]');
    expect(scrubText('x'.repeat(2000)).length).toBe(300);
  });

  it('removes a JWT', () => {
    // built at run time on purpose: a JWT-shaped literal in the source trips secret scanners (gitleaks)
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const fake = [b64({ alg: 'HS256', typ: 'JWT' }), b64({ sub: 'not-a-real-user' }), 'c2lnbmF0dXJl'].join('.');
    expect(scrubText(`token ${fake} end`)).toContain('[jwt]');
  });
});

describe('parseStack', () => {
  it('keeps project frames relative, flags library frames and puts the oldest call first', () => {
    const stack = [
      'Error: boom',
      '    at Foo.bar (/srv/app/dist/modules/x/x.service.js:10:5)',
      '    at /srv/app/node_modules/express/lib/router.js:20:3',
      '    at node:internal/process/task_queues:95:5',
    ].join('\n');
    const frames = parseStack(stack);
    expect(frames).toHaveLength(3);
    expect(frames[0].in_app).toBe(false);
    expect(frames[2]).toMatchObject({ function: 'Foo.bar', filename: 'dist/modules/x/x.service.js', lineno: 10, colno: 5, in_app: true });
  });
});

describe('parseDsn', () => {
  it('builds the envelope endpoint', () => {
    expect(parseDsn('https://abc123@o1.ingest.sentry.io/4500')).toEqual({ endpoint: 'https://o1.ingest.sentry.io/api/4500/envelope/', publicKey: 'abc123' });
    expect(parseDsn('https://k@errors.example.com/sentry/7').endpoint).toBe('https://errors.example.com/sentry/api/7/envelope/');
  });
  it('rejects a DSN without key or project', () => {
    expect(() => parseDsn('https://o1.ingest.sentry.io/')).toThrow();
  });
});

describe('SentryReporter', () => {
  const make = (now = { t: 1_700_000_000_000 }) => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response('{}');
    }) as unknown as typeof fetch;
    const reporter = new SentryReporter({ dsn: 'https://key1@sentry.example.test/9', environment: 'production', release: 'abc123', fetchImpl, now: () => now.t });
    return { reporter, calls, now };
  };

  it('sends a scrubbed envelope with route template, request id and opaque user id only', async () => {
    const { reporter, calls } = make();
    const err = new Error('insert failed for sara@example.com');
    reporter.capture(err, { route: '/api/v1/salons/:id', method: 'GET', status: 500, requestId: 'req-12345678', userId: 'u-1' });
    await reporter.flush(1_000);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://sentry.example.test/api/9/envelope/');
    expect((calls[0].init.headers as Record<string, string>)['X-Sentry-Auth']).toContain('sentry_key=key1');
    const [header, item, payload] = String(calls[0].init.body).trim().split('\n').map((l) => JSON.parse(l));
    expect(header.event_id).toHaveLength(32);
    expect(item.type).toBe('event');
    expect(payload.exception.values[0].value).toBe('insert failed for [email]');
    expect(payload.tags).toEqual({ route: '/api/v1/salons/:id', method: 'GET', status: '500', request_id: 'req-12345678' });
    expect(payload.user).toEqual({ id: 'u-1' });
    expect(payload.environment).toBe('production');
    expect(payload.release).toBe('abc123');
    expect(JSON.stringify(payload)).not.toMatch(/sara@example\.com/);
  });

  it('sends the same error only once a minute and at most 30 events a minute', async () => {
    const { reporter, calls, now } = make();
    const same = new Error('same');
    reporter.capture(same, { route: '/a' });
    reporter.capture(same, { route: '/a' });
    await reporter.flush(1_000);
    expect(calls).toHaveLength(1);
    now.t += 61_000;
    reporter.capture(same, { route: '/a' });
    await reporter.flush(1_000);
    expect(calls).toHaveLength(2);
    for (let i = 0; i < 60; i += 1) reporter.capture(new Error('e'), { route: `/r${i}` });
    await reporter.flush(1_000);
    expect(calls.length).toBeLessThanOrEqual(2 + 30);
  });

  it('never throws, even when the network fails', async () => {
    const reporter = new SentryReporter({ dsn: 'https://k@s.example.test/1', environment: 'test', fetchImpl: (async () => { throw new Error('offline'); }) as unknown as typeof fetch });
    expect(() => reporter.capture(new Error('x'))).not.toThrow();
    await expect(reporter.flush(500)).resolves.toBeUndefined();
  });

  it('accepts non-Error values', () => {
    const { reporter } = make();
    expect(() => reporter.capture('plain string')).not.toThrow();
    expect(() => reporter.capture({ weird: true })).not.toThrow();
  });
});

describe('NullErrorReporter', () => {
  it('does nothing', async () => {
    const r = new NullErrorReporter();
    r.capture();
    await expect(r.flush()).resolves.toBeUndefined();
  });
});
