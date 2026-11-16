import { Inject, Injectable, Logger } from '@nestjs/common';
import { SignJWT, importPKCS8 } from 'jose';
import { ENV, Env } from '../../config/env';

export interface PushMessage {
  /** The device registration token. Never logged. */
  token: string;
  title: string;
  body: string;
  /** FCM data values must be strings. */
  data: Record<string, string>;
}

export type PushResult =
  | { ok: true; id: string }
  /** INVALID_TOKEN: the device is gone (switch it off). TRANSIENT: try again later. PERMANENT: this message can never be sent. */
  | { ok: false; kind: 'INVALID_TOKEN' | 'TRANSIENT' | 'PERMANENT'; code: string };

export abstract class PushProvider {
  abstract send(message: PushMessage): Promise<PushResult>;
}

/** Development / test driver: keeps messages in memory (bounded), logs nothing sensitive. Refused in production by parseEnv. */
@Injectable()
export class LogPushProvider extends PushProvider {
  private readonly logger = new Logger('Push');
  readonly sent: PushMessage[] = [];
  /** Tests can decide the outcome per message (for example to simulate an unregistered device or an outage). */
  behaviour: ((m: PushMessage) => PushResult) | null = null;

  async send(message: PushMessage): Promise<PushResult> {
    if (this.behaviour) {
      const r = this.behaviour(message);
      if (!r.ok) return r;
    }
    this.sent.push(message);
    if (this.sent.length > 200) this.sent.shift();
    this.logger.log(`[dev push] type=${message.data.type ?? '?'} title="${message.title}"`);
    return { ok: true, id: `dev-${this.sent.length}` };
  }
}

interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
}

export function parseServiceAccount(b64: string): ServiceAccount {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
  } catch {
    throw new Error('FCM_SERVICE_ACCOUNT_B64 is not valid base64 JSON');
  }
  const o = parsed as Partial<ServiceAccount>;
  if (!o || typeof o.project_id !== 'string' || typeof o.client_email !== 'string' || typeof o.private_key !== 'string') {
    throw new Error('FCM_SERVICE_ACCOUNT_B64 must contain project_id, client_email and private_key');
  }
  return { project_id: o.project_id, client_email: o.client_email, private_key: o.private_key };
}

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
type FetchFn = typeof fetch;

/**
 * Firebase Cloud Messaging HTTP v1 without the heavy firebase-admin package: a service-account JWT (signed with `jose`) is exchanged
 * for a short-lived OAuth token, which is cached until shortly before it expires. The token endpoint is fixed (never read from the
 * credentials file), so a tampered credentials file cannot redirect the private key to another host.
 */
@Injectable()
export class FcmPushProvider extends PushProvider {
  private readonly logger = new Logger('Push');
  private readonly account: ServiceAccount;
  private cached: { token: string; expiresAtMs: number } | null = null;

  constructor(@Inject(ENV) env: Env, private readonly fetchFn: FetchFn = fetch, private readonly nowMs: () => number = () => Date.now()) {
    super();
    this.account = parseServiceAccount(env.FCM_SERVICE_ACCOUNT_B64 as string);
  }

  private async accessToken(force = false): Promise<string> {
    if (!force && this.cached && this.cached.expiresAtMs - 60_000 > this.nowMs()) return this.cached.token;
    const key = await importPKCS8(this.account.private_key, 'RS256');
    const assertion = await new SignJWT({ scope: SCOPE })
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
      .setIssuer(this.account.client_email)
      .setSubject(this.account.client_email)
      .setAudience(TOKEN_URL)
      .setIssuedAt(Math.floor(this.nowMs() / 1000))
      .setExpirationTime(Math.floor(this.nowMs() / 1000) + 50 * 60)
      .sign(key);
    const res = await this.fetchFn(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`oauth ${res.status}`);
    const json = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!json.access_token) throw new Error('oauth: no access token');
    this.cached = { token: json.access_token, expiresAtMs: this.nowMs() + (json.expires_in ?? 3000) * 1000 };
    return json.access_token;
  }

  async send(m: PushMessage): Promise<PushResult> {
    try {
      let result = await this.post(m, await this.accessToken());
      if (!result.ok && result.code === 'HTTP_401') result = await this.post(m, await this.accessToken(true));
      return result;
    } catch (e) {
      // Network failure, timeout, token endpoint down: nothing is known to be wrong with the message.
      this.logger.warn(`push transport error: ${e instanceof Error ? e.name : 'unknown'}`);
      return { ok: false, kind: 'TRANSIENT', code: 'TRANSPORT' };
    }
  }

  private async post(m: PushMessage, accessToken: string): Promise<PushResult> {
    const res = await this.fetchFn(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(this.account.project_id)}/messages:send`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: {
          token: m.token,
          notification: { title: m.title, body: m.body },
          data: m.data,
          android: { priority: 'HIGH', notification: { channel_id: 'salon_default' } },
          apns: { headers: { 'apns-priority': '10' }, payload: { aps: { sound: 'default' } } },
        },
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) {
      const json = (await res.json().catch(() => ({}))) as { name?: string };
      return { ok: true, id: String(json.name ?? '').slice(0, 200) };
    }
    return classifyFcmError(res.status, await res.json().catch(() => null));
  }
}

/** Maps an FCM HTTP v1 error to what the dispatcher must do. Exported for unit tests. */
export function classifyFcmError(status: number, body: unknown): PushResult {
  const err = (body as { error?: { status?: string; details?: Array<{ errorCode?: string }> } } | null)?.error;
  const code = err?.details?.find((d) => typeof d.errorCode === 'string')?.errorCode ?? err?.status ?? `HTTP_${status}`;
  if (status === 404 || code === 'UNREGISTERED' || code === 'SENDER_ID_MISMATCH') return { ok: false, kind: 'INVALID_TOKEN', code };
  if (status === 401) return { ok: false, kind: 'TRANSIENT', code: 'HTTP_401' };
  if (status === 429 || status >= 500 || status === 403 || code === 'QUOTA_EXCEEDED' || code === 'UNAVAILABLE' || code === 'INTERNAL') {
    return { ok: false, kind: 'TRANSIENT', code };
  }
  return { ok: false, kind: 'PERMANENT', code };
}
