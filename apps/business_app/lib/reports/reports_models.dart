// Phase 13 models. Mirror the API views in apps/api/src/modules/reports (salon-reports.service.ts, expenses.service.ts).
//
// Money is ALWAYS a decimal String such as "600.00" (never a double): it is displayed, never used for arithmetic. The server
// computes every figure; the app only shows them. The one exception is chart bar HEIGHTS, which use [moneyHeight] (display only).

/// Today's calendar date in Pakistan (UTC+5, no daylight saving), as YYYY-MM-DD. Reports always use Karachi days.
String karachiToday([DateTime? now]) {
  final k = (now ?? DateTime.now()).toUtc().add(const Duration(hours: 5));
  return _iso(k);
}

String _iso(DateTime d) => '${d.year.toString().padLeft(4, '0')}-${d.month.toString().padLeft(2, '0')}-${d.day.toString().padLeft(2, '0')}';

/// `YYYY-MM-DD` minus [days] (calendar arithmetic, no time zones involved).
String isoMinusDays(String iso, int days) {
  final p = iso.split('-').map(int.parse).toList();
  return _iso(DateTime.utc(p[0], p[1], p[2]).subtract(Duration(days: days)));
}

class ReportPreset {
  const ReportPreset(this.label, this.days);
  final String label;
  final int days;
}

const kReportPresets = <ReportPreset>[ReportPreset('7 days', 7), ReportPreset('30 days', 30), ReportPreset('90 days', 90)];

/// "Last N days" ends today and starts N-1 days ago, so it is exactly N days.
({String from, String to}) presetRange(String today, int days) => (from: isoMinusDays(today, days - 1), to: today);

/// A non-negative chart height from money text. Display only.
double moneyHeight(String v) => double.tryParse(v)?.clamp(0, double.maxFinite).toDouble() ?? 0;

/// 57.1 -> "57.1%", null -> "-".
String pctText(num? v) => v == null ? '-' : '${v % 1 == 0 ? v.toInt() : v}%';

/// "2026-11-19" -> "19 Nov"; "2026-11" -> "Nov 26" (trend labels).
String shortDay(String iso) {
  const m = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  if (iso.length < 10) return iso;
  final mo = int.tryParse(iso.substring(5, 7));
  final d = int.tryParse(iso.substring(8, 10));
  if (mo == null || d == null || mo < 1 || mo > 12) return iso;
  return '$d ${m[mo - 1]}';
}

const kExpenseCategories = <String, String>{
  'RENT': 'Rent',
  'SALARIES': 'Salaries',
  'UTILITIES': 'Utilities',
  'SUPPLIES': 'Supplies',
  'MARKETING': 'Marketing',
  'EQUIPMENT': 'Equipment',
  'MAINTENANCE': 'Maintenance',
  'TAXES_FEES': 'Taxes and fees',
  'OTHER': 'Other',
};

/// A valid amount typed by a person: digits with at most 2 decimals, at least 0.01. Returns the normalised text or null.
String? parseAmount(String input) {
  final t = input.trim();
  if (!RegExp(r'^\d{1,9}(\.\d{1,2})?$').hasMatch(t)) return null;
  final parts = t.split('.');
  final paisa = int.parse(parts[0]) * 100 + int.parse((parts.length > 1 ? parts[1] : '').padRight(2, '0'));
  if (paisa < 1 || paisa > 100000000 * 100) return null;
  return '${paisa ~/ 100}.${(paisa % 100).toString().padLeft(2, '0')}';
}

int _i(dynamic v) => (v as num?)?.toInt() ?? 0;
num? _n(dynamic v) => v as num?;

class Rates {
  const Rates({required this.resolved, this.completionRate, this.cancellationRate, this.noShowRate});
  final int resolved;
  final num? completionRate;
  final num? cancellationRate;
  final num? noShowRate;
  factory Rates.fromJson(Map<String, dynamic> j) => Rates(
        resolved: _i(j['resolved']),
        completionRate: _n(j['completionRate']),
        cancellationRate: _n(j['cancellationRate']),
        noShowRate: _n(j['noShowRate']),
      );
}

class ReportRange {
  const ReportRange({required this.from, required this.to, required this.days});
  final String from;
  final String to;
  final int days;
  factory ReportRange.fromJson(Map<String, dynamic> j) => ReportRange(from: j['from'] as String, to: j['to'] as String, days: _i(j['days']));
}

