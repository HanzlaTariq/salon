import { Injectable } from '@nestjs/common';
import { createHash, timingSafeEqual } from 'crypto';
import { AuthenticatedUser, toTenantContext } from '../../common/auth/authenticated-user';
import { AppException } from '../../common/errors/app-exception';
import { TenantDb } from '../../common/tenancy/tenant-db.service';
import { Clock } from '../../common/util/clock';
import { Tx } from '../salons/salons.repository';
import { InboxQuery, RegisterDeviceDto, UnregisterDeviceDto, UpdatePreferencesDto } from './dto/notification.dto';
import { InboxItem, NotificationRepository } from './notification.repository';
import { NotificationScheduler } from './notification.scheduler';
import { NOTIFICATION_LIMITS, Preferences, normaliseOffsets } from './notification.types';

const bad = (message: string) => new AppException('VALIDATION_FAILED', message, 400);
const notFound = () => new AppException('NOT_FOUND', 'Notification not found.', 404);

export const hashToken = (token: string): string => createHash('sha256').update(token, 'utf8').digest('hex');

/** base64url("<createdAt ISO>|<uuid>"): the keyset cursor of the inbox. */
export const encodeCursor = (createdAt: Date, id: string): string => Buffer.from(`${createdAt.toISOString()}|${id}`, 'utf8').toString('base64url');
export function decodeCursor(cursor: string): { createdAt: Date; id: string } | null {
  try {
    const [iso, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
    const at = new Date(iso);
    return Number.isNaN(at.getTime()) || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id ?? '') ? null : { createdAt: at, id };
  } catch {
    return null;
  }
}

const view = (n: InboxItem) => ({ id: n.id, type: n.type, category: n.category, title: n.title, body: n.body, data: n.data, createdAt: n.createdAt.toISOString(), readAt: n.readAt?.toISOString() ?? null });

/**
 * A person's own notifications: devices, inbox and preferences. The person is ALWAYS the caller (no user id is accepted anywhere), and
 * row-level security repeats it: a user can only ever read or change rows whose user_id is their own.
 */
@Injectable()
export class NotificationService {
  constructor(
    private readonly tenant: TenantDb,
    private readonly repo: NotificationRepository,
    private readonly scheduler: NotificationScheduler,
    private readonly clock: Clock,
  ) {}

  private own<T>(user: AuthenticatedUser, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.tenant.withTenant(toTenantContext(user), fn);
  }

  // ------------------------------------------------------------------ devices
  /**
   * Registers (or refreshes) this phone for push. The user and the session come from the verified token. A phone that was used by
   * another account moves to this one (the token belongs to the device, not to a person). Runs in the worker context because the
   * old row may belong to someone else; the values written are exactly the caller's own.
   */
  async registerDevice(user: AuthenticatedUser, dto: RegisterDeviceDto): Promise<{ registered: true }> {
    const now = this.clock.now();
    await this.tenant.withNotificationWorker(async (tx) => {
      await this.repo.upsertDevice(tx, {
        userId: user.id, sessionId: user.sessionId, token: dto.token, tokenHash: hashToken(dto.token), platform: dto.platform, app: dto.app, appVersion: dto.appVersion ?? null, now,
      });
      await this.repo.trimDevices(tx, user.id, now);
    });
    return { registered: true };
  }

  /** Called when the person signs out on this phone. Idempotent. */
  async unregisterDevice(user: AuthenticatedUser, dto: UnregisterDeviceDto): Promise<void> {
    await this.own(user, (tx) => this.repo.disableOwnDevice(tx, user.id, hashToken(dto.token), this.clock.now()));
  }

  // ------------------------------------------------------------------ inbox
  async inbox(user: AuthenticatedUser, q: InboxQuery) {
    const limit = Math.min(q.limit ?? NOTIFICATION_LIMITS.inboxPageSize, NOTIFICATION_LIMITS.inboxMaxPageSize);
    let before: { createdAt: Date; id: string } | null = null;
    if (q.cursor) {
      before = decodeCursor(q.cursor);
      if (!before) throw bad('Invalid cursor.');
    }
    return this.own(user, async (tx) => {
      const rows = await this.repo.inbox(tx, user.id, { unreadOnly: q.unread === true, before, limit: limit + 1 });
      const page = rows.slice(0, limit);
      const last = page[page.length - 1];
      return {
        items: page.map(view),
        nextCursor: rows.length > limit && last ? encodeCursor(last.createdAt, last.id) : null,
        unreadCount: await this.repo.unreadCount(tx, user.id),
      };
    });
  }

  async unreadCount(user: AuthenticatedUser) {
    return this.own(user, async (tx) => ({ unreadCount: await this.repo.unreadCount(tx, user.id) }));
  }

  async markRead(user: AuthenticatedUser, id: string) {
    return this.own(user, async (tx) => {
      if (!(await this.repo.markRead(tx, user.id, id, this.clock.now()))) throw notFound();
      return { unreadCount: await this.repo.unreadCount(tx, user.id) };
    });
  }

  async markAllRead(user: AuthenticatedUser) {
    return this.own(user, async (tx) => {
      const updated = await this.repo.markAllRead(tx, user.id, this.clock.now());
      return { updated, unreadCount: 0 };
    });
  }

  // ------------------------------------------------------------------ preferences
  getPreferences(user: AuthenticatedUser): Promise<Preferences> {
    return this.own(user, (tx) => this.repo.getPreferences(tx, user.id));
  }

  async updatePreferences(user: AuthenticatedUser, dto: UpdatePreferencesDto): Promise<Preferences> {
    const prefs: Preferences = {
      pushEnabled: dto.pushEnabled, language: dto.language, bookings: dto.bookings, reminders: dto.reminders, queue: dto.queue, team: dto.team,
      reminderOffsets: normaliseOffsets(dto.reminderOffsets),
    };
    return this.own(user, async (tx) => {
      await this.repo.savePreferences(tx, user.id, prefs, this.clock.now());
      return this.repo.getPreferences(tx, user.id);
    });
  }

  // ------------------------------------------------------------------ cron entry point
  /** Constant-time comparison of the shared secret (SHA-256 first, so both sides always have the same length). */
  static secretMatches(expected: string | undefined, given: string | undefined): boolean {
    if (!expected || !given) return false;
    const a = createHash('sha256').update(expected).digest();
    const b = createHash('sha256').update(given).digest();
    return timingSafeEqual(a, b);
  }

  tick() {
    return this.scheduler.tick({ force: true });
  }
}
