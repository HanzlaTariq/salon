import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Length, Max, MaxLength, Min } from 'class-validator';
import type { Request } from 'express';
import { AuthenticatedUser } from '../../common/auth/authenticated-user';
import { CurrentUser, RequirePermissions } from '../../common/auth/decorators';
import { PERMISSIONS } from '../../common/auth/permissions';
import { USER_ROLES, USER_STATUSES, UserRole, UserStatus } from '../../common/auth/roles';
import { clientContext } from '../../common/http/client-context';
import { AdminUsersService } from './admin-users.service';

class ListUsersQuery {
  @IsOptional() @IsIn(USER_ROLES) role?: UserRole;
  @IsOptional() @IsIn(USER_STATUSES) status?: UserStatus;
  @IsOptional() @IsString() @MaxLength(100) q?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(10_000) page?: number;
}

class SetStatusDto {
  @IsIn(['ACTIVE', 'SUSPENDED']) status!: 'ACTIVE' | 'SUSPENDED';
  @IsString() @Length(3, 500) reason!: string;
}

@ApiTags('admin')
@ApiBearerAuth()
@Controller('admin/users')
export class AdminUsersController {
  constructor(private readonly users: AdminUsersService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.USERS_READ)
  async list(@Query() q: ListUsersQuery) {
    return { data: await this.users.list({ role: q.role, status: q.status, q: q.q, page: q.page ?? 1, pageSize: q.pageSize ?? 25 }) };
  }

  @Patch(':id/status')
  @RequirePermissions(PERMISSIONS.USERS_MANAGE_STATUS)
  async setStatus(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: SetStatusDto,
    @Req() req: Request,
  ) {
    return { data: await this.users.setStatus(actor, id, dto.status, dto.reason, clientContext(req)) };
  }
}
