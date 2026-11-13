import { Module } from '@nestjs/common';
import { ListingModule } from '../listing/listing';
import { AdminDiscoveryController, PublicDiscoveryController } from './discovery.controllers';
import { DiscoveryRepository } from './discovery.repository';
import { DiscoveryService } from './discovery.service';

/** Phase 7: customer discovery (search, nearby, filters, availability preview) and its Super Admin setting. */
@Module({
  imports: [ListingModule],
  controllers: [PublicDiscoveryController, AdminDiscoveryController],
  providers: [DiscoveryRepository, DiscoveryService],
})
export class DiscoveryModule {}
