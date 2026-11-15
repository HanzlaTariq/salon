import { Module } from '@nestjs/common';
import { DiscoveryModule } from '../discovery/discovery.module';
import { ListingModule } from '../listing/listing';
import { SalonsModule } from '../salons/salons.module';
import { BookingRepository } from './booking.repository';
import { CustomerBookingsController, OwnerBookingsController, PublicBookingController, StaffBookingsController } from './booking.controllers';
import { CustomerBookingService } from './customer-booking.service';
import { CustomerLiveService } from './customer-live.service';
import { CustomerLiveController, OwnerQueueController, StaffQueueController } from './queue.controllers';
import { QueueRepository } from './queue.repository';
import { QueueService } from './queue.service';
import { SalonBookingService } from './salon-booking.service';

/**
 * Phase 8: appointment booking engine. Reuses the Phase 7 availability reads (DiscoveryModule exports DiscoveryRepository),
 * the listing rule (ListingModule) and the salon lookup (SalonsModule). Phase 9 adds the staff queue (start / complete /
 * next customer / no-show / walk-ins / ETA / early offers) and the customer's arrival report. Notifications arrive in Phase 10.
 */
@Module({
  imports: [DiscoveryModule, ListingModule, SalonsModule],
  controllers: [
    CustomerBookingsController, OwnerBookingsController, StaffBookingsController, PublicBookingController,
    StaffQueueController, OwnerQueueController, CustomerLiveController,
  ],
  providers: [BookingRepository, QueueRepository, CustomerBookingService, CustomerLiveService, SalonBookingService, QueueService],
})
export class BookingModule {}
