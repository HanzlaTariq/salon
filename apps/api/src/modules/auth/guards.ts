import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthedRequest } from '../../common/auth/authenticated-user';
import { ALLOW_WITHOUT_MFA, IS_PUBLIC, PERMISSIONS_KEY, ROLES_KEY } from '../../common/auth/decorators';
import { Permission, roleHasPermissions } from '../../common/auth/permissions';
import { UserRole, isPlatformRole } from '../../common/auth/roles';
import { AppException } from '../../common/errors/app-exception';
import { Clock } from '../../common/util/clock';
import { ENV, Env } from '../../config/env';
import { AuthRepository } from './auth.repository';
import { TokenService } from './token.service';

/**
 * GLOBAL guard: every route requires a valid access token unless it is marked @Public().
 * On every request it re-reads the session and user from the database, so a logout, suspension,
 * password change or role change takes effect on the very next call (not after token expiry).
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    private readonly repo: AuthRepository,
    private readonly clock: Clock,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const header = req.headers.authorization;
    const match = typeof header === 'string' ? /^Bearer ([A-Za-z0-9\-._~+/]+=*)$/.exec(header) : null;
    if (!match) throw new AppException('UNAUTHENTICATED', 'Authentication required.', 401);

    const claims = await this.tokens.verifyAccessToken(match[1]);
    const active = await this.repo.findActiveSession(claims.sessionId, this.clock.now());
    if (!active || active.user.id !== claims.userId) {
      throw new AppException('UNAUTHENTICATED', 'Session expired. Please sign in again.', 401);
    }
    const { user, session } = active;
    if (user.status !== 'ACTIVE') {
      throw new AppException(
        user.status === 'SUSPENDED' ? 'ACCOUNT_SUSPENDED' : 'EMAIL_NOT_VERIFIED',
        user.status === 'SUSPENDED' ? 'This account has been suspended.' : 'E-mail address not verified.',
        403,
      );
    }

    const enrolmentRequired = this.env.REQUIRE_ADMIN_MFA && isPlatformRole(user.role) && user.mfaEnabledAt === null;
    if (enrolmentRequired && !this.reflector.getAllAndOverride<boolean>(ALLOW_WITHOUT_MFA, targets)) {
      throw new AppException('MFA_ENROLLMENT_REQUIRED', 'Set up two-factor authentication to continue.', 403);
    }

    req.user = {
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      role: user.role,
      status: user.status,
      sessionId: session.id,
      mfaEnabled: user.mfaEnabledAt !== null,
      mfaVerified: session.mfaVerified,
      mfaEnrollmentRequired: enrolmentRequired,
    };
    return true;
  }
}

/** @Roles(...) / @RequirePermissions(...) enforcement. Runs after JwtAuthGuard. */
@Injectable()
export class AuthorizationGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const targets = [ctx.getHandler(), ctx.getClass()];
    const roles = this.reflector.getAllAndOverride<UserRole[] | undefined>(ROLES_KEY, targets);
    const perms = this.reflector.getAllAndOverride<Permission[] | undefined>(PERMISSIONS_KEY, targets);
    if (!roles && !perms) return true;

    const user = ctx.switchToHttp().getRequest<AuthedRequest>().user;
    if (!user) throw new AppException('UNAUTHENTICATED', 'Authentication required.', 401);
    if (roles && !roles.includes(user.role)) throw new AppException('FORBIDDEN', 'You do not have access to this resource.', 403);
    if (perms && !roleHasPermissions(user.role, perms)) {
      throw new AppException('FORBIDDEN', 'You do not have access to this resource.', 403);
    }
    return true;
  }
}
