import { Module } from '@nestjs/common';
import { MulterModule } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { ENV, Env } from '../../config/env';
import { ListingModule } from '../listing/listing';
import { SalonsModule } from '../salons/salons.module';
import { CatalogRepository } from './catalog.repository';
import { CatalogService } from './catalog.service';
import { OwnerCatalogController, PublicCatalogController } from './catalog.controllers';
import { PublicCatalogService } from './public-catalog.service';

@Module({
  imports: [
    ListingModule,
    SalonsModule, // exports SalonsRepository (salon lookup + file rows)
    // Same upload hardening as the salons module (risk R1): memory storage, size/part/field caps while streaming,
    // no async fileFilter. Images are validated and re-encoded by processUpload before they are stored.
    MulterModule.registerAsync({
      inject: [ENV],
      useFactory: (env: Env) => ({
        storage: memoryStorage(),
        limits: { fileSize: env.UPLOAD_MAX_BYTES, files: 1, fields: 4, parts: 6, fieldSize: 1024 },
      }),
    }),
  ],
  controllers: [OwnerCatalogController, PublicCatalogController],
  providers: [CatalogRepository, CatalogService, PublicCatalogService],
})
export class CatalogModule {}
