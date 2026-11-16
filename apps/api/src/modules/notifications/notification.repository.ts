import { Injectable } from '@nestjs/common';
import { Tx } from '../salons/salons.repository';
import { DEFAULT_PREFERENCES, EventKind, Language, NOTIFICATION_LIMITS, NotificationType, Preferences } from './notification.types';

type Row = Record<string, any>;
const date = (v: unknown): Date => (v instanceof Date ? v : new Date(v as string));
const dateOrNull = (v: unknown): Date | null => (v === null || v === undefined ? null : date(v));

export interface EventRecord {
  id: string;
  kind: EventKind;
  salonId: string | null;
  refType: string;
  refId: string;
  actorUserId: string | null;
  payload: Record<string, any>;
  dedupeKey: string;
  attempts: number;
}

export interface HistoryRecord {
  id: string;
  salonId: string;
  appointmentId: string;
  event: string;
  toStatus: string;
  actorUserId: string;
  actorRole: string;
  reason: string | null;
  oldStartsAt: Date | null;
  newStartsAt: Date | null;
  createdAt: Date;
}

export interface AppointmentFacts {
  id: string;
  salonId: string;
  customerUserId: string | null;
  staffId: string;
  status: string;
  source: string;
  startsAt: Date;
  estimatedStartsAt: Date | null;
  customerEtaAt: Date | null;
  arrivalState: string;
  cancelledByRole: string | null;
  cancellationReason: string | null;
  salonName: string;
  staffName: string;
  customerName: string;
  staffUserId: string | null;
  ownerUserId: string;
}

export interface OfferFacts {
  id: string;
  offeredStart: Date;
  expiresAt: Date;
  status: string;
}

export interface SalonFacts {
  id: string;
  name: string;
  ownerUserId: string;
  status: string;
  rejectionReason: string | null;
  suspendedReason: string | null;
}

export interface PaymentFacts {
  id: string;
  salonId: string;
  status: string;
  reviewReason: string | null;
  invoiceNo: string;
  ownerUserId: string;
}

export interface SubscriptionFacts {
  id: string;
  salonId: string;
  status: string;
  periodEnd: string;
  graceDays: number;
  ownerUserId: string;
}

export interface StaffFacts {
  id: string;
  salonId: string;
  userId: string | null;
  displayName: string;
  isActive: boolean;
  ownerUserId: string;
}

export interface NewNotification {
  userId: string;
  salonId: string | null;
  eventId: string | null;
  type: NotificationType;
  category: string;
  title: string;
  body: string;
  data: Record<string, string>;
  locale: Language;
  dedupeKey: string;
  /** The worker's clock (not the database's), so every time rule is testable and consistent. */
  createdAt: Date;
}

export interface DeviceRecord {
  id: string;
  token: string;
}

export interface DeliveryRecord {
  id: string;
  deviceTokenId: string;
  token: string;
  attempts: number;
}

export interface InboxItem {
  id: string;
  type: string;
  category: string;
  title: string;
  body: string;
  data: Record<string, string>;
  createdAt: Date;
  readAt: Date | null;
}

export interface NewEvent {
  kind: EventKind;
  salonId: string | null;
  refType: 'APPOINTMENT' | 'SUBSCRIPTION';
  refId: string;
  payload: Record<string, unknown>;
  dedupeKey: string;
}

const prefsOf = (r: Row | undefined): Preferences =>
  r
    ? {
        pushEnabled: r.push_enabled, language: r.language, bookings: r.bookings, reminders: r.reminders, queue: r.queue, team: r.team,
        reminderOffsets: (r.reminder_offsets as number[]).map(Number),
      }
    : { ...DEFAULT_PREFERENCES, reminderOffsets: [...DEFAULT_PREFERENCES.reminderOffsets] };

@Injectable()
export class NotificationRepository {
  // ================================================================== worker: outbox
  /** Claims due events (several workers may run: SKIP LOCKED). A claimed event that is never finished is claimed again after the lock. */
  async claim(tx: Tx, now: Date, limit: number): Promise<EventRecord[]> {
    const r = await tx.$queryRaw<Row[]>`
      UPDATE notification_events SET attempts = attempts + 1, locked_until = ${now}::timestamptz + make_interval(secs => ${NOTIFICATION_LIMITS.lockSeconds}::int)
      WHERE id IN (
        SELECT id FROM notification_events
        WHERE status = 'PENDING' AND run_at <= ${now}::timestamptz AND (locked_until IS NULL OR locked_until < ${now}::timestamptz)
        ORDER BY run_at, created_at LIMIT ${limit}::int FOR UPDATE SKIP LOCKED)
      RETURNING id, kind, salon_id, ref_type, ref_id, actor_user_id, payload, dedupe_key, attempts`;
    return r.map((x) => ({
      id: x.id, kind: x.kind, salonId: x.salon_id, refType: x.ref_type, refId: x.ref_id, actorUserId: x.actor_user_id,
      payload: (typeof x.payload === 'string' ? JSON.parse(x.payload) : x.payload) ?? {}, dedupeKey: x.dedupe_key, attempts: Number(x.attempts),
    }));
  }

