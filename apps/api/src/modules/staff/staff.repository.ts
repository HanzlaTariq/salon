import { Injectable } from '@nestjs/common';
import { Tx } from '../salons/salons.repository';
import { BreakRow, LeaveStatus, StaffDayRow, StaffPermission } from './staff.types';

type Row = Record<string, any>;

export interface StaffMemberRecord {
  id: string;
  salonId: string;
  userId: string | null;
  displayName: string;
  bio: string | null;
  isOwner: boolean;
  isActive: boolean;
  performsServices: boolean;
  grantedPermissions: StaffPermission[];
  createdAt: Date;
  updatedAt: Date;
  /** Live (PENDING) invitation, if any. */
  inviteId: string | null;
  inviteEmail: string | null;
  inviteExpiresAt: Date | null;
}

export interface LeaveRecord {
  id: string;
  staffId: string;
  startsOn: string;
  endsOn: string;
  status: LeaveStatus;
  reason: string | null;
  requestedBy: string;
  decidedAt: Date | null;
}

export interface InvitationRecord {
  id: string;
  salonId: string;
  staffId: string;
  email: string;
  status: 'PENDING' | 'ACCEPTED' | 'REVOKED';
  expiresAt: Date;
}

const member = (r: Row): StaffMemberRecord => ({
  id: r.id, salonId: r.salon_id, userId: r.user_id ?? null, displayName: r.display_name, bio: r.bio ?? null,
  isOwner: Boolean(r.is_owner), isActive: Boolean(r.is_active), performsServices: Boolean(r.performs_services),
  grantedPermissions: (r.granted_permissions ?? []) as StaffPermission[], createdAt: r.created_at, updatedAt: r.updated_at,
  inviteId: r.invite_id ?? null, inviteEmail: r.invite_email ?? null, inviteExpiresAt: r.invite_expires_at ?? null,
});

const leave = (r: Row): LeaveRecord => ({
  id: r.id, staffId: r.staff_id, startsOn: r.starts_on, endsOn: r.ends_on, status: r.status, reason: r.reason ?? null,
  requestedBy: r.requested_by, decidedAt: r.decided_at ?? null,
});

const invitation = (r: Row): InvitationRecord => ({
  id: r.id, salonId: r.salon_id, staffId: r.staff_id, email: r.email, status: r.status, expiresAt: r.expires_at,
});

/**
 * All SQL for Phase 5 (staff roster, invitations, working hours, breaks, leave). Every method takes the
 * transaction opened by TenantDb so Row-Level Security applies. Parameters are bound and carry explicit
 * casts. Dates are returned as text (to_char) so no timezone shifting can happen in Node.
 */
@Injectable()
export class StaffRepository {
  // ------------------------------------------------------------------ staff profiles
  async listMembers(tx: Tx, salonId: string): Promise<StaffMemberRecord[]> {
    const r = await tx.$queryRaw<Row[]>`
      SELECT sp.*, i.id AS invite_id, i.email AS invite_email, i.expires_at AS invite_expires_at
      FROM staff_profiles sp
      LEFT JOIN staff_invitations i ON i.staff_id = sp.id AND i.salon_id = sp.salon_id AND i.status = 'PENDING'
      WHERE sp.salon_id = ${salonId}::uuid AND sp.deleted_at IS NULL
      ORDER BY sp.is_owner DESC, lower(sp.display_name), sp.id`;
    return r.map(member);
  }

  async findMember(tx: Tx, salonId: string, id: string): Promise<StaffMemberRecord | null> {
    const r = await tx.$queryRaw<Row[]>`
      SELECT sp.*, i.id AS invite_id, i.email AS invite_email, i.expires_at AS invite_expires_at
      FROM staff_profiles sp
      LEFT JOIN staff_invitations i ON i.staff_id = sp.id AND i.salon_id = sp.salon_id AND i.status = 'PENDING'
      WHERE sp.id = ${id}::uuid AND sp.salon_id = ${salonId}::uuid AND sp.deleted_at IS NULL`;
    return r[0] ? member(r[0]) : null;
  }

  /** The caller's own profile (RLS `staff_self_read`): works before any salon context is set. */
  async findOwnProfile(tx: Tx, userId: string): Promise<StaffMemberRecord | null> {
    const r = await tx.$queryRaw<Row[]>`
      SELECT sp.* FROM staff_profiles sp WHERE sp.user_id = ${userId}::uuid AND sp.deleted_at IS NULL`;
    return r[0] ? member(r[0]) : null;
  }

