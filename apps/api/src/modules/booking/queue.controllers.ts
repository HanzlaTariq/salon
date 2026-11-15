import { Body, Controller, Delete, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AuthenticatedUser } from '../../common/auth/authenticated-user';
import { CurrentUser, Roles } from '../../common/auth/decorators';
import { CustomerLiveService } from './customer-live.service';
import { AnswerOfferDto, ArrivalDto, EarlyOfferDto, NoShowDto, OwnerNextDto, OwnerQueueQuery, OwnerWalkInDto, StaffNextDto, StaffWalkInDto } from './dto/queue.dto';
import { QueueService } from './queue.service';

/** Per-route limit (per client IP). The factor exists only so automated tests can run many flows from one IP. */
const factor = () => Number(process.env.AUTH_RATE_LIMIT_FACTOR ?? 1) || 1;
const limit = (perMinute: number) => ({ default: { limit: () => perMinute * factor(), ttl: () => 60_000 } });
const uuid = () => new ParseUUIDPipe();

/**
 * Staff member: THEIR OWN queue. No staff id is accepted anywhere: the lane is derived from the signed-in profile, and an
 * appointment of a colleague answers 404.
 */
@ApiTags('staff-queue')
@ApiBearerAuth()
@Roles('SALON_STAFF')
@Controller('staff/me')
export class StaffQueueController {
  constructor(private readonly svc: QueueService) {}

  @Get('queue')
  @Throttle(limit(120))
  async queue(@CurrentUser() u: AuthenticatedUser) {
    return { data: await this.svc.queue(u) };
  }

  @Get('queue/services')
  @Throttle(limit(60))
  async services(@CurrentUser() u: AuthenticatedUser) {
    return { data: await this.svc.services(u) };
  }

  @Get('bookings/:id')
  @Throttle(limit(120))
  async detail(@CurrentUser() u: AuthenticatedUser, @Param('id', uuid()) id: string) {
    return { data: await this.svc.detail(u, id) };
  }

  @Post('appointments/:id/start')
  @HttpCode(200)
  @Throttle(limit(60))
  async start(@CurrentUser() u: AuthenticatedUser, @Param('id', uuid()) id: string) {
    return { data: await this.svc.start(u, id) };
  }

  @Post('appointments/:id/complete')
  @HttpCode(200)
  @Throttle(limit(60))
  async complete(@CurrentUser() u: AuthenticatedUser, @Param('id', uuid()) id: string) {
    return { data: await this.svc.complete(u, id) };
  }

  @Post('appointments/:id/no-show')
  @HttpCode(200)
  @Throttle(limit(30))
  async noShow(@CurrentUser() u: AuthenticatedUser, @Param('id', uuid()) id: string, @Body() dto: NoShowDto) {
    return { data: await this.svc.noShow(u, id, dto) };
  }

  @Post('queue/next')
  @HttpCode(200)
  @Throttle(limit(60))
  async next(@CurrentUser() u: AuthenticatedUser, @Body() dto: StaffNextDto) {
    return { data: await this.svc.next(u, undefined, dto.completeCurrent === true) };
  }

  /** Needs the `walk_ins.create` permission. Send `Idempotency-Key` so a retry never creates a second walk-in. */
  @Post('walk-ins')
  @Throttle(limit(30))
  async walkIn(@CurrentUser() u: AuthenticatedUser, @Body() dto: StaffWalkInDto, @Headers('idempotency-key') key?: string) {
    return { data: await this.svc.addWalkIn(u, dto, key) };
  }

  @Post('appointments/:id/early-offer')
  @Throttle(limit(30))
  async offer(@CurrentUser() u: AuthenticatedUser, @Param('id', uuid()) id: string, @Body() dto: EarlyOfferDto) {
    return { data: await this.svc.offerEarly(u, id, dto) };
  }

  @Delete('appointments/:id/early-offer')
  @Throttle(limit(30))
  async withdraw(@CurrentUser() u: AuthenticatedUser, @Param('id', uuid()) id: string) {
    return { data: await this.svc.withdrawEarlyOffer(u, id) };
  }
}