  async finishEvent(tx: Tx, id: string, now: Date): Promise<void> {
    await tx.$executeRaw`UPDATE notification_events SET status = 'DONE', processed_at = ${now}::timestamptz, locked_until = NULL, last_error = NULL WHERE id = ${id}::uuid`;
  }

  async retryEvent(tx: Tx, id: string, runAt: Date, error: string): Promise<void> {
    await tx.$executeRaw`UPDATE notification_events SET run_at = ${runAt}::timestamptz, locked_until = NULL, last_error = ${error.slice(0, 200)}::varchar WHERE id = ${id}::uuid`;
  }

  async killEvent(tx: Tx, id: string, now: Date, error: string): Promise<void> {
    await tx.$executeRaw`UPDATE notification_events SET status = 'DEAD', processed_at = ${now}::timestamptz, locked_until = NULL, last_error = ${error.slice(0, 200)}::varchar WHERE id = ${id}::uuid`;
  }

  /** Used by the sweepers. A repeated call with the same key does nothing. */
  async enqueue(tx: Tx, e: NewEvent): Promise<boolean> {
    const n = await tx.$executeRaw`
      INSERT INTO notification_events (kind, salon_id, ref_type, ref_id, payload, dedupe_key)
      VALUES (${e.kind}::varchar, ${e.salonId}::uuid, ${e.refType}::varchar, ${e.refId}::uuid, ${JSON.stringify(e.payload)}::jsonb, ${e.dedupeKey}::varchar)
      ON CONFLICT (dedupe_key) DO NOTHING`;
    return n > 0;
  }

  // ================================================================== worker: the facts
  async history(tx: Tx, id: string): Promise<HistoryRecord | null> {
    const r = await tx.$queryRaw<Row[]>`
      SELECT id, salon_id, appointment_id, event, to_status::text AS to_status, actor_user_id, actor_role, reason, old_starts_at, new_starts_at, created_at
      FROM appointment_status_history WHERE id = ${id}::uuid`;
    const x = r[0];
    return x
      ? { id: x.id, salonId: x.salon_id, appointmentId: x.appointment_id, event: x.event, toStatus: x.to_status, actorUserId: x.actor_user_id, actorRole: x.actor_role, reason: x.reason, oldStartsAt: dateOrNull(x.old_starts_at), newStartsAt: dateOrNull(x.new_starts_at), createdAt: date(x.created_at) }
      : null;
  }

  async appointment(tx: Tx, id: string): Promise<AppointmentFacts | null> {
    const r = await tx.$queryRaw<Row[]>`
      SELECT a.id, a.salon_id, a.customer_user_id, a.staff_id, a.status::text AS status, a.source, a.starts_at, a.estimated_starts_at, a.customer_eta_at,
             a.arrival_state, a.cancelled_by_role, a.cancellation_reason, a.salon_name, a.staff_name, a.walk_in_name,
             cu.full_name AS customer_full_name, sp.user_id AS staff_user_id, s.owner_user_id
      FROM appointments a
      JOIN salons s ON s.id = a.salon_id
      LEFT JOIN staff_profiles sp ON sp.id = a.staff_id AND sp.salon_id = a.salon_id
      LEFT JOIN users cu ON cu.id = a.customer_user_id
      WHERE a.id = ${id}::uuid`;
    const x = r[0];
    return x
      ? {
          id: x.id, salonId: x.salon_id, customerUserId: x.customer_user_id, staffId: x.staff_id, status: x.status, source: x.source, startsAt: date(x.starts_at),
          estimatedStartsAt: dateOrNull(x.estimated_starts_at), customerEtaAt: dateOrNull(x.customer_eta_at), arrivalState: x.arrival_state,
          cancelledByRole: x.cancelled_by_role, cancellationReason: x.cancellation_reason, salonName: x.salon_name, staffName: x.staff_name,
          customerName: x.customer_full_name ?? x.walk_in_name ?? '', staffUserId: x.staff_user_id, ownerUserId: x.owner_user_id,
        }
      : null;
  }

