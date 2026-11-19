import 'package:flutter_test/flutter_test.dart';
import 'package:salon_business/reports/reports_models.dart';

void main() {
  test('Karachi today is UTC+5 (a late-evening UTC instant is already tomorrow in Pakistan)', () {
    expect(karachiToday(DateTime.utc(2026, 11, 19, 18, 59)), '2026-11-19');
    expect(karachiToday(DateTime.utc(2026, 11, 19, 19, 0)), '2026-11-20');
    expect(karachiToday(DateTime.utc(2026, 12, 31, 20, 0)), '2027-01-01');
  });

  test('"last N days" is exactly N days and handles month, year and leap-day edges', () {
    expect(presetRange('2026-11-19', 30), (from: '2026-10-21', to: '2026-11-19'));
    expect(presetRange('2026-11-19', 7), (from: '2026-11-13', to: '2026-11-19'));
    expect(presetRange('2028-03-01', 2), (from: '2028-02-29', to: '2028-03-01'));
    expect(isoMinusDays('2027-01-01', 1), '2026-12-31');
  });

  test('amounts typed by a person: only valid money is accepted and it is normalised', () {
    expect(parseAmount('1500'), '1500.00');
    expect(parseAmount(' 1500.5 '), '1500.50');
    expect(parseAmount('0.01'), '0.01');
    for (final bad in ['', '0', '0.00', '-5', '1.234', '1e3', 'abc', '1,500', '100000000.01', '1234567890']) {
      expect(parseAmount(bad), isNull, reason: bad);
    }
  });

  test('display helpers', () {
    expect(pctText(57.1), '57.1%');
    expect(pctText(50.0), '50%');
    expect(pctText(null), '-');
    expect(shortDay('2026-11-19'), '19 Nov');
    expect(moneyHeight('1234.50'), 1234.5);
    expect(moneyHeight('-5'), 0);
    expect(moneyHeight('x'), 0);
  });

  test('summary parses the API payload and keeps money as text', () {
    final s = ReportSummary.fromJson({
      'range': {'from': '2026-10-31', 'to': '2026-11-19', 'days': 20},
      'appointments': {'total': 7, 'completed': 4, 'cancelled': 2, 'noShow': 1, 'open': 0, 'walkIn': 1, 'online': 6, 'cancelledByCustomer': 1, 'cancelledBySalon': 1},
      'rates': {'resolved': 7, 'completionRate': 57.1, 'cancellationRate': 28.6, 'noShowRate': 14.3},
      'revenue': {'total': '1400.00', 'online': '1250.00', 'walkIn': '150.00', 'averageTicket': '350.00', 'avgServiceMinutes': 30},
      'expenses': {'total': '620.50', 'count': 2},
      'net': '779.50',
      'previous': {'revenue': '300.00', 'net': '300.00', 'revenueChangePct': 366.7, 'completedChangePct': null},
    });
    expect(s.revenue, '1400.00');
    expect(s.net, '779.50');
    expect(s.appointments.walkIn, 1);
    expect(s.rates.completionRate, 57.1);
    expect(s.completedChangePct, isNull);
    expect(s.averageTicket, '350.00');
  });

  test('a staff report has no expenses and no colleagues', () {
    final d = MyPerformance.fromJson({
      'range': {'from': '2026-10-31', 'to': '2026-11-19', 'days': 20},
      'group': 'day',
      'staff': {'id': 'x', 'name': 'Ali'},
      'appointments': {'total': 5, 'completed': 3, 'cancelled': 2, 'noShow': 0, 'open': 0, 'walkIn': 1, 'online': 4},
      'rates': {'resolved': 5, 'completionRate': 60, 'cancellationRate': 40, 'noShowRate': 0},
      'revenue': {'total': '900.00', 'averageTicket': '300.00', 'avgServiceMinutes': null},
      'points': [
        {'bucket': '2026-11-19', 'total': 1, 'completed': 1, 'revenue': '300.00'},
      ],
      'topServices': [
        {'serviceId': 's', 'name': 'Haircut', 'times': 3, 'revenue': '900.00'},
      ],
    });
    expect(d.name, 'Ali');
    expect(d.points.single.expenses, isNull);
    expect(d.topServices.single.name, 'Haircut');
    expect(d.avgServiceMinutes, isNull);
  });

  test('expense pages know when there is more', () {
    final p = ExpensePage.fromJson({
      'items': [
        {'id': 'a', 'category': 'RENT', 'amount': '500.00', 'expenseDate': '2026-11-16', 'description': null},
      ],
      'total': 27,
      'sum': '270.00',
      'page': 1,
      'pageSize': 25,
    });
    expect(p.hasMore, isTrue);
    expect(p.items.single.label, 'Rent');
    expect(ExpensePage.fromJson({'items': [], 'total': 25, 'sum': '0.00', 'page': 1, 'pageSize': 25}).hasMore, isFalse);
  });

  test('every expense category the server knows has a label', () {
    expect(kExpenseCategories.keys, containsAll(['RENT', 'SALARIES', 'UTILITIES', 'SUPPLIES', 'MARKETING', 'EQUIPMENT', 'MAINTENANCE', 'TAXES_FEES', 'OTHER']));
  });
}
