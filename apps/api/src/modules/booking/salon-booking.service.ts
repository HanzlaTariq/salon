import { Injectable } from '@nestjs/common';
import { AuthenticatedUser, toTenantContext } from '../../common/auth/authenticated-user';
import { AppException } from '../../common/errors/app-exception';
import { ClientContext } from '../../common/http/client-context';
import { TenantDb } from '../../common/tenancy/tenant-db.service';
import { Clock } from '../../common/util/clock';
import { insertAudit } from '../audit/audit.types';
import { addDaysIso, isIsoDateText } from '../discovery/discovery.types';
import { PROFILE_EDITABLE, SalonRecord } from '../salons/salon.types';
import { SalonsRepository, Tx } from '../salons/salons.repository';
import { BookingRepository } from './booking.repository';
import { BOOKING_LIMITS, BOOKING_POLICY_DEFAULTS, BOOKING_POLICY_RANGES, BookingPolicy, dayStartMs, karachiParts } from './booking.types';
import { policyView, salonView } from './booking.views';
import { SalonBookingsQuery, SalonCancelDto, UpdateBookingPolicyDto } from './dto/booking.dto';

const bad = (message: string) => new AppException('VALIDATION_FAILED', message, 400);
const notFound = (what: string) => new AppException('NOT_FOUND', `${what} not found.`, 404);
const conflict = (message: string, details?: unknown) => new AppException('CONFLICT', message, 409, details);
const DAY_MS = 86_400_000;

/**
 * Phase 8, salon side. The OWNER sees every appointment of their own salon (name and phone of the customer), can cancel an
 * open one with a reason, and edits the booking policy. The salon can NEVER move a customer's appointment (consent, also
 * enforced by a database trigger). A STAFF member sees only their own appointments, with the customer's name but no phone.
 * The salon is always derived from the verified session; no salon id is accepted from the client.
 */
@Injectable()
export class SalonBookingService {
  constructor(
    private readonly tenant: TenantDb,
    private readonly repo: BookingRepository,
    private readonly salons: SalonsRepository,
    private readonly clock: Clock,
  ) {}

  private async ownerScoped<T>(user: AuthenticatedUser, write: boolean, fn: (tx: Tx, salon: SalonRecord, now: Date) => Promise<T>): Promise<T> {
    const found = await this.tenant.withTenant(toTenantContext(user), (tx: Tx) => this.salons.findByOwner(tx, user.id));
    if (!found) throw new AppException('NOT_FOUND', 'You have not registered a salon yet.', 404);
    return this.tenant.withTenant(toTenantContext(user, found.id), async (tx: Tx) => {
      const salon = write ? await this.salons.lockById(tx, found.id) : await this.salons.findById(tx, found.id);
      if (!salon) throw new AppException('NOT_FOUND', 'You have not registered a salon yet.', 404);
      return fn(tx, salon, this.clock.now());
    });
  }

  /** Inclusive Karachi dates -> [from, to) instants. Default: today only. At most 31 days. */
  private range(q: SalonBookingsQuery, now: Date): { from: Date; to: Date } {
    const today = karachiParts(now.getTime()).date;
    const from = q.from ?? today;
    const to = q.to ?? from;
    if (!isIsoDateText(from) || !isIsoDateText(to)) throw bad('from and to must be real calendar dates (YYYY-MM-DD).');
    if (to < from) throw bad('to cannot be before from.');
    if (addDaysIso(from, BOOKING_LIMITS.maxRangeDays) <= to) throw bad(`Choose at most ${BOOKING_LIMITS.maxRangeDays} days at a time.`);
    return { from: new Date(dayStartMs(from)), to: new Date(dayStartMs(to) + DAY_MS) };
  }

  // ------------------------------------------------------------------ owner: appointments
  async list(user: AuthenticatedUser, q: SalonBookingsQuery) {
    const now = this.clock.now();
    const { from, to } = this.range(q, now);
    const page = q.page ?? 1;
    const pageSize = q.pageSize ?? 50;
    return this.ownerScoped(user, false, async (tx, salon) => {
      const res = await this.repo.listForSalon(tx, salon.id, {
        from, to, staffId: q.staffId ?? null, status: q.status ?? null, includePhone: true, limit: pageSize, offset: (page - 1) * pageSize,
      });
      const lines = await this.repo.linesFor(tx, res.items.map((a) => a.id));
      const items = res.items.map((a) => salonView(a, lines.get(a.id) ?? []));
      return { items, total: res.total, page, pageSize, hasMore: (page - 1) * pageSize + items.length < res.total };
    });
  }

