import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { TenantContext, assertValidContext } from './tenant-context';

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
}
