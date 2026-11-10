import { Injectable } from '@nestjs/common';
import { AuthenticatedUser, toTenantContext } from '../../common/auth/authenticated-user';
import { sqlState } from '../../common/db/pg-errors';
import { AppException } from '../../common/errors/app-exception';
import { ClientContext } from '../../common/http/client-context';
import { TenantDb } from '../../common/tenancy/tenant-db.service';
import { Clock } from '../../common/util/clock';
import { insertAudit } from '../audit/audit.types';
import { SalonRecord } from '../salons/salon.types';
import { SalonsRepository, Tx } from '../salons/salons.repository';
import { BreaksDto, LeaveDto } from './dto/staff.dto';
import { LeaveRecord, StaffMemberRecord, StaffRepository } from './staff.repository';
import { STAFF_LIMITS, StaffPermission, todayInSalonTz, validateBreaks, validateLeavePeriod } from './staff.types';
import { breaksView, hoursView, leaveView } from './team.service';

const notFound = (what: string) => new AppException('NOT_FOUND', `${what} not found.`, 404);

/**
 * Staff self-service: a SALON_STAFF account sees ONLY its own profile, hours, breaks and leave. Colleagues
 * are never returned. Writes need the `schedule.manage_own` permission, granted by the owner. The database
 * (RLS on staff_breaks / staff_leaves) enforces the same rules again.
 */
@Injectable()
export class StaffSelfService {
  constructor(
    private readonly tenant: TenantDb,
    private readonly repo: StaffRepository,
    private readonly salons: SalonsRepository,
    private readonly clock: Clock,
  ) {}

  /** Resolves the caller's profile and salon. Blocks work when the salon is not approved or the profile is off. */
  private async context(user: AuthenticatedUser): Promise<{ profile: StaffMemberRecord; salon: SalonRecord }> {
    const profile = await this.tenant.withTenant(toTenantContext(user), (tx: Tx) => this.repo.findOwnProfile(tx, user.id));
    if (!profile) throw notFound('Staff profile');
    const salon = await this.tenant.withTenant(toTenantContext(user, profile.salonId), (tx: Tx) => this.salons.findById(tx, profile.salonId));
    if (!salon) throw notFound('Salon');
    if (salon.status !== 'APPROVED') throw new AppException('FORBIDDEN', 'Your salon is not active at the moment.', 403);
    if (!profile.isActive) throw new AppException('FORBIDDEN', 'Your access has been disabled by the salon owner.', 403);
    return { profile, salon };
  }

  private requirePermission(profile: StaffMemberRecord, perm: StaffPermission): void {
    if (!profile.grantedPermissions.includes(perm)) {
      throw new AppException('FORBIDDEN', 'Your salon owner has not allowed this change.', 403);
    }
  }

  private audit(user: AuthenticatedUser, meta: ClientContext, salonId: string, action: string, targetId: string, metadata?: Record<string, unknown>) {
    return {
      actorUserId: user.id, actorRole: user.role, action, targetType: 'staff_profile', targetId, salonId,
      ipAddress: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId, metadata: metadata ?? null,
    };
  }

  /** The caller's own profile, own weekly hours, breaks and upcoming leave. */
  async me(user: AuthenticatedUser) {
    const { profile, salon } = await this.context(user);
    const today = todayInSalonTz(this.clock.now());
    return this.tenant.withTenant(toTenantContext(user, salon.id), async (tx: Tx) => {
      const [hours, breaks, leaves] = await Promise.all([
        this.repo.listWorkingHours(tx, salon.id, profile.id),
        this.repo.listBreaks(tx, salon.id, profile.id),
        this.repo.listUpcomingLeaves(tx, salon.id, profile.id, today, STAFF_LIMITS.upcomingLeaveLimit),
      ]);
      return {
        profile: {
          id: profile.id, displayName: profile.displayName, bio: profile.bio, performsServices: profile.performsServices,
          isActive: profile.isActive, permissions: profile.grantedPermissions,
        },
        salon: { id: salon.id, name: salon.name, status: salon.status },
        workingHours: hoursView(hours),
        breaks: breaksView(breaks),
        leaves: leaves.map(leaveView),
      };
    });
  }

  async replaceBreaks(user: AuthenticatedUser, dto: BreaksDto, meta: ClientContext) {
    const { profile, salon } = await this.context(user);
    this.requirePermission(profile, 'schedule.manage_own');
    return this.tenant.withTenant(toTenantContext(user, salon.id), async (tx: Tx) => {
      const hours = await this.repo.listWorkingHours(tx, salon.id, profile.id);
      const rows = validateBreaks(dto.breaks.map((b) => ({ weekday: b.weekday, startsAt: b.startsAt, endsAt: b.endsAt, label: b.label })), hours);
      if (!rows.ok) throw new AppException('VALIDATION_FAILED', rows.message, 400);
      await this.repo.replaceBreaks(tx, salon.id, profile.id, rows.value, this.clock.now());
      await insertAudit(tx, this.audit(user, meta, salon.id, 'staff.self_breaks_updated', profile.id, { count: rows.value.length }));
      return { breaks: breaksView(rows.value) };
    });
  }

  /** Leave is requested as PENDING; the owner approves or rejects it. Overlapping requests are refused by the DB. */
  async requestLeave(user: AuthenticatedUser, dto: LeaveDto, meta: ClientContext) {
    const { profile, salon } = await this.context(user);
    this.requirePermission(profile, 'schedule.manage_own');
    const now = this.clock.now();
    const period = validateLeavePeriod(dto, todayInSalonTz(now), { forStaff: true });
    if (!period.ok) throw new AppException('VALIDATION_FAILED', period.message, 400);
    return this.tenant.withTenant(toTenantContext(user, salon.id), async (tx: Tx) => {
      let l: LeaveRecord;
      try {
        l = await this.repo.insertLeave(tx, salon.id, {
          staffId: profile.id, startsOn: period.value.startsOn, endsOn: period.value.endsOn,
          reason: dto.reason?.trim() || null, status: 'PENDING', requestedBy: user.id, decidedBy: null,
        }, now);
      } catch (e) {
        if (sqlState(e) === '23P01') {
          throw new AppException('CONFLICT', 'You already have leave or a pending request in those dates.', 409);
        }
        throw e;
      }
      await insertAudit(tx, this.audit(user, meta, salon.id, 'staff.leave_requested', l.id, { days: period.value.days }));
      return leaveView(l);
    });
  }

  /** Only the caller's own PENDING request can be withdrawn (approved leave is changed by the owner). */
  async cancelLeaveRequest(user: AuthenticatedUser, leaveId: string, meta: ClientContext): Promise<void> {
    const { profile, salon } = await this.context(user);
    this.requirePermission(profile, 'schedule.manage_own');
    await this.tenant.withTenant(toTenantContext(user, salon.id), async (tx: Tx) => {
      const l = await this.repo.findLeave(tx, salon.id, leaveId);
      if (!l || l.staffId !== profile.id) throw notFound('Leave request');
      const moved = await this.repo.moveLeave(tx, salon.id, leaveId, ['PENDING'], 'CANCELLED', null, this.clock.now());
      if (!moved) throw new AppException('CONFLICT', 'Only a pending request can be withdrawn.', 409);
      await insertAudit(tx, this.audit(user, meta, salon.id, 'staff.leave_request_withdrawn', leaveId));
    });
  }
}
