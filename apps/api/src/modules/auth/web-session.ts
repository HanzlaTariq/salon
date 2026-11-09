import type { CookieOptions, Request, Response } from 'express';
import { AppException } from '../../common/errors/app-exception';
import { Env } from '../../config/env';

export const REFRESH_COOKIE = 'rt';
const COOKIE_PATH = '/api/v1/auth';

/** Mobile apps send `X-Client-Type: mobile` and keep tokens in the OS keychain/keystore. */
export function isMobileClient(req: Request): boolean {
  return req.headers['x-client-type'] === 'mobile';
}

function cookieOptions(env: Env, maxAgeMs?: number): CookieOptions {
  return {
    httpOnly: true, // not readable by JavaScript => XSS cannot steal the refresh token
    secure: env.COOKIE_SECURE,
    sameSite: 'strict',
    path: COOKIE_PATH, // never sent to any other API route
    ...(maxAgeMs ? { maxAge: maxAgeMs } : {}),
  };
}

export function setRefreshCookie(res: Response, env: Env, token: string): void {
  res.cookie(REFRESH_COOKIE, token, cookieOptions(env, env.REFRESH_TOKEN_TTL_DAYS * 86_400_000));
}

export function clearRefreshCookie(res: Response, env: Env): void {
  res.clearCookie(REFRESH_COOKIE, cookieOptions(env));
}

/**
 * CSRF defence for requests that authenticate with the refresh COOKIE (browsers attach cookies
 * automatically, so these need an extra check). Defence in depth:
 *   1. SameSite=Strict on the cookie,
 *   2. Origin header must be on the CORS allowlist (browsers always send it on POST),
 *   3. a custom header is required, which forces a CORS preflight that foreign origins fail.
 */
export function assertCookieRequestIsSameSite(req: Request, env: Env): void {
  const origin = req.headers.origin;
  const header = req.headers['x-csrf-token'];
  if (typeof origin !== 'string' || !env.CORS_ORIGINS.includes(origin) || typeof header !== 'string' || header.length === 0) {
    throw new AppException('CSRF_REJECTED', 'Request rejected.', 403);
  }
}
