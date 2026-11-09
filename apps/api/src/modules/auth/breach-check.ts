import { createHash } from 'crypto';

export type BreachResult = 'breached' | 'clean' | 'unknown';
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const HIBP_RANGE_URL = 'https://api.pwnedpasswords.com/range/';

/**
 * Breached-password check using the Have I Been Pwned k-anonymity range API.
 *
 * Privacy: only the first 5 hex characters of the SHA-1 hash are sent. The full password and
 * the rest of the hash never leave the server. `Add-Padding` asks HIBP to pad responses so the
 * response size does not reveal which prefix was queried.
 *
 * Returns 'unknown' on any network, timeout or HTTP error. The caller decides fail-open/closed.
 */
export async function checkPasswordBreach(
  password: string,
  fetchImpl: FetchLike = fetch,
  timeoutMs = 2_000,
): Promise<BreachResult> {
  const digest = createHash('sha1').update(password, 'utf8').digest('hex').toUpperCase();
  const prefix = digest.slice(0, 5);
  const suffix = digest.slice(5);
  try {
    const res = await fetchImpl(`${HIBP_RANGE_URL}${prefix}`, {
      headers: { 'Add-Padding': 'true', 'User-Agent': 'salon-platform-api' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return 'unknown';
    return parseRangeBody(await res.text(), suffix) ? 'breached' : 'clean';
  } catch {
    return 'unknown';
  }
}

/** Each line is `SUFFIX:COUNT`. Padding lines have COUNT 0 and must not count as a breach. */
export function parseRangeBody(body: string, suffix: string): boolean {
  for (const line of body.split(/\r?\n/)) {
    const [candidate, count] = line.trim().split(':');
    if (candidate === suffix && Number(count) > 0) return true;
  }
  return false;
}
