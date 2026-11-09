/**
 * Account-level roles (stored on users.role). Salon-level roles (Manager, Receptionist, ...) are
 * memberships resolved server-side per salon in Phase 3/5 and are never taken from the client.
 */
export const USER_ROLES = ['SUPER_ADMIN', 'SUPPORT', 'FINANCE', 'SALON_OWNER', 'SALON_STAFF', 'CUSTOMER'] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const USER_STATUSES = ['PENDING_VERIFICATION', 'ACTIVE', 'SUSPENDED'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export const PLATFORM_ROLES: readonly UserRole[] = ['SUPER_ADMIN', 'SUPPORT', 'FINANCE'];

/** The ONLY roles that public self-registration can create. Platform and staff accounts never self-register. */
export const SELF_REGISTRATION_ROLES = ['CUSTOMER', 'SALON_OWNER'] as const;
export type SelfRegistrationRole = (typeof SELF_REGISTRATION_ROLES)[number];

export function isPlatformRole(role: UserRole): boolean {
  return PLATFORM_ROLES.includes(role);
}
