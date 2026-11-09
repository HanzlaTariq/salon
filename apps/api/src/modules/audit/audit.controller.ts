import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { PERMISSIONS } from '../../common/auth/permissions';
import { RequirePermissions } from '../../common/auth/decorators';
import { AuditService } from './audit.service';

class AuditQuery {
  @IsOptional() @IsString() @MaxLength(80) action?: string;
  @IsOptional() @IsUUID() actorUserId?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(10_000) page?: number;
}

@ApiTags('admin')
@ApiBearerAuth()
@Controller('admin/audit-logs')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.AUDIT_READ)
  async list(@Query() q: AuditQuery) {
    const pageSize = q.pageSize ?? 50;
    const page = q.page ?? 1;
    const items = await this.audit.list({
      action: q.action,
      actorUserId: q.actorUserId,
      limit: pageSize,
      offset: (page - 1) * pageSize,
    });
    return { data: { items, page, pageSize } };
  }
}
