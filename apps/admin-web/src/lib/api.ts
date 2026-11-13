/** Shared API conventions: `{ data }` on success, `{ error: { code, message, details?, requestId } }` on failure. */
import { AuthPayload, getAccessToken, notifySessionExpired, setAccessToken } from './session';

export interface ApiErrorBody {
  code: string;
  message: string;
  details?: unknown;
  requestId?: string;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: ApiErrorBody,
  ) {
    super(body.message);
    this.name = 'ApiError';
  }
  get requestId() {
    return this.body.requestId;
  }
  get code() {
    return this.body.code;
  }
}

const BASE = (import.meta.env?.VITE_API_URL as string | undefined) ?? '';

async function request<T>(path: string, init: RequestInit, fetchImpl: typeof fetch): Promise<T> {
  const headers = new Headers(init.headers ?? {});
  headers.set('Accept', 'application/json');
  const token = getAccessToken();
  if (token && !headers.has('Authorization')) headers.set('Authorization', `Bearer ${token}`);

  let res: Response;
  try {
    res = await fetchImpl(`${BASE}/api/v1${path}`, { ...init, headers, credentials: 'include' });
  } catch {
    throw new ApiError(0, { code: 'NETWORK_ERROR', message: 'Cannot reach the server. Check your connection.' });
  }
  if (res.status === 204) return undefined as T;
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const body: ApiErrorBody = json?.error ?? { code: 'UNKNOWN_ERROR', message: 'Unexpected response from the server.' };
    throw new ApiError(res.status, body);
  }
  return (json as { data: T }).data;
}

/**
 * Calls the API. If an authenticated call gets 401 (access token expired), it refreshes the session
 * ONCE (single-flight) and retries; if that fails the app is told the session ended.
 */
export async function apiFetch<T>(path: string, init: RequestInit = {}, fetchImpl: typeof fetch = fetch): Promise<T> {
  try {
    return await request<T>(path, init, fetchImpl);
  } catch (e) {
    const canRetry = e instanceof ApiError && e.status === 401 && getAccessToken() !== null && !path.startsWith('/auth/');
    if (!canRetry) throw e;
    const refreshed = await refreshSession(fetchImpl);
    if (!refreshed) {
      notifySessionExpired();
      throw e;
    }
    return request<T>(path, init, fetchImpl);
  }
}

export function apiJson<T>(path: string, method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', body?: unknown): Promise<T> {
  return apiFetch<T>(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

// ---------------------------------------------------------------- session refresh

let inflight: Promise<AuthPayload | null> | null = null;

/** Cookie-authenticated requests need the custom header (CSRF defence); the browser adds Origin. */
const CSRF_HEADERS = { 'X-CSRF-Token': 'web' };

async function doRefresh(fetchImpl: typeof fetch): Promise<AuthPayload | null> {
  try {
    const payload = await request<AuthPayload>('/auth/refresh', { method: 'POST', headers: CSRF_HEADERS }, fetchImpl);
    setAccessToken(payload.accessToken);
    return payload;
  } catch (e) {
    if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
      setAccessToken(null);
      return null; // no valid session
    }
    throw e; // network/server trouble: let the caller show a retry state
  }
}

/**
 * Single-flight AND cross-tab serialised: the server rotates the refresh token on every use and treats
 * a replay as theft, so two simultaneous refreshes (StrictMode double effects, two tabs, parallel
 * requests) must never present the same cookie. Web Locks makes later tabs read the already-rotated cookie.
 */
export function refreshSession(fetchImpl: typeof fetch = fetch): Promise<AuthPayload | null> {
  inflight ??= (async () => {
    const locks = (globalThis as { navigator?: { locks?: { request: <R>(n: string, cb: () => Promise<R>) => Promise<R> } } })
      .navigator?.locks;
    return locks ? locks.request('salon-admin-refresh', () => doRefresh(fetchImpl)) : doRefresh(fetchImpl);
  })().finally(() => {
    inflight = null;
  });
  return inflight;
}

export async function login(email: string, password: string, mfaCode?: string): Promise<AuthPayload> {
  const payload = await request<AuthPayload>(
    '/auth/login',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, ...(mfaCode ? { mfaCode } : {}) }),
    },
    fetch,
  );
  setAccessToken(payload.accessToken);
  return payload;
}

export async function logout(): Promise<void> {
  try {
    await request<void>('/auth/logout', { method: 'POST', headers: { ...CSRF_HEADERS, 'Content-Type': 'application/json' }, body: '{}' }, fetch);
  } finally {
    setAccessToken(null);
  }
}
