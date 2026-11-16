import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Clock } from '../../common/util/clock';
import { TenantDb } from '../../common/tenancy/tenant-db.service';
import { ENV, Env } from '../../config/env';
import { addDays, diffDays } from '../billing/billing.types';
import { NotificationDispatcher, DispatchStats } from './notification.dispatcher';
import { NotificationRepository } from './notification.repository';
import {
  NOTIFICATION_LIMITS, REMINDER_OFFSETS, effectiveStartMs, karachiIsoDate, reminderDedupeKey, reminderDue,
} from './notification.types';

export interface TickResult extends DispatchStats {
  reminders: number;
  subscriptionNotices: number;
  purged: number;
}

/**
 * Time-based work: the sweepers that create reminder and subscription events, the dispatcher run, and the retention purge.
 * One `tick()` is safe to run from several processes at once (events are claimed with SKIP LOCKED and every sweeper insert is
 * idempotent), so a second API instance, a restart or a cron call can never send anything twice.
 *
 * It runs as a loop inside the API process when NOTIFICATIONS_WORKER_ENABLED=true (never in tests), and can also be driven by a
 * cron service through POST /internal/notifications/tick on hosting that has no long-running process.
 */
@Injectable()
export class NotificationScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('Notifications');
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<TickResult> | null = null;
  private lastSubscriptionSweepMs = 0;
  private lastPurgeMs = 0;

  constructor(
    private readonly tenant: TenantDb,
    private readonly repo: NotificationRepository,
    private readonly dispatcher: NotificationDispatcher,
    private readonly clock: Clock,
    @Inject(ENV) private readonly env: Env,
  ) {}

  onModuleInit(): void {
    if (this.env.NODE_ENV === 'test' || !this.env.NOTIFICATIONS_WORKER_ENABLED) return;
    this.timer = setInterval(() => {
      this.tick().catch((e) => this.logger.error(`tick failed: ${e instanceof Error ? e.message : 'unknown'}`));
    }, this.env.NOTIFICATIONS_TICK_SECONDS * 1000);
    this.timer.unref();
    this.logger.log(`notification worker started (every ${this.env.NOTIFICATIONS_TICK_SECONDS}s)`);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.running) await this.running.catch(() => undefined);
  }

  /** One round of work. A call made while another is running waits for it (no overlapping rounds inside one process). */
  tick(options: { force?: boolean } = {}): Promise<TickResult> {
    if (this.running) return this.running;
    this.running = this.doTick(options.force === true).finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async doTick(force: boolean): Promise<TickResult> {
    const now = this.clock.now();
    const reminders = await this.sweepReminders(now);
    let subscriptionNotices = 0;
    if (force || now.getTime() - this.lastSubscriptionSweepMs >= NOTIFICATION_LIMITS.subscriptionSweepEveryMs) {
      this.lastSubscriptionSweepMs = now.getTime();
      subscriptionNotices = await this.sweepSubscriptions(now);
    }
    // A burst (many bookings at once) is drained in several batches in the same round, up to a safety limit.
    let stats = await this.dispatcher.runOnce();
    for (let i = 1; i < NOTIFICATION_LIMITS.maxBatchesPerTick && stats.claimed >= i * NOTIFICATION_LIMITS.claimBatch; i += 1) {
      const more = await this.dispatcher.runOnce();
      if (more.claimed === 0) break;
      stats = { claimed: stats.claimed + more.claimed, notifications: stats.notifications + more.notifications, pushed: stats.pushed + more.pushed, failed: stats.failed + more.failed, retried: stats.retried + more.retried, dead: stats.dead + more.dead };
    }
    let purged = 0;
    if (force || now.getTime() - this.lastPurgeMs >= NOTIFICATION_LIMITS.purgeEveryMs) {
      this.lastPurgeMs = now.getTime();
      const p = await this.tenant.withNotificationWorker((tx) => this.repo.purge(tx, now));
      purged = p.events + p.notifications + p.devices;
    }
    return { ...stats, reminders, subscriptionNotices, purged };
  }

  /** 30 / 20 / 10 minutes before and at the appointment time. Which of them a person gets is decided later, from their preferences. */
  async sweepReminders(now: Date): Promise<number> {
    return this.tenant.withNotificationWorker(async (tx) => {
      const candidates = await this.repo.reminderCandidates(tx, now);
      let created = 0;
      for (const c of candidates) {
        const start = effectiveStartMs(c.startsAt, c.estimatedStartsAt);
        for (const offset of REMINDER_OFFSETS) {
          if (!reminderDue(start, offset, now.getTime())) continue;
          const ok = await this.repo.enqueue(tx, {
            kind: 'APPOINTMENT_REMINDER', salonId: c.salonId, refType: 'APPOINTMENT', refId: c.id,
            payload: { offset, startsAtMs: c.startsAt.getTime() }, dedupeKey: reminderDedupeKey(c.id, c.startsAt.getTime(), offset),
          });
          if (ok) created += 1;
        }
      }
      return created;
    });
  }

  /** "Ends in 7 / 3 / 1 days" and "has ended" (once per paid period). */
  async sweepSubscriptions(now: Date): Promise<number> {
    const today = karachiIsoDate(now.getTime());
    return this.tenant.withNotificationWorker(async (tx) => {
      let created = 0;
      for (const s of await this.repo.subscriptionCandidates(tx, today)) {
        const left = diffDays(today, s.periodEnd);
        if (left > 0 && NOTIFICATION_LIMITS.subscriptionWarnDays.includes(left)) {
          if (await this.repo.enqueue(tx, { kind: 'SUBSCRIPTION_NOTICE', salonId: s.salonId, refType: 'SUBSCRIPTION', refId: s.id, payload: { when: 'EXPIRING', days: left, periodEnd: s.periodEnd }, dedupeKey: `sub:${s.id}:${s.periodEnd}:${left}d` })) created += 1;
        } else if (left <= 0 && today < addDays(s.periodEnd, Math.max(s.graceDays, 0) + 30)) {
          if (await this.repo.enqueue(tx, { kind: 'SUBSCRIPTION_NOTICE', salonId: s.salonId, refType: 'SUBSCRIPTION', refId: s.id, payload: { when: 'EXPIRED', periodEnd: s.periodEnd }, dedupeKey: `sub:${s.id}:${s.periodEnd}:expired` })) created += 1;
        }
      }
      return created;
    });
  }
}
