// Phase 6 models. Mirror the API views in apps/api/src/modules/billing (billing.views.ts, owner-billing.service.ts).
//
// Money is ALWAYS a decimal String such as "600.00" (never a double): it is displayed, never used for arithmetic.
// The server computes every amount; the app only shows it.

/// "1234.5" -> "Rs. 1,234.50". String based, so no floating point is involved.
String formatPkr(String? value) {
  if (value == null) return '-';
  final negative = value.startsWith('-');
  final parts = (negative ? value.substring(1) : value).split('.');
  final whole = parts[0].replaceAllMapped(RegExp(r'\B(?=(\d{3})+(?!\d))'), (_) => ',');
  final frac = (parts.length > 1 ? parts[1] : '00').padRight(2, '0').substring(0, 2);
  return '${negative ? '-' : ''}Rs. $whole.$frac';
}

const kMethodLabels = <String, String>{'JAZZCASH': 'JazzCash', 'EASYPAISA': 'Easypaisa', 'BANK_TRANSFER': 'Bank transfer'};
const kKindLabels = <String, String>{'INITIAL': 'First subscription', 'RENEWAL': 'Renewal', 'TOP_UP': 'Staff top-up', 'COMPLIMENTARY': 'Complimentary'};
const kPaymentLabels = <String, String>{
  'PENDING': 'Waiting for verification',
  'NEEDS_INFO': 'More information needed',
  'APPROVED': 'Verified',
  'REJECTED': 'Rejected',
};

/// "2026-12-13" -> "13 Dec 2026".
String formatDay(String? iso) {
  if (iso == null || iso.length < 10) return '-';
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  final m = int.tryParse(iso.substring(5, 7));
  final d = int.tryParse(iso.substring(8, 10));
  if (m == null || d == null || m < 1 || m > 12) return iso;
  return '$d ${months[m - 1]} ${iso.substring(0, 4)}';
}

class PaymentMethodInfo {
  const PaymentMethodInfo({required this.id, required this.method, required this.accountTitle, required this.accountNumber, this.bankName, this.instructions});

  final String id;
  final String method;
  final String accountTitle;
  final String accountNumber;
  final String? bankName;
  final String? instructions;

  String get label => kMethodLabels[method] ?? method;

  factory PaymentMethodInfo.fromJson(Map<String, dynamic> j) => PaymentMethodInfo(
        id: j['id'] as String,
        method: j['method'] as String,
        accountTitle: j['accountTitle'] as String,
        accountNumber: j['accountNumber'] as String,
        bankName: j['bankName'] as String?,
        instructions: j['instructions'] as String?,
      );
}

class SubscriptionInfo {
  const SubscriptionInfo({
    required this.phase,
    required this.isOperational,
    this.billingCycle,
    this.periodStart,
    this.periodEnd,
    this.paidThrough,
    this.accessThrough,
    required this.daysLeft,
    required this.coveredStaff,
    required this.graceDays,
    this.suspendedReason,
  });

  /// NONE | ACTIVE | GRACE | EXPIRED | SUSPENDED
  final String phase;
  final bool isOperational;
  final String? billingCycle;
  final String? periodStart;
  final String? periodEnd;
  final String? paidThrough;
  final String? accessThrough;
  final int daysLeft;
  final int coveredStaff;
  final int graceDays;
  final String? suspendedReason;

  factory SubscriptionInfo.fromJson(Map<String, dynamic> j) => SubscriptionInfo(
        phase: j['phase'] as String? ?? 'NONE',
        isOperational: j['isOperational'] as bool? ?? false,
        billingCycle: j['billingCycle'] as String?,
        periodStart: j['periodStart'] as String?,
        periodEnd: j['periodEnd'] as String?,
        paidThrough: j['paidThrough'] as String?,
        accessThrough: j['accessThrough'] as String?,
        daysLeft: (j['daysLeft'] as num?)?.toInt() ?? 0,
        coveredStaff: (j['coveredStaff'] as num?)?.toInt() ?? 0,
        graceDays: (j['graceDays'] as num?)?.toInt() ?? 0,
        suspendedReason: j['suspendedReason'] as String?,
      );
}

class Quote {
  const Quote({
    required this.cycle,
    required this.staff,
    required this.unitPrice,
    required this.discountPercent,
    this.promotionName,
    required this.subtotal,
    required this.discountAmount,
    required this.creditApplied,
    required this.total,
  });

  final String cycle;
  final int staff;
  final String unitPrice;
  final num discountPercent;
  final String? promotionName;
  final String subtotal;
  final String discountAmount;
  final String creditApplied;
  final String total;

  factory Quote.fromJson(Map<String, dynamic> j) => Quote(
        cycle: j['cycle'] as String,
        staff: (j['staff'] as num).toInt(),
        unitPrice: j['unitPrice'] as String,
        discountPercent: j['discountPercent'] as num? ?? 0,
        promotionName: j['promotionName'] as String?,
        subtotal: j['subtotal'] as String,
        discountAmount: j['discountAmount'] as String,
        creditApplied: j['creditApplied'] as String,
        total: j['total'] as String,
      );
}

class InvoiceInfo {
  const InvoiceInfo({
    required this.id,
    required this.invoiceNo,
    required this.kind,
    required this.status,
    required this.billingCycle,
    required this.staffCount,
    required this.unitPrice,
    required this.discountPercent,
    this.promotionName,
    this.remainingDays,
    this.totalDays,
    required this.subtotal,
    required this.discountAmount,
    required this.creditApplied,
    required this.total,
    this.periodStart,
    this.periodEnd,
    required this.issuedAt,
    this.paymentStatus,
    required this.stale,
  });

  final String id;
  final String invoiceNo;

