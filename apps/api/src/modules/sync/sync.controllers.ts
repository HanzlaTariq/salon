import { Body, Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AuthenticatedUser } from '../../common/auth/authenticated-user';
import { CurrentUser, Roles } from '../../common/auth/decorators';
import { PullQuery, PushDto } from './dto/sync.dto';
import { SyncService } from './sync.service';

/** Per-route limit (per client IP). The factor exists only so automated tests can run many flows from one IP. */
const factor = () => Number(process.env.AUTH_RATE_LIMIT_FACTOR ?? 1) || 1;
const limit = (perMinute: number) => ({ default: { limit: () => perMinute * factor(), ttl: () => 60_000 } });

/**
 * Offline sync for the salon apps (owner and staff). The salon, the user and the staff member always come from the verified session;
 * the body never carries them. Customers and platform users get 403.
 */
@ApiTags('sync')
@ApiBearerAuth()
@Roles('SALON_OWNER', 'SALON_STAFF')
@Controller('sync')
export class SyncController {
  constructor(private readonly svc: SyncService) {}

  /** Uploads the operations done offline. Idempotent per `operationId`; each result says APPLIED, REJECTED (final) or RETRY (try again). */
  @Post('push')
  @HttpCode(200)
  @Throttle(limit(30))
  async push(@CurrentUser() u: AuthenticatedUser, @Body() dto: PushDto) {
    return { data: await this.svc.push(u, dto) };
  }

  /** The caller's window of appointments (yesterday to a week ahead) with notes; `since` makes it a delta. */
  @Get('pull')
  @Throttle(limit(60))
  async pull(@CurrentUser() u: AuthenticatedUser, @Query() q: PullQuery) {
    return { data: await this.svc.pull(u, q) };
  }
}
