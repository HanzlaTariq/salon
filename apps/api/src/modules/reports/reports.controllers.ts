import { Body, Controller, Delete, Get, Headers, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { AuthenticatedUser } from '../../common/auth/authenticated-user';
import { CurrentUser, RequirePermissions, Roles } from '../../common/auth/decorators';
import { PERMISSIONS } from '../../common/auth/permissions';
import { clientContext } from '../../common/http/client-context';
import { AdminAnalyticsService } from './admin-analytics.service';
import { AdminTrendQuery, CreateExpenseDto, ExpensesQuery, RangeQuery, ServicesQuery, TrendQuery, UpdateExpenseDto } from './dto/reports.dto';
import { ExpensesService } from './expenses.service';
import { SalonReportsService } from './salon-reports.service';

/** Per-route limit (per client IP). The factor exists only so automated tests can run many flows from one IP. */
const factor = () => Number(process.env.AUTH_RATE_LIMIT_FACTOR ?? 1) || 1;
const limit = (perMinute: number) => ({ default: { limit: () => perMinute * factor(), ttl: () => 60_000 } });
const uuid = () => new ParseUUIDPipe();

/** Salon owner: reports of their own salon. The salon comes from the session; there is no salon id anywhere in the URL. */
@ApiTags('salon-reports')
@ApiBearerAuth()
@Roles('SALON_OWNER')
@Controller('salons/mine/reports')
export class OwnerReportsController {
  constructor(private readonly svc: SalonReportsService) {}

  @Get('summary')
  @Throttle(limit(60))
  async summary(@CurrentUser() u: AuthenticatedUser, @Query() q: RangeQuery) {
    return { data: await this.svc.summary(u, q) };
  }

  @Get('trend')
  @Throttle(limit(60))
  async trend(@CurrentUser() u: AuthenticatedUser, @Query() q: TrendQuery) {
    return { data: await this.svc.trend(u, q) };
  }

  @Get('staff')
  @Throttle(limit(60))
  async staff(@CurrentUser() u: AuthenticatedUser, @Query() q: RangeQuery) {
    return { data: await this.svc.staff(u, q) };
  }

  @Get('services')
  @Throttle(limit(60))
  async services(@CurrentUser() u: AuthenticatedUser, @Query() q: ServicesQuery) {
    return { data: await this.svc.services(u, q) };
  }

  @Get('retention')
  @Throttle(limit(60))
  async retention(@CurrentUser() u: AuthenticatedUser, @Query() q: RangeQuery) {
    return { data: await this.svc.retention(u, q) };
  }

  @Get('expenses')
  @Throttle(limit(60))
  async expenses(@CurrentUser() u: AuthenticatedUser, @Query() q: RangeQuery) {
    return { data: await this.svc.expenses(u, q) };
  }
}

/** Salon owner: the salon's expenses. Staff, customers and platform roles get 403. */
@ApiTags('salon-expenses')
@ApiBearerAuth()
@Roles('SALON_OWNER')
@Controller('salons/mine/expenses')
export class OwnerExpensesController {
  constructor(private readonly svc: ExpensesService) {}

  @Get()
  @Throttle(limit(60))
  async list(@CurrentUser() u: AuthenticatedUser, @Query() q: ExpensesQuery) {
    return { data: await this.svc.list(u, q) };
  }

  /** Send `Idempotency-Key` so a retry on a bad network never records the same expense twice. */
  @Post()
  @Throttle(limit(30))
  async create(@CurrentUser() u: AuthenticatedUser, @Body() dto: CreateExpenseDto, @Headers('idempotency-key') key: string | undefined, @Req() req: Request) {
    return { data: await this.svc.create(u, dto, key, clientContext(req)) };
  }

  @Patch(':id')
  @Throttle(limit(30))
  async update(@CurrentUser() u: AuthenticatedUser, @Param('id', uuid()) id: string, @Body() dto: UpdateExpenseDto, @Req() req: Request) {
    return { data: await this.svc.update(u, id, dto, clientContext(req)) };
  }

  @Delete(':id')
  @HttpCode(204)
  @Throttle(limit(30))
  async remove(@CurrentUser() u: AuthenticatedUser, @Param('id', uuid()) id: string, @Req() req: Request) {
    await this.svc.remove(u, id, clientContext(req));
  }
}

/** Staff member: THEIR OWN performance. No staff id is accepted anywhere: it is derived from the signed-in profile. */
@ApiTags('staff-reports')
@ApiBearerAuth()
@Roles('SALON_STAFF')
@Controller('staff/me/reports')
export class StaffReportsController {
  constructor(private readonly svc: SalonReportsService) {}

  @Get('performance')
  @Throttle(limit(60))
  async performance(@CurrentUser() u: AuthenticatedUser, @Query() q: TrendQuery) {
    return { data: await this.svc.myPerformance(u, q) };
  }
}

/** Platform side: Super Admin, Support and Finance (`analytics.read`). Booking counts and platform subscription revenue only. */
@ApiTags('admin-analytics')
@ApiBearerAuth()
@Controller('admin/analytics')
export class AdminAnalyticsController {
  constructor(private readonly svc: AdminAnalyticsService) {}

  @Get('overview')
  @Throttle(limit(30))
  @RequirePermissions(PERMISSIONS.ANALYTICS_READ)
  async overview(@CurrentUser() u: AuthenticatedUser, @Query() q: RangeQuery) {
    return { data: await this.svc.overview(u, q) };
  }

  @Get('trend')
  @Throttle(limit(30))
  @RequirePermissions(PERMISSIONS.ANALYTICS_READ)
  async trend(@CurrentUser() u: AuthenticatedUser, @Query() q: AdminTrendQuery) {
    return { data: await this.svc.trend(u, q) };
  }

  @Get('cities')
  @Throttle(limit(30))
  @RequirePermissions(PERMISSIONS.ANALYTICS_READ)
  async cities(@CurrentUser() u: AuthenticatedUser, @Query() q: RangeQuery) {
    return { data: await this.svc.cities(u, q) };
  }
}
