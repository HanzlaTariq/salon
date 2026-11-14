import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { AuthenticatedUser } from '../../common/auth/authenticated-user';
import { CurrentUser, Public, Roles } from '../../common/auth/decorators';
import { clientContext } from '../../common/http/client-context';
import { CustomerBookingService } from './customer-booking.service';
import { CreateBookingDto, CustomerCancelDto, ListBookingsQuery, RescheduleBookingDto, SalonBookingsQuery, SalonCancelDto, UpdateBookingPolicyDto } from './dto/booking.dto';
import { SalonBookingService } from './salon-booking.service';

/** Per-route limit (per client IP). The factor exists only so automated tests can run many flows from one IP. */
const factor = () => Number(process.env.AUTH_RATE_LIMIT_FACTOR ?? 1) || 1;
const limit = (perMinute: number) => ({ default: { limit: () => perMinute * factor(), ttl: () => 60_000 } });
const uuid = () => new ParseUUIDPipe();

/** The signed-in CUSTOMER's own bookings. The customer is always the caller; no customer id is accepted. */
@ApiTags('bookings')
@ApiBearerAuth()
@Roles('CUSTOMER')
@Controller('bookings')
export class CustomerBookingsController {
  constructor(private readonly svc: CustomerBookingService) {}

  /** Send `Idempotency-Key` (8-64 chars) so a retry after a network failure never creates a second booking. */
  @Post()
  @Throttle(limit(10))
  async create(@CurrentUser() u: AuthenticatedUser, @Body() dto: CreateBookingDto, @Headers('idempotency-key') key?: string) {
    return { data: await this.svc.create(u, dto, key) };
  }

  @Get()
  @Throttle(limit(60))
  async list(@CurrentUser() u: AuthenticatedUser, @Query() q: ListBookingsQuery) {
    return { data: await this.svc.list(u, q) };
  }

  @Get(':id')
  @Throttle(limit(120))
  async get(@CurrentUser() u: AuthenticatedUser, @Param('id', uuid()) id: string) {
    return { data: await this.svc.get(u, id) };
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @Throttle(limit(20))
  async cancel(@CurrentUser() u: AuthenticatedUser, @Param('id', uuid()) id: string, @Body() dto: CustomerCancelDto) {
    return { data: await this.svc.cancel(u, id, dto) };
  }

  @Post(':id/reschedule')
  @HttpCode(200)
  @Throttle(limit(20))
  async reschedule(@CurrentUser() u: AuthenticatedUser, @Param('id', uuid()) id: string, @Body() dto: RescheduleBookingDto) {
    return { data: await this.svc.reschedule(u, id, dto) };
  }
}

/** Salon owner: appointments of their own salon and the booking policy. The salon is derived from the session. */
@ApiTags('salon-bookings')
@ApiBearerAuth()
@Roles('SALON_OWNER')
@Controller('salons/mine')
export class OwnerBookingsController {
  constructor(private readonly svc: SalonBookingService) {}

  @Get('bookings')
  @Throttle(limit(120))
  async list(@CurrentUser() u: AuthenticatedUser, @Query() q: SalonBookingsQuery) {
    return { data: await this.svc.list(u, q) };
  }

  @Get('bookings/:id')
  @Throttle(limit(120))
  async get(@CurrentUser() u: AuthenticatedUser, @Param('id', uuid()) id: string) {
    return { data: await this.svc.get(u, id) };
  }

  @Post('bookings/:id/cancel')
  @HttpCode(200)
  @Throttle(limit(30))
  async cancel(@CurrentUser() u: AuthenticatedUser, @Param('id', uuid()) id: string, @Body() dto: SalonCancelDto) {
    return { data: await this.svc.cancel(u, id, dto) };
  }

  @Get('booking-policy')
  @Throttle(limit(60))
  async policy(@CurrentUser() u: AuthenticatedUser) {
    return { data: await this.svc.getPolicy(u) };
  }

  @Put('booking-policy')
  @Throttle(limit(20))
  async updatePolicy(@CurrentUser() u: AuthenticatedUser, @Body() dto: UpdateBookingPolicyDto, @Req() req: Request) {
    return { data: await this.svc.updatePolicy(u, dto, clientContext(req)) };
  }
}

/** Staff member: their OWN appointments only. */
@ApiTags('staff')
@ApiBearerAuth()
@Roles('SALON_STAFF')
@Controller('staff/me')
export class StaffBookingsController {
  constructor(private readonly svc: SalonBookingService) {}

  @Get('bookings')
  @Throttle(limit(120))
  async list(@CurrentUser() u: AuthenticatedUser, @Query() q: SalonBookingsQuery) {
    return { data: await this.svc.staffList(u, q) };
  }
}

/** Public: the rules a customer agrees to when booking. */
@ApiTags('public')
@Public()
@Controller('public/salons')
export class PublicBookingController {
  constructor(private readonly svc: CustomerBookingService) {}

  @Get(':id/booking-policy')
  @Throttle(limit(60))
  async policy(@Param('id', uuid()) id: string) {
    return { data: await this.svc.publicPolicy(id) };
  }
}
