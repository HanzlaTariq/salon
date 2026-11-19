import { Injectable } from '@nestjs/common';
import { AuthenticatedUser, toTenantContext } from '../../common/auth/authenticated-user';
import { sqlState } from '../../common/db/pg-errors';
import { AppException } from '../../common/errors/app-exception';
import { TenantDb } from '../../common/tenancy/tenant-db.service';
import { Clock } from '../../common/util/clock';
import { normalizePhone } from '../../common/util/phone';
import { DiscoveryRepository } from '../discovery/discovery.repository';
import { addDaysIso, parseClock, sumMoney } from '../discovery/discovery.types';
import { SalonRecord } from '../salons/salon.types';
import { SalonsRepository, Tx } from '../salons/salons.repository';
import { AppointmentRecord, BookingRepository } from './booking.repository';
import {
  BOOKING_LIMITS, BookingPolicy, IDEMPOTENCY_KEY_RE, canStartAt, dayStartMs, karachiParts, openStarts, slotMs,
} from './booking.types';
import { EarlyOfferDto, NoShowDto, OwnerWalkInDto } from './dto/queue.dto';
import { OwnStaffRecord, QueueRepository, StaffLaneRecord } from './queue.repository';
import {
  QUEUE_LIMITS, QueueItem, QueueProjection, earlyOfferBounds, estimateChanged, karachiDayBounds, noShowDecision, projectQueue, startDecision, walkInFingerprint,
} from './queue.types';
import { LaneView, QueueItemView, laneView, queueItemView } from './queue.views';
import { offerView } from './booking.views';

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const bad = (message: string) => new AppException('VALIDATION_FAILED', message, 400);
const notFound = (what: string) => new AppException('NOT_FOUND', `${what} not found.`, 404);
const conflict = (message: string, details?: unknown) => new AppException('CONFLICT', message, 409, details);
const forbidden = (message: string) => new AppException('FORBIDDEN', message, 403);
const isExclusionViolation = (e: unknown): boolean => sqlState(e) === '23P01';
const isUniqueViolation = (e: unknown): boolean => sqlState(e) === '23505';
const statusConflict = (a: AppointmentRecord) =>
  conflict(`This appointment is ${a.status.toLowerCase().replace('_', ' ')}.`, { rule: 'STATUS', status: a.status });

type Kind = 'OWNER' | 'STAFF';
export interface Scope {
  user: AuthenticatedUser;
  kind: Kind;
  salon: SalonRecord;
  /** The caller's own staff profile (STAFF only). */
  own: OwnStaffRecord | null;
}
/** Phase 12 (offline sync). A walk-in written down within this long of "now" is simply a walk-in of now. */
const BACKDATE_THRESHOLD_MS = 2 * MINUTE_MS;

/**
 * Extra instructions of the offline sync service for the actions below. Online requests never pass them.
 *  - `at`: when the person REALLY acted (already clamped by the sync service to the last 48 hours and never later than now). It is the
 *    moment that is recorded (started / completed / no-show / walk-in time) and the moment the rules are judged at. Forecasts and
 *    estimates always use the real clock.
 *  - `after`: runs inside the SAME transaction, after the change and before the commit. The sync service writes its ledger row there,
 *    so the change and its record commit together or not at all (a retry can never apply it twice).
 */
export interface Acting {
  at?: Date;
  after?: (tx: Tx, a: AppointmentRecord) => Promise<void>;
}

interface Loaded {
  rows: AppointmentRecord[];
  projection: QueueProjection;
}

const toItem = (a: AppointmentRecord): QueueItem => ({
  id: a.id,
  status: a.status as QueueItem['status'],
  startsAtMs: a.startsAt.getTime(),
  durationMinutes: a.totalDurationMinutes,
  bufferMinutes: a.bufferMinutes,
  startedAtMs: a.startedAt?.getTime() ?? null,
  customerEtaAtMs: a.arrivalState === 'NONE' ? null : a.customerEtaAt?.getTime() ?? null,
});

