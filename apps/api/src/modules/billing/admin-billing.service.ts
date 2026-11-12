import { Inject, Injectable } from '@nestjs/common';
import { AuthenticatedUser, toTenantContext } from '../../common/auth/authenticated-user';
import { isUniqueViolation } from '../../common/db/pg-errors';
import { AppException } from '../../common/errors/app-exception';
import { ClientContext } from '../../common/http/client-context';
import { ObjectStorage } from '../../common/storage/object-storage';
import { TenantDb } from '../../common/tenancy/tenant-db.service';
import { Clock } from '../../common/util/clock';
import { ENV, Env } from '../../config/env';
import { SalonRecord } from '../salons/salon.types';
import { SalonsRepository, Tx } from '../salons/salons.repository';
import { BillingActor, BillingCore, conflict } from './billing-core.service';
import { BillingMailer } from './billing-mailer';
import { BillingRepository } from './billing.repository';
import { Phase, PaymentStatus, isIsoDate, todayKarachi, toPaisa } from './billing.types';
import { adminPaymentView, creditView, invoiceView, methodView, ownerPaymentView, planView, promotionView, subscriptionView } from './billing.views';
import { ApprovePaymentDto, CreatePaymentMethodDto, CreatePlanDto, CreatePromotionDto, GrantDto, UpdatePaymentMethodDto } from './dto/billing.dto';

const notFound = (what: string) => new AppException('NOT_FOUND', `${what} not found.`, 404);
const bad = (message: string) => new AppException('VALIDATION_FAILED', message, 400);

