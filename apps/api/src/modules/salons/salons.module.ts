import { Module } from '@nestjs/common';
import { MulterModule } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { ENV, Env } from '../../config/env';
import { AdminSalonsService } from './admin-salons.service';
import { OwnerSalonsService } from './owner-salons.service';
import { PublicSalonsService } from './public-salons.service';
import { AdminSalonsController, OwnerSalonsController, PublicSalonsController } from './salons.controllers';
import { SalonsRepository } from './salons.repository';

@Module({
  imports: [
    // Risk R1: multer >= 2.5.0 (package.json override); NO async fileFilter; size, part and field counts capped
    // while streaming; files are held in memory only until validated and re-encoded (never written to disk).
    MulterModule.registerAsync({
      inject: [ENV],
      useFactory: (env: Env) => ({
        storage: memoryStorage(),
        limits: { fileSize: env.UPLOAD_MAX_BYTES, files: 1, fields: 4, parts: 6, fieldSize: 1024 },
      }),
    }),
  ],
  controllers: [OwnerSalonsController, AdminSalonsController, PublicSalonsController],
  providers: [SalonsRepository, OwnerSalonsService, AdminSalonsService, PublicSalonsService],
  exports: [SalonsRepository],
})
export class SalonsModule {}
