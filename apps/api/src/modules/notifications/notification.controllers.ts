import { Body, Controller, Delete, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Inject } from '@nestjs/common';
import { AuthenticatedUser } from '../../common/auth/authenticated-user';
import { CurrentUser, Public, Roles } from '../../common/auth/decorators';
import { AppException } from '../../common/errors/app-exception';
import { ENV, Env } from '../../config/env';
import { InboxQuery, RegisterDeviceDto, UnregisterDeviceDto, UpdatePreferencesDto } from './dto/notification.dto';
import { NotificationService } from './notification.service';

/** Per-route limit (per client IP). The factor exists only so automated tests can run many flows from one IP. */
const factor = () => Number(process.env.AUTH_RATE_LIMIT_FACTOR ?? 1) || 1;
const limit = (perMinute: number) => ({ default: { limit: () => perMinute * factor(), ttl: () => 60_000 } });

/** Customers, salon owners and staff manage their own devices, inbox and preferences. Platform accounts use the web console. */
@ApiTags('notifications')
@ApiBearerAuth()
@Roles('CUSTOMER', 'SALON_OWNER', 'SALON_STAFF')
@Controller()
export class NotificationsController {
  constructor(private readonly svc: NotificationService) {}

  @Post('devices')
  @HttpCode(200)
  @Throttle(limit(20))
  async register(@CurrentUser() u: AuthenticatedUser, @Body() dto: RegisterDeviceDto) {
    return { data: await this.svc.registerDevice(u, dto) };
  }

  /** Sign-out on this phone: stop pushes to it. The token travels in the body (it can be 200+ characters). */
  @Delete('devices')
  @HttpCode(204)
  @Throttle(limit(20))
  async unregister(@CurrentUser() u: AuthenticatedUser, @Body() dto: UnregisterDeviceDto): Promise<void> {
    await this.svc.unregisterDevice(u, dto);
  }

  @Get('notifications')
  @Throttle(limit(120))
  async inbox(@CurrentUser() u: AuthenticatedUser, @Query() q: InboxQuery) {
    return { data: await this.svc.inbox(u, q) };
  }

  @Get('notifications/unread-count')
  @Throttle(limit(240))
  async unread(@CurrentUser() u: AuthenticatedUser) {
    return { data: await this.svc.unreadCount(u) };
  }

  @Get('notifications/preferences')
  @Throttle(limit(60))
  async preferences(@CurrentUser() u: AuthenticatedUser) {
    return { data: await this.svc.getPreferences(u) };
  }

  @Put('notifications/preferences')
  @Throttle(limit(30))
  async updatePreferences(@CurrentUser() u: AuthenticatedUser, @Body() dto: UpdatePreferencesDto) {
    return { data: await this.svc.updatePreferences(u, dto) };
  }

  @Post('notifications/read-all')
  @HttpCode(200)
  @Throttle(limit(30))
  async readAll(@CurrentUser() u: AuthenticatedUser) {
    return { data: await this.svc.markAllRead(u) };
  }

  @Post('notifications/:id/read')
  @HttpCode(200)
  @Throttle(limit(120))
  async read(@CurrentUser() u: AuthenticatedUser, @Param('id', new ParseUUIDPipe()) id: string) {
    return { data: await this.svc.markRead(u, id) };
  }
}

/**
 * For a cron service on hosting without a long-running process. Disabled (404) unless NOTIFICATIONS_CRON_SECRET is set. The secret is
 * compared in constant time. The endpoint takes no input and only runs the same safe, idempotent round as the built-in loop.
 */
@ApiTags('internal')
@Controller('internal/notifications')
export class NotificationCronController {
  constructor(private readonly svc: NotificationService, @Inject(ENV) private readonly env: Env) {}

  @Public()
  @Post('tick')
  @HttpCode(200)
  @Throttle(limit(12))
  async tick(@Headers('x-cron-secret') secret?: string) {
    if (!this.env.NOTIFICATIONS_CRON_SECRET) throw new AppException('NOT_FOUND', 'Not found.', 404);
    if (!NotificationService.secretMatches(this.env.NOTIFICATIONS_CRON_SECRET, secret)) throw new AppException('UNAUTHENTICATED', 'Invalid secret.', 401);
    return { data: await this.svc.tick() };
  }
}