/**
 * Phase 9, salon side: the live queue and everything staff do to it.
 *
 * Who may do what (the salon is ALWAYS derived from the verified session, never from the request):
 *  - SALON_OWNER: every staff member's queue in their own salon (start, complete, next, no-show, walk-ins, early offers).
 *  - SALON_STAFF: ONLY their own queue (their staff id comes from their own profile, never from input). Walk-ins also need the
 *    `walk_ins.create` permission granted by the owner. The database repeats these rules in Row-Level Security.
 *
 * Concurrency: every queue action takes a per-staff advisory lock, re-reads the appointment, and every status change repeats the
 * expected status in its UPDATE, so two taps (or a tap and a customer cancel) can never both win.
 *
 * Nothing here is automatic: no-show, completion and start are always an explicit action by a person (section 12 of the brief).
 */
@Injectable()
export class QueueService {
  constructor(
    private readonly tenant: TenantDb,
    private readonly repo: BookingRepository,
    private readonly q: QueueRepository,
    private readonly discovery: DiscoveryRepository,
    private readonly salons: SalonsRepository,
    private readonly clock: Clock,
  ) {}

  // ------------------------------------------------------------------ who is calling, and where
  /** Who is calling, and for which salon (derived from the session). Also used by the Phase 12 sync service. */
  async resolve(user: AuthenticatedUser): Promise<Scope> {
    if (user.role === 'SALON_OWNER') {
      const salon = await this.tenant.withTenant(toTenantContext(user), (tx: Tx) => this.salons.findByOwner(tx, user.id));
      if (!salon) throw notFound('Salon');
      if (salon.status !== 'APPROVED') throw forbidden('Your salon is not active at the moment.');
      return { user, kind: 'OWNER', salon, own: null };
    }
    const own = await this.tenant.withTenant(toTenantContext(user), (tx: Tx) => this.q.findOwnStaff(tx, user.id));
    if (!own) throw notFound('Staff profile');
    if (!own.isActive) throw forbidden('Your access has been disabled by the salon owner.');
    const salon = await this.tenant.withTenant(toTenantContext(user, own.salonId), (tx: Tx) => this.salons.findById(tx, own.salonId));
    if (!salon) throw notFound('Salon');
    if (salon.status !== 'APPROVED') throw forbidden('Your salon is not active at the moment.');
    return { user, kind: 'STAFF', salon, own };
  }

  /** Runs `fn` in a transaction scoped to the caller's salon (Row-Level Security applies). */
  inTx<T>(s: Scope, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.tenant.withTenant(toTenantContext(s.user, s.salon.id), fn);
  }

  private actorRole = (s: Scope): 'SALON_OWNER' | 'SALON_STAFF' => (s.kind === 'OWNER' ? 'SALON_OWNER' : 'SALON_STAFF');
  private includePhone = (s: Scope): boolean => s.kind === 'OWNER';

  // ------------------------------------------------------------------ estimates
  /**
   * Re-reads today's open appointments of the given staff, forecasts the day and SAVES the estimate of every appointment whose
   * forecast moved by 5 minutes or more (with an ETA_CHANGED history row: the hook for Phase 10 notifications). The booked time
   * is never touched. Staff are locked in id order so two callers can never deadlock.
   */
  private async refresh(tx: Tx, s: Scope, staffIds: string[], now: Date): Promise<Map<string, Loaded>> {
    const ids = [...new Set(staffIds)].sort();
    for (const id of ids) await this.q.lockStaff(tx, id);
    const { dayStart, dayEnd } = karachiDayBounds(now.getTime());
    const all = ids.length === 0 ? [] : await this.q.openToday(tx, s.salon.id, ids, dayStart, dayEnd, this.includePhone(s));
    const out = new Map<string, Loaded>();
    for (const id of ids) {
      const rows = all.filter((r) => r.staffId === id);
      const projection = projectQueue(rows.map(toItem), now.getTime());
      for (const a of rows) {
        if (a.status === 'IN_PROGRESS') continue;
        const p = projection.byId.get(a.id);
        if (!p) continue;
        const oldMs = a.estimatedStartsAt?.getTime() ?? null;
        if (!estimateChanged(oldMs, p.estimatedStartsAtMs)) continue;
        const next = p.estimatedStartsAtMs === null ? null : new Date(p.estimatedStartsAtMs);
        if (!(await this.q.saveEstimate(tx, a.id, next, now))) continue;
        await this.repo.insertHistory(tx, {
          salonId: s.salon.id, appointmentId: a.id, event: 'ETA_CHANGED', fromStatus: a.status, toStatus: a.status, actorUserId: s.user.id,
          actorRole: this.actorRole(s), reason: null, oldStartsAt: a.estimatedStartsAt, newStartsAt: next,
        });
        a.estimatedStartsAt = next;
        a.etaUpdatedAt = now;
      }
      out.set(id, { rows, projection });
    }
    return out;
  }

