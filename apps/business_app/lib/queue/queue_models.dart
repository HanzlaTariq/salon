String _s(Map<String, dynamic> j, String k, [String fallback = '']) => j[k] is String ? j[k] as String : fallback;
String? _sn(Map<String, dynamic> j, String k) => j[k] is String ? j[k] as String : null;
int _i(Map<String, dynamic> j, String k, [int fallback = 0]) => j[k] is num ? (j[k] as num).toInt() : fallback;
bool _b(Map<String, dynamic> j, String k) => j[k] == true;
Map<String, dynamic>? _m(Object? v) => v is Map<String, dynamic> ? v : null;
List<Map<String, dynamic>> _list(Object? v) => v is List ? v.whereType<Map<String, dynamic>>().toList() : <Map<String, dynamic>>[];

/// One appointment in the live queue. The booked time (`time`) is never replaced by the forecast (`estimateTime`): both are shown.
class QueueItem {
  const QueueItem({
    required this.id,
    required this.status,
    required this.time,
    required this.endTime,
    required this.durationMinutes,
    required this.totalPrice,
    required this.customerName,
    required this.customerPhone,
    required this.services,
    required this.walkIn,
    required this.position,
    required this.delayMinutes,
    required this.overrunMinutes,
    required this.estimateTime,
    required this.customerEtaState,
    required this.customerEtaTime,
    required this.canStart,
    required this.noShowAllowed,
    required this.noShowAllowedFrom,
    required this.graceMinutes,
    required this.offeredTime,
    required this.note,
  });

  final String id;
  final String status;
  /// Karachi clock (HH:MM) of the BOOKED start and end.
  final String time;
  final String endTime;
  final int durationMinutes;
  final String totalPrice;
  final String customerName;
  /// Only the owner receives a phone number; staff never do.
  final String? customerPhone;
  final List<String> services;
  final bool walkIn;
  /// 1 = next to be served; null for the appointment in service.
  final int? position;
  final int delayMinutes;
  final int overrunMinutes;
  /// The salon's forecast (HH:MM) when the day runs late, else null.
  final String? estimateTime;
  /// NONE / ON_THE_WAY / RUNNING_LATE and the customer's own ETA (HH:MM).
  final String customerEtaState;
  final String? customerEtaTime;
  final bool canStart;
  final bool noShowAllowed;
  final DateTime? noShowAllowedFrom;
  final int graceMinutes;
  /// The clock time of an early offer that is waiting for the customer's answer.
  final String? offeredTime;
  final String? note;

  bool get inProgress => status == 'IN_PROGRESS';
  bool get isDelayed => estimateTime != null;
  bool get hasEarlyOffer => offeredTime != null;
  bool get customerReported => customerEtaState != 'NONE';

  factory QueueItem.fromJson(Map<String, dynamic> j) {
    final customer = _m(j['customer']) ?? const <String, dynamic>{};
    final estimate = _m(j['estimate']);
    final eta = _m(j['customerEta']);
    final noShow = _m(j['noShow']) ?? const <String, dynamic>{};
    final offer = _m(j['earlyOffer']);
    return QueueItem(
      id: _s(j, 'id'),
      status: _s(j, 'status'),
      time: _s(j, 'time'),
      endTime: _s(j, 'endTime'),
      durationMinutes: _i(j, 'durationMinutes'),
      totalPrice: _s(j, 'totalPrice', '0'),
      customerName: _s(customer, 'name', 'Customer'),
      customerPhone: _sn(customer, 'phone'),
      services: _list(j['services']).map((e) => _s(e, 'name')).where((e) => e.isNotEmpty).toList(),
      walkIn: _b(j, 'walkIn'),
      position: j['position'] is num ? (j['position'] as num).toInt() : null,
      delayMinutes: _i(j, 'delayMinutes'),
      overrunMinutes: _i(j, 'overrunMinutes'),
      estimateTime: estimate == null ? null : _sn(estimate, 'time'),
      customerEtaState: eta == null ? 'NONE' : _s(eta, 'state', 'NONE'),
      customerEtaTime: eta == null ? null : _sn(eta, 'etaTime'),
      canStart: _b(j, 'canStart'),
      noShowAllowed: _b(noShow, 'allowed'),
      noShowAllowedFrom: DateTime.tryParse(_s(noShow, 'allowedFrom')),
      graceMinutes: _i(noShow, 'graceMinutes', 15),
      offeredTime: offer == null ? null : _sn(offer, 'offeredTime'),
      note: _sn(j, 'note'),
    );
  }
}

/// A waiting customer who could be asked to come earlier.
class EarlyCandidate {
  const EarlyCandidate({required this.appointmentId, required this.earliestTime, required this.savesMinutes});
  final String appointmentId;
  final String earliestTime;
  final int savesMinutes;

