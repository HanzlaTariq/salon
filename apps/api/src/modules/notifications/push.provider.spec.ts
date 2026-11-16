import { generateKeyPairSync } from 'crypto';
import { Env } from '../../config/env';
import { FcmPushProvider, LogPushProvider, classifyFcmError, parseServiceAccount } from './push.provider';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const b64 = Buffer.from(JSON.stringify({ project_id: 'demo-proj', client_email: 'svc@demo-proj.iam.gserviceaccount.com', private_key: privateKey })).toString('base64');
const env = { FCM_SERVICE_ACCOUNT_B64: b64 } as Env;
const msg = { token: 't'.repeat(40), title: 'Hi', body: 'There', data: { type: 'X' } };

function fakeFetch(handler: (url: string, init: RequestInit) => { status: number; json: unknown }) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const r = handler(url, init);
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.json } as Response;
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe('FCM error classification', () => {
  it('an unregistered or foreign token switches the device off', () => {
    expect(classifyFcmError(404, { error: { status: 'NOT_FOUND', details: [{ errorCode: 'UNREGISTERED' }] } })).toMatchObject({ kind: 'INVALID_TOKEN' });
    expect(classifyFcmError(403, { error: { details: [{ errorCode: 'SENDER_ID_MISMATCH' }] } })).toMatchObject({ kind: 'INVALID_TOKEN' });
  });
  it('outages, quota, bad credentials and rate limits are retried', () => {
    for (const s of [429, 500, 503, 403]) expect(classifyFcmError(s, null)).toMatchObject({ kind: 'TRANSIENT' });
    expect(classifyFcmError(401, null)).toMatchObject({ kind: 'TRANSIENT', code: 'HTTP_401' });
  });
  it('a malformed message is permanent (retrying cannot help, and the device is NOT switched off)', () => {
    expect(classifyFcmError(400, { error: { status: 'INVALID_ARGUMENT' } })).toMatchObject({ kind: 'PERMANENT', code: 'INVALID_ARGUMENT' });
  });
});

describe('FcmPushProvider', () => {
  it('rejects a broken credentials value', () => {
    expect(() => parseServiceAccount('not-base64-json')).toThrow();
    expect(() => parseServiceAccount(Buffer.from('{"project_id":"x"}').toString('base64'))).toThrow();
  });

  it('gets one OAuth token, caches it, and posts the message to the fixed FCM endpoint', async () => {
    const f = fakeFetch((url) => (url.startsWith('https://oauth2.googleapis.com/') ? { status: 200, json: { access_token: 'ya29.test', expires_in: 3600 } } : { status: 200, json: { name: 'projects/demo-proj/messages/1' } }));
    const p = new FcmPushProvider(env, f.fn, () => 1_800_000_000_000);
    expect(await p.send(msg)).toEqual({ ok: true, id: 'projects/demo-proj/messages/1' });
    expect(await p.send(msg)).toMatchObject({ ok: true });
    expect(f.calls.filter((c) => c.url.includes('oauth2')).length).toBe(1);
    const post = f.calls.find((c) => c.url.includes('fcm.googleapis.com'))!;
    expect(post.url).toBe('https://fcm.googleapis.com/v1/projects/demo-proj/messages:send');
    expect((post.init.headers as Record<string, string>).Authorization).toBe('Bearer ya29.test');
    const sent = JSON.parse(post.init.body as string).message;
    expect(sent.token).toBe(msg.token);
    expect(sent.notification).toEqual({ title: 'Hi', body: 'There' });
    expect(sent.data).toEqual({ type: 'X' });
  });

  it('refreshes the token once after a 401', async () => {
    let tokens = 0;
    let posts = 0;
    const f = fakeFetch((url) => {
      if (url.includes('oauth2')) return { status: 200, json: { access_token: `tok-${++tokens}`, expires_in: 3600 } };
      return ++posts === 1 ? { status: 401, json: null } : { status: 200, json: { name: 'm' } };
    });
    const p = new FcmPushProvider(env, f.fn, () => 1_800_000_000_000);
    expect(await p.send(msg)).toMatchObject({ ok: true });
    expect(tokens).toBe(2);
  });

  it('turns a network failure into a retryable result and never throws', async () => {
    const fn = (async () => {
      throw new Error('boom');
    }) as unknown as typeof fetch;
    expect(await new FcmPushProvider(env, fn).send(msg)).toEqual({ ok: false, kind: 'TRANSIENT', code: 'TRANSPORT' });
  });
});

describe('LogPushProvider', () => {
  it('keeps messages and lets tests decide the outcome', async () => {
    const p = new LogPushProvider();
    expect(await p.send(msg)).toMatchObject({ ok: true });
    p.behaviour = () => ({ ok: false, kind: 'INVALID_TOKEN', code: 'UNREGISTERED' });
    expect(await p.send(msg)).toMatchObject({ ok: false, kind: 'INVALID_TOKEN' });
    expect(p.sent.length).toBe(1);
  });
});
