import { ExecutionContext, SetMetadata, createParamDecorator } from '@nestjs/common';
import { AuthedRequest, AuthenticatedUser } from './authenticated-user';
import { Permission } from './permissions';
import { UserRole } from './roles';

export const IS_PUBLIC = 'auth:isPublic';
export const ROLES_KEY = 'auth:roles';
export const PERMISSIONS_KEY = 'auth:permissions';
export const ALLOW_WITHOUT_MFA = 'auth:allowWithoutMfa';

/** Opt OUT of authentication. Every route is authenticated by default (default deny). */
export const Public = () => SetMetadata(IS_PUBLIC, true);
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);
export const RequirePermissions = (...permissions: Permission[]) => SetMetadata(PERMISSIONS_KEY, permissions);
/** Reachable by a platform user who has not finished mandatory MFA enrolment yet. */
export const AllowWithoutMfa = () => SetMetadata(ALLOW_WITHOUT_MFA, true);

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthenticatedUser => {
  const req = ctx.switchToHttp().getRequest<AuthedRequest>();
  if (!req.user) throw new Error('CurrentUser used on a route without an authenticated user');
  return req.user;
});
