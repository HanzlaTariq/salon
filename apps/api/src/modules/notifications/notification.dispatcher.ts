import { Injectable, Logger } from '@nestjs/common';
import { Clock } from '../../common/util/clock';
import { TenantDb } from '../../common/tenancy/tenant-db.service';
import { Tx } from '../salons/salons.repository';
import { EventRecord, NotificationRepository } from './notification.repository';
import { NotificationPlanner, Planned } from './notification.planner';
import { PushProvider, PushResult } from './push.provider';
import { renderNotification } from './notification.templates';
import {
  CATEGORY_OF, NOTIFICATION_LIMITS, Preferences, SELF_NOTICE_TYPES, allowsType, isLastAttempt, retryDelayMs, throttleDelayNotice,
} from './notification.types';

export interface DispatchStats {
  claimed: number;
  notifications: number;
  pushed: number;
  failed: number;
  retried: number;
  dead: number;
}

interface ToPush {
  notificationId: string;
  title: string;
  body: string;
  data: Record<string, string>;
}

/**
 * The worker's heart. For each claimed event it (1) decides the recipients from verified facts, (2) writes the in-app history rows,
 * (3) sends the push, OUTSIDE any database transaction (a slow network call must never hold a transaction open), and (4) finishes,
 * retries or buries the event. Every step is idempotent: a crash anywhere re-runs the event without duplicates.
 */
@Injectable()
export class NotificationDispatcher {
  private readonly logger = new Logger('Notifications');

  constructor(
    private readonly tenant: TenantDb,
    private readonly repo: NotificationRepository,
    private readonly planner: NotificationPlanner,
    private readonly push: PushProvider,
    private readonly clock: Clock,
  ) {}

  async runOnce(limit: number = NOTIFICATION_LIMITS.claimBatch): Promise<DispatchStats> {
    const now = this.clock.now();
    const stats: DispatchStats = { claimed: 0, notifications: 0, pushed: 0, failed: 0, retried: 0, dead: 0 };
    const events = await this.tenant.withNotificationWorker((tx) => this.repo.claim(tx, now, limit));
    stats.claimed = events.length;
    for (const ev of events) {
      try {
        await this.handle(ev, stats);
      } catch (e) {
        await this.fail(ev, e instanceof Error ? e.message : 'unknown error', stats);
      }
    }
    return stats;
  }

  private async handle(ev: EventRecord, stats: DispatchStats): Promise<void> {
    const now = this.clock.now();
    // Phase 1: who is told what. Writes only the history rows and the (pending) delivery rows.
    const toPush = await this.tenant.withNotificationWorker((tx) => this.prepare(tx, ev, now, stats));

    // Phase 2: send. No transaction is open.
    let transientLeft = 0;
    for (const item of toPush) {
      const deliveries = await this.tenant.withNotificationWorker((tx) => this.repo.pendingDeliveries(tx, item.notificationId));
      for (const d of deliveries) {
        let result: PushResult;
        try {
          result = await this.push.send({ token: d.token, title: item.title, body: item.body, data: { ...item.data, notificationId: item.notificationId } });
        } catch {
          result = { ok: false, kind: 'TRANSIENT', code: 'PROVIDER_THROW' };
        }
        const at = this.clock.now();
        await this.tenant.withNotificationWorker(async (tx) => {
          if (result.ok) {
            await this.repo.markDelivery(tx, d.id, 'SENT', at, null, result.id);
            stats.pushed += 1;
          } else if (result.kind === 'INVALID_TOKEN') {
            await this.repo.markDelivery(tx, d.id, 'INVALID_TOKEN', at, result.code, null);
            await this.repo.disableDevice(tx, d.deviceTokenId, 'INVALID_TOKEN', at);
            stats.failed += 1;
          } else if (result.kind === 'PERMANENT' || isLastAttempt(d.attempts + 1)) {
            await this.repo.markDelivery(tx, d.id, 'FAILED', at, result.code, null);
            stats.failed += 1;
          } else {
            await this.repo.markDelivery(tx, d.id, 'PENDING', at, result.code, null);
            transientLeft += 1;
          }
        });
      }
    }

    // Phase 3: finish, or try again later (only the still-PENDING deliveries are sent again).
    const done = this.clock.now();
    if (transientLeft === 0) {
      await this.tenant.withNotificationWorker((tx) => this.repo.finishEvent(tx, ev.id, done));
    } else if (isLastAttempt(ev.attempts)) {
      stats.dead += 1;
      await this.tenant.withNotificationWorker((tx) => this.repo.killEvent(tx, ev.id, done, 'push provider kept failing'));
    } else {
      stats.retried += 1;
      await this.tenant.withNotificationWorker((tx) => this.repo.retryEvent(tx, ev.id, new Date(done.getTime() + retryDelayMs(ev.attempts)), 'push provider failed, retrying'));
    }
  }

