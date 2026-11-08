/**
 * Identity + tenant scope for ONE request/job/socket event.
 *
 * It must be built ONLY from verified server-side data (verified JWT + DB membership),
 * never from request body, query string or client-supplied headers.
 * (Auth that produces it arrives in Phase 2.)
 */
export interface TenantContext {
  /** Authenticated user. */
  readonly userId: string;
  /** Salon the user is acting within (null for customers and platform admins browsing cross-tenant). */
  readonly salonId: string | null;
  /** True only for platform roles (SUPER_ADMIN / SUPPORT / FINANCE) resolved server-side. */
  readonly isPlatformAdmin: boolean;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

/** Throws if a context is malformed. Defence in depth: fails closed. */
export function assertValidContext(ctx: TenantContext): void {
  if (!isUuid(ctx.userId)) throw new Error('TenantContext.userId must be a UUID');
  if (ctx.salonId !== null && !isUuid(ctx.salonId)) throw new Error('TenantContext.salonId must be a UUID or null');
  if (ctx.salonId === null && !ctx.isPlatformAdmin) {
    // A non-admin without a salon would see nothing under RLS; make that explicit.
    // (Customers use user-scoped policies via app.user_id and pass a context with userId only.)
  }
}
