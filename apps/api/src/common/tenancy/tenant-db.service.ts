import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { TenantContext, assertValidContext, isUuid } from './tenant-context';

/** Minimal transaction surface we rely on (keeps this testable without a database). */
export interface TenantTx {
  $queryRaw: (query: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>;
}

/**
 * The ONLY sanctioned way for repositories to touch tenant-scoped tables.
 *
 * Every call opens a transaction and sets transaction-local settings that the PostgreSQL
 * Row-Level-Security policies read (`app.salon_id`, `app.user_id`, `app.is_platform_admin`).
 * `set_config(..., true)` is transaction-local, so values can never leak to another request
 * that reuses the pooled connection.
 *
 * Phase 2+ repositories receive a TenantContext and call `withTenant(ctx, tx => ...)`.
 */
@Injectable()
export class TenantDb {
  constructor(private readonly prisma: PrismaService) {}

  async withTenant<T>(ctx: TenantContext, fn: (tx: any) => Promise<T>): Promise<T> {
    assertValidContext(ctx);
    return this.prisma.$transaction(async (tx: any) => {
      const t = tx as TenantTx;
      await t.$queryRaw`SELECT set_config('app.user_id', ${ctx.userId}, true)`;
      await t.$queryRaw`SELECT set_config('app.salon_id', ${ctx.salonId ?? ''}, true)`;
      await t.$queryRaw`SELECT set_config('app.is_platform_admin', ${ctx.isPlatformAdmin ? 'true' : 'false'}, true)`;
      return fn(tx);
    });
  }

  /**
   * Read-only access for UNAUTHENTICATED public endpoints (approved-salon listings).
   * No user and no salon are set, so only RLS policies that explicitly check `app_public_read()`
   * can match (approved salons and their photos). Every other table stays invisible (fail closed).
   * Never use this for writes.
   */
  async withPublicRead<T>(fn: (tx: any) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(async (tx: any) => {
      const t = tx as TenantTx;
      await t.$queryRaw`SELECT set_config('app.user_id', '', true)`;
      await t.$queryRaw`SELECT set_config('app.salon_id', '', true)`;
      await t.$queryRaw`SELECT set_config('app.is_platform_admin', 'false', true)`;
      await t.$queryRaw`SELECT set_config('app.public_read', 'true', true)`;
      return fn(tx);
    });
  }

  /**
   * Phase 8: a signed-in CUSTOMER. The user id is set (their own appointments match `customer_user_id`), no salon and no admin
   * flag, AND the public read context is opened so the booking transaction can read approved salons, services, staff,
   * hours and the time span of busy slots. Writes still need a policy that names this customer, so the public context
   * grants no write. Because the public context can also see other customers' active time spans, every customer query
   * must filter `customer_user_id` explicitly (see BookingRepository).
   */
  async withCustomer<T>(userId: string, fn: (tx: any) => Promise<T>): Promise<T> {
    if (!isUuid(userId)) throw new Error('userId must be a UUID');
    return this.prisma.$transaction(async (tx: any) => {
      const t = tx as TenantTx;
      await t.$queryRaw`SELECT set_config('app.user_id', ${userId}, true)`;
      await t.$queryRaw`SELECT set_config('app.salon_id', '', true)`;
      await t.$queryRaw`SELECT set_config('app.is_platform_admin', 'false', true)`;
      await t.$queryRaw`SELECT set_config('app.public_read', 'true', true)`;
      return fn(tx);
    });
  }

  /**
   * Access for an UNAUTHENTICATED holder of a staff invitation link (Phase 5). Only the invitation row
   * whose SHA-256 token hash equals `tokenHash` is visible (policy `invite_token_select`). The caller may
   * then bind the invitation's salon with `setTenantSalon` inside the same transaction. The hash is
   * validated here so a malformed value can never widen access. Never use this for anything else.
   */
  async withInviteToken<T>(tokenHash: string, fn: (tx: any) => Promise<T>): Promise<T> {
    if (!/^[0-9a-f]{64}$/.test(tokenHash)) throw new Error('invite token hash must be a SHA-256 hex digest');
    return this.prisma.$transaction(async (tx: any) => {
      const t = tx as TenantTx;
      await t.$queryRaw`SELECT set_config('app.user_id', '', true)`;
      await t.$queryRaw`SELECT set_config('app.salon_id', '', true)`;
      await t.$queryRaw`SELECT set_config('app.is_platform_admin', 'false', true)`;
      await t.$queryRaw`SELECT set_config('app.invite_token_hash', ${tokenHash}, true)`;
      return fn(tx);
    });
  }
}

/**
 * Binds the salon context inside an existing transaction (used after the invitation row has been
 * found through `withInviteToken`). The salon id must come from that verified invitation row, never from input.
 */
export async function setTenantSalon(tx: any, salonId: string): Promise<void> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(salonId)) {
    throw new Error('salonId must be a UUID');
  }
  await (tx as TenantTx).$queryRaw`SELECT set_config('app.salon_id', ${salonId}, true)`;
}
