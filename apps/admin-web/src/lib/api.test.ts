import { describe, expect, it } from 'vitest';
import { ApiError, apiFetch, refreshSession } from './api';
import { getAccessToken, setAccessToken } from './session';

const json = (status: number, body: unknown) =>
  (async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })) as typeof fetch;

const failure = (f: typeof fetch) =>
  apiFetch<unknown>('/x', {}, f).then(
    () => {
      throw new Error('expected the request to fail');
    },
    (e: unknown) => e as ApiError,
  );

describe('apiFetch', () => {
  it('unwraps { data }', async () => {
    await expect(apiFetch('/health', {}, json(200, { data: { status: 'ok' } }))).resolves.toEqual({ status: 'ok' });
  });

  it('maps the server error envelope to ApiError (with requestId)', async () => {
    const f = json(409, { error: { code: 'SLOT_TAKEN', message: 'Taken', requestId: 'req-1' } });
    const err = await failure(f);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.body.code).toBe('SLOT_TAKEN');
    expect(err.requestId).toBe('req-1');
  });

  it('turns network failures into a friendly ApiError', async () => {
    const f = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    const err = await failure(f);
    expect(err.body.code).toBe('NETWORK_ERROR');
  });

  it('handles non-JSON error bodies without crashing', async () => {
    const f = (async () => new Response('<html>bad gateway</html>', { status: 502 })) as typeof fetch;
    const err = await failure(f);
    expect(err.status).toBe(502);
    expect(err.body.code).toBe('UNKNOWN_ERROR');
  });
});

describe('session refresh', () => {
  const ok = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200, headers: { 'content-type': 'application/json' } });
  const unauth = () => new Response(JSON.stringify({ error: { code: 'UNAUTHENTICATED', message: 'expired' } }), { status: 401 });
  const payload = { accessToken: 'new-token', expiresIn: 900, user: { id: 'u' }, mfaEnrollmentRequired: false };

  it('attaches the in-memory bearer token', async () => {
    setAccessToken('abc');
    let seen = '';
    const f = (async (_u: string, init: RequestInit) => {
      seen = new Headers(init.headers).get('Authorization') ?? '';
      return ok({});
    }) as unknown as typeof fetch;
    await apiFetch('/x', {}, f);
    expect(seen).toBe('Bearer abc');
    setAccessToken(null);
  });

  it('refreshes once on 401 and retries with the new token', async () => {
    setAccessToken('old');
    const calls: string[] = [];
    const f = (async (url: string, init: RequestInit) => {
      calls.push(`${init.method ?? 'GET'} ${url}`);
      const auth = new Headers(init.headers).get('Authorization');
      if (url.endsWith('/auth/refresh')) {
        expect(new Headers(init.headers).get('X-CSRF-Token')).toBeTruthy(); // CSRF header present
        return ok(payload);
      }
      return auth === 'Bearer new-token' ? ok({ fine: true }) : unauth();
    }) as unknown as typeof fetch;
    await expect(apiFetch('/admin/users', {}, f)).resolves.toEqual({ fine: true });
    expect(calls).toEqual(['GET /api/v1/admin/users', 'POST /api/v1/auth/refresh', 'GET /api/v1/admin/users']);
    expect(getAccessToken()).toBe('new-token');
    setAccessToken(null);
  });

  it('runs concurrent refreshes as ONE request (rotating tokens must never be replayed)', async () => {
    let refreshCalls = 0;
    const f = (async () => {
      refreshCalls++;
      await new Promise((r) => setTimeout(r, 10));
      return ok(payload);
    }) as unknown as typeof fetch;
    const results = await Promise.all([refreshSession(f), refreshSession(f), refreshSession(f)]);
    expect(refreshCalls).toBe(1);
    expect(results.every((r) => r?.accessToken === 'new-token')).toBe(true);
    setAccessToken(null);
  });

  it('gives up (null) when the refresh is rejected, and does not loop', async () => {
    setAccessToken('old');
    let n = 0;
    const f = (async () => {
      n++;
      return unauth();
    }) as unknown as typeof fetch;
    await expect(apiFetch('/admin/users', {}, f)).rejects.toBeInstanceOf(ApiError);
    expect(n).toBe(2); // original call + one refresh attempt
    expect(getAccessToken()).toBeNull();
  });

  it('never tries to refresh for /auth/* calls', async () => {
    setAccessToken('old');
    let n = 0;
    const f = (async () => {
      n++;
      return unauth();
    }) as unknown as typeof fetch;
    await expect(apiFetch('/auth/me', {}, f)).rejects.toBeInstanceOf(ApiError);
    expect(n).toBe(1);
    setAccessToken(null);
  });
});