  async countMembers(tx: Tx, salonId: string): Promise<number> {
    const r = await tx.$queryRaw<Row[]>`
      SELECT count(*)::int AS n FROM staff_profiles WHERE salon_id = ${salonId}::uuid AND deleted_at IS NULL`;
    return Number(r[0].n);
  }

  async insertMember(
    tx: Tx, salonId: string,
    m: { userId: string | null; displayName: string; bio: string | null; isOwner: boolean; performsServices: boolean; permissions: StaffPermission[] },
    now: Date,
  ): Promise<StaffMemberRecord> {
    const r = await tx.$queryRaw<Row[]>`
      INSERT INTO staff_profiles (salon_id, user_id, display_name, bio, is_owner, is_active, performs_services,
                                  granted_permissions, created_at, updated_at)
      VALUES (${salonId}::uuid, ${m.userId}::uuid, ${m.displayName}::varchar, ${m.bio}::varchar, ${m.isOwner}::boolean, true,
              ${m.performsServices}::boolean, ${m.permissions}::text[], ${now}::timestamptz, ${now}::timestamptz)
      RETURNING *`;
    return member({ ...r[0], invite_id: null, invite_email: null, invite_expires_at: null });
  }

  async updateMember(
    tx: Tx, salonId: string, id: string,
    m: { displayName: string; bio: string | null; performsServices: boolean; permissions: StaffPermission[]; isActive: boolean },
    now: Date,
  ): Promise<void> {
    await tx.$executeRaw`
      UPDATE staff_profiles SET display_name = ${m.displayName}::varchar, bio = ${m.bio}::varchar,
        performs_services = ${m.performsServices}::boolean, granted_permissions = ${m.permissions}::text[],
        is_active = ${m.isActive}::boolean, updated_at = ${now}::timestamptz
      WHERE id = ${id}::uuid AND salon_id = ${salonId}::uuid AND deleted_at IS NULL`;
  }

  async softDeleteMember(tx: Tx, salonId: string, id: string, now: Date): Promise<void> {
    await tx.$executeRaw`
      UPDATE staff_profiles SET deleted_at = ${now}::timestamptz, is_active = false, updated_at = ${now}::timestamptz
      WHERE id = ${id}::uuid AND salon_id = ${salonId}::uuid AND deleted_at IS NULL`;
  }

  /** Removes the member from service assignments (the catalogue shows only performing staff). */
  async deleteServiceAssignments(tx: Tx, salonId: string, staffId: string): Promise<void> {
    await tx.$executeRaw`DELETE FROM staff_services WHERE salon_id = ${salonId}::uuid AND staff_id = ${staffId}::uuid`;
  }

  async linkProfileToUser(tx: Tx, salonId: string, staffId: string, userId: string, now: Date): Promise<boolean> {
    const r = await tx.$queryRaw<Row[]>`
      UPDATE staff_profiles SET user_id = ${userId}::uuid, updated_at = ${now}::timestamptz
      WHERE id = ${staffId}::uuid AND salon_id = ${salonId}::uuid AND user_id IS NULL AND deleted_at IS NULL AND is_active
      RETURNING id`;
    return r.length === 1;
  }

  // ------------------------------------------------------------------ invitations
  async revokePendingForStaff(tx: Tx, salonId: string, staffId: string, now: Date): Promise<number> {
    return tx.$executeRaw`
      UPDATE staff_invitations SET status = 'REVOKED', revoked_at = ${now}::timestamptz
      WHERE salon_id = ${salonId}::uuid AND staff_id = ${staffId}::uuid AND status = 'PENDING'`;
  }

  async insertInvitation(
    tx: Tx, salonId: string,
    i: { staffId: string; email: string; tokenHash: string; expiresAt: Date; createdBy: string },
    now: Date,
  ): Promise<InvitationRecord> {
    const r = await tx.$queryRaw<Row[]>`
      INSERT INTO staff_invitations (salon_id, staff_id, email, token_hash, status, expires_at, created_by, created_at)
      VALUES (${salonId}::uuid, ${i.staffId}::uuid, ${i.email}::varchar, ${i.tokenHash}::varchar, 'PENDING',
              ${i.expiresAt}::timestamptz, ${i.createdBy}::uuid, ${now}::timestamptz)
      RETURNING id, salon_id, staff_id, email, status, expires_at`;
    return invitation(r[0]);
  }

  async revokeInvitation(tx: Tx, salonId: string, id: string, now: Date): Promise<number> {
    return tx.$executeRaw`
      UPDATE staff_invitations SET status = 'REVOKED', revoked_at = ${now}::timestamptz
      WHERE id = ${id}::uuid AND salon_id = ${salonId}::uuid AND status = 'PENDING'`;
  }

