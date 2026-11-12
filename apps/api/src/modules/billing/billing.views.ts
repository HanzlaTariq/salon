import { AdminPaymentRow, CreditRecord, InvoiceRecord, PaymentMethodRecord, PaymentRecord, PlanRecord, PromotionRecord, SubscriptionRecord } from './billing.repository';
import { addDays, diffDays, isOperational, phaseOf, toPaisa } from './billing.types';

/** The ONLY shapes the billing API returns. Storage keys, hashes and internal ids never leave the server. */

export const planView = (p: PlanRecord) => ({
  id: p.id, monthlyPricePerStaff: p.monthlyPrice, yearlyPricePerStaff: p.yearlyPrice, currency: p.currency, graceDays: p.graceDays,
  renewalNoticeDays: p.renewalNoticeDays, effectiveFrom: p.effectiveFrom, note: p.note, createdAt: p.createdAt,
});

export const promotionView = (p: PromotionRecord) => ({
  id: p.id, name: p.name, percentOff: p.percentOff, appliesTo: p.appliesTo, startsOn: p.startsOn, endsOn: p.endsOn, isActive: p.isActive,
});

export const methodView = (p: PaymentMethodRecord) => ({
  id: p.id, method: p.method, accountTitle: p.accountTitle, accountNumber: p.accountNumber, bankName: p.bankName, instructions: p.instructions,
  isActive: p.isActive, sortOrder: p.sortOrder,
});

export function subscriptionView(sub: SubscriptionRecord | null, today: string) {
  if (!sub) {
    return { phase: 'NONE' as const, isOperational: false, status: null, billingCycle: null, periodStart: null, periodEnd: null, paidThrough: null, accessThrough: null,
      daysLeft: 0, coveredStaff: 0, unitPrice: null, discountPercent: 0, graceDays: 0, suspendedReason: null };
  }
  const phase = phaseOf({ status: sub.status, periodStart: sub.periodStart, periodEnd: sub.periodEnd, graceDays: sub.periodGraceDays }, today);
  return {
    phase,
    /** Phases 7-8 use this to decide whether a salon may be listed and take bookings. */
    isOperational: isOperational(phase),
    status: sub.status,
    billingCycle: sub.billingCycle,
    periodStart: sub.periodStart,
    periodEnd: sub.periodEnd,
    /** Last day covered by the payment. */
    paidThrough: addDays(sub.periodEnd, -1),
    /** Last day of the grace period (equals paidThrough when there is no grace). */
    accessThrough: addDays(sub.periodEnd, sub.periodGraceDays - 1),
    daysLeft: phase === 'ACTIVE' ? Math.max(0, diffDays(today, sub.periodEnd)) : 0,
    coveredStaff: sub.coveredStaffCount,
    unitPrice: sub.periodUnitPrice,
    discountPercent: sub.periodDiscountPercent,
    graceDays: sub.periodGraceDays,
    suspendedReason: sub.suspendedReason,
  };
}

export function invoiceView(i: InvoiceRecord, billableNow?: number) {
  return {
    id: i.id,
    invoiceNo: i.invoiceNo,
    kind: i.kind,
    status: i.status,
    billingCycle: i.billingCycle,
    staffCount: i.staffCount,
    unitPrice: i.unitPrice,
    discountPercent: i.discountPercent,
    promotionName: i.promotionName,
    proration: i.prorationDaysTotal === null ? null : { remainingDays: i.prorationDaysRemaining, totalDays: i.prorationDaysTotal },
    subtotal: i.subtotal,
    discountAmount: i.discountAmount,
    creditApplied: i.creditApplied,
    total: i.total,
    currency: 'PKR',
    periodStart: i.periodStart,
    periodEnd: i.periodEnd,
    issuedAt: i.issuedAt,
    paidAt: i.paidAt,
    voidedAt: i.voidedAt,
    voidReason: i.voidReason,
    /** Status of the payment attached to this invoice (null = none yet). An invoice is PAID only after a reviewer approved it. */
    paymentStatus: i.livePaymentStatus,
    /** An unpaid renewal was priced for a different staff count than today: cancel and re-create it to refresh. */
    stale: billableNow !== undefined && i.status === 'OPEN' && (i.kind === 'INITIAL' || i.kind === 'RENEWAL') && i.staffCount !== billableNow,
  };
}

/** Owner-facing payment. Review reasons are shown only when they ask the owner to act or explain a rejection. */
export const ownerPaymentView = (p: PaymentRecord) => ({
  id: p.id,
  invoiceId: p.invoiceId,
  method: p.method,
  transactionId: p.transactionId,
  amount: p.claimedAmount,
  paidOn: p.paidOn,
  senderName: p.senderName,
  note: p.note,
  status: p.status,
  submittedAt: p.submittedAt,
  reviewedAt: p.reviewedAt,
  message: p.status === 'NEEDS_INFO' || p.status === 'REJECTED' ? p.reviewReason : null,
  hasReceipt: true,
});

export const adminPaymentView = (p: AdminPaymentRow) => ({
  ...ownerPaymentView(p),
  reviewReason: p.reviewReason,
  receivedAmount: p.receivedAmount,
  receiptContentType: p.receiptContentType,
  salon: { id: p.salonId, name: p.salonName, city: p.salonCity },
  invoice: { id: p.invoiceId, invoiceNo: p.invoiceNo, kind: p.invoiceKind, total: p.invoiceTotal, billingCycle: p.billingCycle },
  /** True when the declared amount equals the invoice total (it always does: the API and a DB trigger enforce it). */
  amountMatchesInvoice: toPaisa(p.claimedAmount) === toPaisa(p.invoiceTotal),
});

export const creditView = (c: CreditRecord) => ({ id: c.id, amount: c.amount, reason: c.reason, invoiceId: c.invoiceId, note: c.note, createdAt: c.createdAt });
