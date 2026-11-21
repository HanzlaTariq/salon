import { Module } from '@nestjs/common';
import { DiscoveryModule } from '../discovery/discovery.module';
import { ListingModule } from '../listing/listing';
import { SalonsModule } from '../salons/salons.module';
import { AdminReviewsService } from './admin-reviews.service';
import { CustomerReviewsService } from './customer-reviews.service';
import { FavouritesService } from './favourites.service';
import { PublicReviewsService } from './public-reviews.service';
import {
  AdminReviewsController, CustomerReviewsController, FavouritesController, OwnerReviewsController, PublicReviewsController, StaffReviewsController,
} from './reviews.controllers';
import { ReviewsRepository } from './reviews.repository';
import { SalonReviewsService } from './salon-reviews.service';

/**
 * Phase 14: reviews, ratings, moderation, favourite salons and the owner's customer history. Reads earlier phases (appointments, staff, salons)
 * and writes only its own tables. Imports DiscoveryModule / ListingModule for the single "is this salon listed" rule and SalonsModule for the
 * owner's salon lookup.
 */
@Module({
  imports: [SalonsModule, DiscoveryModule, ListingModule],
  controllers: [PublicReviewsController, CustomerReviewsController, FavouritesController, OwnerReviewsController, StaffReviewsController, AdminReviewsController],
  providers: [ReviewsRepository, CustomerReviewsService, PublicReviewsService, SalonReviewsService, AdminReviewsService, FavouritesService],
})
export class ReviewsModule {}
