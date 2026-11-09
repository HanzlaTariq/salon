/**
 * In-memory session state. The ACCESS token lives only in this module's memory (never localStorage /
 * sessionStorage), so an XSS payload cannot read it after a page reload and it dies with the tab.
 * The REFRESH token is an httpOnly cookie managed by the browser; JavaScript never sees it.
 */
export type UserRole = 'SUPER_ADMIN' | 'SUPPORT' | 'FINANCE' | 'SALON_OWNER' | 'SALON_STAFF' | 'CUSTOMER';

export const PLATFORM_ROLES: readonly UserRole[] = ['SUPER_ADMIN', 'SUPPORT', 'FINANCE'];

export interface SessionUser {
  id: string;
  email: string;
  fullName: string;
  phone: string | null;
  role: UserRole;
  status: string;
  emailVerified: boolean;
  mfaEnabled: boolean;
}

export interface AuthPayload {
  accessToken: string;
  expiresIn: number;
  user: SessionUser;
  mfaEnrollmentRequired: boolean;
}

let accessToken: string | null = null;
let onExpired: (() => void) | null = null;

export const getAccessToken = () => accessToken;
export const setAccessToken = (t: string | null) => {
  accessToken = t;
};
export const setSessionExpiredHandler = (fn: (() => void) | null) => {
  onExpired = fn;
};
export const notifySessionExpired = () => {
  accessToken = null;
  onExpired?.();
};
