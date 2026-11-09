import { Injectable } from '@nestjs/common';
import { AuthenticatedUser } from '../../common/auth/authenticated-user';
import { UserRole, UserStatus } from '../../common/auth/roles';
import { AppException } from '../../common/errors/app-exception';
import { ClientContext } from '../../common/http/client-context';
import { Clock } from '../../common/util/clock';
import { AuthRepository, UserRecord } from '../auth/auth.repository';

export interface AdminUserView {
  id: string;
  email: string;
  fullName: string;
  phone: string | null;
  role: UserRole;
  status: UserStatus;
  emailVerified: boolean;
  mfaEnabled: boolean;
  lastLoginAt: Date | null;
  createdAt: Date;
}

const view = (u: UserRecord): AdminUserView => ({
  id: u.id,
  email: u.email,
  fullName: u.fullName,
  phone: u.phone,
  role: u.role,
  status: u.status,
  emailVerified: u.emailVerifiedAt !== null,
  mfaEnabled: u.mfaEnabledAt !== null,
  lastLoginAt: u.lastLoginAt,
  createdAt: u.createdAt,
});

@Injectable()
export class AdminUsersService {
  constructor(
    private readonly repo: AuthRepository,
    private readonly clock: Clock,
  ) {}

  async list(f: { role?: UserRole; status?: UserStatus; q?: string; page: number; pageSize: number }) {
    const { items, total } = await this.repo.listUsers({
      role: f.role,
      status: f.status,
      q: f.q,
      limit: f.pageSize,
      offset: (f.page - 1) * f.pageSize,
    });
    return { items: items.map(view), total, page: f.page, pageSize: f.pageSize };
  }

  /**
   * Suspend / reactivate. Guard rails against privilege escalation and lock-out:
   *  - the caller needs users.manage_status (enforced by the controller),
   *  - you can never change your own status,
   *  - SUPER_ADMIN accounts cannot be suspended through the API at all (break-glass is a DB/CLI action).
   * The status change and its audit record commit in ONE transaction; suspension also kills every session.
   */
  async setStatus(actor: AuthenticatedUser, targetId: string, requested: 'ACTIVE' | 'SUSPENDED', reason: string, ctx: ClientContext) {
    const target = await this.repo.findUserById(targetId);
    if (!target) throw new AppException('NOT_FOUND', 'User not found.', 404);
    if (target.id === actor.id) throw new AppException('FORBIDDEN', 'You cannot change your own account status.', 403);
    if (target.role === 'SUPER_ADMIN') throw new AppException('FORBIDDEN', 'Super admin accounts cannot be changed here.', 403);

    // Reactivating an account that never verified its e-mail returns it to the verification state.
    const effective: UserStatus = requested === 'ACTIVE' && !target.emailVerifiedAt ? 'PENDING_VERIFICATION' : requested;
    const now = this.clock.now();
    const ok = await this.repo.setUserStatus(
      target.id,
      effective,
      {
        actorUserId: actor.id,
        actorRole: actor.role,
        action: requested === 'SUSPENDED' ? 'admin.user_suspended' : 'admin.user_reactivated',
        targetType: 'user',
        targetId: target.id,
        ipAddress: ctx.ip,
        userAgent: ctx.userAgent,
        requestId: ctx.requestId,
        metadata: { from: target.status, to: effective, reason },
      },
      now,
    );
    if (!ok) throw new AppException('NOT_FOUND', 'User not found.', 404);
    if (effective === 'SUSPENDED') await this.repo.revokeAllSessions(target.id, 'ACCOUNT_SUSPENDED', now);
    return view({ ...target, status: effective });
  }
}