  /** Runs inside withInviteToken: visible only when the token hash matches. */
  async findInvitationByTokenHash(tx: Tx, tokenHash: string): Promise<InvitationRecord | null> {
    const r = await tx.$queryRaw<Row[]>`
      SELECT id, salon_id, staff_id, email, status, expires_at FROM staff_invitations
      WHERE token_hash = ${tokenHash}::varchar`;
    return r[0] ? invitation(r[0]) : null;
  }

  /** Row lock for the accept transaction (serialises two accept attempts with the same link). */
  async lockInvitationByTokenHash(tx: Tx, tokenHash: string): Promise<InvitationRecord | null> {
    const r = await tx.$queryRaw<Row[]>`
      SELECT id, salon_id, staff_id, email, status, expires_at FROM staff_invitations
      WHERE token_hash = ${tokenHash}::varchar FOR UPDATE`;
    return r[0] ? invitation(r[0]) : null;
  }

  async markInvitationAccepted(tx: Tx, id: string, userId: string, now: Date): Promise<boolean> {
    const r = await tx.$queryRaw<Row[]>`
      UPDATE staff_invitations SET status = 'ACCEPTED', accepted_at = ${now}::timestamptz, accepted_user_id = ${userId}::uuid
      WHERE id = ${id}::uuid AND status = 'PENDING' RETURNING id`;
    return r.length === 1;
  }

  // ------------------------------------------------------------------ accounts (no RLS on users)
  async userExistsByEmail(tx: Tx, email: string): Promise<boolean> {
    const r = await tx.$queryRaw<Row[]>`SELECT 1 AS x FROM users WHERE email = ${email}::varchar`;
    return r.length > 0;
  }

  /** Creates a verified SALON_STAFF account. Returns null when the e-mail is already registered. */
  async insertStaffUser(tx: Tx, u: { email: string; passwordHash: string; fullName: string }, now: Date): Promise<string | null> {
    const r = await tx.$queryRaw<Row[]>`
      INSERT INTO users (email, password_hash, full_name, role, status, email_verified_at, created_at, updated_at)
      VALUES (${u.email}::varchar, ${u.passwordHash}::varchar, ${u.fullName}::varchar, 'SALON_STAFF'::user_role,
              'ACTIVE'::user_status, ${now}::timestamptz, ${now}::timestamptz, ${now}::timestamptz)
      ON CONFLICT (email) DO NOTHING
      RETURNING id`;
    return r[0] ? (r[0].id as string) : null;
  }

  // ------------------------------------------------------------------ working hours
  async listWorkingHours(tx: Tx, salonId: string, staffId: string): Promise<StaffDayRow[]> {
    const r = await tx.$queryRaw<Row[]>`
      SELECT weekday, is_off, starts_minute, ends_minute FROM staff_working_hours
      WHERE salon_id = ${salonId}::uuid AND staff_id = ${staffId}::uuid ORDER BY weekday`;
    return r.map((x) => ({
      weekday: Number(x.weekday), off: Boolean(x.is_off),
      startMinute: x.starts_minute === null ? null : Number(x.starts_minute),
      endMinute: x.ends_minute === null ? null : Number(x.ends_minute),
    }));
  }

  async replaceWorkingHours(tx: Tx, salonId: string, staffId: string, rows: StaffDayRow[], now: Date): Promise<void> {
    await tx.$executeRaw`DELETE FROM staff_working_hours WHERE salon_id = ${salonId}::uuid AND staff_id = ${staffId}::uuid`;
    for (const d of rows) {
      await tx.$executeRaw`
        INSERT INTO staff_working_hours (salon_id, staff_id, weekday, is_off, starts_minute, ends_minute, updated_at)
        VALUES (${salonId}::uuid, ${staffId}::uuid, ${d.weekday}::smallint, ${d.off}::boolean,
                ${d.startMinute}::smallint, ${d.endMinute}::smallint, ${now}::timestamptz)`;
    }
  }

  // ------------------------------------------------------------------ breaks
  async listBreaks(tx: Tx, salonId: string, staffId: string): Promise<BreakRow[]> {
    const r = await tx.$queryRaw<Row[]>`
      SELECT weekday, starts_minute, ends_minute, label FROM staff_breaks
      WHERE salon_id = ${salonId}::uuid AND staff_id = ${staffId}::uuid ORDER BY weekday, starts_minute`;
    return r.map((x) => ({ weekday: Number(x.weekday), startMinute: Number(x.starts_minute), endMinute: Number(x.ends_minute), label: x.label }));
  }

