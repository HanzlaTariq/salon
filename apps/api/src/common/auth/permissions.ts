import { UserRole } from './roles';

/**
 * Granular permission catalogue. Controllers declare what they need with @RequirePermissions();
 * roles only map to permissions here, in one reviewable place. New phases append to this file.
 */
export const PERMISSIONS = {
  USERS_READ: 'users.read',
  USERS_MANAGE_STATUS: 'users.manage_status',
  AUDIT_READ: 'audit.read',
  SALONS_READ: 'salons.read',
  /** Approve / reject salon applications. */
  SALONS_REVIEW: 'salons.review',
  /** Suspend / reactivate approved salons. */
  SALONS_MANAGE_STATUS: 'salons.manage_status',
  /** View identity/business documents (CNIC, licence): the most sensitive salon data. */
  SALONS_DOCUMENTS_READ: 'salons.documents_read',
  /** Phase 6: view subscriptions, plans, invoices and the billing overview (read-only). */
  BILLING_READ: 'billing.read',
  /** Phase 6: change prices, promotions and payment instructions (Super Admin only). */
  BILLING_MANAGE: 'billing.manage',
  /** Phase 6: see receipts, approve / reject / query manual payments (Super Admin and Finance). */
  PAYMENTS_REVIEW: 'payments.review',
  /** Phase 6: suspend / reactivate a subscription, grant a complimentary period, void an invoice (Super Admin only). */
  SUBSCRIPTIONS_MANAGE: 'subscriptions.manage',
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

const ALL: readonly Permission[] = Object.values(PERMISSIONS);

export const ROLE_PERMISSIONS: Record<UserRole, readonly Permission[]> = {
  SUPER_ADMIN: ALL,
  SUPPORT: [PERMISSIONS.USERS_READ, PERMISSIONS.SALONS_READ, PERMISSIONS.BILLING_READ],
  FINANCE: [PERMISSIONS.BILLING_READ, PERMISSIONS.PAYMENTS_REVIEW],
  SALON_OWNER: [],
  SALON_STAFF: [],
  CUSTOMER: [],
};

export function roleHasPermissions(role: UserRole, required: readonly Permission[]): boolean {
  const granted = ROLE_PERMISSIONS[role] ?? [];
  return required.every((p) => granted.includes(p));
}
