import { Body, Controller, Get, Param, ParseUUIDPipe, Put, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { AuthenticatedUser } from '../../common/auth/authenticated-user';
import { CurrentUser, Public, RequirePermissions } from '../../common/auth/decorators';
import { PERMISSIONS } from '../../common/auth/permissions';
import { clientContext } from '../../common/http/client-context';
import { AvailabilityQuery, DiscoverySearchQuery, UpdateDiscoverySettingsDto } from './dto/discovery.dto';
import { DiscoveryService } from './discovery.service';

/** Per-route limit (per client IP). The factor exists only so automated tests can run many flows from one IP. */
const factor = () => Number(process.env.AUTH_RATE_LIMIT_FACTOR ?? 1) || 1;
const limit = (perMinute: number) => ({ default: { limit: () => perMinute * factor(), ttl: () => 60_000 } });

/** Customer discovery: no login needed, read-only, APPROVED and currently listed salons only. */
@ApiTags('public')
@Public()
@Controller('public/discovery')
export class PublicDiscoveryController {
  constructor(private readonly svc: DiscoveryService) {}

  @Get('options')
  @Throttle(limit(60))
  async options() {
    return { data: await this.svc.options() };
  }

  @Get('salons')
  @Throttle(limit(60))
  async search(@Query() q: DiscoverySearchQuery) {
    return { data: await this.svc.search(q) };
  }

  @Get('salons/:id/availability')
  @Throttle(limit(60))
  async availability(@Param('id', new ParseUUIDPipe()) id: string, @Query() q: AvailabilityQuery) {
    return { data: await this.svc.availability(id, q) };
  }
}

@ApiTags('admin')
@ApiBearerAuth()
@Controller('admin/discovery')
export class AdminDiscoveryController {
  constructor(private readonly svc: DiscoveryService) {}

  @Get('settings')
  @RequirePermissions(PERMISSIONS.BILLING_READ)
  async settings(@CurrentUser() u: AuthenticatedUser) {
    return { data: await this.svc.getSettings(u) };
  }

  @Put('settings')
  @Throttle(limit(20))
  @RequirePermissions(PERMISSIONS.BILLING_MANAGE)
  async update(@CurrentUser() u: AuthenticatedUser, @Body() dto: UpdateDiscoverySettingsDto, @Req() req: Request) {
    return { data: await this.svc.updateSettings(u, dto, clientContext(req)) };
  }
}