  // ------------------------------------------------------------------ views
  private async lanesFor(tx: Tx, s: Scope, staff: StaffLaneRecord[], now: Date): Promise<LaneView[]> {
    if (staff.length === 0) return [];
    const ids = staff.map((x) => x.id);
    const loaded = await this.refresh(tx, s, ids, now);
    const { dayStart, dayEnd } = karachiDayBounds(now.getTime());
    const { policy } = await this.repo.getPolicy(tx, s.salon.id);
    const overdue = await this.q.overdue(tx, s.salon.id, ids, dayStart, this.includePhone(s), QUEUE_LIMITS.overdueListLimit);
    const counts = await this.q.todayCounts(tx, s.salon.id, ids, dayStart, dayEnd);
    const everyone = [...[...loaded.values()].flatMap((l) => l.rows), ...overdue];
    const lines = await this.repo.linesFor(tx, everyone.map((a) => a.id));
    const offers = await this.q.pendingOffers(tx, everyone.map((a) => a.id));
    const nowMs = now.getTime();

    return staff.map((st) => {
      const { rows, projection } = loaded.get(st.id) as Loaded;
      const byId = new Map(rows.map((r) => [r.id, r]));
      let position = 0;
      const items: QueueItemView[] = [];
      for (const p of projection.items) {
        const a = byId.get(p.id) as AppointmentRecord;
        const waiting = a.status !== 'IN_PROGRESS';
        if (waiting) position += 1;
        items.push(queueItemView(a, lines.get(a.id) ?? [], p, { position: waiting ? position : null, offer: offers.get(a.id) ?? null, policy, nowMs }));
      }
      const head = projection.items.map((p) => byId.get(p.id) as AppointmentRecord).find((a) => a.status !== 'IN_PROGRESS');
      const bounds = head && head.status === 'CONFIRMED' && head.customerUserId && !head.estimatedStartsAt && !offers.has(head.id)
        ? earlyOfferBounds(head.startsAt.getTime(), projection.freeAtMs, nowMs)
        : null;
      return laneView({
        staff: st,
        items,
        overdue: overdue.filter((a) => a.staffId === st.id).map((a) => queueItemView(a, lines.get(a.id) ?? [], undefined, { position: null, offer: null, policy, nowMs })),
        freeAtMs: projection.freeAtMs,
        counts: counts.get(st.id),
        candidate: head && bounds ? { appointmentId: head.id, bounds } : null,
        canAddWalkIn: s.kind === 'OWNER' || Boolean(s.own?.permissions.includes('walk_ins.create')),
      });
    });
  }

  private async laneOf(tx: Tx, s: Scope, staffId: string, now: Date): Promise<LaneView | null> {
    const staff = await this.q.lanes(tx, s.salon.id, [staffId]);
    return (await this.lanesFor(tx, s, staff, now))[0] ?? null;
  }

  private async itemOf(tx: Tx, s: Scope, id: string, now: Date, withHistory = false): Promise<QueueItemView> {
    const a = await this.repo.findForSalon(tx, s.salon.id, id, this.includePhone(s), s.own?.id ?? null);
    if (!a) throw notFound('Appointment');
    const { policy } = await this.repo.getPolicy(tx, s.salon.id);
    const lines = (await this.repo.linesFor(tx, [a.id])).get(a.id) ?? [];
    const offer = (await this.q.pendingOffers(tx, [a.id])).get(a.id) ?? null;
    const history = withHistory ? await this.repo.historyFor(tx, a.id) : undefined;
    return queueItemView(a, lines, undefined, { position: null, offer, policy, nowMs: now.getTime() }, history);
  }

  private async result(tx: Tx, s: Scope, a: AppointmentRecord, now: Date) {
    return { appointment: await this.itemOf(tx, s, a.id, now), lane: await this.laneOf(tx, s, a.staffId, now) };
  }