class AppointmentCounts {
  const AppointmentCounts({required this.total, required this.completed, required this.cancelled, required this.noShow, required this.open, required this.walkIn, required this.online});
  final int total, completed, cancelled, noShow, open, walkIn, online;
  factory AppointmentCounts.fromJson(Map<String, dynamic> j) => AppointmentCounts(
        total: _i(j['total']),
        completed: _i(j['completed']),
        cancelled: _i(j['cancelled']),
        noShow: _i(j['noShow']),
        open: _i(j['open']),
        walkIn: _i(j['walkIn']),
        online: _i(j['online']),
      );
}

class ReportSummary {
  const ReportSummary({
    required this.range, required this.appointments, required this.rates, required this.revenue, required this.online, required this.walkIn,
    this.averageTicket, this.avgServiceMinutes, required this.expenses, required this.expenseCount, required this.net, required this.previousRevenue,
    required this.previousNet, this.revenueChangePct, this.completedChangePct,
  });
  final ReportRange range;
  final AppointmentCounts appointments;
  final Rates rates;
  final String revenue, online, walkIn, expenses, net, previousRevenue, previousNet;
  final String? averageTicket;
  final num? avgServiceMinutes;
  final int expenseCount;
  final num? revenueChangePct, completedChangePct;

  factory ReportSummary.fromJson(Map<String, dynamic> j) {
    final rev = j['revenue'] as Map<String, dynamic>;
    final exp = j['expenses'] as Map<String, dynamic>;
    final prev = j['previous'] as Map<String, dynamic>;
    return ReportSummary(
      range: ReportRange.fromJson(j['range'] as Map<String, dynamic>),
      appointments: AppointmentCounts.fromJson(j['appointments'] as Map<String, dynamic>),
      rates: Rates.fromJson(j['rates'] as Map<String, dynamic>),
      revenue: rev['total'] as String,
      online: rev['online'] as String,
      walkIn: rev['walkIn'] as String,
      averageTicket: rev['averageTicket'] as String?,
      avgServiceMinutes: _n(rev['avgServiceMinutes']),
      expenses: exp['total'] as String,
      expenseCount: _i(exp['count']),
      net: j['net'] as String,
      previousRevenue: prev['revenue'] as String,
      previousNet: prev['net'] as String,
      revenueChangePct: _n(prev['revenueChangePct']),
      completedChangePct: _n(prev['completedChangePct']),
    );
  }
}

class TrendPoint {
  const TrendPoint({required this.bucket, required this.total, required this.completed, required this.revenue, this.expenses});
  final String bucket;
  final int total, completed;
  final String revenue;
  /// null for a staff member (they never see expenses).
  final String? expenses;
  factory TrendPoint.fromJson(Map<String, dynamic> j) => TrendPoint(
        bucket: j['bucket'] as String,
        total: _i(j['total']),
        completed: _i(j['completed']),
        revenue: j['revenue'] as String,
        expenses: j['expenses'] as String?,
      );
}

class TrendData {
  const TrendData({required this.group, required this.points});
  final String group;
  final List<TrendPoint> points;
  factory TrendData.fromJson(Map<String, dynamic> j) =>
      TrendData(group: j['group'] as String, points: (j['points'] as List<dynamic>).map((e) => TrendPoint.fromJson(e as Map<String, dynamic>)).toList());
}

class StaffStat {
  const StaffStat({required this.staffId, required this.name, required this.isOwner, required this.isActive, required this.total, required this.completed, required this.cancelled, required this.noShow, required this.walkIn, required this.revenue, this.averageTicket, this.revenueSharePct, this.avgServiceMinutes});
  final String staffId, name, revenue;
  final bool isOwner, isActive;
  final int total, completed, cancelled, noShow, walkIn;
  final String? averageTicket;
  final num? revenueSharePct, avgServiceMinutes;
  factory StaffStat.fromJson(Map<String, dynamic> j) => StaffStat(
        staffId: j['staffId'] as String,
        name: j['name'] as String,
        isOwner: j['isOwner'] == true,
        isActive: j['isActive'] == true,
        total: _i(j['total']),
        completed: _i(j['completed']),
        cancelled: _i(j['cancelled']),
        noShow: _i(j['noShow']),
        walkIn: _i(j['walkIn']),
        revenue: j['revenue'] as String,
        averageTicket: j['averageTicket'] as String?,
        revenueSharePct: _n(j['revenueSharePct']),
        avgServiceMinutes: _n(j['avgServiceMinutes']),
      );
}

class ServiceStat {
  const ServiceStat({required this.serviceId, required this.name, required this.times, required this.revenue});
  final String serviceId, name, revenue;
  final int times;
  factory ServiceStat.fromJson(Map<String, dynamic> j) =>
      ServiceStat(serviceId: j['serviceId'] as String, name: j['name'] as String, times: _i(j['times']), revenue: j['revenue'] as String);
}

