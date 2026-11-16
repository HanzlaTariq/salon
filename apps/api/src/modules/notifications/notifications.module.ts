import { Module } from '@nestjs/common';
import { ENV, Env } from '../../config/env';
import { NotificationDispatcher } from './notification.dispatcher';
import { NotificationPlanner } from './notification.planner';
import { NotificationRepository } from './notification.repository';
import { NotificationScheduler } from './notification.scheduler';
import { NotificationService } from './notification.service';
import { NotificationCronController, NotificationsController } from './notification.controllers';
import { FcmPushProvider, LogPushProvider, PushProvider } from './push.provider';

/**
 * Phase 10: notifications. The database outbox (fed by triggers) is drained by the worker; this module owns the worker, the push
 * provider (FCM in production, an in-memory log driver for development and tests) and the people-facing API (devices, inbox,
 * preferences). It has NO hooks inside the booking, billing or salon services: those stay exactly as they were.
 */
@Module({
  controllers: [NotificationsController, NotificationCronController],
  providers: [
    NotificationRepository, NotificationPlanner, NotificationDispatcher, NotificationScheduler, NotificationService,
    { provide: PushProvider, useFactory: (env: Env): PushProvider => (env.PUSH_DRIVER === 'fcm' ? new FcmPushProvider(env) : new LogPushProvider()), inject: [ENV] },
  ],
  exports: [PushProvider],
})
export class NotificationsModule {}
