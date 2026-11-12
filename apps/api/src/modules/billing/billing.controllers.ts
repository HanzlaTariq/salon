import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Req, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { AuthenticatedUser } from '../../common/auth/authenticated-user';
import { CurrentUser, RequirePermissions, Roles } from '../../common/auth/decorators';
import { PERMISSIONS } from '../../common/auth/permissions';
import { clientContext } from '../../common/http/client-context';
import { AdminBillingService } from './admin-billing.service';
import { OwnerBillingService } from './owner-billing.service';
import {
  AdminPaymentsQuery, AdminSubscriptionsQuery, ApprovePaymentDto, CreateInvoiceDto, CreatePaymentMethodDto, CreatePlanDto, CreatePromotionDto, GrantDto, PageQuery,
  RespondPaymentDto, ReviewReasonDto, SetActiveDto, SubmitPaymentDto, SubscriptionReasonDto, UpdatePaymentMethodDto,
} from './dto/billing.dto';

/** Per-route limit (per client IP). The factor exists only so automated tests can run many flows from one IP. */
const factor = () => Number(process.env.AUTH_RATE_LIMIT_FACTOR ?? 1) || 1;
const limit = (perMinute: number) => ({ default: { limit: () => perMinute * factor(), ttl: () => 60_000 } });

/** Salon owner: subscription, invoices and manual payments. Staff, managers and customers get 403 (default deny). */
@ApiTags('billing')
@ApiBearerAuth()
@Roles('SALON_OWNER')
@Controller('salons/mine/billing')
export class OwnerBillingController {
  constructor(private readonly svc: OwnerBillingService) {}

  @Get()
  async summary(@CurrentUser() u: AuthenticatedUser) {
    return { data: await this.svc.summary(u) };
  }

  @Get('invoices')
  async invoices(@CurrentUser() u: AuthenticatedUser, @Query() q: PageQuery) {
    return { data: await this.svc.listInvoices(u, q.page ?? 1) };
  }

  @Post('invoices')
  @Throttle(limit(10))
  async createInvoice(@CurrentUser() u: AuthenticatedUser, @Body() dto: CreateInvoiceDto, @Req() req: Request) {
    return { data: await this.svc.createInvoice(u, dto, clientContext(req)) };
  }

  @Post('invoices/:id/cancel')
  @HttpCode(200)
  @Throttle(limit(10))
  async cancelInvoice(@CurrentUser() u: AuthenticatedUser, @Param('id', new ParseUUIDPipe()) id: string, @Req() req: Request) {
    return { data: await this.svc.cancelInvoice(u, id, clientContext(req)) };
  }

  @Post('invoices/:id/payments')
  @Throttle(limit(10))
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('receipt'))
  async submitPayment(
    @CurrentUser() u: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: SubmitPaymentDto,
    @UploadedFile() file: { buffer: Buffer; originalname?: string } | undefined,
    @Req() req: Request,
  ) {
    return { data: await this.svc.submitPayment(u, id, dto, file, clientContext(req)) };
  }

  @Get('payments')
  async payments(@CurrentUser() u: AuthenticatedUser) {
    return { data: await this.svc.listPayments(u) };
  }

  @Post('payments/:id/respond')
  @HttpCode(200)
  @Throttle(limit(10))
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('receipt'))
  async respond(
    @CurrentUser() u: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: RespondPaymentDto,
    @UploadedFile() file: { buffer: Buffer; originalname?: string } | undefined,
    @Req() req: Request,
  ) {
    return { data: await this.svc.respond(u, id, dto, file, clientContext(req)) };
  }

  @Get('payments/:id/receipt-url')
  @Throttle(limit(60))
  async receiptUrl(@CurrentUser() u: AuthenticatedUser, @Param('id', new ParseUUIDPipe()) id: string) {
    return { data: await this.svc.receiptUrl(u, id) };
  }
}

/** Platform side. Reading billing: Super Admin, Support, Finance. Money decisions: Super Admin and Finance. Prices and policy: Super Admin. */
@ApiTags('admin-billing')
@ApiBearerAuth()
@Controller('admin')
export class AdminBillingController {
  constructor(private readonly svc: AdminBillingService) {}

