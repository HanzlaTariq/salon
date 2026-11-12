import { Injectable } from '@nestjs/common';
import { AuthenticatedUser, toTenantContext } from '../../common/auth/authenticated-user';
import { isUniqueViolation, sqlState } from '../../common/db/pg-errors';
import { AppException } from '../../common/errors/app-exception';
import { ClientContext } from '../../common/http/client-context';
import { TenantDb } from '../../common/tenancy/tenant-db.service';
import { Clock } from '../../common/util/clock';
import { AuthRepository } from '../auth/auth.repository';
import { insertAudit } from '../audit/audit.types';
import { HourRow } from '../salons/opening-hours';
import { CATALOG_LIMITS } from '../catalog/catalog.types';
import { PROFILE_EDITABLE, SalonRecord } from '../salons/salon.types';
import { SalonsRepository, Tx } from '../salons/salons.repository';
import { BreaksDto, CreateStaffMemberDto, LeaveDecisionDto, LeaveDto, SendInvitationDto, UpdateStaffMemberDto, WeeklyHoursDto } from './dto/staff.dto';
import { InvitationMailer } from './invitation-mailer';
import { InvitationRecord, LeaveRecord, StaffMemberRecord, StaffRepository } from './staff.repository';
import {
  BreakRow, STAFF_LIMITS, StaffDayRow, billingSummary, breaksStillFit, formatClock, invitationExpiresAt, isExpired,
  normalizePermissions, todayInSalonTz, validateBreaks, validateLeavePeriod, validateStaffWeek,
} from './staff.types';
import { TokenService } from '../auth/token.service';
import { BillingCore } from '../billing/billing-core.service';

/** Views: the ONLY shapes the owner API returns for staff data. */
export const memberView = (m: StaffMemberRecord, now: Date) => ({
  id: m.id,
  displayName: m.displayName,
  bio: m.bio,
  isOwner: m.isOwner,
  isActive: m.isActive,
  performsServices: m.performsServices,
  /** Billable in the subscription (Phase 6): active and performing services. */
  billable: m.isActive && m.performsServices,
  permissions: m.grantedPermissions,
  account: m.userId
    ? 'LINKED'
    : m.inviteId
      ? (m.inviteExpiresAt && isExpired(m.inviteExpiresAt, now) ? 'INVITE_EXPIRED' : 'INVITED')
      : 'NO_ACCOUNT',
  invitation: m.inviteId ? { id: m.inviteId, email: m.inviteEmail, expiresAt: m.inviteExpiresAt } : null,
});

export const hoursView = (rows: ReadonlyArray<StaffDayRow>) =>
  [1, 2, 3, 4, 5, 6, 7].map((weekday) => {
    const r = rows.find((x) => x.weekday === weekday);
    if (!r) return { weekday, configured: false, off: true, startsAt: null, endsAt: null };
    return {
      weekday, configured: true, off: r.off,
      startsAt: r.startMinute === null ? null : formatClock(r.startMinute),
      endsAt: r.endMinute === null ? null : formatClock(r.endMinute),
    };
  });

export const breaksView = (rows: ReadonlyArray<BreakRow>) =>
  rows.map((b) => ({ weekday: b.weekday, startsAt: formatClock(b.startMinute), endsAt: formatClock(b.endMinute), label: b.label }));

export const leaveView = (l: LeaveRecord) => ({
  id: l.id, staffId: l.staffId, startsOn: l.startsOn, endsOn: l.endsOn, status: l.status, reason: l.reason, decidedAt: l.decidedAt,
});

const notFound = (what: string) => new AppException('NOT_FOUND', `${what} not found.`, 404);
const locked = (status: string) =>
  new AppException('CONFLICT', `The team cannot be changed while the salon is ${status.toLowerCase()}.`, 409);
const overlap = () => new AppException('CONFLICT', 'The staff member already has leave or a pending request in those dates.', 409);