  factory EarlyCandidate.fromJson(Map<String, dynamic> j) =>
      EarlyCandidate(appointmentId: _s(j, 'appointmentId'), earliestTime: _s(j, 'earliestTime'), savesMinutes: _i(j, 'savesMinutes'));
}

/// The queue of ONE staff member.
class QueueLane {
  const QueueLane({
    required this.staffId,
    required this.staffName,
    required this.current,
    required this.waiting,
    required this.overdue,
    required this.freeAtTime,
    required this.candidate,
    required this.completedToday,
    required this.noShowsToday,
    required this.canAddWalkIn,
  });

  final String staffId;
  final String staffName;
  final QueueItem? current;
  final List<QueueItem> waiting;
  /// Open appointments from earlier days that were never closed.
  final List<QueueItem> overdue;
  final String freeAtTime;
  final EarlyCandidate? candidate;
  final int completedToday;
  final int noShowsToday;
  final bool canAddWalkIn;

  /// "Next customer" needs somebody who is waiting.
  QueueItem? get next => waiting.cast<QueueItem?>().firstWhere((w) => w != null && w.status == 'CONFIRMED', orElse: () => null);

  factory QueueLane.fromJson(Map<String, dynamic> j) {
    final staff = _m(j['staff']) ?? const <String, dynamic>{};
    final today = _m(j['today']) ?? const <String, dynamic>{};
    final current = _m(j['current']);
    final candidate = _m(j['earlyOfferCandidate']);
    return QueueLane(
      staffId: _s(staff, 'id'),
      staffName: _s(staff, 'name'),
      current: current == null ? null : QueueItem.fromJson(current),
      waiting: _list(j['waiting']).map(QueueItem.fromJson).toList(),
      overdue: _list(j['overdue']).map(QueueItem.fromJson).toList(),
      freeAtTime: _s(j, 'freeAtTime'),
      candidate: candidate == null ? null : EarlyCandidate.fromJson(candidate),
      completedToday: _i(today, 'completed'),
      noShowsToday: _i(today, 'noShows'),
      canAddWalkIn: _b(j, 'canAddWalkIn'),
    );
  }
}

class QueueSnapshot {
  const QueueSnapshot({required this.date, required this.lanes});
  final String date;
  final List<QueueLane> lanes;

  factory QueueSnapshot.fromJson(Map<String, dynamic> j) => QueueSnapshot(date: _s(j, 'date'), lanes: _list(j['lanes']).map(QueueLane.fromJson).toList());
}

/// "Ali is 10 minutes behind" etc. Short text for the lane header.
String laneStatusText(QueueLane l) {
  final c = l.current;
  if (c != null) {
    return c.overrunMinutes > 0 ? 'In service, running ${c.overrunMinutes} min over' : 'In service until ${c.endTime}';
  }
  return l.waiting.isEmpty ? 'Free now' : 'Free from ${l.freeAtTime}';
}

/// The question shown before "Next customer" when a service is still running. The server refuses to complete it silently.
String nextConfirmText(QueueLane l) {
  final c = l.current;
  final n = l.next;
  if (c == null || n == null) return '';
  return 'Complete ${c.customerName} and start ${n.customerName}?';
}

/// One line about the times of an appointment: the booked time, the forecast, and what the customer reported.
String timesText(QueueItem i) {
  final parts = <String>['Booked ${i.time}'];
  if (i.estimateTime != null) parts.add('now expected ${i.estimateTime} (+${i.delayMinutes} min)');
  if (i.customerReported && i.customerEtaTime != null) parts.add(i.customerEtaState == 'RUNNING_LATE' ? 'customer late, arriving ${i.customerEtaTime}' : 'customer on the way, arriving ${i.customerEtaTime}');
  if (i.offeredTime != null) parts.add('offer ${i.offeredTime} sent');
  return parts.join(' · ');
}

/// A service one staff member offers, with THEIR price (informational: the server derives the real price and duration).
class OfferedService {
  const OfferedService({required this.id, required this.name, required this.durationMinutes, required this.price});
  final String id;
  final String name;
  final int durationMinutes;
  final String price;

  factory OfferedService.fromJson(Map<String, dynamic> j) =>
      OfferedService(id: _s(j, 'id'), name: _s(j, 'name'), durationMinutes: _i(j, 'durationMinutes'), price: _s(j, 'price', '0'));
}

/// Total minutes and price of the chosen services, shown before the walk-in is added.
({int minutes, String price}) walkInTotals(List<OfferedService> chosen) {
  var minutes = 0;
  var paisa = 0;
  for (final s in chosen) {
    minutes += s.durationMinutes;
    final parts = s.price.split('.');
    paisa += (int.tryParse(parts.first) ?? 0) * 100 + (parts.length > 1 ? int.tryParse(parts[1].padRight(2, '0').substring(0, 2)) ?? 0 : 0);
  }
  return (minutes: minutes, price: '${paisa ~/ 100}.${(paisa % 100).toString().padLeft(2, '0')}');
}
