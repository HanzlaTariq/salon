import { Injectable } from '@nestjs/common';
import { AppException } from '../../common/errors/app-exception';
import { ClientContext } from '../../common/http/client-context';
import { insertAudit } from '../audit/audit.types';
import { SalonRecord } from '../salons/salon.types';
import { Tx } from '../salons/salons.repository';
import { BillingRepository, InvoiceRecord, PlanRecord } from './billing.repository';
import {
  BillingCycle, PlanPrices, bestPromotion, computeMainInvoice, computeRemovalCredit, computeTopUp, fromPaisa, nextPeriod, phaseOf, planReconcile,
  prorationWindow, renewalOpensOn, todayKarachi, toPaisa, topUpSettlement, unitPriceFor,
} from './billing.types';

/** Who is acting (for created_by and the audit log). `role` is the verified role, never client input. */
export interface BillingActor {
  id: string;
  role: string;
  meta: ClientContext;
}

export const conflict = (message: string) => new AppException('CONFLICT', message, 409);

export const planPrices = (p: PlanRecord): PlanPrices => ({
  id: p.id, monthlyPaisa: toPaisa(p.monthlyPrice), yearlyPaisa: toPaisa(p.yearlyPrice), graceDays: p.graceDays, renewalNoticeDays: p.renewalNoticeDays,
});

/**
 * Transaction-scoped billing rules shared by the owner, admin and staff modules. Every method takes the caller's
 * `Tx` (already inside TenantDb.withTenant) and assumes the SALON ROW IS LOCKED by the caller (`lockById`), which
 * serialises all billing writes of one salon: no double invoice, no double credit, no lost update.
 */
@Injectable()
export class BillingCore {
  constructor(private readonly repo: BillingRepository) {}

  audit(tx: Tx, actor: BillingActor, salonId: string | null, action: string, targetType: string, targetId: string, metadata?: Record<string, unknown>) {
    return insertAudit(tx, {
      actorUserId: actor.id, actorRole: actor.role, action, targetType, targetId, salonId,
      ipAddress: actor.meta.ip, userAgent: actor.meta.userAgent, requestId: actor.meta.requestId, metadata: metadata ?? null,
    });
  }

  async requirePlan(tx: Tx, now: Date): Promise<PlanRecord> {
    const plan = await this.repo.currentPlan(tx, now);
    if (!plan) throw conflict('Subscription pricing has not been configured yet. Please contact support.');
    return plan;
  }

  // ------------------------------------------------------------------ invoices for a full period
  /** INITIAL (no subscription yet) or RENEWAL invoice for the CURRENT billable staff, price and promotion. */
  async createMainInvoice(tx: Tx, salon: SalonRecord, actor: BillingActor, cycle: BillingCycle, now: Date): Promise<InvoiceRecord> {
    const today = todayKarachi(now);
    const sub = await this.repo.findSubscription(tx, salon.id);
    if (sub?.status === 'SUSPENDED') throw conflict('Your subscription is suspended. Please contact support.');
    const plan = await this.requirePlan(tx, now);
    if (sub) {
      const like = { status: sub.status, periodStart: sub.periodStart, periodEnd: sub.periodEnd, graceDays: sub.periodGraceDays };
      if (phaseOf(like, today) === 'ACTIVE') {
        const opens = renewalOpensOn(like, plan.renewalNoticeDays);
        if (today < opens) throw conflict(`Renewal opens on ${opens}.`);
      }
    }
    if (await this.repo.findOpenInvoice(tx, salon.id, false)) throw conflict('You already have an open invoice. Pay it or cancel it first.');
    const billable = await this.repo.billableCount(tx, salon.id);
    if (billable < 1) throw conflict('Add at least one active team member who performs services before subscribing. The owner counts when they perform services.');

    const promos = await this.repo.listPromotions(tx);
    const promo = bestPromotion(promos, cycle, today);
    const prices = planPrices(plan);
    const amounts = computeMainInvoice({
      unitPaisa: unitPriceFor(prices, cycle), staff: billable, discountPercent: promo?.percentOff ?? 0,
      creditBalancePaisa: toPaisa(await this.repo.creditBalance(tx, salon.id)),
    });
    const kind = sub ? 'RENEWAL' : 'INITIAL';
    const id = await this.repo.insertInvoice(tx, {
      salonId: salon.id, kind, status: 'OPEN', cycle, staffCount: billable, unitPrice: fromPaisa(amounts.unitPaisa), discountPercent: amounts.discountPercent,
      promotionId: promo?.id ?? null, promotionName: promo?.name ?? null, planId: plan.id, graceDays: plan.graceDays, prorationRemaining: null, prorationTotal: null,
      subtotal: fromPaisa(amounts.subtotal), discountAmount: fromPaisa(amounts.discountAmount), creditApplied: fromPaisa(amounts.creditApplied),
      total: fromPaisa(amounts.total), periodStart: null, periodEnd: null, paidAt: null, createdBy: actor.id,
    });
    if (amounts.creditApplied > 0) {
      await this.repo.insertCredit(tx, { salonId: salon.id, amount: fromPaisa(-amounts.creditApplied), reason: 'APPLIED_TO_INVOICE', invoiceId: id, note: null, createdBy: actor.id });
    }
    await this.repo.snapshotStaff(tx, { salonId: salon.id, billable, covered: sub?.coveredStaffCount ?? null, reason: 'INVOICE', invoiceId: id });
    await this.audit(tx, actor, salon.id, 'invoice.created', 'invoice', id, {
      kind, cycle, staffCount: billable, subtotal: fromPaisa(amounts.subtotal), discountPercent: amounts.discountPercent, creditApplied: fromPaisa(amounts.creditApplied),
      total: fromPaisa(amounts.total), promotion: promo?.name ?? null,
    });
    if (amounts.total === 0) await this.applyPaidInvoice(tx, salon.id, id, actor, now); // fully covered by credit / a 100% promotion
    return (await this.repo.findInvoice(tx, id)) as InvoiceRecord;
  }