@Injectable()
export class AdminBillingService {
  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly tenant: TenantDb,
    private readonly salons: SalonsRepository,
    private readonly repo: BillingRepository,
    private readonly core: BillingCore,
    private readonly mailer: BillingMailer,
    private readonly storage: ObjectStorage,
    private readonly clock: Clock,
  ) {}

  private actor(u: AuthenticatedUser, meta: ClientContext): BillingActor {
    return { id: u.id, role: u.role, meta };
  }

  /** Platform context: the database additionally checks the CALLER'S STORED ROLE (Super Admin / Finance) for every money write. */
  private run<T>(u: AuthenticatedUser, fn: (tx: Tx, now: Date) => Promise<T>, salonId: string | null = null): Promise<T> {
    return this.tenant.withTenant(toTenantContext(u, salonId), (tx: Tx) => fn(tx, this.clock.now()));
  }

  /** Locks the salon row first (same order as the owner flows: no deadlocks), then runs `fn`. */
  private async withSalonLock<T>(u: AuthenticatedUser, salonId: string, fn: (tx: Tx, salon: SalonRecord, now: Date) => Promise<T>): Promise<T> {
    return this.run(u, async (tx, now) => {
      const salon = await this.salons.lockById(tx, salonId);
      if (!salon) throw notFound('Salon');
      return fn(tx, salon, now);
    }, salonId);
  }

  // ------------------------------------------------------------------ overview
  async overview(u: AuthenticatedUser) {
    return this.run(u, async (tx, now) => {
      const today = todayKarachi(now);
      const stats = await this.repo.overview(tx, today, `${today.slice(0, 7)}-01`, `${today.slice(0, 4)}-01-01`);
      return {
        currency: 'PKR',
        subscriptions: stats.phases,
        pendingPayments: stats.pendingPayments,
        pendingAmount: stats.pendingAmount,
        /** Sum over running subscriptions of the net monthly-equivalent price. Salon revenue is NOT included (platform revenue only). */
        monthlyRecurringRevenue: stats.mrr,
        verifiedRevenueThisMonth: stats.revenueThisMonth,
        verifiedRevenueThisYear: stats.revenueThisYear,
      };
    });
  }

  // ------------------------------------------------------------------ plans, promotions, payment methods (Super Admin)
  async plans(u: AuthenticatedUser) {
    return this.run(u, async (tx, now) => {
      const [current, history] = await Promise.all([this.repo.currentPlan(tx, now), this.repo.listPlans(tx, 50)]);
      return { current: current ? planView(current) : null, history: history.map(planView) };
    });
  }

  async createPlan(u: AuthenticatedUser, dto: CreatePlanDto, meta: ClientContext) {
    const monthly = toPaisa(dto.monthlyPricePerStaff);
    const yearly = toPaisa(dto.yearlyPricePerStaff);
    if (monthly < 100 || monthly > 100_000_000) throw bad('monthlyPricePerStaff must be between Rs. 1 and Rs. 1,000,000.');
    if (yearly < 100 || yearly > 1_000_000_000) throw bad('yearlyPricePerStaff must be between Rs. 1 and Rs. 10,000,000.');
    return this.run(u, async (tx, now) => {
      let effectiveFrom = now;
      if (dto.effectiveFrom !== undefined) {
        const t = Date.parse(dto.effectiveFrom);
        if (!Number.isFinite(t)) throw bad('effectiveFrom must be an ISO date-time.');
        if (t < now.getTime() - 5 * 60_000) throw bad('effectiveFrom cannot be in the past: price history is immutable.');
        effectiveFrom = new Date(t);
      }
      const plan = await this.repo.insertPlan(tx, {
        monthly: dto.monthlyPricePerStaff, yearly: dto.yearlyPricePerStaff, graceDays: dto.graceDays, renewalNoticeDays: dto.renewalNoticeDays,
        effectiveFrom, note: dto.note ?? null, createdBy: u.id,
      });
      await this.core.audit(tx, this.actor(u, meta), null, 'billing.plan_created', 'subscription_plan', plan.id, {
        monthlyPricePerStaff: plan.monthlyPrice, yearlyPricePerStaff: plan.yearlyPrice, graceDays: plan.graceDays, renewalNoticeDays: plan.renewalNoticeDays, effectiveFrom: plan.effectiveFrom,
      });
      return planView(plan);
    });
  }

  async promotions(u: AuthenticatedUser) {
    return this.run(u, async (tx) => ({ items: (await this.repo.listPromotions(tx)).map(promotionView) }));
  }

  async createPromotion(u: AuthenticatedUser, dto: CreatePromotionDto, meta: ClientContext) {
    if (!isIsoDate(dto.startsOn) || (dto.endsOn !== undefined && !isIsoDate(dto.endsOn))) throw bad('Dates must be valid calendar dates (YYYY-MM-DD).');
    if (dto.endsOn !== undefined && dto.endsOn < dto.startsOn) throw bad('endsOn cannot be before startsOn.');
    if (Number(dto.percentOff) <= 0 || Number(dto.percentOff) > 100) throw bad('percentOff must be between 0.01 and 100.');
    return this.run(u, async (tx) => {
      const p = await this.repo.insertPromotion(tx, { name: dto.name, percentOff: dto.percentOff, appliesTo: dto.appliesTo, startsOn: dto.startsOn, endsOn: dto.endsOn ?? null, createdBy: u.id });
      await this.core.audit(tx, this.actor(u, meta), null, 'billing.promotion_created', 'subscription_promotion', p.id, { name: p.name, percentOff: p.percentOff, appliesTo: p.appliesTo, startsOn: p.startsOn, endsOn: p.endsOn });
      return promotionView(p);
    });
  }

  async setPromotionActive(u: AuthenticatedUser, id: string, isActive: boolean, meta: ClientContext) {
    return this.run(u, async (tx, now) => {
      const p = await this.repo.setPromotionActive(tx, id, isActive, now);
      if (!p) throw notFound('Promotion');
      await this.core.audit(tx, this.actor(u, meta), null, isActive ? 'billing.promotion_activated' : 'billing.promotion_deactivated', 'subscription_promotion', id, { name: p.name });
      return promotionView(p);
    });
  }

  async paymentMethods(u: AuthenticatedUser) {
    return this.run(u, async (tx) => ({ items: (await this.repo.listPaymentMethods(tx, false)).map(methodView) }));
  }

  async createPaymentMethod(u: AuthenticatedUser, dto: CreatePaymentMethodDto, meta: ClientContext) {
    if (dto.method === 'BANK_TRANSFER' && !dto.bankName) throw bad('bankName is required for a bank transfer.');
    return this.run(u, async (tx) => {
      const m = await this.repo.insertPaymentMethod(tx, {
        method: dto.method, accountTitle: dto.accountTitle, accountNumber: dto.accountNumber, bankName: dto.bankName ?? null, instructions: dto.instructions ?? null,
        sortOrder: dto.sortOrder ?? 0, createdBy: u.id,
      });
      await this.core.audit(tx, this.actor(u, meta), null, 'billing.payment_method_created', 'payment_method', m.id, { method: m.method });
      return methodView(m);
    });
  }

  async updatePaymentMethod(u: AuthenticatedUser, id: string, dto: UpdatePaymentMethodDto, meta: ClientContext) {
    return this.run(u, async (tx, now) => {
      const cur = await this.repo.findPaymentMethod(tx, id);
      if (!cur) throw notFound('Payment method');
      const next = {
        accountTitle: dto.accountTitle ?? cur.accountTitle,
        accountNumber: dto.accountNumber ?? cur.accountNumber,
        bankName: dto.bankName === undefined ? cur.bankName : dto.bankName,
        instructions: dto.instructions === undefined ? cur.instructions : dto.instructions,
        isActive: dto.isActive ?? cur.isActive,
        sortOrder: dto.sortOrder ?? cur.sortOrder,
      };
      if (cur.method === 'BANK_TRANSFER' && !next.bankName) throw bad('bankName is required for a bank transfer.');
      const m = await this.repo.updatePaymentMethod(tx, id, next, now);
      if (!m) throw notFound('Payment method');
      // Changing WHERE owners send money is the most sensitive configuration: always audited (values omitted from the log).
      await this.core.audit(tx, this.actor(u, meta), null, 'billing.payment_method_updated', 'payment_method', id, {
        method: m.method, changed: Object.keys(dto).filter((k) => (dto as Record<string, unknown>)[k] !== undefined),
      });
      return methodView(m);
    });
  }

  // ------------------------------------------------------------------ payment verification (Super Admin / Finance)
  async listPayments(u: AuthenticatedUser, f: { status?: PaymentStatus; q?: string; page: number; pageSize: number }) {
    return this.run(u, async (tx) => {
      const r = await this.repo.adminListPayments(tx, { status: f.status, q: f.q, limit: f.pageSize, offset: (f.page - 1) * f.pageSize });
      return { items: r.items.map(adminPaymentView), total: r.total, page: f.page, pageSize: f.pageSize };
    });
  }

  async paymentDetail(u: AuthenticatedUser, id: string) {
    return this.run(u, async (tx) => {
      const p = await this.repo.adminFindPayment(tx, id);
      if (!p) throw notFound('Payment');
      const [inv, trail, owner] = await Promise.all([this.repo.findInvoice(tx, p.invoiceId), this.repo.paymentTrail(tx, id), this.ownerOf(tx, p.salonId)]);
      return {
        payment: adminPaymentView(p),
        invoice: inv ? invoiceView(inv) : null,
        owner,
        history: trail.map((t) => ({ action: t.action, actorRole: t.actorRole, at: t.createdAt, reason: t.reason })),
      };
    });
  }

  private async ownerOf(tx: Tx, salonId: string): Promise<{ name: string; email: string } | null> {
    const s = await this.salons.findById(tx, salonId);
    if (!s) return null;
    const c = await this.salons.findUserContact(s.ownerUserId);
    return c ? { name: c.fullName, email: c.email } : null;
  }

  async receiptUrl(u: AuthenticatedUser, id: string, meta: ClientContext) {
    const p = await this.run(u, async (tx) => {
      const found = await this.repo.findPayment(tx, id);
      if (!found) throw notFound('Payment');
      await this.core.audit(tx, this.actor(u, meta), found.salonId, 'payment.receipt_viewed', 'payment', id, { reason: null });
      return found;
    });
    try {
      return { url: await this.storage.signedUrl(p.receiptKey, this.env.SIGNED_URL_TTL_SEC), expiresInSec: this.env.SIGNED_URL_TTL_SEC };
    } catch {
      throw new AppException('SERVICE_UNAVAILABLE', 'File storage is temporarily unavailable. Please try again.', 503);
    }
  }

  /** Shared skeleton: read the payment to learn the salon, then lock salon -> payment -> invoice (always this order). */
  private async decide<T>(u: AuthenticatedUser, paymentId: string, fn: (tx: Tx, salon: SalonRecord, now: Date) => Promise<T>): Promise<T> {
    const salonId = await this.run(u, async (tx) => (await this.repo.findPayment(tx, paymentId))?.salonId ?? null);
    if (!salonId) throw notFound('Payment');
    return this.withSalonLock(u, salonId, fn);
  }

  async approve(u: AuthenticatedUser, paymentId: string, dto: ApprovePaymentDto, meta: ClientContext) {
    const out = await this.decide(u, paymentId, async (tx, salon, now) => {
      const pay = await this.repo.findPayment(tx, paymentId, { lock: true });
      if (!pay) throw notFound('Payment');
      if (pay.status !== 'PENDING') throw conflict(`This payment is ${pay.status.toLowerCase().replace('_', ' ')} and cannot be approved now.`);
      const inv = await this.repo.findInvoice(tx, pay.invoiceId, { lock: true });
      if (!inv || inv.status !== 'OPEN') throw conflict('The invoice is no longer open.');
      if (toPaisa(dto.receivedAmount) !== toPaisa(inv.total)) {
        throw bad(`The received amount must equal the invoice total (Rs. ${inv.total}). If a different amount arrived, reject the payment or ask for more information.`);
      }
      const actor = this.actor(u, meta);
      if (!(await this.repo.reviewPayment(tx, paymentId, { status: 'APPROVED', reviewerId: u.id, reason: null, receivedAmount: inv.total }, now))) throw conflict('This payment was already decided.');
      await this.core.audit(tx, actor, salon.id, 'payment.approved', 'payment', paymentId, { invoiceNo: inv.invoiceNo, receivedAmount: inv.total, reason: null });
      await this.core.applyPaidInvoice(tx, salon.id, inv.id, actor, now);
      await this.core.reconcile(tx, salon.id, actor, now); // staff may have changed while the payment was in review
      return { salon, invoiceNo: inv.invoiceNo, amount: inv.total };
    });
    void this.notifyOwner(out.salon.ownerUserId, (c) => this.mailer.paymentApproved(c, { salonName: out.salon.name, invoiceNo: out.invoiceNo, amount: out.amount }));
    return this.paymentDetail(u, paymentId);
  }

  async reject(u: AuthenticatedUser, paymentId: string, reason: string, meta: ClientContext) {
    const out = await this.decide(u, paymentId, async (tx, salon, now) => {
      const pay = await this.repo.findPayment(tx, paymentId, { lock: true });
      if (!pay) throw notFound('Payment');
      if (pay.status !== 'PENDING' && pay.status !== 'NEEDS_INFO') throw conflict('This payment was already decided.');
      const inv = await this.repo.findInvoice(tx, pay.invoiceId);
      if (!(await this.repo.reviewPayment(tx, paymentId, { status: 'REJECTED', reviewerId: u.id, reason, receivedAmount: null }, now))) throw conflict('This payment was already decided.');
      await this.core.audit(tx, this.actor(u, meta), salon.id, 'payment.rejected', 'payment', paymentId, { invoiceNo: inv?.invoiceNo ?? null, reason });
      return { salon, invoiceNo: inv?.invoiceNo ?? '' };
    });
    void this.notifyOwner(out.salon.ownerUserId, (c) => this.mailer.paymentRejected(c, { salonName: out.salon.name, invoiceNo: out.invoiceNo, reason }));
    return this.paymentDetail(u, paymentId);
  }

  async requestInfo(u: AuthenticatedUser, paymentId: string, message: string, meta: ClientContext) {
    const out = await this.decide(u, paymentId, async (tx, salon, now) => {
      const pay = await this.repo.findPayment(tx, paymentId, { lock: true });
      if (!pay) throw notFound('Payment');
      if (pay.status !== 'PENDING') throw conflict('Only a payment that is awaiting review can be queried.');
      const inv = await this.repo.findInvoice(tx, pay.invoiceId);
      if (!(await this.repo.reviewPayment(tx, paymentId, { status: 'NEEDS_INFO', reviewerId: u.id, reason: message, receivedAmount: null }, now))) throw conflict('This payment was already decided.');
      await this.core.audit(tx, this.actor(u, meta), salon.id, 'payment.info_requested', 'payment', paymentId, { invoiceNo: inv?.invoiceNo ?? null, reason: message });
      return { salon, invoiceNo: inv?.invoiceNo ?? '' };
    });
    void this.notifyOwner(out.salon.ownerUserId, (c) => this.mailer.infoRequested(c, { salonName: out.salon.name, invoiceNo: out.invoiceNo, message }));
    return this.paymentDetail(u, paymentId);
  }

  private async notifyOwner(ownerUserId: string, send: (c: { email: string; fullName: string }) => Promise<void>): Promise<void> {
    try {
      const c = await this.salons.findUserContact(ownerUserId);
      if (c) await send(c);
    } catch {
      /* the decision is already saved; e-mail is best-effort */
    }
  }

  // ------------------------------------------------------------------ subscriptions
  async listSubscriptions(u: AuthenticatedUser, f: { phase?: Phase; q?: string; page: number; pageSize: number }) {
    return this.run(u, async (tx, now) => {
      const r = await this.repo.adminListSubscriptions(tx, { phase: f.phase, q: f.q, today: todayKarachi(now), limit: f.pageSize, offset: (f.page - 1) * f.pageSize });
      return { items: r.items, total: r.total, page: f.page, pageSize: f.pageSize };
    });
  }

  async salonSubscription(u: AuthenticatedUser, salonId: string) {
    return this.run(u, async (tx, now) => {
      const salon = await this.salons.findById(tx, salonId);
      if (!salon) throw notFound('Salon');
      const today = todayKarachi(now);
      const [sub, billable, credit, invoices, payments, snapshots, credits, plan] = await Promise.all([
        this.repo.findSubscription(tx, salonId), this.repo.billableCount(tx, salonId), this.repo.creditBalance(tx, salonId),
        this.repo.listInvoices(tx, salonId, 50, 0), this.repo.listPaymentsForSalon(tx, salonId, 50), this.repo.listSnapshots(tx, salonId, 30),
        this.repo.listCredits(tx, salonId, 30), this.repo.currentPlan(tx, now),
      ]);
      return {
        salon: { id: salon.id, name: salon.name, city: salon.city, status: salon.status },
        subscription: subscriptionView(sub, today),
        billableStaff: billable,
        creditBalance: credit,
        currentPlan: plan ? planView(plan) : null,
        invoices: invoices.map((i) => invoiceView(i, billable)),
        payments: payments.map(ownerPaymentView).map((p, i) => ({ ...p, reviewReason: payments[i].reviewReason })),
        staffHistory: snapshots,
        credits: credits.map(creditView),
      };
    }, salonId);
  }

  private async mutateSubscription(u: AuthenticatedUser, salonId: string, fn: (tx: Tx, salon: SalonRecord, now: Date) => Promise<void>) {
    await this.withSalonLock(u, salonId, fn);
    return this.salonSubscription(u, salonId);
  }

  suspend(u: AuthenticatedUser, salonId: string, reason: string, meta: ClientContext) {
    return this.mutateSubscription(u, salonId, async (tx, salon, now) => {
      const sub = await this.repo.findSubscription(tx, salonId);
      if (!sub) throw conflict('This salon has no subscription yet.');
      if (sub.status === 'SUSPENDED') throw conflict('The subscription is already suspended.');
      await this.repo.setSubscriptionStatus(tx, salonId, 'SUSPENDED', reason, now);
      await this.core.audit(tx, this.actor(u, meta), salon.id, 'subscription.suspended', 'salon', salon.id, { reason });
    });
  }

  reactivate(u: AuthenticatedUser, salonId: string, reason: string, meta: ClientContext) {
    return this.mutateSubscription(u, salonId, async (tx, salon, now) => {
      const sub = await this.repo.findSubscription(tx, salonId);
      if (!sub || sub.status !== 'SUSPENDED') throw conflict('The subscription is not suspended.');
      await this.repo.setSubscriptionStatus(tx, salonId, 'ACTIVE', null, now);
      await this.core.audit(tx, this.actor(u, meta), salon.id, 'subscription.reactivated', 'salon', salon.id, { reason });
      await this.core.reconcile(tx, salon.id, this.actor(u, meta), now); // staff changes made while suspended are billed now
    });
  }

  grant(u: AuthenticatedUser, salonId: string, dto: GrantDto, meta: ClientContext) {
    return this.mutateSubscription(u, salonId, async (tx, salon, now) => {
      if (salon.status !== 'APPROVED' && salon.status !== 'SUSPENDED') throw conflict('Only an approved salon can have a subscription.');
      await this.core.grantComplimentary(tx, salon, this.actor(u, meta), dto.cycle, dto.reason, now);
    });
  }

  async voidInvoice(u: AuthenticatedUser, invoiceId: string, reason: string, meta: ClientContext) {
    const salonId = await this.run(u, async (tx) => (await this.repo.findInvoice(tx, invoiceId))?.salonId ?? null);
    if (!salonId) throw notFound('Invoice');
    try {
      return await this.mutateSubscription(u, salonId, async (tx, _salon, now) => {
        const inv = await this.repo.findInvoice(tx, invoiceId, { lock: true });
        if (!inv) throw notFound('Invoice');
        await this.core.voidInvoice(tx, inv, reason, this.actor(u, meta), now);
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw conflict('The invoice could not be voided.');
      throw e;
    }
  }
}