  async replaceBreaks(tx: Tx, salonId: string, staffId: string, rows: BreakRow[], now: Date): Promise<void> {
    await tx.$executeRaw`DELETE FROM staff_breaks WHERE salon_id = ${salonId}::uuid AND staff_id = ${staffId}::uuid`;
    for (const b of rows) {
      await tx.$executeRaw`
        INSERT INTO staff_breaks (salon_id, staff_id, weekday, starts_minute, ends_minute, label, created_at)
        VALUES (${salonId}::uuid, ${staffId}::uuid, ${b.weekday}::smallint, ${b.startMinute}::smallint,
                ${b.endMinute}::smallint, ${b.label}::varchar, ${now}::timestamptz)`;
    }
  }

  // ------------------------------------------------------------------ leave
  async listUpcomingLeaves(tx: Tx, salonId: string, staffId: string, today: string, limit: number): Promise<LeaveRecord[]> {
    const r = await tx.$queryRaw<Row[]>`
      SELECT id, staff_id, to_char(starts_on, 'YYYY-MM-DD') AS starts_on,
        to_char(ends_on, 'YYYY-MM-DD') AS ends_on, status, reason, requested_by, decided_at
      FROM staff_leaves
      WHERE salon_id = ${salonId}::uuid AND staff_id = ${staffId}::uuid
        AND ends_on >= ${today}::date AND status IN ('PENDING', 'APPROVED')
      ORDER BY starts_on, id
      LIMIT ${limit}::int`;
    return r.map(leave);
  }

  async findLeave(tx: Tx, salonId: string, id: string): Promise<LeaveRecord | null> {
    const r = await tx.$queryRaw<Row[]>`
      SELECT id, staff_id, to_char(starts_on, 'YYYY-MM-DD') AS starts_on, to_char(ends_on, 'YYYY-MM-DD') AS ends_on,
        status, reason, requested_by, decided_at
      FROM staff_leaves WHERE id = ${id}::uuid AND salon_id = ${salonId}::uuid`;
    return r[0] ? leave(r[0]) : null;
  }

  async insertLeave(
    tx: Tx, salonId: string,
    l: { staffId: string; startsOn: string; endsOn: string; reason: string | null; status: LeaveStatus; requestedBy: string; decidedBy: string | null },
    now: Date,
  ): Promise<LeaveRecord> {
    const r = await tx.$queryRaw<Row[]>`
      INSERT INTO staff_leaves (salon_id, staff_id, starts_on, ends_on, status, reason, requested_by, decided_by, decided_at,
                                created_at, updated_at)
      VALUES (${salonId}::uuid, ${l.staffId}::uuid, ${l.startsOn}::date, ${l.endsOn}::date, ${l.status}::varchar,
              ${l.reason}::varchar, ${l.requestedBy}::uuid, ${l.decidedBy}::uuid,
              ${l.decidedBy ? now : null}::timestamptz, ${now}::timestamptz, ${now}::timestamptz)
      RETURNING id, staff_id, to_char(starts_on, 'YYYY-MM-DD') AS starts_on, to_char(ends_on, 'YYYY-MM-DD') AS ends_on,
        status, reason, requested_by, decided_at`;
    return leave(r[0]);
  }

  /** Moves a leave row to `to` only when its current status is one of `from` (guards against races). */
  async moveLeave(tx: Tx, salonId: string, id: string, from: LeaveStatus[], to: LeaveStatus, decidedBy: string | null, now: Date): Promise<boolean> {
    const r = await tx.$queryRaw<Row[]>`
      UPDATE staff_leaves SET status = ${to}::varchar, decided_by = COALESCE(${decidedBy}::uuid, decided_by),
        decided_at = CASE WHEN ${decidedBy}::uuid IS NULL THEN decided_at ELSE ${now}::timestamptz END,
        updated_at = ${now}::timestamptz
      WHERE id = ${id}::uuid AND salon_id = ${salonId}::uuid AND status = ANY(${from}::text[])
      RETURNING id`;
    return r.length === 1;
  }

  // ------------------------------------------------------------------ public invitation preview helpers
  async findLiveProfileName(tx: Tx, salonId: string, staffId: string): Promise<{ displayName: string; isActive: boolean; userId: string | null } | null> {
    const r = await tx.$queryRaw<Row[]>`
      SELECT display_name, is_active, user_id FROM staff_profiles
      WHERE id = ${staffId}::uuid AND salon_id = ${salonId}::uuid AND deleted_at IS NULL`;
    return r[0] ? { displayName: r[0].display_name, isActive: Boolean(r[0].is_active), userId: r[0].user_id ?? null } : null;
  }
}