  // ------------------------------------------------------------------ paying an invoice
  /**
   * Marks an invoice PAID and applies it. Called (a) by payment approval after a reviewer approved the payment and
   * (b) for a zero-total invoice. The database refuses PAID with an amount due unless an approved payment exists.
   */
  async applyPaidInvoice(tx: Tx, salonId: string, invoiceId: string, actor: BillingActor, now: Date): Promise<InvoiceRecord> {
    const inv = await this.repo.findInvoice(tx, invoiceId, { lock: true });
    if (!inv || inv.salonId !== salonId) throw new AppException('NOT_FOUND', 'Invoice not found.', 404);
    if (inv.status !== 'OPEN') throw conflict(`This invoice is already ${inv.status === 'PAID' ? 'paid' : 'void'}.`);
    const today = todayKarachi(now);
    const sub = await this.repo.findSubscription(tx, salonId);

    if (inv.kind === 'INITIAL' || inv.kind === 'RENEWAL') {
      const period = nextPeriod(inv.billingCycle, sub ? sub.periodEnd : null, today);
      await this.repo.markInvoicePaid(tx, inv.id, period, now);
      const next = { salonId, cycle: inv.billingCycle, periodStart: period.start, periodEnd: period.end, covered: inv.staffCount, unitPrice: inv.unitPrice, discountPercent: inv.discountPercent, graceDays: inv.graceDays };
      if (sub) await this.repo.renewSubscription(tx, next, now);
      else await this.repo.insertSubscription(tx, next);
      await this.repo.snapshotStaff(tx, { salonId, billable: await this.repo.billableCount(tx, salonId), covered: inv.staffCount, reason: 'ACTIVATION', invoiceId: inv.id });
      await this.audit(tx, actor, salonId, sub ? 'subscription.renewed' : 'subscription.activated', 'invoice', inv.id, {
        invoiceNo: inv.invoiceNo, cycle: inv.billingCycle, periodStart: period.start, periodEnd: period.end, staffCount: inv.staffCount, total: inv.total,
      });
    } else if (inv.kind === 'TOP_UP') {
      const own = { periodStart: inv.periodStart as string, periodEnd: inv.periodEnd as string };
      await this.repo.markInvoicePaid(tx, inv.id, { start: own.periodStart, end: own.periodEnd }, now);
      if (topUpSettlement(sub ? { periodStart: sub.periodStart, periodEnd: sub.periodEnd } : null, own) === 'APPLY' && sub) {
        await this.repo.setCovered(tx, salonId, sub.coveredStaffCount + inv.staffCount, now);
        await this.audit(tx, actor, salonId, 'subscription.topup_applied', 'invoice', inv.id, { invoiceNo: inv.invoiceNo, addedStaff: inv.staffCount, total: inv.total });
      } else if (toPaisa(inv.total) > 0) {
        // The period moved on while this top-up was awaiting verification: the money is never lost, it becomes credit.
        await this.repo.insertCredit(tx, { salonId, amount: inv.total, reason: 'STALE_TOPUP_PAYMENT', invoiceId: inv.id, note: 'Top-up paid after the period changed', createdBy: actor.id });
        await this.audit(tx, actor, salonId, 'credit.granted', 'invoice', inv.id, { reason: 'STALE_TOPUP_PAYMENT', amount: inv.total });
      }
    } else {
      throw conflict('This invoice cannot be paid.');
    }
    await this.audit(tx, actor, salonId, 'invoice.paid', 'invoice', inv.id, { invoiceNo: inv.invoiceNo, kind: inv.kind, total: inv.total });
    return (await this.repo.findInvoice(tx, inv.id)) as InvoiceRecord;
  }

