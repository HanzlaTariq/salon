import { UserRole } from './roles';

/**
 * Granular permission catalogue. Controllers declare what they need with @RequirePermissions();
 * roles only map to permissions here, in one reviewable place. New phases append to this file.
 */
export const PERMISSIONS = {
  USERS_READ: 'users.read',
  USERS_MANAGE_STATUS: 'users.manage_status',
  AUDIT_READ: 'audit.read',
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

const ALL: readonly Permission[] = Object.values(PERMISSIONS);

export const ROLE_PERMISSIONS: Record<UserRole, readonly Permission[]> = {
  SUPER_ADMIN: ALL,
  SUPPORT: [PERMISSIONS.USERS_READ],
  FINANCE: [],
  SALON_OWNER: [],
  SALON_STAFF: [],
  CUSTOMER: [],
};

export function roleHasPermissions(role: UserRole, required: readonly Permission[]): boolean {
  const granted = ROLE_PERMISSIONS[role] ?? [];
  return required.every((p) => granted.includes(p));
}
