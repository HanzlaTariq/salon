/**
 * Validates a post-login redirect target taken from the URL (`?next=`). Only same-app absolute paths are
 * allowed. Rejects protocol-relative (`//evil`), backslash tricks (`/\evil`, the React Router 6 open-redirect
 * class), schemes, control characters and anything that is not a plain path. Falls back to "/".
 */
export function safeInternalPath(candidate: string | null | undefined, fallback = '/'): string {
  if (!candidate) return fallback;
  if (candidate.length > 300) return fallback;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\]/.test(candidate)) return fallback;
  if (!candidate.startsWith('/') || candidate.startsWith('//')) return fallback;
  let decoded = candidate;
  try {
    decoded = decodeURIComponent(candidate);
  } catch {
    return fallback;
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(decoded)) return fallback;
  if (/[\\]/.test(decoded) || decoded.startsWith('//') || /^\/+[a-z][a-z0-9+.-]*:/i.test(decoded)) return fallback;
  if (/^\/(login|forgot-password|reset-password|verify-email)(\/|\?|#|$)/.test(candidate)) return fallback;
  return candidate;
}