  /** Loads one appointment the caller may act on (staff: only their own; others look like "not found") under the staff lock. */
  private async withAppointment<T>(user: AuthenticatedUser, id: string, fn: (c: { tx: Tx; s: Scope; a: AppointmentRecord; now: Date; policy: BookingPolicy }) => Promise<T>): Promise<T> {
    const s = await this.resolve(user);
    const now = this.clock.now();
    return this.inTx(s, async (tx) => {
      const first = await this.repo.findForSalon(tx, s.salon.id, id, this.includePhone(s), s.own?.id ?? null);
      if (!first) throw notFound('Appointment');
      await this.q.lockStaff(tx, first.staffId);
      const a = await this.repo.findForSalon(tx, s.salon.id, id, this.includePhone(s), s.own?.id ?? null);
      if (!a) throw notFound('Appointment');
      const { policy } = await this.repo.getPolicy(tx, s.salon.id);
      return fn({ tx, s, a, now, policy });
    });
  }

  // ------------------------------------------------------------------ read
  /** Owner: every lane (or one with `staffId`). Staff: their own lane. Reading refreshes the estimates (they depend on the time). */
  async queue(user: AuthenticatedUser, staffId?: string) {
    const s = await this.resolve(user);
    const now = this.clock.now();
    return this.inTx(s, async (tx) => {
      const ids = s.kind === 'STAFF' ? [s.own?.id as string] : staffId ? [staffId] : null;
      const staff = await this.q.lanes(tx, s.salon.id, ids);
      if (s.kind === 'OWNER' && staffId && staff.length === 0) throw notFound('Staff member');
      const lanes = await this.lanesFor(tx, s, staff, now);
      return { asOf: now.toISOString(), date: karachiDayBounds(now.getTime()).date, lanes };
    });
  }

  /** The services the staff member (staff: themselves; owner: `staffId`) can be booked for, with their prices: the walk-in form. */
  async services(user: AuthenticatedUser, staffIdFromOwner?: string) {
    const s = await this.resolve(user);
    const staffId = s.kind === 'STAFF' ? (s.own?.id as string) : staffIdFromOwner;
    if (!staffId) throw bad('staffId is required.');
    return this.inTx(s, async (tx) => {
      if ((await this.q.lanes(tx, s.salon.id, [staffId])).length === 0) throw notFound('Staff member');
      return { items: await this.q.offeredServices(tx, s.salon.id, staffId) };
    });
  }

  async detail(user: AuthenticatedUser, id: string) {
    const s = await this.resolve(user);
    return this.inTx(s, (tx) => this.itemOf(tx, s, id, this.clock.now(), true));
  }

  // ------------------------------------------------------------------ start / complete / no-show
  private async doStart(tx: Tx, s: Scope, a: AppointmentRecord, now: Date): Promise<void> {
    const d = startDecision(a.status, a.startsAt.getTime(), now.getTime());
    if (!d.allowed) {
      if (d.reason === 'STATUS') throw statusConflict(a);
      throw conflict(`This appointment cannot be started before ${new Date(d.earliestMs).toISOString()}.`, { rule: 'TOO_EARLY', earliest: new Date(d.earliestMs).toISOString() });
    }
    const busy = await this.q.inProgressFor(tx, a.staffId);
    if (busy) throw conflict('Complete the current service first.', { rule: 'ALREADY_IN_PROGRESS', currentId: busy.id });
    try {
      if (!(await this.q.markStarted(tx, a.id, now))) throw conflict('This appointment was just changed. Please refresh.');
    } catch (e) {
      if (isUniqueViolation(e)) throw conflict('Complete the current service first.', { rule: 'ALREADY_IN_PROGRESS' });
      throw e;
    }
    await this.q.withdrawOffer(tx, a.id, now);
    await this.repo.insertHistory(tx, {
      salonId: s.salon.id, appointmentId: a.id, event: 'STARTED', fromStatus: a.status, toStatus: 'IN_PROGRESS', actorUserId: s.user.id,
      actorRole: this.actorRole(s), reason: null, oldStartsAt: null, newStartsAt: null,
    });
  }

