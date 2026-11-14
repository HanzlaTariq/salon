import { Module } from '@nestjs/common';
import { DiscoveryModule } from '../discovery/discovery.module';
import { ListingModule } from '../listing/listing';
import { SalonsModule } from '../salons/salons.module';
import { BookingRepository } from './booking.repository';
import { CustomerBookingsController, OwnerBookingsController, PublicBookingController, StaffBookingsController } from './booking.controllers';
import { CustomerBookingService } from './customer-booking.service';
import { SalonBookingService } from './salon-booking.service';

/**
 * Phase 8: appointment booking engine. Reuses the Phase 7 availability reads (DiscoveryModule exports DiscoveryRepository),
 * the listing rule (ListingModule) and the salon lookup (SalonsModule). Notifications arrive in Phase 10, the staff
 * queue (start / complete / next customer / no-show / walk-ins) in Phase 9.
 */
@Module({
  imports: [DiscoveryModule, ListingModule, SalonsModule],
  controllers: [CustomerBookingsController, OwnerBookingsController, StaffBookingsController, PublicBookingController],
  providers: [BookingRepository, CustomerBookingService, SalonBookingService],
})
export class BookingModule {}