  async pendingOffer(tx: Tx, appointmentId: string): Promise<OfferFacts | null> {
    const r = await tx.$queryRaw<Row[]>`
      SELECT id, offered_start, expires_at, status FROM appointment_early_offers WHERE appointment_id = ${appointmentId}::uuid AND status = 'PENDING'`;
    const x = r[0];
    return x ? { id: x.id, offeredStart: date(x.offered_start), expiresAt: date(x.expires_at), status: x.status } : null;
  }

  async acceptedOfferMinutes(tx: Tx, appointmentId: string): Promise<number | null> {
    const r = await tx.$queryRaw<Row[]>`
      SELECT customer_eta_minutes FROM appointment_early_offers WHERE appointment_id = ${appointmentId}::uuid AND status = 'ACCEPTED' ORDER BY responded_at DESC LIMIT 1`;
    return r[0]?.customer_eta_minutes === null || r[0] === undefined ? null : Number(r[0].customer_eta_minutes);
  }

  async salon(tx: Tx, id: string): Promise<SalonFacts | null> {
    const r = await tx.$queryRaw<Row[]>`SELECT id, name, owner_user_id, status::text AS status, rejection_reason, suspended_reason FROM salons WHERE id = ${id}::uuid`;
    const x = r[0];
    return x ? { id: x.id, name: x.name, ownerUserId: x.owner_user_id, status: x.status, rejectionReason: x.rejection_reason, suspendedReason: x.suspended_reason } : null;
  }

  async payment(tx: Tx, id: string): Promise<PaymentFacts | null> {
    const r = await tx.$queryRaw<Row[]>`
      SELECT p.id, p.salon_id, p.status, p.review_reason, i.invoice_no, s.owner_user_id
      FROM payments p JOIN invoices i ON i.id = p.invoice_id JOIN salons s ON s.id = p.salon_id WHERE p.id = ${id}::uuid`;
    const x = r[0];
    return x ? { id: x.id, salonId: x.salon_id, status: x.status, reviewReason: x.review_reason, invoiceNo: x.invoice_no, ownerUserId: x.owner_user_id } : null;
  }

  async subscription(tx: Tx, id: string): Promise<SubscriptionFacts | null> {
    const r = await tx.$queryRaw<Row[]>`
      SELECT ss.id, ss.salon_id, ss.status, to_char(ss.period_end, 'YYYY-MM-DD') AS period_end, ss.period_grace_days, s.owner_user_id
      FROM salon_subscriptions ss JOIN salons s ON s.id = ss.salon_id WHERE ss.id = ${id}::uuid`;
    const x = r[0];
    return x ? { id: x.id, salonId: x.salon_id, status: x.status, periodEnd: x.period_end, graceDays: Number(x.period_grace_days), ownerUserId: x.owner_user_id } : null;
  }

  async staff(tx: Tx, id: string): Promise<StaffFacts | null> {
    const r = await tx.$queryRaw<Row[]>`
      SELECT sp.id, sp.salon_id, sp.user_id, sp.display_name, sp.is_active, s.owner_user_id
      FROM staff_profiles sp JOIN salons s ON s.id = sp.salon_id WHERE sp.id = ${id}::uuid AND sp.deleted_at IS NULL`;
    const x = r[0];
    return x ? { id: x.id, salonId: x.salon_id, userId: x.user_id, displayName: x.display_name, isActive: x.is_active, ownerUserId: x.owner_user_id } : null;
  }

  async invitation(tx: Tx, id: string): Promise<{ id: string; salonId: string; staffId: string; status: string } | null> {
    const r = await tx.$queryRaw<Row[]>`SELECT id, salon_id, staff_id, status FROM staff_invitations WHERE id = ${id}::uuid`;
    const x = r[0];
    return x ? { id: x.id, salonId: x.salon_id, staffId: x.staff_id, status: x.status } : null;
  }

  /** Only ACTIVE accounts are ever notified. */
  async activeUserIds(tx: Tx, ids: string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const r = await tx.$queryRaw<Row[]>`SELECT id FROM users WHERE id = ANY(${ids}::uuid[]) AND status = 'ACTIVE'`;
    return new Set(r.map((x) => x.id as string));
  }

