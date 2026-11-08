import { describe, expect, it } from 'vitest';
import { ApiError, apiFetch } from './api';

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