  /** Voids an OPEN invoice (no live payment: the database enforces it too) and gives back any credit it consumed. */
  async voidInvoice(tx: Tx, inv: InvoiceRecord, reason: string, actor: BillingActor, now: Date): Promise<void> {
    if (inv.status !== 'OPEN') throw conflict('Only an open invoice can be voided.');
    if (inv.livePaymentStatus !== null) throw conflict('This invoice has a payment attached. A reviewer must decide on the payment first.');
    await this.repo.voidInvoice(tx, inv.id, reason, now);
    if (toPaisa(inv.creditApplied) > 0) {
      await this.repo.insertCredit(tx, { salonId: inv.salonId, amount: inv.creditApplied, reason: 'INVOICE_VOIDED', invoiceId: inv.id, note: null, createdBy: actor.id });
    }
    await this.audit(tx, actor, inv.salonId, 'invoice.voided', 'invoice', inv.id, { invoiceNo: inv.invoiceNo, kind: inv.kind, reason, creditRestored: inv.creditApplied });
  }

  // ------------------------------------------------------------------ mid-period staff changes
  /**
   * Brings billing in line with the CURRENT billable staff (agreed rule, Phase 6):
   *  - staff added mid-period  -> one prorated TOP_UP invoice (explicit, separate; the paid invoice never changes);
   *  - staff removed mid-period -> a credit for the unused days, spent on the next invoice.
   * Idempotent and cheap: callers run it after every staff change and after every payment decision.
   */
  async reconcile(tx: Tx, salonId: string, actor: BillingActor, now: Date): Promise<void> {
    const sub = await this.repo.findSubscription(tx, salonId);
    if (!sub) return;
    const today = todayKarachi(now);
    const billable = await this.repo.billableCount(tx, salonId);
    const open = await this.repo.findOpenInvoice(tx, salonId, true);
    await this.repo.snapshotStaff(tx, { salonId, billable, covered: sub.coveredStaffCount, reason: 'STAFF_CHANGE', invoiceId: null });

    const actions = planReconcile({
      today,
      sub: { status: sub.status, periodStart: sub.periodStart, periodEnd: sub.periodEnd, coveredStaff: sub.coveredStaffCount },
      billable,
      openTopUp: open && open.periodStart && open.periodEnd
        ? { id: open.id, staffCount: open.staffCount, periodStart: open.periodStart, periodEnd: open.periodEnd, hasLivePayment: open.livePaymentStatus !== null }
        : null,
    });

    for (const a of actions) {
      if (a.type === 'VOID_TOPUP') {
        await this.voidInvoice(tx, open as InvoiceRecord, 'Staff count changed', actor, now);
      } else if (a.type === 'CREATE_TOPUP') {
        const win = prorationWindow(sub, today);
        const amounts = computeTopUp({
          unitPaisa: toPaisa(sub.periodUnitPrice), staff: a.staff, discountPercent: sub.periodDiscountPercent, remainingDays: win.remainingDays, totalDays: win.totalDays,
          creditBalancePaisa: toPaisa(await this.repo.creditBalance(tx, salonId)),
        });
        const id = await this.repo.insertInvoice(tx, {
          salonId, kind: 'TOP_UP', status: 'OPEN', cycle: sub.billingCycle, staffCount: a.staff, unitPrice: sub.periodUnitPrice, discountPercent: sub.periodDiscountPercent,
          promotionId: null, promotionName: null, planId: null, graceDays: sub.periodGraceDays, prorationRemaining: win.remainingDays, prorationTotal: win.totalDays,
          subtotal: fromPaisa(amounts.subtotal), discountAmount: fromPaisa(amounts.discountAmount), creditApplied: fromPaisa(amounts.creditApplied), total: fromPaisa(amounts.total),
          periodStart: sub.periodStart, periodEnd: sub.periodEnd, paidAt: null, createdBy: actor.id,
        });
        if (amounts.creditApplied > 0) {
          await this.repo.insertCredit(tx, { salonId, amount: fromPaisa(-amounts.creditApplied), reason: 'APPLIED_TO_INVOICE', invoiceId: id, note: null, createdBy: actor.id });
        }
        await this.repo.snapshotStaff(tx, { salonId, billable, covered: sub.coveredStaffCount, reason: 'INVOICE', invoiceId: id });
        await this.audit(tx, actor, salonId, 'invoice.created', 'invoice', id, {
          kind: 'TOP_UP', addedStaff: a.staff, prorationDays: `${win.remainingDays}/${win.totalDays}`, total: fromPaisa(amounts.total), creditApplied: fromPaisa(amounts.creditApplied),
        });
        if (amounts.total === 0) await this.applyPaidInvoice(tx, salonId, id, actor, now);
      } else {
        const win = prorationWindow(sub, today);
        const credit = computeRemovalCredit({
          unitPaisa: toPaisa(sub.periodUnitPrice), discountPercent: sub.periodDiscountPercent, removed: a.removed, remainingDays: win.remainingDays, totalDays: win.totalDays,
        });
        if (credit > 0) {
          await this.repo.insertCredit(tx, { salonId, amount: fromPaisa(credit), reason: 'STAFF_REMOVED', invoiceId: null, note: `${a.removed} staff, ${win.remainingDays}/${win.totalDays} days`, createdBy: actor.id });
        }
        await this.repo.setCovered(tx, salonId, a.newCovered, now);
        await this.audit(tx, actor, salonId, 'credit.granted', 'salon', salonId, { reason: 'STAFF_REMOVED', removedStaff: a.removed, remainingDays: win.remainingDays, totalDays: win.totalDays, amount: fromPaisa(credit) });
      }
    }
  }

