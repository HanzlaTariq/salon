import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { AuthenticatedUser } from '../../common/auth/authenticated-user';
import { CurrentUser, Public, RequirePermissions, Roles } from '../../common/auth/decorators';
import { PERMISSIONS } from '../../common/auth/permissions';
import { clientContext } from '../../common/http/client-context';
import { AdminReviewsService } from './admin-reviews.service';
import { CustomerReviewsService } from './customer-reviews.service';
import {
  AdminReportsQuery, AdminReviewsQuery, CreateReviewDto, CustomersQuery, HideReviewDto, OwnerReviewsQuery, PageQuery, PublicReviewsQuery, ReportReviewDto, RespondDto,
  ResolveReportDto, UpdateReviewDto,
} from './dto/reviews.dto';
import { FavouritesService } from './favourites.service';
import { PublicReviewsService } from './public-reviews.service';
import { SalonReviewsService } from './salon-reviews.service';

/** Per-route limit (per client IP). The factor exists only so automated tests can run many flows from one IP. */
const factor = () => Number(process.env.AUTH_RATE_LIMIT_FACTOR ?? 1) || 1;
const limit = (perMinute: number) => ({ default: { limit: () => perMinute * factor(), ttl: () => 60_000 } });
const uuid = () => new ParseUUIDPipe();

/** Public: published reviews of a listed salon, with the rating summary. */
@ApiTags('public-reviews')
@Public()
@Controller('public/discovery/salons')
export class PublicReviewsController {
  constructor(private readonly svc: PublicReviewsService) {}

  @Get(':id/reviews')
  @Throttle(limit(60))
  async list(@Param('id', uuid()) id: string, @Query() q: PublicReviewsQuery) {
    return { data: await this.svc.list(id, q) };
  }
}

/** The signed-in CUSTOMER's own reviews. The customer is always the caller; no customer id is accepted anywhere. */
@ApiTags('customer-reviews')
@ApiBearerAuth()
@Roles('CUSTOMER')
@Controller('customers/me/reviews')
export class CustomerReviewsController {
  constructor(private readonly svc: CustomerReviewsService) {}

  @Get()
  @Throttle(limit(60))
  async list(@CurrentUser() u: AuthenticatedUser, @Query() q: PageQuery) {
    return { data: await this.svc.list(u, q) };
  }

  /** Completed visits that can still be reviewed. Declared before `:id` so it is never read as an id. */
  @Get('pending')
  @Throttle(limit(60))
  async pending(@CurrentUser() u: AuthenticatedUser) {
    return { data: await this.svc.pending(u) };
  }

  @Get(':id')
  @Throttle(limit(60))
  async get(@CurrentUser() u: AuthenticatedUser, @Param('id', uuid()) id: string) {
    return { data: await this.svc.get(u, id) };
  }

  @Post()
  @Throttle(limit(10))
  async create(@CurrentUser() u: AuthenticatedUser, @Body() dto: CreateReviewDto, @Req() req: Request) {
    return { data: await this.svc.create(u, dto, clientContext(req)) };
  }

  @Patch(':id')
  @Throttle(limit(20))
  async update(@CurrentUser() u: AuthenticatedUser, @Param('id', uuid()) id: string, @Body() dto: UpdateReviewDto, @Req() req: Request) {
    return { data: await this.svc.update(u, id, dto, clientContext(req)) };
  }
}

@ApiTags('customer-favourites')
@ApiBearerAuth()
@Roles('CUSTOMER')
@Controller('customers/me/favourites')
export class FavouritesController {
  constructor(private readonly svc: FavouritesService) {}

  @Get()
  @Throttle(limit(60))
  async list(@CurrentUser() u: AuthenticatedUser) {
    return { data: await this.svc.list(u) };
  }

  @Put(':salonId')
  @Throttle(limit(60))
  async add(@CurrentUser() u: AuthenticatedUser, @Param('salonId', uuid()) salonId: string) {
    return { data: await this.svc.add(u, salonId) };
  }

  @Delete(':salonId')
  @HttpCode(204)
  @Throttle(limit(60))
  async remove(@CurrentUser() u: AuthenticatedUser, @Param('salonId', uuid()) salonId: string) {
    await this.svc.remove(u, salonId);
  }
}

/** Salon owner: reviews of their own salon (the salon comes from the session; there is no salon id in any URL). */
@ApiTags('salon-reviews')
@ApiBearerAuth()
@Roles('SALON_OWNER')
@Controller('salons/mine')
export class OwnerReviewsController {
  constructor(private readonly svc: SalonReviewsService) {}

  @Get('reviews')
  @Throttle(limit(60))
  async list(@CurrentUser() u: AuthenticatedUser, @Query() q: OwnerReviewsQuery) {
    return { data: await this.svc.list(u, q) };
  }

