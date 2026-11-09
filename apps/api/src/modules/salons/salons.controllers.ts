import {
  Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Req, UploadedFile, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { AuthenticatedUser } from '../../common/auth/authenticated-user';
import { CurrentUser, Public, RequirePermissions, Roles } from '../../common/auth/decorators';
import { PERMISSIONS } from '../../common/auth/permissions';
import { clientContext } from '../../common/http/client-context';
import { AdminSalonsService } from './admin-salons.service';
import { AdminListSalonsQuery, CreateSalonDto, PublicListSalonsQuery, ReasonDto, RejectDto, UpdateSalonDto, UploadFileDto } from './dto/salon.dto';
import { OwnerSalonsService } from './owner-salons.service';
import { PublicSalonsService } from './public-salons.service';

/** Per-route limit (per client IP). The factor exists only so automated tests can run many flows from one IP. */
const factor = () => Number(process.env.AUTH_RATE_LIMIT_FACTOR ?? 1) || 1;
const limit = (perMinute: number) => ({ default: { limit: () => perMinute * factor(), ttl: () => 60_000 } });

@ApiTags('salons')
@ApiBearerAuth()
@Roles('SALON_OWNER')
@Controller('salons')
export class OwnerSalonsController {
  constructor(private readonly svc: OwnerSalonsService) {}

  @Post()
  @Throttle(limit(10))
  async create(@CurrentUser() u: AuthenticatedUser, @Body() dto: CreateSalonDto, @Req() req: Request) {
    return { data: await this.svc.create(u, dto, clientContext(req)) };
  }

  @Get('mine')
  async mine(@CurrentUser() u: AuthenticatedUser) {
    return { data: await this.svc.getMine(u) };
  }

  @Patch('mine')
  @Throttle(limit(30))
  async update(@CurrentUser() u: AuthenticatedUser, @Body() dto: UpdateSalonDto, @Req() req: Request) {
    return { data: await this.svc.update(u, dto, clientContext(req)) };
  }

  @Post('mine/submit')
  @HttpCode(200)
  @Throttle(limit(10))
  async submit(@CurrentUser() u: AuthenticatedUser, @Req() req: Request) {
    return { data: await this.svc.submit(u, clientContext(req)) };
  }

  /** multipart/form-data: fields `kind`, `docType`, and the binary field `file`. Size cap enforced while streaming. */
  @Post('mine/files')
  @Throttle(limit(20))
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file'))
  async upload(
    @CurrentUser() u: AuthenticatedUser,
    @UploadedFile() file: { buffer: Buffer; originalname?: string } | undefined,
    @Body() dto: UploadFileDto,
    @Req() req: Request,
  ) {
    return this.svc.uploadFile(u, file, dto, clientContext(req));
  }

  @Get('mine/files/:fileId/url')
  @Throttle(limit(60))
  async fileUrl(@CurrentUser() u: AuthenticatedUser, @Param('fileId', new ParseUUIDPipe()) fileId: string) {
    return { data: await this.svc.fileUrl(u, fileId) };
  }

  @Delete('mine/files/:fileId')
  @HttpCode(204)
  @Throttle(limit(30))
  async remove(@CurrentUser() u: AuthenticatedUser, @Param('fileId', new ParseUUIDPipe()) fileId: string, @Req() req: Request) {
    await this.svc.deleteFile(u, fileId, clientContext(req));
  }
}

@ApiTags('admin')
@ApiBearerAuth()
@Controller('admin/salons')
export class AdminSalonsController {
  constructor(private readonly svc: AdminSalonsService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.SALONS_READ)
  async list(@CurrentUser() u: AuthenticatedUser, @Query() q: AdminListSalonsQuery) {
    return { data: await this.svc.list(u, { status: q.status, q: q.q, city: q.city, page: q.page ?? 1, pageSize: q.pageSize ?? 25 }) };
  }

  @Get('stats')
  @RequirePermissions(PERMISSIONS.SALONS_READ)
  async stats(@CurrentUser() u: AuthenticatedUser) {
    return { data: await this.svc.stats(u) };
  }

  @Get(':id')
  @RequirePermissions(PERMISSIONS.SALONS_READ)
  async detail(@CurrentUser() u: AuthenticatedUser, @Param('id', new ParseUUIDPipe()) id: string) {
    return { data: await this.svc.detail(u, id) };
  }

  @Get(':id/files/:fileId/url')
  @Throttle(limit(60))
  @RequirePermissions(PERMISSIONS.SALONS_READ)
  async fileUrl(
    @CurrentUser() u: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('fileId', new ParseUUIDPipe()) fileId: string,
    @Req() req: Request,
  ) {
    return { data: await this.svc.fileUrl(u, id, fileId, clientContext(req)) };
  }

  @Post(':id/approve')
  @HttpCode(200)
  @RequirePermissions(PERMISSIONS.SALONS_REVIEW)
  async approve(@CurrentUser() u: AuthenticatedUser, @Param('id', new ParseUUIDPipe()) id: string, @Req() req: Request) {
    return { data: await this.svc.approve(u, id, clientContext(req)) };
  }

  @Post(':id/reject')
  @HttpCode(200)
  @RequirePermissions(PERMISSIONS.SALONS_REVIEW)
  async reject(@CurrentUser() u: AuthenticatedUser, @Param('id', new ParseUUIDPipe()) id: string, @Body() dto: RejectDto, @Req() req: Request) {
    return { data: await this.svc.reject(u, id, dto.reason, clientContext(req)) };
  }

  @Post(':id/suspend')
  @HttpCode(200)
  @RequirePermissions(PERMISSIONS.SALONS_MANAGE_STATUS)
  async suspend(@CurrentUser() u: AuthenticatedUser, @Param('id', new ParseUUIDPipe()) id: string, @Body() dto: ReasonDto, @Req() req: Request) {
    return { data: await this.svc.suspend(u, id, dto.reason, clientContext(req)) };
  }

  @Post(':id/reactivate')
  @HttpCode(200)
  @RequirePermissions(PERMISSIONS.SALONS_MANAGE_STATUS)
  async reactivate(@CurrentUser() u: AuthenticatedUser, @Param('id', new ParseUUIDPipe()) id: string, @Req() req: Request) {
    return { data: await this.svc.reactivate(u, id, clientContext(req)) };
  }
}

@ApiTags('public')
@Public()
@Controller('public/salons')
export class PublicSalonsController {
  constructor(private readonly svc: PublicSalonsService) {}

  @Get()
  @Throttle(limit(60))
  async list(@Query() q: PublicListSalonsQuery) {
    return { data: await this.svc.list({ q: q.q, city: q.city, area: q.area, type: q.type, page: q.page ?? 1, pageSize: q.pageSize ?? 20 }) };
  }

  @Get(':id')
  @Throttle(limit(60))
  async detail(@Param('id', new ParseUUIDPipe()) id: string) {
    return { data: await this.svc.detail(id) };
  }
}