/**
 * Owner-side team management: roster, profiles, permissions, invitations, working hours, breaks and leave.
 * The salon is ALWAYS the caller's own (derived from the session). Every write locks the salon row first, so
 * concurrent edits of one salon are serialised (limits, overlaps and invitations stay consistent).
 */
@Injectable()
export class TeamService {
  constructor(
    private readonly tenant: TenantDb,
    private readonly repo: StaffRepository,
    private readonly salons: SalonsRepository,
    private readonly authRepo: AuthRepository,
    private readonly tokens: TokenService,
    private readonly mailer: InvitationMailer,
    private readonly clock: Clock,
    private readonly billing: BillingCore,
  ) {}

  private async scoped<T>(user: AuthenticatedUser, write: boolean, fn: (tx: Tx, salon: SalonRecord, now: Date) => Promise<T>): Promise<T> {
    const found = await this.tenant.withTenant(toTenantContext(user), (tx: Tx) => this.salons.findByOwner(tx, user.id));
    if (!found) throw new AppException('NOT_FOUND', 'You have not registered a salon yet.', 404);
    return this.tenant.withTenant(toTenantContext(user, found.id), async (tx: Tx) => {
      const salon = write ? await this.salons.lockById(tx, found.id) : await this.salons.findById(tx, found.id);
      if (!salon) throw new AppException('NOT_FOUND', 'You have not registered a salon yet.', 404);
      if (write && !PROFILE_EDITABLE.includes(salon.status)) throw locked(salon.status);
      return fn(tx, salon, this.clock.now());
    });
  }

  /**
   * Phase 6: a change to who is billable (added, activated, deactivated, performs-services toggled, removed) must be
   * reflected in billing in the SAME transaction: a prorated top-up invoice for added staff, a credit for removed staff.
   * Runs under the salon row lock taken by scoped(write).
   */
  private reconcileBilling(tx: Tx, user: AuthenticatedUser, meta: ClientContext, salonId: string, now: Date): Promise<void> {
    return this.billing.reconcile(tx, salonId, { id: user.id, role: user.role, meta }, now);
  }

  private audit(user: AuthenticatedUser, meta: ClientContext, salonId: string, action: string, targetType: string, targetId: string, metadata?: Record<string, unknown>) {
    return {
      actorUserId: user.id, actorRole: user.role, action, targetType, targetId, salonId,
      ipAddress: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId, metadata: metadata ?? null,
    };
  }

  /** Sessions of a deactivated or removed account end immediately (access tokens are re-checked per request). */
  private async revokeSessions(userId: string | null, reason: string, now: Date): Promise<void> {
    if (userId) await this.authRepo.revokeAllSessions(userId, reason, now);
  }

  private async findOrThrow(tx: Tx, salonId: string, id: string): Promise<StaffMemberRecord> {
    const m = await this.repo.findMember(tx, salonId, id);
    if (!m) throw notFound('Team member');
    return m;
  }

  // ------------------------------------------------------------------ roster
  async list(user: AuthenticatedUser) {
    return this.scoped(user, false, async (tx, salon, now) => {
      const members = await this.repo.listMembers(tx, salon.id);
      return {
        canEdit: PROFILE_EDITABLE.includes(salon.status),
        members: members.map((m) => memberView(m, now)),
        billing: billingSummary(members),
        limits: { staff: CATALOG_LIMITS.staff, breaksPerDay: STAFF_LIMITS.breaksPerDay },
      };
    });
  }

  async get(user: AuthenticatedUser, id: string) {
    return this.scoped(user, false, async (tx, salon, now) => {
      const m = await this.findOrThrow(tx, salon.id, id);
      const [hours, breaks, leaves] = await Promise.all([
        this.repo.listWorkingHours(tx, salon.id, id),
        this.repo.listBreaks(tx, salon.id, id),
        this.repo.listUpcomingLeaves(tx, salon.id, id, todayInSalonTz(now), STAFF_LIMITS.upcomingLeaveLimit),
      ]);
      return { member: memberView(m, now), workingHours: hoursView(hours), breaks: breaksView(breaks), leaves: leaves.map(leaveView) };
    });
  }