  async get(user: AuthenticatedUser, id: string) {
    return this.ownerScoped(user, false, async (tx, salon) => {
      const a = await this.repo.findForSalon(tx, salon.id, id, true, null);
      if (!a) throw notFound('Booking');
      const lines = (await this.repo.linesFor(tx, [a.id])).get(a.id) ?? [];
      return salonView(a, lines, await this.repo.historyFor(tx, a.id));
    });
  }

  async cancel(user: AuthenticatedUser, id: string, dto: SalonCancelDto) {
    const reason = dto.reason.trim();
    if (reason.length < BOOKING_LIMITS.reasonMinLength) throw bad('Please give a reason for the customer.');
    await this.ownerScoped(user, false, async (tx, salon, now) => {
      const a = await this.repo.findForSalon(tx, salon.id, id, false, null);
      if (!a) throw notFound('Booking');
      if (a.status !== 'CONFIRMED' && a.status !== 'PENDING') throw conflict(`This booking is ${a.status.toLowerCase().replace('_', ' ')} and cannot be cancelled.`, { rule: 'STATUS', status: a.status });
      if (!(await this.repo.cancelBySalon(tx, salon.id, user.id, id, reason, now))) {
        throw conflict('This booking has already ended or was just changed. Please refresh.');
      }
      await this.repo.insertHistory(tx, {
        salonId: salon.id, appointmentId: a.id, event: 'CANCELLED', fromStatus: a.status, toStatus: 'CANCELLED', actorUserId: user.id,
        actorRole: 'SALON_OWNER', reason, oldStartsAt: a.startsAt, newStartsAt: null,
      });
    });
    return this.get(user, id);
  }

  // ------------------------------------------------------------------ owner: booking policy
  private rangesView() {
    return { ...BOOKING_POLICY_RANGES, defaults: BOOKING_POLICY_DEFAULTS };
  }

  async getPolicy(user: AuthenticatedUser) {
    return this.ownerScoped(user, false, async (tx, salon) => {
      const { policy, customized } = await this.repo.getPolicy(tx, salon.id);
      return { ...policyView(policy, customized), limits: this.rangesView() };
    });
  }

  async updatePolicy(user: AuthenticatedUser, dto: UpdateBookingPolicyDto, meta: ClientContext) {
    const next: BookingPolicy = {
      bufferMinutes: dto.bufferMinutes, minNoticeMinutes: dto.minNoticeMinutes, advanceDays: dto.advanceDays,
      cancelCutoffMinutes: dto.cancelCutoffMinutes, rescheduleCutoffMinutes: dto.rescheduleCutoffMinutes, maxReschedules: dto.maxReschedules,
    };
    return this.ownerScoped(user, true, async (tx, salon, now) => {
      if (!PROFILE_EDITABLE.includes(salon.status)) throw conflict(`The booking policy cannot be changed while the salon is ${salon.status.toLowerCase()}.`);
      const before = (await this.repo.getPolicy(tx, salon.id)).policy;
      await this.repo.upsertPolicy(tx, salon.id, next, user.id, now);
      await insertAudit(tx, {
        actorUserId: user.id, actorRole: user.role, action: 'booking.policy_updated', targetType: 'salon', targetId: salon.id, salonId: salon.id,
        ipAddress: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId, metadata: { before, after: next },
      });
      return { ...policyView(next, true), limits: this.rangesView() };
    });
  }

  // ------------------------------------------------------------------ staff: own appointments only
  async staffList(user: AuthenticatedUser, q: SalonBookingsQuery) {
    const now = this.clock.now();
    const { from, to } = this.range(q, now);
    const page = q.page ?? 1;
    const pageSize = q.pageSize ?? 50;
    const own = await this.tenant.withTenant(toTenantContext(user), (tx: Tx) => this.repo.findOwnStaff(tx, user.id));
    if (!own) throw notFound('Staff profile');
    if (!own.isActive) throw new AppException('FORBIDDEN', 'Your access has been disabled by the salon owner.', 403);
    return this.tenant.withTenant(toTenantContext(user, own.salonId), async (tx: Tx) => {
      // staffId comes from the caller's own profile, never from the query string (the DTO has no such field for staff).
      const res = await this.repo.listForSalon(tx, own.salonId, {
        from, to, staffId: own.id, status: q.status ?? null, includePhone: false, limit: pageSize, offset: (page - 1) * pageSize,
      });
      const lines = await this.repo.linesFor(tx, res.items.map((a) => a.id));
      const items = res.items.map((a) => salonView(a, lines.get(a.id) ?? []));
      return { items, total: res.total, page, pageSize, hasMore: (page - 1) * pageSize + items.length < res.total };
    });
  }
}