  // ------------------------------------------------------------------ complimentary period (Super Admin)
  async grantComplimentary(tx: Tx, salon: SalonRecord, actor: BillingActor, cycle: BillingCycle, reason: string, now: Date): Promise<InvoiceRecord> {
    if (await this.repo.findOpenInvoice(tx, salon.id, false)) throw conflict('Void the open invoice before granting a complimentary period.');
    const today = todayKarachi(now);
    const sub = await this.repo.findSubscription(tx, salon.id);
    const plan = await this.repo.currentPlan(tx, now);
    const billable = await this.repo.billableCount(tx, salon.id);
    const period = nextPeriod(cycle, sub ? sub.periodEnd : null, today);
    const graceDays = plan?.graceDays ?? 0;
    const id = await this.repo.insertInvoice(tx, {
      salonId: salon.id, kind: 'COMPLIMENTARY', status: 'PAID', cycle, staffCount: billable, unitPrice: '0.00', discountPercent: 0, promotionId: null, promotionName: null,
      planId: plan?.id ?? null, graceDays, prorationRemaining: null, prorationTotal: null, subtotal: '0.00', discountAmount: '0.00', creditApplied: '0.00', total: '0.00',
      periodStart: period.start, periodEnd: period.end, paidAt: now, createdBy: actor.id,
    });
    // A complimentary period is free for the whole period: price 0 means later top-ups are 0 as well.
    const next = { salonId: salon.id, cycle, periodStart: period.start, periodEnd: period.end, covered: billable, unitPrice: '0.00', discountPercent: 0, graceDays };
    if (sub) await this.repo.renewSubscription(tx, next, now);
    else await this.repo.insertSubscription(tx, next);
    await this.repo.snapshotStaff(tx, { salonId: salon.id, billable, covered: billable, reason: 'ACTIVATION', invoiceId: id });
    await this.audit(tx, actor, salon.id, 'subscription.granted', 'invoice', id, { cycle, periodStart: period.start, periodEnd: period.end, reason });
    return (await this.repo.findInvoice(tx, id)) as InvoiceRecord;
  }
}