  @Get('billing/overview')
  @RequirePermissions(PERMISSIONS.BILLING_READ)
  async overview(@CurrentUser() u: AuthenticatedUser) {
    return { data: await this.svc.overview(u) };
  }

  // ---- configuration
  @Get('billing/plans')
  @RequirePermissions(PERMISSIONS.BILLING_READ)
  async plans(@CurrentUser() u: AuthenticatedUser) {
    return { data: await this.svc.plans(u) };
  }

  @Post('billing/plans')
  @Throttle(limit(10))
  @RequirePermissions(PERMISSIONS.BILLING_MANAGE)
  async createPlan(@CurrentUser() u: AuthenticatedUser, @Body() dto: CreatePlanDto, @Req() req: Request) {
    return { data: await this.svc.createPlan(u, dto, clientContext(req)) };
  }

  @Get('billing/promotions')
  @RequirePermissions(PERMISSIONS.BILLING_READ)
  async promotions(@CurrentUser() u: AuthenticatedUser) {
    return { data: await this.svc.promotions(u) };
  }

  @Post('billing/promotions')
  @Throttle(limit(20))
  @RequirePermissions(PERMISSIONS.BILLING_MANAGE)
  async createPromotion(@CurrentUser() u: AuthenticatedUser, @Body() dto: CreatePromotionDto, @Req() req: Request) {
    return { data: await this.svc.createPromotion(u, dto, clientContext(req)) };
  }

  @Patch('billing/promotions/:id')
  @RequirePermissions(PERMISSIONS.BILLING_MANAGE)
  async setPromotionActive(@CurrentUser() u: AuthenticatedUser, @Param('id', new ParseUUIDPipe()) id: string, @Body() dto: SetActiveDto, @Req() req: Request) {
    return { data: await this.svc.setPromotionActive(u, id, dto.isActive, clientContext(req)) };
  }

  @Get('billing/payment-methods')
  @RequirePermissions(PERMISSIONS.BILLING_READ)
  async paymentMethods(@CurrentUser() u: AuthenticatedUser) {
    return { data: await this.svc.paymentMethods(u) };
  }

  @Post('billing/payment-methods')
  @Throttle(limit(20))
  @RequirePermissions(PERMISSIONS.BILLING_MANAGE)
  async createPaymentMethod(@CurrentUser() u: AuthenticatedUser, @Body() dto: CreatePaymentMethodDto, @Req() req: Request) {
    return { data: await this.svc.createPaymentMethod(u, dto, clientContext(req)) };
  }

  @Patch('billing/payment-methods/:id')
  @Throttle(limit(20))
  @RequirePermissions(PERMISSIONS.BILLING_MANAGE)
  async updatePaymentMethod(@CurrentUser() u: AuthenticatedUser, @Param('id', new ParseUUIDPipe()) id: string, @Body() dto: UpdatePaymentMethodDto, @Req() req: Request) {
    return { data: await this.svc.updatePaymentMethod(u, id, dto, clientContext(req)) };
  }

  // ---- payment verification
  @Get('payments')
  @RequirePermissions(PERMISSIONS.PAYMENTS_REVIEW)
  async listPayments(@CurrentUser() u: AuthenticatedUser, @Query() q: AdminPaymentsQuery) {
    return { data: await this.svc.listPayments(u, { status: q.status, q: q.q, page: q.page ?? 1, pageSize: q.pageSize ?? 25 }) };
  }

  @Get('payments/:id')
  @RequirePermissions(PERMISSIONS.PAYMENTS_REVIEW)
  async paymentDetail(@CurrentUser() u: AuthenticatedUser, @Param('id', new ParseUUIDPipe()) id: string) {
    return { data: await this.svc.paymentDetail(u, id) };
  }

  @Get('payments/:id/receipt-url')
  @Throttle(limit(60))
  @RequirePermissions(PERMISSIONS.PAYMENTS_REVIEW)
  async receiptUrl(@CurrentUser() u: AuthenticatedUser, @Param('id', new ParseUUIDPipe()) id: string, @Req() req: Request) {
    return { data: await this.svc.receiptUrl(u, id, clientContext(req)) };
  }