  async preferences(tx: Tx, ids: string[]): Promise<Map<string, Preferences>> {
    const out = new Map<string, Preferences>();
    if (ids.length === 0) return out;
    const r = await tx.$queryRaw<Row[]>`SELECT * FROM notification_preferences WHERE user_id = ANY(${ids}::uuid[])`;
    const byId = new Map(r.map((x) => [x.user_id as string, x]));
    for (const id of ids) out.set(id, prefsOf(byId.get(id)));
    return out;
  }

  /** The last delay notice sent to this customer for this appointment (for the throttle). */
  async lastNoticeFor(tx: Tx, userId: string, type: NotificationType, dataKey: 'appointmentId' | 'staffId', dataValue: string): Promise<{ createdAt: Date; estimateMs: number | null } | null> {
    const r = await tx.$queryRaw<Row[]>`
      SELECT created_at, data->>'estimateMs' AS estimate_ms FROM notifications
      WHERE user_id = ${userId}::uuid AND type = ${type}::varchar AND data->>${dataKey}::text = ${dataValue}::text
      ORDER BY created_at DESC LIMIT 1`;
    const x = r[0];
    return x ? { createdAt: date(x.created_at), estimateMs: x.estimate_ms === null ? null : Number(x.estimate_ms) } : null;
  }

  // ================================================================== worker: history, devices, deliveries
  async findNotification(tx: Tx, userId: string, dedupeKey: string): Promise<string | null> {
    const r = await tx.$queryRaw<Row[]>`SELECT id FROM notifications WHERE user_id = ${userId}::uuid AND dedupe_key = ${dedupeKey}::varchar`;
    return r[0]?.id ?? null;
  }

  /** Idempotent: the same (person, event) can never produce two history rows. */
  async insertNotification(tx: Tx, n: NewNotification): Promise<string | null> {
    const r = await tx.$queryRaw<Row[]>`
      INSERT INTO notifications (user_id, salon_id, event_id, type, category, title, body, data, locale, dedupe_key, created_at)
      VALUES (${n.userId}::uuid, ${n.salonId}::uuid, ${n.eventId}::uuid, ${n.type}::varchar, ${n.category}::varchar, ${n.title}::varchar, ${n.body}::varchar,
              ${JSON.stringify(n.data)}::jsonb, ${n.locale}::varchar, ${n.dedupeKey}::varchar, ${n.createdAt}::timestamptz)
      ON CONFLICT (user_id, dedupe_key) DO NOTHING RETURNING id`;
    return r[0]?.id ?? null;
  }

  /** The person's devices that can receive a push: not switched off, and still signed in (the session is neither revoked nor expired). */
  async sendableDevices(tx: Tx, userId: string, now: Date): Promise<DeviceRecord[]> {
    const r = await tx.$queryRaw<Row[]>`
      SELECT d.id, d.token FROM device_tokens d JOIN auth_sessions s ON s.id = d.session_id
      WHERE d.user_id = ${userId}::uuid AND d.disabled_at IS NULL AND s.revoked_at IS NULL AND s.expires_at > ${now}::timestamptz
      ORDER BY d.last_seen_at DESC LIMIT ${NOTIFICATION_LIMITS.maxDevicesPerUser}::int`;
    return r.map((x) => ({ id: x.id, token: x.token }));
  }

  async ensureDeliveries(tx: Tx, notificationId: string, deviceIds: string[]): Promise<void> {
    if (deviceIds.length === 0) return;
    await tx.$executeRaw`
      INSERT INTO notification_deliveries (notification_id, device_token_id)
      SELECT ${notificationId}::uuid, d FROM unnest(${deviceIds}::uuid[]) AS d
      ON CONFLICT (notification_id, device_token_id) DO NOTHING`;
  }

  async pendingDeliveries(tx: Tx, notificationId: string): Promise<DeliveryRecord[]> {
    const r = await tx.$queryRaw<Row[]>`
      SELECT nd.id, nd.device_token_id, nd.attempts, d.token
      FROM notification_deliveries nd JOIN device_tokens d ON d.id = nd.device_token_id
      WHERE nd.notification_id = ${notificationId}::uuid AND nd.status = 'PENDING' AND d.disabled_at IS NULL`;
    return r.map((x) => ({ id: x.id, deviceTokenId: x.device_token_id, token: x.token, attempts: Number(x.attempts) }));
  }