/** Salon owner: every queue of their own salon. The salon comes from the session; a staff id from another salon answers 404. */
@ApiTags('salon-queue')
@ApiBearerAuth()
@Roles('SALON_OWNER')
@Controller('salons/mine')
export class OwnerQueueController {
  constructor(private readonly svc: QueueService) {}

  @Get('queue')
  @Throttle(limit(120))
  async queue(@CurrentUser() u: AuthenticatedUser, @Query() q: OwnerQueueQuery) {
    return { data: await this.svc.queue(u, q.staffId) };
  }

  @Get('queue/services')
  @Throttle(limit(60))
  async services(@CurrentUser() u: AuthenticatedUser, @Query() q: OwnerQueueQuery) {
    return { data: await this.svc.services(u, q.staffId) };
  }

  @Post('appointments/:id/start')
  @HttpCode(200)
  @Throttle(limit(60))
  async start(@CurrentUser() u: AuthenticatedUser, @Param('id', uuid()) id: string) {
    return { data: await this.svc.start(u, id) };
  }

  @Post('appointments/:id/complete')
  @HttpCode(200)
  @Throttle(limit(60))
  async complete(@CurrentUser() u: AuthenticatedUser, @Param('id', uuid()) id: string) {
    return { data: await this.svc.complete(u, id) };
  }

  @Post('appointments/:id/no-show')
  @HttpCode(200)
  @Throttle(limit(30))
  async noShow(@CurrentUser() u: AuthenticatedUser, @Param('id', uuid()) id: string, @Body() dto: NoShowDto) {
    return { data: await this.svc.noShow(u, id, dto) };
  }

  @Post('queue/next')
  @HttpCode(200)
  @Throttle(limit(60))
  async next(@CurrentUser() u: AuthenticatedUser, @Body() dto: OwnerNextDto) {
    return { data: await this.svc.next(u, dto.staffId, dto.completeCurrent === true) };
  }

  @Post('walk-ins')
  @Throttle(limit(30))
  async walkIn(@CurrentUser() u: AuthenticatedUser, @Body() dto: OwnerWalkInDto, @Headers('idempotency-key') key?: string) {
    return { data: await this.svc.addWalkIn(u, dto, key) };
  }

  @Post('appointments/:id/early-offer')
  @Throttle(limit(30))
  async offer(@CurrentUser() u: AuthenticatedUser, @Param('id', uuid()) id: string, @Body() dto: EarlyOfferDto) {
    return { data: await this.svc.offerEarly(u, id, dto) };
  }

  @Delete('appointments/:id/early-offer')
  @Throttle(limit(30))
  async withdraw(@CurrentUser() u: AuthenticatedUser, @Param('id', uuid()) id: string) {
    return { data: await this.svc.withdrawEarlyOffer(u, id) };
  }
}

/** Customer: report arrival and answer an early offer for THEIR OWN booking. */
@ApiTags('bookings')
@ApiBearerAuth()
@Roles('CUSTOMER')
@Controller('bookings')
export class CustomerLiveController {
  constructor(private readonly svc: CustomerLiveService) {}

  @Post(':id/arrival')
  @HttpCode(200)
  @Throttle(limit(20))
  async arrival(@CurrentUser() u: AuthenticatedUser, @Param('id', uuid()) id: string, @Body() dto: ArrivalDto) {
    return { data: await this.svc.arrival(u, id, dto) };
  }

  @Post(':id/early-offer/accept')
  @HttpCode(200)
  @Throttle(limit(20))
  async accept(@CurrentUser() u: AuthenticatedUser, @Param('id', uuid()) id: string, @Body() dto: AnswerOfferDto) {
    return { data: await this.svc.accept(u, id, dto) };
  }

  @Post(':id/early-offer/decline')
  @HttpCode(200)
  @Throttle(limit(20))
  async decline(@CurrentUser() u: AuthenticatedUser, @Param('id', uuid()) id: string, @Body() dto: AnswerOfferDto) {
    return { data: await this.svc.decline(u, id, dto) };
  }
}