  private async doComplete(tx: Tx, s: Scope, a: AppointmentRecord, now: Date): Promise<void> {
    if (a.status !== 'IN_PROGRESS') throw statusConflict(a);
    // A completion is never recorded before its start (a device clock that jumped back must not break the CHECK constraint).
    const when = a.startedAt && now.getTime() < a.startedAt.getTime() ? a.startedAt : now;
    if (!(await this.q.markCompleted(tx, a.id, when))) throw conflict('This appointment was just changed. Please refresh.');
    await this.repo.insertHistory(tx, {
      salonId: s.salon.id, appointmentId: a.id, event: 'COMPLETED', fromStatus: 'IN_PROGRESS', toStatus: 'COMPLETED', actorUserId: s.user.id,
      actorRole: this.actorRole(s), reason: null, oldStartsAt: null, newStartsAt: null,
    });
  }

  async start(user: AuthenticatedUser, id: string, acting?: Acting) {
    return this.withAppointment(user, id, async ({ tx, s, a, now }) => {
      await this.doStart(tx, s, a, acting?.at ?? now);
      if (acting?.after) await acting.after(tx, a);
      return this.result(tx, s, a, now);
    });
  }

  async complete(user: AuthenticatedUser, id: string, acting?: Acting) {
    return this.withAppointment(user, id, async ({ tx, s, a, now }) => {
      await this.doComplete(tx, s, a, acting?.at ?? now);
      if (acting?.after) await acting.after(tx, a);
      return this.result(tx, s, a, now);
    });
  }

  /** Only after the salon's grace period (counted from the booked time or the customer's own ETA, whichever is later). */
  async noShow(user: AuthenticatedUser, id: string, dto: NoShowDto, acting?: Acting) {
    const reason = dto.reason && dto.reason.trim().length > 0 ? dto.reason.trim() : null;
    return this.withAppointment(user, id, async ({ tx, s, a, now: realNow, policy }) => {
      const now = acting?.at ?? realNow;
      const d = noShowDecision(policy, a.status, a.startsAt.getTime(), a.arrivalState === 'NONE' ? null : a.customerEtaAt?.getTime() ?? null, now.getTime());
      if (!d.allowed) {
        if (d.reason === 'STATUS') throw statusConflict(a);
        throw conflict('The grace period has not ended yet.', { rule: 'NO_SHOW_GRACE', graceMinutes: policy.noShowGraceMinutes, allowedFrom: new Date(d.allowedFromMs).toISOString() });
      }
      if (!(await this.q.markNoShow(tx, a.id, now))) throw conflict('This appointment was just changed. Please refresh.');
      await this.q.withdrawOffer(tx, a.id, now);
      await this.repo.insertHistory(tx, {
        salonId: s.salon.id, appointmentId: a.id, event: 'NO_SHOW', fromStatus: 'CONFIRMED', toStatus: 'NO_SHOW', actorUserId: s.user.id,
        actorRole: this.actorRole(s), reason, oldStartsAt: null, newStartsAt: null,
      });
      if (acting?.after) await acting.after(tx, a);
      return this.result(tx, s, a, realNow);
    });
  }

  // ------------------------------------------------------------------ next customer
  /**
   * Starts the next waiting customer. It NEVER completes the current service silently: while one is in progress the call is refused
   * (CURRENT_IN_PROGRESS) unless `completeCurrent` is true, which the app sends only after the person confirmed the warning.
   * Completing and starting happen in one transaction: both or neither.
   */
  async next(user: AuthenticatedUser, staffIdFromOwner: string | undefined, completeCurrent: boolean) {
    const s = await this.resolve(user);
    const now = this.clock.now();
    const staffId = s.kind === 'STAFF' ? (s.own?.id as string) : staffIdFromOwner;
    if (!staffId) throw bad('staffId is required.');
    return this.inTx(s, async (tx) => {
      const lane = await this.q.lanes(tx, s.salon.id, [staffId]);
      if (lane.length === 0) throw notFound('Staff member');
      const loaded = (await this.refresh(tx, s, [staffId], now)).get(staffId) as Loaded;
      const byId = new Map(loaded.rows.map((r) => [r.id, r]));
      const current = loaded.rows.find((r) => r.status === 'IN_PROGRESS') ?? null;
      const waiting = loaded.projection.items.map((p) => byId.get(p.id) as AppointmentRecord).filter((a) => a.status === 'CONFIRMED');
      const nextUp = waiting[0];
      if (!nextUp) throw conflict('Nobody is waiting.', { rule: 'QUEUE_EMPTY' });
      if (current && !completeCurrent) {
        throw conflict('A service is still in progress. Complete it first, or confirm to complete it and call the next customer.', {
          rule: 'CURRENT_IN_PROGRESS', current: { id: current.id, customerName: current.customerName }, next: { id: nextUp.id, customerName: nextUp.customerName },
        });
      }
      const early = startDecision(nextUp.status, nextUp.startsAt.getTime(), now.getTime());
      if (!early.allowed) throw conflict('The next customer is booked much later.', { rule: 'TOO_EARLY', earliest: new Date(early.earliestMs).toISOString() });

      if (current) await this.doComplete(tx, s, current, now);
      await this.doStart(tx, s, nextUp, now);
      return {
        completed: current ? await this.itemOf(tx, s, current.id, now) : null,
        started: await this.itemOf(tx, s, nextUp.id, now),
        lane: await this.laneOf(tx, s, staffId, now),
      };
    });
  }

