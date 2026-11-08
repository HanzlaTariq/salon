/** Shared API conventions: `{ data }` on success, `{ error: { code, message, details?, requestId } }` on failure. */

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
}

const BASE = (import.meta.env?.VITE_API_URL as string | undefined) ?? '';

export async function apiFetch<T>(path: string, init: RequestInit = {}, fetchImpl: typeof fetch = fetch): Promise<T> {
  let res: Response;
  try {
    res = await fetchImpl(`${BASE}/api/v1${path}`, {
      ...init,
      headers: { Accept: 'application/json', ...(init.headers ?? {}) },
      credentials: 'include',
    });
  } catch {
    throw new ApiError(0, { code: 'NETWORK_ERROR', message: 'Cannot reach the server. Check your connection.' });
  }

  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const body: ApiErrorBody = json?.error ?? {
      code: 'UNKNOWN_ERROR',
      message: 'Unexpected response from the server.',
    };
    throw new ApiError(res.status, body);
  }
  return (json as { data: T }).data;
}