  @Get('reviews/summary')
  @Throttle(limit(60))
  async summary(@CurrentUser() u: AuthenticatedUser) {
    return { data: await this.svc.summary(u) };
  }

  @Get('review-reports')
  @Throttle(limit(60))
  async reports(@CurrentUser() u: AuthenticatedUser) {
    return { data: await this.svc.myReports(u) };
  }

  @Put('reviews/:id/response')
  @Throttle(limit(30))
  async respond(@CurrentUser() u: AuthenticatedUser, @Param('id', uuid()) id: string, @Body() dto: RespondDto, @Req() req: Request) {
    return { data: await this.svc.respond(u, id, dto, clientContext(req)) };
  }

  @Delete('reviews/:id/response')
  @HttpCode(204)
  @Throttle(limit(30))
  async removeResponse(@CurrentUser() u: AuthenticatedUser, @Param('id', uuid()) id: string, @Req() req: Request) {
    await this.svc.removeResponse(u, id, clientContext(req));
  }

  @Post('reviews/:id/report')
  @Throttle(limit(10))
  async report(@CurrentUser() u: AuthenticatedUser, @Param('id', uuid()) id: string, @Body() dto: ReportReviewDto, @Req() req: Request) {
    return { data: await this.svc.report(u, id, dto, clientContext(req)) };
  }

  @Get('customers')
  @Throttle(limit(60))
  async customers(@CurrentUser() u: AuthenticatedUser, @Query() q: CustomersQuery) {
    return { data: await this.svc.customers(u, q) };
  }

  @Get('customers/:customerId')
  @Throttle(limit(60))
  async customer(@CurrentUser() u: AuthenticatedUser, @Param('customerId', uuid()) customerId: string) {
    return { data: await this.svc.customer(u, customerId) };
  }
}

/** Staff member: reviews about THEIR OWN work. The staff id is derived from the signed-in profile; none is accepted. */
@ApiTags('staff-reviews')
@ApiBearerAuth()
@Roles('SALON_STAFF')
@Controller('staff/me')
export class StaffReviewsController {
  constructor(private readonly svc: SalonReviewsService) {}

  @Get('reviews')
  @Throttle(limit(60))
  async list(@CurrentUser() u: AuthenticatedUser, @Query() q: PageQuery) {
    return { data: await this.svc.myStaffReviews(u, q) };
  }
}

/** Platform moderation. Reading: `reviews.read`; changing: `reviews.moderate`. */
@ApiTags('admin-reviews')
@ApiBearerAuth()
@Controller('admin/reviews')
export class AdminReviewsController {
  constructor(private readonly svc: AdminReviewsService) {}

  @Get()
  @Throttle(limit(60))
  @RequirePermissions(PERMISSIONS.REVIEWS_READ)
  async list(@CurrentUser() u: AuthenticatedUser, @Query() q: AdminReviewsQuery) {
    return { data: await this.svc.list(u, q) };
  }

  @Get('overview')
  @Throttle(limit(60))
  @RequirePermissions(PERMISSIONS.REVIEWS_READ)
  async overview(@CurrentUser() u: AuthenticatedUser) {
    return { data: await this.svc.overview(u) };
  }

  @Get('reports')
  @Throttle(limit(60))
  @RequirePermissions(PERMISSIONS.REVIEWS_READ)
  async reports(@CurrentUser() u: AuthenticatedUser, @Query() q: AdminReportsQuery) {
    return { data: await this.svc.reports(u, q) };
  }

  @Post('reports/:reportId/resolve')
  @HttpCode(200)
  @Throttle(limit(30))
  @RequirePermissions(PERMISSIONS.REVIEWS_MODERATE)
  async resolve(@CurrentUser() u: AuthenticatedUser, @Param('reportId', uuid()) reportId: string, @Body() dto: ResolveReportDto, @Req() req: Request) {
    return { data: await this.svc.resolve(u, reportId, dto, clientContext(req)) };
  }

  @Post(':id/hide')
  @HttpCode(200)
  @Throttle(limit(30))
  @RequirePermissions(PERMISSIONS.REVIEWS_MODERATE)
  async hide(@CurrentUser() u: AuthenticatedUser, @Param('id', uuid()) id: string, @Body() dto: HideReviewDto, @Req() req: Request) {
    return { data: await this.svc.hide(u, id, dto, clientContext(req)) };
  }

  @Post(':id/restore')
  @HttpCode(200)
  @Throttle(limit(30))
  @RequirePermissions(PERMISSIONS.REVIEWS_MODERATE)
  async restore(@CurrentUser() u: AuthenticatedUser, @Param('id', uuid()) id: string, @Req() req: Request) {
    return { data: await this.svc.restore(u, id, clientContext(req)) };
  }
}
