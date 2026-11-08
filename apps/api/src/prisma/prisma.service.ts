import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

/**
 * Single Prisma client. In Phase 2+ all tenant-scoped access goes through repositories
 * that run inside a transaction which sets `app.salon_id` for Row-Level Security
 * (see docs/PHASE1.md > Tenancy skeleton).
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