  /// INITIAL | RENEWAL | TOP_UP | COMPLIMENTARY
  final String kind;

  /// OPEN | PAID | VOID
  final String status;
  final String billingCycle;
  final int staffCount;
  final String unitPrice;
  final num discountPercent;
  final String? promotionName;
  final int? remainingDays;
  final int? totalDays;
  final String subtotal;
  final String discountAmount;
  final String creditApplied;
  final String total;
  final String? periodStart;
  final String? periodEnd;
  final String issuedAt;

  /// Status of the payment attached to the invoice; null = nothing submitted yet.
  final String? paymentStatus;

  /// Priced for another team size than today: cancel and create again to refresh.
  final bool stale;

  bool get isOpen => status == 'OPEN';
  String get kindLabel => kKindLabels[kind] ?? kind;

  factory InvoiceInfo.fromJson(Map<String, dynamic> j) {
    final p = j['proration'] as Map<String, dynamic>?;
    return InvoiceInfo(
      id: j['id'] as String,
      invoiceNo: j['invoiceNo'] as String,
      kind: j['kind'] as String,
      status: j['status'] as String,
      billingCycle: j['billingCycle'] as String,
      staffCount: (j['staffCount'] as num).toInt(),
      unitPrice: j['unitPrice'] as String,
      discountPercent: j['discountPercent'] as num? ?? 0,
      promotionName: j['promotionName'] as String?,
      remainingDays: (p?['remainingDays'] as num?)?.toInt(),
      totalDays: (p?['totalDays'] as num?)?.toInt(),
      subtotal: j['subtotal'] as String,
      discountAmount: j['discountAmount'] as String,
      creditApplied: j['creditApplied'] as String,
      total: j['total'] as String,
      periodStart: j['periodStart'] as String?,
      periodEnd: j['periodEnd'] as String?,
      issuedAt: j['issuedAt'] as String,
      paymentStatus: j['paymentStatus'] as String?,
      stale: j['stale'] as bool? ?? false,
    );
  }
}

class PaymentInfo {
  const PaymentInfo({
    required this.id,
    required this.invoiceId,
    required this.method,
    required this.transactionId,
    required this.amount,
    required this.paidOn,
    required this.status,
    required this.submittedAt,
    this.message,
  });

  final String id;
  final String invoiceId;
  final String method;
  final String transactionId;
  final String amount;
  final String paidOn;

  /// PENDING | NEEDS_INFO | APPROVED | REJECTED. Only APPROVED means money was verified.
  final String status;
  final String submittedAt;

  /// The reviewer's question (NEEDS_INFO) or the reason for a rejection.
  final String? message;

  String get statusLabel => kPaymentLabels[status] ?? status;

  factory PaymentInfo.fromJson(Map<String, dynamic> j) => PaymentInfo(
        id: j['id'] as String,
        invoiceId: j['invoiceId'] as String,
        method: j['method'] as String,
        transactionId: j['transactionId'] as String,
        amount: j['amount'] as String,
        paidOn: j['paidOn'] as String,
        status: j['status'] as String,
        submittedAt: j['submittedAt'] as String,
        message: j['message'] as String?,
      );
}

class CanCreateInvoice {
  const CanCreateInvoice({required this.allowed, this.reason, this.opensOn});

  final bool allowed;
  final String? reason;
  final String? opensOn;

  factory CanCreateInvoice.fromJson(Map<String, dynamic> j) =>
      CanCreateInvoice(allowed: j['allowed'] as bool? ?? false, reason: j['reason'] as String?, opensOn: j['opensOn'] as String?);
}

class BillingSummary {
  const BillingSummary({
    required this.eligible,
    this.message,
    required this.billableStaff,
    required this.subscription,
    required this.quotes,
    required this.canCreate,
    required this.creditBalance,
    this.openInvoice,
    this.openTopUp,
    required this.paymentMethods,
    required this.pricingConfigured,
  });

  /// false until the salon is approved (then only [message] is meaningful).
  final bool eligible;
  final String? message;
  final int billableStaff;
  final SubscriptionInfo subscription;
  final Map<String, Quote> quotes;
  final CanCreateInvoice canCreate;
  final String creditBalance;
  final InvoiceInfo? openInvoice;
  final InvoiceInfo? openTopUp;
  final List<PaymentMethodInfo> paymentMethods;
  final bool pricingConfigured;

  bool get hasCredit => creditBalance != '0.00' && creditBalance != '0';

  factory BillingSummary.fromJson(Map<String, dynamic> j) {
    final q = j['quotes'];
    return BillingSummary(
      eligible: j['eligible'] as bool? ?? false,
      message: j['message'] as String?,
      billableStaff: (j['billableStaff'] as num?)?.toInt() ?? 0,
      subscription: SubscriptionInfo.fromJson((j['subscription'] as Map<String, dynamic>?) ?? const {}),
      quotes: q is Map<String, dynamic> ? q.map((k, v) => MapEntry(k, Quote.fromJson(v as Map<String, dynamic>))) : const {},
      canCreate: CanCreateInvoice.fromJson((j['canCreateInvoice'] as Map<String, dynamic>?) ?? const {}),
      creditBalance: j['creditBalance'] as String? ?? '0.00',
      openInvoice: j['openInvoice'] == null ? null : InvoiceInfo.fromJson(j['openInvoice'] as Map<String, dynamic>),
      openTopUp: j['openTopUp'] == null ? null : InvoiceInfo.fromJson(j['openTopUp'] as Map<String, dynamic>),
      paymentMethods: ((j['paymentMethods'] as List<dynamic>?) ?? const []).map((e) => PaymentMethodInfo.fromJson(e as Map<String, dynamic>)).toList(),
      pricingConfigured: j['pricingConfigured'] as bool? ?? false,
    );
  }
}