  async markDelivery(tx: Tx, id: string, status: 'SENT' | 'FAILED' | 'INVALID_TOKEN' | 'PENDING', now: Date, error: string | null, providerId: string | null): Promise<void> {
    await tx.$executeRaw`
      UPDATE notification_deliveries SET status = ${status}::varchar, attempts = attempts + 1, last_error = ${error}::varchar, provider_message_id = ${providerId}::varchar,
        sent_at = CASE WHEN ${status}::varchar = 'SENT' THEN ${now}::timestamptz ELSE NULL END, updated_at = ${now}::timestamptz
      WHERE id = ${id}::uuid`;
  }

  async disableDevice(tx: Tx, id: string, reason: string, now: Date): Promise<void> {
    await tx.$executeRaw`UPDATE device_tokens SET disabled_at = ${now}::timestamptz, disabled_reason = ${reason}::varchar WHERE id = ${id}::uuid AND disabled_at IS NULL`;
  }

  // ================================================================== worker: sweepers
  /** Confirmed online appointments that start soon (or whose forecast makes them start soon): reminder candidates. */
  async reminderCandidates(tx: Tx, now: Date): Promise<Array<{ id: string; salonId: string; customerUserId: string; startsAt: Date; estimatedStartsAt: Date | null }>> {
    const r = await tx.$queryRaw<Row[]>`
      SELECT id, salon_id, customer_user_id, starts_at, estimated_starts_at FROM appointments
      WHERE status = 'CONFIRMED' AND customer_user_id IS NOT NULL
        AND starts_at BETWEEN ${now}::timestamptz - make_interval(hours => ${NOTIFICATION_LIMITS.reminderLookBackHours}::int)
                          AND ${now}::timestamptz + make_interval(mins => ${NOTIFICATION_LIMITS.reminderLookAheadMinutes}::int)
      ORDER BY starts_at LIMIT 500`;
    return r.map((x) => ({ id: x.id, salonId: x.salon_id, customerUserId: x.customer_user_id, startsAt: date(x.starts_at), estimatedStartsAt: dateOrNull(x.estimated_starts_at) }));
  }

  async subscriptionCandidates(tx: Tx, today: string): Promise<Array<{ id: string; salonId: string; status: string; periodEnd: string; graceDays: number }>> {
    const r = await tx.$queryRaw<Row[]>`
      SELECT id, salon_id, status, to_char(period_end, 'YYYY-MM-DD') AS period_end, period_grace_days FROM salon_subscriptions
      WHERE status = 'ACTIVE' AND period_end <= (${today}::date + 8) AND period_end >= (${today}::date - 40)`;
    return r.map((x) => ({ id: x.id, salonId: x.salon_id, status: x.status, periodEnd: x.period_end, graceDays: Number(x.period_grace_days) }));
  }

  /** Data-retention policy. Returns how many rows were removed. */
  async purge(tx: Tx, now: Date): Promise<{ events: number; notifications: number; devices: number }> {
    const events = await tx.$executeRaw`
      DELETE FROM notification_events WHERE status <> 'PENDING' AND processed_at < ${now}::timestamptz - make_interval(days => ${NOTIFICATION_LIMITS.retainEventsDays}::int)`;
    const notifications = await tx.$executeRaw`
      DELETE FROM notifications WHERE created_at < ${now}::timestamptz - make_interval(days => ${NOTIFICATION_LIMITS.retainNotificationsDays}::int)`;
    const devices = await tx.$executeRaw`
      DELETE FROM device_tokens WHERE disabled_at IS NOT NULL AND disabled_at < ${now}::timestamptz - make_interval(days => ${NOTIFICATION_LIMITS.retainDevicesDays}::int)`;
    return { events, notifications, devices };
  }

  // ================================================================== devices (registered through the worker context, see the service)
  async upsertDevice(tx: Tx, d: { userId: string; sessionId: string; token: string; tokenHash: string; platform: string; app: string; appVersion: string | null; now: Date }): Promise<string> {
    const r = await tx.$queryRaw<Row[]>`
      INSERT INTO device_tokens (user_id, session_id, token, token_hash, platform, app, app_version, last_seen_at)
      VALUES (${d.userId}::uuid, ${d.sessionId}::uuid, ${d.token}::text, ${d.tokenHash}::char(64), ${d.platform}::varchar, ${d.app}::varchar, ${d.appVersion}::varchar, ${d.now}::timestamptz)
      ON CONFLICT (token_hash) DO UPDATE SET user_id = EXCLUDED.user_id, session_id = EXCLUDED.session_id, platform = EXCLUDED.platform, app = EXCLUDED.app,
        app_version = EXCLUDED.app_version, last_seen_at = EXCLUDED.last_seen_at, disabled_at = NULL, disabled_reason = NULL
      RETURNING id`;
    return r[0].id as string;
  }