  // ------------------------------------------------------------------ walk-ins
  /**
   * A customer who walks in. The walk-in gets the EARLIEST free time of the chosen staff member today that the normal slot engine
   * allows (working hours, breaks, leave, buffer, other appointments, the current service running late). It never takes the time
   * of someone who booked. Price and duration come from the catalogue exactly as for an online booking.
   */
  async addWalkIn(user: AuthenticatedUser, dto: OwnerWalkInDto | (Omit<OwnerWalkInDto, 'staffId'> & { staffId?: undefined }), idempotencyKey: string | undefined, acting?: Acting) {
    if (idempotencyKey !== undefined && !IDEMPOTENCY_KEY_RE.test(idempotencyKey)) throw bad('Idempotency-Key must be 8 to 64 characters: letters, digits, - and _.');
    const s = await this.resolve(user);
    const now = this.clock.now();
    const staffId = s.kind === 'STAFF' ? (s.own?.id as string) : dto.staffId;
    if (!staffId) throw bad('staffId is required.');
    if (s.kind === 'STAFF' && !s.own?.permissions.includes('walk_ins.create')) throw forbidden('Your salon owner has not allowed you to add walk-ins.');
    const name = dto.customerName.trim();
    const phone = dto.phone && dto.phone.trim().length > 0 ? normalizePhone(dto.phone) : null;
    if (dto.phone && dto.phone.trim().length > 0 && !phone) throw bad('The phone number is not valid. Use a Pakistani mobile number such as 0300 1234567.');
    const note = dto.note && dto.note.trim().length > 0 ? dto.note.trim() : null;
    const fingerprint = walkInFingerprint({ staffId, serviceIds: dto.serviceIds, name, phone, note });
    // Offline sync: the person walked in earlier. The time is searched from THAT moment, not from the moment the phone found a signal.
    const backdated = acting?.at !== undefined && now.getTime() - acting.at.getTime() > BACKDATE_THRESHOLD_MS;

    try {
      return await this.inTx(s, async (tx) => {
        await this.q.lockStaff(tx, staffId);
        if (idempotencyKey) {
          const prior = await this.q.findWalkInByIdempotency(tx, s.salon.id, idempotencyKey);
          if (prior) {
            if (prior.requestFingerprint !== fingerprint) throw conflict('This Idempotency-Key was already used for a different walk-in.');
            if (acting?.after) await acting.after(tx, prior);
            return this.result(tx, s, prior, now); // a retry: the same walk-in, nothing new is created
          }
        }
        const staff = (await this.q.lanes(tx, s.salon.id, [staffId]))[0];
        if (!staff) throw notFound('Staff member');

        const rows = await this.repo.bookable(tx, s.salon.id, staffId, dto.serviceIds);
        const byId = new Map(rows.map((r) => [r.serviceId, r]));
        if (dto.serviceIds.some((sid) => !byId.has(sid)) || rows.some((r) => r.price === null)) throw conflict('This staff member does not offer all the chosen services.');
        const lines = dto.serviceIds.map((sid, i) => ({ ...(byId.get(sid) as (typeof rows)[number]), position: i + 1 }));
        const durationMin = lines.reduce((acc, l) => acc + l.durationMinutes, 0);
        if (durationMin > BOOKING_LIMITS.maxTotalDurationMinutes) throw bad('The chosen services take too long for one appointment.');
        const totalPrice = sumMoney(lines.map((l) => l.price as string));

        const { policy } = await this.repo.getPolicy(tx, s.salon.id);
        const { dayStart, dayEnd, date: today } = karachiDayBounds(now.getTime());
        if ((await this.q.waitingWalkIns(tx, s.salon.id, staffId, dayStart, dayEnd)) >= QUEUE_LIMITS.walkInMaxWaitingPerStaff) {
          throw conflict('Too many walk-ins are already waiting for this staff member.', { rule: 'WALK_IN_LIMIT', max: QUEUE_LIMITS.walkInMaxWaitingPerStaff });
        }

        // The staff member is free from `freeAtMs` (a service running late pushes it back); look for the first real slot from then on.
        // A backdated (offline) walk-in is placed from the moment the person walked in: today's live queue does not apply to it.
        const fromMs = backdated
          ? (acting?.at as Date).getTime()
          : Math.max(now.getTime(), ((await this.refresh(tx, s, [staffId], now)).get(staffId) as Loaded).projection.freeAtMs);
        const date = karachiParts(fromMs).date;
        const hours = (await this.discovery.hoursForSalons(tx, [s.salon.id])).get(s.salon.id) ?? {};
        const weekFrom = backdated ? date : today;
        const week = (await this.discovery.staffWeeks(tx, [staffId], weekFrom, addDaysIso(weekFrom, 1))).get(staffId);
        const base = dayStartMs(date);
        const busy = await this.discovery.busyByStaff(tx, [staffId], base - DAY_MS, base + 2 * DAY_MS);
        const starts = week
          ? openStarts({ date, salon: hours, staff: week, busy: busy.get(staffId) ?? [], policy: { bufferMinutes: policy.bufferMinutes, minNoticeMinutes: 0 }, durationMin, nowMs: fromMs, stepMin: 5 })
          : [];
        if (starts.length === 0) throw conflict('There is no free time left today for this staff member.', { rule: 'NO_CAPACITY_TODAY' });

        const startsAt = new Date(slotMs(date, starts[0]));
        const endsAt = new Date(startsAt.getTime() + durationMin * MINUTE_MS);
        const blockedUntil = new Date(endsAt.getTime() + policy.bufferMinutes * MINUTE_MS);
        // Only a backdated walk-in may start in the past (up to 48 hours). The flag is transaction-local and read by appointments_guard().
        if (backdated) await tx.$queryRaw`SELECT set_config('app.offline_sync', 'on', true)`;
        const id = await this.q.insertWalkIn(tx, {
          salonId: s.salon.id, staffId, name, phone, startsAt, endsAt, bufferMinutes: policy.bufferMinutes, blockedUntil, totalDurationMinutes: durationMin,
          totalPrice, salonName: s.salon.name, staffName: lines[0].staffName, note, idempotencyKey: idempotencyKey ?? null,
          requestFingerprint: idempotencyKey ? fingerprint : null, now,
        });
        for (const l of lines) {
          await this.repo.insertLine(tx, s.salon.id, id, { serviceId: l.serviceId, position: l.position, serviceName: l.serviceName, durationMinutes: l.durationMinutes, price: l.price as string });
        }
        await this.repo.insertHistory(tx, {
          salonId: s.salon.id, appointmentId: id, event: 'CREATED', fromStatus: null, toStatus: 'CONFIRMED', actorUserId: s.user.id,
          actorRole: this.actorRole(s), reason: null, oldStartsAt: null, newStartsAt: startsAt,
        });
        const created = (await this.repo.findForSalon(tx, s.salon.id, id, this.includePhone(s), s.own?.id ?? null)) as AppointmentRecord;
        if (acting?.after) await acting.after(tx, created);
        return this.result(tx, s, created, now);
      });
    } catch (e) {
      if (isExclusionViolation(e)) throw new AppException('SLOT_TAKEN', 'That time was just taken. Please try again.', 409);
      throw e;
    }
  }

