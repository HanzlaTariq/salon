import 'package:flutter_test/flutter_test.dart';
import 'package:salon_business/billing/billing_models.dart';

void main() {
  test('formatPkr formats decimal strings without floating point', () {
    expect(formatPkr('600.00'), 'Rs. 600.00');
    expect(formatPkr('1234567.5'), 'Rs. 1,234,567.50');
    expect(formatPkr('0.07'), 'Rs. 0.07');
    expect(formatPkr('-25.00'), '-Rs. 25.00');
    expect(formatPkr(null), '-');
  });

  test('formatDay renders an ISO date', () {
    expect(formatDay('2026-12-13'), '13 Dec 2026');
    expect(formatDay(null), '-');
  });

  test('BillingSummary parses an active subscription with an open top-up and a pending payment', () {
    final s = BillingSummary.fromJson({
      'eligible': true,
      'currency': 'PKR',
      'billableStaff': 3,
      'subscription': {
        'phase': 'ACTIVE', 'isOperational': true, 'status': 'ACTIVE', 'billingCycle': 'MONTHLY', 'periodStart': '2026-11-13', 'periodEnd': '2026-12-13',
        'paidThrough': '2026-12-12', 'accessThrough': '2026-12-15', 'daysLeft': 17, 'coveredStaff': 2, 'unitPrice': '300.00', 'discountPercent': 0, 'graceDays': 3,
        'suspendedReason': null,
      },
      'quotes': {
        'MONTHLY': {
          'cycle': 'MONTHLY', 'staff': 3, 'unitPrice': '300.00', 'discountPercent': 0, 'promotionName': null, 'subtotal': '900.00', 'discountAmount': '0.00',
          'creditApplied': '0.00', 'total': '900.00',
        },
      },
      'canCreateInvoice': {'allowed': false, 'reason': 'Renewal opens on 2026-12-06.', 'opensOn': '2026-12-06'},
      'creditBalance': '0.00',
      'recentCredits': [],
      'openInvoice': null,
      'openTopUp': {
        'id': 't1', 'invoiceNo': 'INV-2026-000002', 'kind': 'TOP_UP', 'status': 'OPEN', 'billingCycle': 'MONTHLY', 'staffCount': 1, 'unitPrice': '300.00',
        'discountPercent': 0, 'promotionName': null, 'proration': {'remainingDays': 17, 'totalDays': 30}, 'subtotal': '170.00', 'discountAmount': '0.00',
        'creditApplied': '0.00', 'total': '170.00', 'currency': 'PKR', 'periodStart': '2026-11-13', 'periodEnd': '2026-12-13', 'issuedAt': '2026-11-26T10:00:00.000Z',
        'paidAt': null, 'voidedAt': null, 'voidReason': null, 'paymentStatus': 'PENDING', 'stale': false,
      },
      'paymentMethods': [
        {'id': 'm1', 'method': 'JAZZCASH', 'accountTitle': 'Salon Platform', 'accountNumber': '03001234567', 'bankName': null, 'instructions': null, 'isActive': true, 'sortOrder': 0},
      ],
      'pricingConfigured': true,
    });
    expect(s.eligible, isTrue);
    expect(s.subscription.phase, 'ACTIVE');
    expect(s.subscription.daysLeft, 17);
    expect(s.quotes['MONTHLY']!.total, '900.00');
    expect(s.canCreate.allowed, isFalse);
    expect(s.openTopUp!.remainingDays, 17);
    expect(s.openTopUp!.paymentStatus, 'PENDING');
    expect(s.openTopUp!.kindLabel, 'Staff top-up');
    expect(s.paymentMethods.single.label, 'JazzCash');
    expect(s.hasCredit, isFalse);
  });

  test('BillingSummary tolerates the "not approved yet" response', () {
    final s = BillingSummary.fromJson({'eligible': false, 'message': 'Billing starts after your salon is approved.'});
    expect(s.eligible, isFalse);
    expect(s.message, contains('approved'));
    expect(s.quotes, isEmpty);
    expect(s.subscription.phase, 'NONE');
  });

  test('PaymentInfo only counts APPROVED as verified and carries the reviewer message', () {
    final p = PaymentInfo.fromJson({
      'id': 'p1', 'invoiceId': 'i1', 'method': 'EASYPAISA', 'transactionId': 'TX123456', 'amount': '600.00', 'paidOn': '2026-11-12',
      'status': 'NEEDS_INFO', 'submittedAt': '2026-11-12T10:00:00.000Z', 'message': 'The sender name does not match.',
    });
    expect(p.statusLabel, 'More information needed');
    expect(p.message, 'The sender name does not match.');
    expect(kPaymentLabels['APPROVED'], 'Verified');
  });
}