  async create(user: AuthenticatedUser, dto: CreateStaffMemberDto, meta: ClientContext) {
    const self = dto.self === true;
    const name = (self ? (dto.displayName ?? user.fullName) : dto.displayName)?.trim();
    if (!name || name.length < 2) throw new AppException('VALIDATION_FAILED', 'displayName is required.', 400);
    const perms = normalizePermissions(dto.permissions);
    if (!perms.ok) throw new AppException('VALIDATION_FAILED', perms.message, 400);
    try {
      return await this.scoped(user, true, async (tx, salon, now) => {
        const existing = await this.repo.listMembers(tx, salon.id);
        if (self && existing.some((m) => m.isOwner)) throw new AppException('CONFLICT', 'You are already on your team list.', 409);
        if (existing.length >= CATALOG_LIMITS.staff) throw new AppException('CONFLICT', `You can have at most ${CATALOG_LIMITS.staff} team members.`, 409);
        const m = await this.repo.insertMember(tx, salon.id, {
          userId: self ? user.id : null,
          displayName: name.slice(0, 80),
          bio: dto.bio?.trim() || null,
          isOwner: self,
          performsServices: dto.performsServices ?? true,
          permissions: perms.value,
        }, now);
        await insertAudit(tx, this.audit(user, meta, salon.id, 'staff.created', 'staff_profile', m.id, { isOwner: self }));
        await this.reconcileBilling(tx, user, meta, salon.id, now);
        return memberView({ ...m, inviteId: null, inviteEmail: null, inviteExpiresAt: null }, now);
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw new AppException('CONFLICT', 'You are already on your team list.', 409);
      throw e;
    }
  }

  async update(user: AuthenticatedUser, id: string, dto: UpdateStaffMemberDto, meta: ClientContext) {
    let deactivatedUserId: string | null = null;
    const result = await this.scoped(user, true, async (tx, salon, now) => {
      const cur = await this.findOrThrow(tx, salon.id, id);
      if (cur.isOwner && dto.isActive === false) throw new AppException('CONFLICT', 'The owner profile cannot be deactivated.', 409);
      let permissions = cur.grantedPermissions;
      if (dto.permissions !== undefined) {
        const p = normalizePermissions(dto.permissions);
        if (!p.ok) throw new AppException('VALIDATION_FAILED', p.message, 400);
        permissions = p.value;
      }
      const next = {
        displayName: dto.displayName?.trim() ?? cur.displayName,
        bio: dto.bio === undefined ? cur.bio : (dto.bio?.trim() || null),
        performsServices: dto.performsServices ?? cur.performsServices,
        permissions,
        isActive: dto.isActive ?? cur.isActive,
      };
      await this.repo.updateMember(tx, salon.id, id, next, now);
      if (cur.isActive && !next.isActive) {
        await this.repo.revokePendingForStaff(tx, salon.id, id, now);
        deactivatedUserId = cur.userId;
      }
      await insertAudit(tx, this.audit(user, meta, salon.id, 'staff.updated', 'staff_profile', id, {
        fields: Object.keys(dto).filter((k) => (dto as Record<string, unknown>)[k] !== undefined),
        ...(cur.isActive !== next.isActive ? { active: next.isActive } : {}),
      }));
      await this.reconcileBilling(tx, user, meta, salon.id, now);
      return memberView((await this.findOrThrow(tx, salon.id, id)), now);
    });
    await this.revokeSessions(deactivatedUserId, 'STAFF_DEACTIVATED', this.clock.now());
    return result;
  }

  async remove(user: AuthenticatedUser, id: string, meta: ClientContext): Promise<void> {
    let userId: string | null = null;
    await this.scoped(user, true, async (tx, salon, now) => {
      const cur = await this.findOrThrow(tx, salon.id, id);
      if (cur.isOwner) throw new AppException('CONFLICT', 'The owner profile cannot be removed.', 409);
      await this.repo.revokePendingForStaff(tx, salon.id, id, now);
      await this.repo.deleteServiceAssignments(tx, salon.id, id);
      await this.repo.softDeleteMember(tx, salon.id, id, now);
      userId = cur.userId;
      await insertAudit(tx, this.audit(user, meta, salon.id, 'staff.deleted', 'staff_profile', id, { hadAccount: cur.userId !== null }));
      await this.reconcileBilling(tx, user, meta, salon.id, now);
    });
    await this.revokeSessions(userId, 'STAFF_REMOVED', this.clock.now());
  }

  // ------------------------------------------------------------------ invitations
  async invite(user: AuthenticatedUser, staffId: string, dto: SendInvitationDto, meta: ClientContext) {
    const out = await this.scoped(user, true, async (tx, salon, now) => {
      const m = await this.findOrThrow(tx, salon.id, staffId);
      if (m.isOwner) throw new AppException('CONFLICT', 'The owner account is already linked.', 409);
      if (m.userId) throw new AppException('CONFLICT', 'This team member already has an account.', 409);
      if (!m.isActive) throw new AppException('CONFLICT', 'Activate this team member before sending an invitation.', 409);
      if (await this.repo.userExistsByEmail(tx, dto.email)) {
        throw new AppException('CONFLICT', 'An account with this e-mail already exists. Use a different e-mail address.', 409);
      }
      await this.repo.revokePendingForStaff(tx, salon.id, staffId, now); // resend = new token, old one dies
      const t = this.tokens.newOpaqueToken();
      const expiresAt = invitationExpiresAt(now);
      let inv: InvitationRecord;
      try {
        inv = await this.repo.insertInvitation(tx, salon.id, { staffId, email: dto.email, tokenHash: t.hash, expiresAt, createdBy: user.id }, now);
      } catch (e) {
        if (isUniqueViolation(e)) throw new AppException('CONFLICT', 'This e-mail is already invited to another team member.', 409);
        throw e;
      }
      await insertAudit(tx, this.audit(user, meta, salon.id, 'staff.invitation_sent', 'staff_invitation', inv.id, { staffId }));
      return {
        invitation: { id: inv.id, email: inv.email, expiresAt: inv.expiresAt },
        mail: { to: dto.email, salonName: salon.name, displayName: m.displayName, rawToken: t.raw, expiresAt },
      };
    });
    await this.mailer.send(out.mail); // outside the transaction; a failure is logged and the owner can resend
    return out.invitation;
  }

  async revokeInvitation(user: AuthenticatedUser, inviteId: string, meta: ClientContext): Promise<void> {
    await this.scoped(user, true, async (tx, salon, now) => {
      const n = await this.repo.revokeInvitation(tx, salon.id, inviteId, now);
      if (n === 0) throw notFound('Invitation');
      await insertAudit(tx, this.audit(user, meta, salon.id, 'staff.invitation_revoked', 'staff_invitation', inviteId));
    });
  }

  // ------------------------------------------------------------------ working hours and breaks
  async setWorkingHours(user: AuthenticatedUser, staffId: string, dto: WeeklyHoursDto, meta: ClientContext) {
    return this.scoped(user, true, async (tx, salon, now) => {
      await this.findOrThrow(tx, salon.id, staffId);
      const salonHours: HourRow[] = await this.salons.listHours(tx, salon.id);
      const week = validateStaffWeek(dto.days.map((d) => ({ weekday: d.weekday, off: d.off, startsAt: d.startsAt, endsAt: d.endsAt })), salonHours);
      if (!week.ok) throw new AppException('VALIDATION_FAILED', week.message, 400);
      const breaks = await this.repo.listBreaks(tx, salon.id, staffId);
      const clash = breaksStillFit(breaks, week.value);
      if (clash) throw new AppException('CONFLICT', `${clash} Update the breaks first.`, 409);
      await this.repo.replaceWorkingHours(tx, salon.id, staffId, week.value, now);
      await insertAudit(tx, this.audit(user, meta, salon.id, 'staff.hours_updated', 'staff_profile', staffId));
      return { workingHours: hoursView(week.value) };
    });
  }

  async setBreaks(user: AuthenticatedUser, staffId: string, dto: BreaksDto, meta: ClientContext) {
    return this.scoped(user, true, async (tx, salon, now) => {
      await this.findOrThrow(tx, salon.id, staffId);
      const hours = await this.repo.listWorkingHours(tx, salon.id, staffId);
      const rows = validateBreaks(dto.breaks.map((b) => ({ weekday: b.weekday, startsAt: b.startsAt, endsAt: b.endsAt, label: b.label })), hours);
      if (!rows.ok) throw new AppException('VALIDATION_FAILED', rows.message, 400);
      await this.repo.replaceBreaks(tx, salon.id, staffId, rows.value, now);
      await insertAudit(tx, this.audit(user, meta, salon.id, 'staff.breaks_updated', 'staff_profile', staffId, { count: rows.value.length }));
      return { breaks: breaksView(rows.value) };
    });
  }

  // ------------------------------------------------------------------ leave
  async recordLeave(user: AuthenticatedUser, staffId: string, dto: LeaveDto, meta: ClientContext) {
    return this.scoped(user, true, async (tx, salon, now) => {
      await this.findOrThrow(tx, salon.id, staffId);
      const period = validateLeavePeriod(dto, todayInSalonTz(now), { forStaff: false });
      if (!period.ok) throw new AppException('VALIDATION_FAILED', period.message, 400);
      let l: LeaveRecord;
      try {
        l = await this.repo.insertLeave(tx, salon.id, {
          staffId, startsOn: period.value.startsOn, endsOn: period.value.endsOn, reason: dto.reason?.trim() || null,
          status: 'APPROVED', requestedBy: user.id, decidedBy: user.id,
        }, now);
      } catch (e) {
        if (sqlState(e) === '23P01') throw overlap();
        throw e;
      }
      await insertAudit(tx, this.audit(user, meta, salon.id, 'staff.leave_recorded', 'staff_leave', l.id, { days: period.value.days }));
      return leaveView(l);
    });
  }

  async reviewLeave(user: AuthenticatedUser, leaveId: string, dto: LeaveDecisionDto, meta: ClientContext) {
    return this.scoped(user, true, async (tx, salon, now) => {
      const l = await this.repo.findLeave(tx, salon.id, leaveId);
      if (!l) throw notFound('Leave request');
      if (l.status !== 'PENDING') throw new AppException('CONFLICT', 'This request was already decided.', 409);
      const to = dto.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED';
      try {
        const moved = await this.repo.moveLeave(tx, salon.id, leaveId, ['PENDING'], to, user.id, now);
        if (!moved) throw new AppException('CONFLICT', 'This request was already decided.', 409);
      } catch (e) {
        if (sqlState(e) === '23P01') throw overlap();
        throw e;
      }
      await insertAudit(tx, this.audit(user, meta, salon.id, `staff.leave_${to.toLowerCase()}`, 'staff_leave', leaveId));
      return { ...leaveView(l), status: to };
    });
  }

  async cancelLeave(user: AuthenticatedUser, staffId: string, leaveId: string, meta: ClientContext): Promise<void> {
    await this.scoped(user, true, async (tx, salon, now) => {
      const l = await this.repo.findLeave(tx, salon.id, leaveId);
      if (!l || l.staffId !== staffId) throw notFound('Leave');
      const moved = await this.repo.moveLeave(tx, salon.id, leaveId, ['PENDING', 'APPROVED'], 'CANCELLED', null, now);
      if (!moved) throw new AppException('CONFLICT', 'This leave can no longer be cancelled.', 409);
      await insertAudit(tx, this.audit(user, meta, salon.id, 'staff.leave_cancelled', 'staff_leave', leaveId));
    });
  }
}