  private async prepare(tx: Tx, ev: EventRecord, now: Date, stats: DispatchStats): Promise<ToPush[]> {
    let planned = await this.planner.plan(tx, ev, now);
    // Whoever caused the fact is not told about it (except the customer's own booking confirmation).
    planned = planned.filter((p) => p.userId !== ev.actorUserId || SELF_NOTICE_TYPES.has(p.type));
    if (planned.length === 0) return [];
    const ids = [...new Set(planned.map((p) => p.userId))];
    const [active, prefs] = await Promise.all([this.repo.activeUserIds(tx, ids), this.repo.preferences(tx, ids)]);

    const out: ToPush[] = [];
    const seen = new Set<string>();
    for (const p of planned) {
      const key = `${p.userId}:${p.type}`;
      if (seen.has(key) || !active.has(p.userId)) continue;
      seen.add(key);
      const pref = prefs.get(p.userId) as Preferences;
      if (!allowsType(pref, p.type)) continue;
      if (p.reminderOffset !== undefined && !pref.reminderOffsets.includes(p.reminderOffset)) continue;

      const dedupeKey = `evt:${ev.id}:${p.type}`;
      let id = await this.repo.findNotification(tx, p.userId, dedupeKey);
      const isRetry = id !== null;
      if (!isRetry && (await this.throttled(tx, p, now))) continue;

      const text = renderNotification(p.type, pref.language, p.params);
      const data = { ...p.data, type: p.type, route: p.route };
      if (!id) {
        id = await this.repo.insertNotification(tx, {
          userId: p.userId, salonId: p.salonId, eventId: ev.id, type: p.type, category: CATEGORY_OF[p.type], title: text.title, body: text.body,
          data, locale: pref.language, dedupeKey, createdAt: now,
        });
        if (id) stats.notifications += 1;
      }
      if (!id || !pref.pushEnabled) continue;
      const devices = await this.repo.sendableDevices(tx, p.userId, now);
      await this.repo.ensureDeliveries(tx, id, devices.map((d) => d.id));
      if (devices.length > 0 || isRetry) out.push({ notificationId: id, title: text.title, body: text.body, data });
    }
    return out;
  }

  private async throttled(tx: Tx, p: Planned, now: Date): Promise<boolean> {
    if (!p.throttle) return false;
    if (p.throttle.kind === 'DELAY') {
      const last = await this.repo.lastNoticeFor(tx, p.userId, 'DELAY_NOTICE', 'appointmentId', p.throttle.appointmentId);
      return throttleDelayNotice(last ? { createdAtMs: last.createdAt.getTime(), estimateMs: last.estimateMs } : null, p.throttle.estimateMs, now.getTime());
    }
    const last = await this.repo.lastNoticeFor(tx, p.userId, 'STAFF_SCHEDULE_UPDATED', 'staffId', p.throttle.staffId);
    return last !== null && now.getTime() - last.createdAt.getTime() < NOTIFICATION_LIMITS.scheduleThrottleMs;
  }

  private async fail(ev: EventRecord, message: string, stats: DispatchStats): Promise<void> {
    this.logger.error(`event ${ev.kind} failed (attempt ${ev.attempts}): ${message.slice(0, 160)}`);
    const now = this.clock.now();
    try {
      if (isLastAttempt(ev.attempts)) {
        stats.dead += 1;
        await this.tenant.withNotificationWorker((tx) => this.repo.killEvent(tx, ev.id, now, message));
      } else {
        stats.retried += 1;
        await this.tenant.withNotificationWorker((tx) => this.repo.retryEvent(tx, ev.id, new Date(now.getTime() + retryDelayMs(ev.attempts)), message));
      }
    } catch {
      // The lock expires and the event is claimed again: nothing is lost.
    }
  }
}
