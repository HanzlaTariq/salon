import type { Request } from 'express';
import { TenantContext } from '../tenancy/tenant-context';
import { UserRole, UserStatus, isPlatformRole } from './roles';

/** Identity of the caller, built ONLY from a verified token + a fresh database lookup. */
export interface AuthenticatedUser {
  readonly id: string;
  readonly email: string;
  readonly fullName: string;
  readonly role: UserRole;
  readonly status: UserStatus;
  readonly sessionId: string;
  readonly mfaEnabled: boolean;
  /** Whether this session passed a second factor at login. */
  readonly mfaVerified: boolean;
  /** Platform role + MFA mandatory + not enrolled yet: only enrolment endpoints are reachable. */
  readonly mfaEnrollmentRequired: boolean;
}

export type AuthedRequest = Request & { user?: AuthenticatedUser; id?: string };

/**
 * Builds the tenant scope for database access from the VERIFIED user.
 * salonId stays null until Phase 3 adds salon membership lookups; it must come from the
 * database membership of this user, never from a request body, query or header.
 */
export function toTenantContext(user: AuthenticatedUser, salonId: string | null = null): TenantContext {
  return { userId: user.id, salonId, isPlatformAdmin: isPlatformRole(user.role) };
}
