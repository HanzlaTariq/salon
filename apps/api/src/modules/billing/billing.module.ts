import { Module } from '@nestjs/common';
import { MulterModule } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { ENV, Env } from '../../config/env';
import { SalonsModule } from '../salons/salons.module';
import { AdminBillingService } from './admin-billing.service';
import { BillingCore } from './billing-core.service';
import { BillingMailer } from './billing-mailer';
import { AdminBillingController, OwnerBillingController } from './billing.controllers';
import { BillingRepository } from './billing.repository';
import { OwnerBillingService } from './owner-billing.service';

/**
 * Phase 6: subscriptions, invoices, manual payment verification. Imports SalonsModule (salon lookup) only.
 * It must NOT import StaffModule: StaffModule imports THIS module (BillingCore.reconcile runs after every staff change).
 */
@Module({
  imports: [
    // Receipts: same hardening as salon uploads (R1: multer >= 2.5.0, memory storage, strict part/field/size caps).
    MulterModule.registerAsync({
      inject: [ENV],
      useFactory: (env: Env) => ({
        storage: memoryStorage(),
        limits: { fileSize: env.UPLOAD_MAX_BYTES, files: 1, fields: 8, parts: 10, fieldSize: 1024 },
      }),
    }),
    SalonsModule,
  ],
  controllers: [OwnerBillingController, AdminBillingController],
  providers: [BillingRepository, BillingCore, BillingMailer, OwnerBillingService, AdminBillingService],
  exports: [BillingCore],
})
export class BillingModule {}