class RetentionData {
  const RetentionData({required this.served, required this.newCustomers, required this.returning, this.returningRatePct, required this.visits, this.avgPerCustomer, required this.walkIns});
  final int served, newCustomers, returning, visits, walkIns;
  final num? returningRatePct, avgPerCustomer;
  factory RetentionData.fromJson(Map<String, dynamic> j) {
    final c = j['customers'] as Map<String, dynamic>;
    final v = j['visits'] as Map<String, dynamic>;
    return RetentionData(
      served: _i(c['served']),
      newCustomers: _i(c['new']),
      returning: _i(c['returning']),
      returningRatePct: _n(c['returningRatePct']),
      visits: _i(v['byCustomers']),
      avgPerCustomer: _n(v['avgPerCustomer']),
      walkIns: _i(v['walkIns']),
    );
  }
}

class ExpenseCategoryTotal {
  const ExpenseCategoryTotal({required this.category, required this.total, required this.count, this.sharePct});
  final String category, total;
  final int count;
  final num? sharePct;
  String get label => kExpenseCategories[category] ?? category;
  factory ExpenseCategoryTotal.fromJson(Map<String, dynamic> j) =>
      ExpenseCategoryTotal(category: j['category'] as String, total: j['total'] as String, count: _i(j['count']), sharePct: _n(j['sharePct']));
}

class ExpenseSummary {
  const ExpenseSummary({required this.total, required this.count, required this.byCategory});
  final String total;
  final int count;
  final List<ExpenseCategoryTotal> byCategory;
  factory ExpenseSummary.fromJson(Map<String, dynamic> j) => ExpenseSummary(
        total: j['total'] as String,
        count: _i(j['count']),
        byCategory: (j['byCategory'] as List<dynamic>).map((e) => ExpenseCategoryTotal.fromJson(e as Map<String, dynamic>)).toList(),
      );
}

class ExpenseItem {
  const ExpenseItem({required this.id, required this.category, required this.amount, required this.expenseDate, this.description});
  final String id, category, amount, expenseDate;
  final String? description;
  String get label => kExpenseCategories[category] ?? category;
  factory ExpenseItem.fromJson(Map<String, dynamic> j) => ExpenseItem(
        id: j['id'] as String,
        category: j['category'] as String,
        amount: j['amount'] as String,
        expenseDate: j['expenseDate'] as String,
        description: j['description'] as String?,
      );
}

class ExpensePage {
  const ExpensePage({required this.items, required this.total, required this.sum, required this.page, required this.pageSize});
  final List<ExpenseItem> items;
  final int total, page, pageSize;
  final String sum;
  bool get hasMore => page * pageSize < total;
  factory ExpensePage.fromJson(Map<String, dynamic> j) => ExpensePage(
        items: (j['items'] as List<dynamic>).map((e) => ExpenseItem.fromJson(e as Map<String, dynamic>)).toList(),
        total: _i(j['total']),
        sum: j['sum'] as String,
        page: _i(j['page']),
        pageSize: _i(j['pageSize']),
      );
}

/// A staff member's own performance (no expenses, no colleagues).
class MyPerformance {
  const MyPerformance({required this.range, required this.name, required this.appointments, required this.rates, required this.revenue, this.averageTicket, this.avgServiceMinutes, required this.group, required this.points, required this.topServices});
  final ReportRange range;
  final String name, revenue, group;
  final AppointmentCounts appointments;
  final Rates rates;
  final String? averageTicket;
  final num? avgServiceMinutes;
  final List<TrendPoint> points;
  final List<ServiceStat> topServices;
  factory MyPerformance.fromJson(Map<String, dynamic> j) {
    final rev = j['revenue'] as Map<String, dynamic>;
    return MyPerformance(
      range: ReportRange.fromJson(j['range'] as Map<String, dynamic>),
      name: (j['staff'] as Map<String, dynamic>)['name'] as String,
      appointments: AppointmentCounts.fromJson(j['appointments'] as Map<String, dynamic>),
      rates: Rates.fromJson(j['rates'] as Map<String, dynamic>),
      revenue: rev['total'] as String,
      averageTicket: rev['averageTicket'] as String?,
      avgServiceMinutes: _n(rev['avgServiceMinutes']),
      group: j['group'] as String,
      points: (j['points'] as List<dynamic>).map((e) => TrendPoint.fromJson(e as Map<String, dynamic>)).toList(),
      topServices: (j['topServices'] as List<dynamic>).map((e) => ServiceStat.fromJson(e as Map<String, dynamic>)).toList(),
    );
  }
}
