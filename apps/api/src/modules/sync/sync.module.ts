import { Module } from '@nestjs/common';
import { BookingModule } from '../booking/booking.module';
import { SyncController } from './sync.controllers';
import { SyncRepository } from './sync.repository';
import { SyncService } from './sync.service';

/**
 * Phase 12: offline-first sync for the owner and staff apps. It replays the offline actions through the SAME QueueService as the
 * online endpoints (same permissions, same rules, same database guards) and keeps an append-only ledger so a retry never repeats
 * anything. Nothing in booking, billing or notifications was changed to make this work.
 */
@Module({
  imports: [BookingModule],
  controllers: [SyncController],
  providers: [SyncRepository, SyncService],
})
export class SyncModule {}
