/** API shapes for Phase 6 (money is always a decimal STRING such as "600.00"; never parse it into a float for arithmetic). */
export type Cycle = 'MONTHLY' | 'YEARLY';
export type Phase = 'NONE' | 'ACTIVE' | 'GRACE' | 'EXPIRED' | 'SUSPENDED';
export type PaymentStatus = 'PENDING' | 'NEEDS_INFO' | 'APPROVED' | 'REJECTED';
export type MethodKind = 'JAZZCASH' | 'EASYPAISA' | 'BANK_TRANSFER';

export const METHOD_LABEL: Record<MethodKind, string> = { JAZZCASH: 'JazzCash', EASYPAISA: 'Easypaisa', BANK_TRANSFER: 'Bank transfer' };
export const PHASE_LABEL: Record<Phase, string> = { NONE: 'Not subscribed', ACTIVE: 'Active', GRACE: 'Grace period', EXPIRED: 'Expired', SUSPENDED: 'Suspended' };
export const PAYMENT_LABEL: Record<PaymentStatus, string> = { PENDING: 'Awaiting review', NEEDS_INFO: 'Needs info', APPROVED: 'Approved', REJECTED: 'Rejected' };
export const KIND_LABEL: Record<string, string> = { INITIAL: 'First subscription', RENEWAL: 'Renewal', TOP_UP: 'Staff top-up', COMPLIMENTARY: 'Complimentary' };

/** "1234.5" -> "Rs. 1,234.50" (string maths only: no floats). */
export function pkr(value: string | null | undefined): string {
  if (value === null || value === undefined) return '-';
  const neg = value.startsWith('-');
  const [whole, frac = '00'] = (neg ? value.slice(1) : value).split('.');
  return `${neg ? '-' : ''}Rs. ${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${frac.padEnd(2, '0').slice(0, 2)}`;
}

export const day = (d: string | null | undefined) => (d ? new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '-');
export const when = (d: string | null | undefined) => (d ? new Date(d).toLocaleString() : '-');

export interface Plan {
  id: string; monthlyPricePerStaff: string; yearlyPricePerStaff: string; currency: string; graceDays: number; renewalNoticeDays: number;
  effectiveFrom: string; note: string | null; createdAt: string;
}
export interface Promotion { id: string; name: string; percentOff: number; appliesTo: Cycle | 'ANY'; startsOn: string; endsOn: string | null; isActive: boolean }
export interface PayMethod { id: string; method: MethodKind; accountTitle: string; accountNumber: string; bankName: string | null; instructions: string | null; isActive: boolean; sortOrder: number }

export interface Invoice {
  id: string; invoiceNo: string; kind: string; status: 'OPEN' | 'PAID' | 'VOID'; billingCycle: Cycle; staffCount: number; unitPrice: string; discountPercent: number;
  promotionName: string | null; proration: { remainingDays: number; totalDays: number } | null; subtotal: string; discountAmount: string; creditApplied: string; total: string;
  periodStart: string | null; periodEnd: string | null; issuedAt: string; paidAt: string | null; voidedAt: string | null; voidReason: string | null;
  paymentStatus: PaymentStatus | null; stale: boolean;
}

export interface AdminPayment {
  id: string; invoiceId: string; method: MethodKind; transactionId: string; amount: string; paidOn: string; senderName: string | null; note: string | null;
  status: PaymentStatus; submittedAt: string; reviewedAt: string | null; message: string | null; reviewReason: string | null; receivedAmount: string | null;
  receiptContentType: string; amountMatchesInvoice: boolean;
  salon: { id: string; name: string; city: string };
  invoice: { id: string; invoiceNo: string; kind: string; total: string; billingCycle: Cycle };
}
export interface PaymentList { items: AdminPayment[]; total: number; page: number; pageSize: number }
export interface PaymentDetail {
  payment: AdminPayment; invoice: Invoice | null; owner: { name: string; email: string } | null;
  history: Array<{ action: string; actorRole: string | null; at: string; reason: string | null }>;
}

export interface Overview {
  currency: string; subscriptions: Record<Phase, number>; pendingPayments: number; pendingAmount: string; monthlyRecurringRevenue: string;
  verifiedRevenueThisMonth: string; verifiedRevenueThisYear: string;
}
export interface SubscriptionRow {
  salonId: string; salonName: string; city: string; salonStatus: string; ownerName: string; ownerEmail: string; phase: Phase; billingCycle: Cycle | null;
  periodStart: string | null; periodEnd: string | null; coveredStaff: number | null; billableStaff: number; openInvoiceTotal: string | null; openInvoiceNo: string | null;
}
export interface SubscriptionList { items: SubscriptionRow[]; total: number; page: number; pageSize: number }

export interface SubscriptionView {
  phase: Phase; isOperational: boolean; status: string | null; billingCycle: Cycle | null; periodStart: string | null; periodEnd: string | null;
  paidThrough: string | null; accessThrough: string | null; daysLeft: number; coveredStaff: number; unitPrice: string | null; discountPercent: number; graceDays: number;
  suspendedReason: string | null;
}
export interface SalonSubscription {
  salon: { id: string; name: string; city: string; status: string };
  subscription: SubscriptionView; billableStaff: number; creditBalance: string; currentPlan: Plan | null;
  invoices: Invoice[];
  payments: Array<Omit<AdminPayment, 'salon' | 'invoice' | 'receiptContentType' | 'amountMatchesInvoice' | 'receivedAmount'>>;
  staffHistory: Array<{ billableStaff: number; coveredStaff: number | null; reason: string; createdAt: string }>;
  credits: Array<{ id: string; amount: string; reason: string; invoiceId: string | null; note: string | null; createdAt: string }>;
}