  /** Keeps the newest devices; switches the rest off. */
  async trimDevices(tx: Tx, userId: string, now: Date): Promise<void> {
    await tx.$executeRaw`
      UPDATE device_tokens SET disabled_at = ${now}::timestamptz, disabled_reason = 'TOO_MANY'
      WHERE id IN (SELECT id FROM device_tokens WHERE user_id = ${userId}::uuid AND disabled_at IS NULL
                   ORDER BY last_seen_at DESC OFFSET ${NOTIFICATION_LIMITS.maxDevicesPerUser}::int)`;
  }

  // ================================================================== a person's own data (user context, RLS applies)
  async disableOwnDevice(tx: Tx, userId: string, tokenHash: string, now: Date): Promise<void> {
    await tx.$executeRaw`
      UPDATE device_tokens SET disabled_at = ${now}::timestamptz, disabled_reason = 'LOGOUT'
      WHERE token_hash = ${tokenHash}::char(64) AND user_id = ${userId}::uuid AND disabled_at IS NULL`;
  }

  async inbox(tx: Tx, userId: string, opts: { unreadOnly: boolean; before: { createdAt: Date; id: string } | null; limit: number }): Promise<InboxItem[]> {
    const r = await tx.$queryRaw<Row[]>`
      SELECT id, type, category, title, body, data, created_at, read_at FROM notifications
      WHERE user_id = ${userId}::uuid
        AND (${opts.unreadOnly}::boolean = false OR read_at IS NULL)
        AND (${opts.before?.createdAt ?? null}::timestamptz IS NULL OR (created_at, id) < (${opts.before?.createdAt ?? null}::timestamptz, ${opts.before?.id ?? null}::uuid))
      ORDER BY created_at DESC, id DESC LIMIT ${opts.limit}::int`;
    return r.map((x) => ({
      id: x.id, type: x.type, category: x.category, title: x.title, body: x.body, data: (typeof x.data === 'string' ? JSON.parse(x.data) : x.data) ?? {},
      createdAt: date(x.created_at), readAt: dateOrNull(x.read_at),
    }));
  }

  async unreadCount(tx: Tx, userId: string): Promise<number> {
    const r = await tx.$queryRaw<Row[]>`SELECT count(*)::int AS n FROM notifications WHERE user_id = ${userId}::uuid AND read_at IS NULL`;
    return Number(r[0].n);
  }

  async markRead(tx: Tx, userId: string, id: string, now: Date): Promise<boolean> {
    const n = await tx.$executeRaw`UPDATE notifications SET read_at = ${now}::timestamptz WHERE id = ${id}::uuid AND user_id = ${userId}::uuid AND read_at IS NULL`;
    if (n > 0) return true;
    const r = await tx.$queryRaw<Row[]>`SELECT 1 FROM notifications WHERE id = ${id}::uuid AND user_id = ${userId}::uuid`;
    return r.length > 0; // already read counts as success; someone else's or unknown id is "not found"
  }

  async markAllRead(tx: Tx, userId: string, now: Date): Promise<number> {
    return tx.$executeRaw`UPDATE notifications SET read_at = ${now}::timestamptz WHERE user_id = ${userId}::uuid AND read_at IS NULL`;
  }

  async getPreferences(tx: Tx, userId: string): Promise<Preferences> {
    const r = await tx.$queryRaw<Row[]>`SELECT * FROM notification_preferences WHERE user_id = ${userId}::uuid`;
    return prefsOf(r[0]);
  }

  async savePreferences(tx: Tx, userId: string, p: Preferences, now: Date): Promise<void> {
    await tx.$executeRaw`
      INSERT INTO notification_preferences (user_id, push_enabled, language, bookings, reminders, queue, team, reminder_offsets, updated_at)
      VALUES (${userId}::uuid, ${p.pushEnabled}::boolean, ${p.language}::varchar, ${p.bookings}::boolean, ${p.reminders}::boolean, ${p.queue}::boolean, ${p.team}::boolean,
              ${p.reminderOffsets}::smallint[], ${now}::timestamptz)
      ON CONFLICT (user_id) DO UPDATE SET push_enabled = EXCLUDED.push_enabled, language = EXCLUDED.language, bookings = EXCLUDED.bookings, reminders = EXCLUDED.reminders,
        queue = EXCLUDED.queue, team = EXCLUDED.team, reminder_offsets = EXCLUDED.reminder_offsets, updated_at = EXCLUDED.updated_at`;
  }
}