  @Post('payments/:id/approve')
  @HttpCode(200)
  @Throttle(limit(30))
  @RequirePermissions(PERMISSIONS.PAYMENTS_REVIEW)
  async approve(@CurrentUser() u: AuthenticatedUser, @Param('id', new ParseUUIDPipe()) id: string, @Body() dto: ApprovePaymentDto, @Req() req: Request) {
    return { data: await this.svc.approve(u, id, dto, clientContext(req)) };
  }

  @Post('payments/:id/reject')
  @HttpCode(200)
  @Throttle(limit(30))
  @RequirePermissions(PERMISSIONS.PAYMENTS_REVIEW)
  async reject(@CurrentUser() u: AuthenticatedUser, @Param('id', new ParseUUIDPipe()) id: string, @Body() dto: ReviewReasonDto, @Req() req: Request) {
    return { data: await this.svc.reject(u, id, dto.reason, clientContext(req)) };
  }

  @Post('payments/:id/request-info')
  @HttpCode(200)
  @Throttle(limit(30))
  @RequirePermissions(PERMISSIONS.PAYMENTS_REVIEW)
  async requestInfo(@CurrentUser() u: AuthenticatedUser, @Param('id', new ParseUUIDPipe()) id: string, @Body() dto: ReviewReasonDto, @Req() req: Request) {
    return { data: await this.svc.requestInfo(u, id, dto.reason, clientContext(req)) };
  }

  // ---- subscriptions
  @Get('subscriptions')
  @RequirePermissions(PERMISSIONS.BILLING_READ)
  async subscriptions(@CurrentUser() u: AuthenticatedUser, @Query() q: AdminSubscriptionsQuery) {
    return { data: await this.svc.listSubscriptions(u, { phase: q.phase, q: q.q, page: q.page ?? 1, pageSize: q.pageSize ?? 25 }) };
  }

  @Get('salons/:id/subscription')
  @RequirePermissions(PERMISSIONS.BILLING_READ)
  async salonSubscription(@CurrentUser() u: AuthenticatedUser, @Param('id', new ParseUUIDPipe()) id: string) {
    return { data: await this.svc.salonSubscription(u, id) };
  }

  @Post('salons/:id/subscription/suspend')
  @HttpCode(200)
  @Throttle(limit(20))
  @RequirePermissions(PERMISSIONS.SUBSCRIPTIONS_MANAGE)
  async suspend(@CurrentUser() u: AuthenticatedUser, @Param('id', new ParseUUIDPipe()) id: string, @Body() dto: SubscriptionReasonDto, @Req() req: Request) {
    return { data: await this.svc.suspend(u, id, dto.reason, clientContext(req)) };
  }

  @Post('salons/:id/subscription/reactivate')
  @HttpCode(200)
  @Throttle(limit(20))
  @RequirePermissions(PERMISSIONS.SUBSCRIPTIONS_MANAGE)
  async reactivate(@CurrentUser() u: AuthenticatedUser, @Param('id', new ParseUUIDPipe()) id: string, @Body() dto: SubscriptionReasonDto, @Req() req: Request) {
    return { data: await this.svc.reactivate(u, id, dto.reason, clientContext(req)) };
  }

  @Post('salons/:id/subscription/grant')
  @HttpCode(200)
  @Throttle(limit(10))
  @RequirePermissions(PERMISSIONS.SUBSCRIPTIONS_MANAGE)
  async grant(@CurrentUser() u: AuthenticatedUser, @Param('id', new ParseUUIDPipe()) id: string, @Body() dto: GrantDto, @Req() req: Request) {
    return { data: await this.svc.grant(u, id, dto, clientContext(req)) };
  }

  @Post('invoices/:id/void')
  @HttpCode(200)
  @Throttle(limit(20))
  @RequirePermissions(PERMISSIONS.SUBSCRIPTIONS_MANAGE)
  async voidInvoice(@CurrentUser() u: AuthenticatedUser, @Param('id', new ParseUUIDPipe()) id: string, @Body() dto: SubscriptionReasonDto, @Req() req: Request) {
    return { data: await this.svc.voidInvoice(u, id, dto.reason, clientContext(req)) };
  }
}