  // ------------------------------------------------------------------ early availability offer
  /**
   * "Your stylist is free earlier. Would you like to come now?" The offer is only a question: nothing moves until the CUSTOMER
   * accepts, and declining costs nothing. The offered time must pass the same slot engine as any booking.
   */
  async offerEarly(user: AuthenticatedUser, id: string, dto: EarlyOfferDto) {
    return this.withAppointment(user, id, async ({ tx, s, a, now }) => {
      const nowMs = now.getTime();
      if (a.status !== 'CONFIRMED') throw statusConflict(a);
      if (!a.customerUserId) throw conflict('A walk-in has no app account, so there is nobody to send an offer to.', { rule: 'WALK_IN' });
      const today = karachiDayBounds(nowMs).date;
      const date = karachiParts(a.startsAt.getTime()).date;
      if (date !== today) throw conflict('Early offers are only for appointments today.', { rule: 'ONLY_TODAY' });

      await this.q.expireOffers(tx, a.id, now);
      if ((await this.q.pendingOffers(tx, [a.id])).has(a.id)) throw conflict('An offer is already waiting for an answer.', { rule: 'OFFER_PENDING' });
      if ((await this.q.offerCount(tx, a.id)) >= QUEUE_LIMITS.earlyOfferMaxPerAppointment) throw conflict('You already sent the maximum number of offers for this appointment.', { rule: 'OFFER_LIMIT' });

      const loaded = (await this.refresh(tx, s, [a.staffId], now)).get(a.staffId) as Loaded;
      const bounds = earlyOfferBounds(a.startsAt.getTime(), loaded.projection.freeAtMs, nowMs);
      if (!bounds) throw conflict('There is no earlier time worth offering right now.', { rule: 'NO_EARLIER_TIME' });

      let startMs = bounds.earliestMs;
      if (dto.time) {
        const minute = parseClock(dto.time);
        if (minute === null || minute % 5 !== 0) throw bad('time must be HH:MM on a 5-minute mark.');
        startMs = slotMs(date, minute);
        if (startMs < bounds.earliestMs || a.startsAt.getTime() - startMs < QUEUE_LIMITS.earlyOfferMinGainMinutes * MINUTE_MS) {
          throw conflict('That time is not possible. Choose a time after you are free and at least 10 minutes before the booked time.', {
            rule: 'BAD_TIME', earliest: new Date(bounds.earliestMs).toISOString(),
          });
        }
      }

      const hours = (await this.discovery.hoursForSalons(tx, [s.salon.id])).get(s.salon.id) ?? {};
      const week = (await this.discovery.staffWeeks(tx, [a.staffId], today, addDaysIso(today, 1))).get(a.staffId);
      const base = dayStartMs(date);
      const busy = await this.discovery.busyByStaff(tx, [a.staffId], base - DAY_MS, base + 2 * DAY_MS, a.id);
      const free = week && canStartAt({
        date, salon: hours, staff: week, busy: busy.get(a.staffId) ?? [], policy: { bufferMinutes: a.bufferMinutes, minNoticeMinutes: 0 },
        durationMin: a.totalDurationMinutes, nowMs, startMinute: karachiParts(startMs).minute,
      });
      if (!free) throw conflict('That earlier time is not free.', { rule: 'SLOT_BUSY' });

      const offeredStart = new Date(startMs);
      // The customer must answer before the offered time arrives.
      const offerId = await this.q.insertOffer(tx, { salonId: s.salon.id, appointmentId: a.id, offeredBy: s.user.id, offeredStart, expiresAt: offeredStart });
      await this.repo.insertHistory(tx, {
        salonId: s.salon.id, appointmentId: a.id, event: 'EARLY_OFFERED', fromStatus: 'CONFIRMED', toStatus: 'CONFIRMED', actorUserId: s.user.id,
        actorRole: this.actorRole(s), reason: null, oldStartsAt: a.startsAt, newStartsAt: offeredStart,
      });
      const open = (await this.q.pendingOffers(tx, [a.id])).get(a.id);
      return { offer: open ? offerView(open, a) : { id: offerId }, ...(await this.result(tx, s, a, now)) };
    });
  }

  async withdrawEarlyOffer(user: AuthenticatedUser, id: string) {
    return this.withAppointment(user, id, async ({ tx, s, a, now }) => {
      const withdrawn = await this.q.withdrawOffer(tx, a.id, now);
      if (!withdrawn) throw notFound('Open offer');
      await this.repo.insertHistory(tx, {
        salonId: s.salon.id, appointmentId: a.id, event: 'EARLY_WITHDRAWN', fromStatus: a.status, toStatus: a.status, actorUserId: s.user.id,
        actorRole: this.actorRole(s), reason: null, oldStartsAt: a.startsAt, newStartsAt: withdrawn.offeredStart,
      });
      return this.result(tx, s, a, now);
    });
  }
}
