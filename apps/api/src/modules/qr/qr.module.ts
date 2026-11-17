import { Module } from '@nestjs/common';
import { ListingModule } from '../listing/listing';
import { SalonsModule } from '../salons/salons.module';
import { OwnerQrController, PublicQrController, SalonLandingController } from './qr.controllers';
import { QrRepository } from './qr.repository';
import { OwnerQrService, PublicQrService } from './qr.service';

/**
 * Phase 11: the permanent salon link, its QR code (PNG / SVG), the printable PDF poster and the public landing page a phone
 * camera opens. Codes are created by a database trigger when a salon is approved. Nothing here changes booking, billing or salons.
 */
@Module({
  imports: [ListingModule, SalonsModule],
  controllers: [OwnerQrController, PublicQrController, SalonLandingController],
  providers: [QrRepository, OwnerQrService, PublicQrService],
})
export class QrModule {}
