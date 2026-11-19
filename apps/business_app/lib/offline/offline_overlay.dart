import 'offline_models.dart';

/// One row of the offline "Today" list: the last state the server told us, with the person's own waiting actions applied on top.
class LocalAppointment {
  const LocalAppointment({
    required this.id,
    required this.status,
    required this.staffId,
    required this.staffName,
    required this.customerName,
    required this.customerPhone,
    required this.time,
    required this.endTime,
    required this.startsAt,
    required this.durationMinutes,
    required this.price,
    required this.serviceNames,
    required this.walkIn,
    required this.provisional,
    required this.waitingActions,
    required this.notes,
    required this.startAllowedFrom,
    required this.noShowAllowedFrom,
    this.startedAt,
    this.completedAt,
  });

  final String id;
  final String status;
  final String staffId;
  final String staffName;
  final String customerName;
  final String? customerPhone;
  final String time;
  final String endTime;
  final DateTime? startsAt;
  final int durationMinutes;
  final String price;
  final List<String> serviceNames;
  final bool walkIn;
  /// A walk-in written down offline that the server has not placed yet: it has NO confirmed time (requirement 15: provisional).
  final bool provisional;
  /// Actions on this appointment that have not reached the server yet.
  final int waitingActions;
  final List<OfflineNote> notes;
  final DateTime? startAllowedFrom;
  final DateTime? noShowAllowedFrom;
  final DateTime? startedAt;
  final DateTime? completedAt;

  bool get inProgress => status == 'IN_PROGRESS';
  bool get open => status == 'CONFIRMED' || status == 'PENDING';
  bool get done => status == 'COMPLETED' || status == 'NO_SHOW' || status == 'CANCELLED';
}

class _Draft {
  _Draft(this.base);
  OfflineAppointment? base;
  String id = '';
  String status = '';
  String staffId = '';
  String staffName = '';
  String customerName = '';
  String? customerPhone;
  String time = '';
  String endTime = '';
  DateTime? startsAt;
  int durationMinutes = 0;
  String price = '0';
  List<String> serviceNames = const [];
  bool walkIn = false;
  bool provisional = false;
  int waiting = 0;
  List<OfflineNote> notes = [];
  DateTime? startAllowedFrom;
  DateTime? noShowAllowedFrom;
  DateTime? startedAt;
  DateTime? completedAt;

  bool get open => status == 'CONFIRMED' || status == 'PENDING';
  bool get inProgressLike => status == 'IN_PROGRESS';

  LocalAppointment freeze() => LocalAppointment(
        id: id, status: status, staffId: staffId, staffName: staffName, customerName: customerName, customerPhone: customerPhone, time: time, endTime: endTime,
        startsAt: startsAt, durationMinutes: durationMinutes, price: price, serviceNames: serviceNames, walkIn: walkIn, provisional: provisional,
        waitingActions: waiting, notes: List.unmodifiable(notes), startAllowedFrom: startAllowedFrom, noShowAllowedFrom: noShowAllowedFrom,
        startedAt: startedAt, completedAt: completedAt,
      );
}

/// Applies the operations that are still waiting (and the ones the server applied but the next pull has not delivered yet) on top of
/// the cached server state. Pure function: the same input always gives the same list. Rejected and failed operations are NOT applied:
/// the server said no, so the screen shows the server's truth and lists the refusal separately.
///
/// Only the LOCAL display changes. The server stays the authority and re-checks every rule when the operation arrives.
List<LocalAppointment> overlayLocal({
  required List<OfflineAppointment> cached,
  required List<OfflineNote> notes,
  required List<PendingOp> ops,
}) {
  final byId = <String, _Draft>{};
  for (final a in cached) {
    final d = _Draft(a)
      ..id = a.id
      ..status = a.status
      ..staffId = a.staffId
      ..staffName = a.staffName
      ..customerName = a.customerName
      ..customerPhone = a.customerPhone
      ..time = a.time
      ..endTime = a.endTime
      ..startsAt = a.startsAt
      ..durationMinutes = a.durationMinutes
      ..price = a.totalPrice
      ..serviceNames = a.serviceNames
      ..walkIn = a.walkIn
      ..startAllowedFrom = a.startAllowedFrom
      ..noShowAllowedFrom = a.noShowAllowedFrom
      ..startedAt = a.startedAt
      ..completedAt = a.completedAt;
    byId[a.id] = d;
  }
  for (final n in notes) {
    byId[n.appointmentId]?.notes.add(n);
  }

  // A walk-in written offline is addressed by its operation id until the server gives it a real id.
  final walkInIds = <String, String>{}; // operation id -> key in byId
  final active = ops.where((o) => o.state == OpState.pending || o.state == OpState.applied).toList()..sort((a, b) => a.seq.compareTo(b.seq));

  for (final op in active) {
    final waiting = op.state == OpState.pending;
    if (op.kind == SyncKind.walkIn) {
      final real = op.serverAppointmentId;
      if (real != null && byId.containsKey(real)) {
        walkInIds[op.id] = real; // the pull already delivered it: nothing provisional left
        continue;
      }
      final key = real ?? op.id;
      final staffId = (op.local['staffId'] as String?) ?? '';
      final d = _Draft(null)
        ..id = key
        ..status = 'CONFIRMED'
        ..staffId = staffId
        ..staffName = (op.local['staffName'] as String?) ?? ''
        ..customerName = (op.payload['customerName'] as String?) ?? ''
        ..customerPhone = op.payload['phone'] as String?
        ..time = ''
        ..startsAt = null
        ..durationMinutes = (op.local['minutes'] as num?)?.toInt() ?? 0
        ..price = (op.local['price'] as String?) ?? '0'
        ..serviceNames = ((op.local['serviceNames'] as List?) ?? const []).whereType<String>().toList()
        ..walkIn = true
        ..provisional = true
        ..waiting = waiting ? 1 : 0;
      byId[key] = d;
      walkInIds[op.id] = key;
      continue;
    }

    final targetKey = op.appointmentId ?? walkInIds[op.refOperationId];
    final d = targetKey == null ? null : byId[targetKey];
    if (d == null) continue; // the appointment left the window: nothing to show
    if (waiting) d.waiting += 1;
    switch (op.kind) {
      case SyncKind.start:
        if (d.open) {
          d.status = 'IN_PROGRESS';
          d.startedAt = op.createdAt;
        }
      case SyncKind.complete:
        if (d.inProgressLike) {
          d.status = 'COMPLETED';
          d.completedAt = op.createdAt;
        }
      case SyncKind.noShow:
        if (d.status == 'CONFIRMED') d.status = 'NO_SHOW';
      case SyncKind.note:
        d.notes.add(OfflineNote(
          id: 'local-${op.id}', appointmentId: d.id, author: 'You', mine: true, body: (op.payload['body'] as String?) ?? '', createdAt: op.createdAt));
    }
  }

  final list = byId.values.map((d) => d.freeze()).toList()
    ..sort((a, b) {
      // provisional walk-ins have no time yet: they go last, in the order they were written
      if (a.startsAt == null && b.startsAt == null) return 0;
      if (a.startsAt == null) return 1;
      if (b.startsAt == null) return -1;
      return a.startsAt!.compareTo(b.startsAt!);
    });
  return list;
}

/// What the buttons may offer right now. These are the SAME rules the server applies (server clock decides in the end), so the
/// screen does not offer actions that are certain to be refused. A refusal that still happens is shown in "Needs attention".
class LocalRules {
  const LocalRules(this.all);
  final List<LocalAppointment> all;

  /// One service at a time per staff member (the server enforces this with a unique index).
  bool staffBusy(LocalAppointment a) => all.any((x) => x.id != a.id && x.staffId == a.staffId && x.inProgress);

  bool canStart(LocalAppointment a, DateTime now) {
    if (!a.open || staffBusy(a)) return false;
    final from = a.startAllowedFrom;
    return a.provisional || from == null || !now.isBefore(from);
  }

  bool canComplete(LocalAppointment a) => a.inProgress;

  /// Never for a provisional walk-in (it has no booked time to be late for) and never before the grace period is over.
  bool canNoShow(LocalAppointment a, DateTime now) {
    if (a.status != 'CONFIRMED' || a.provisional || a.walkIn) return false;
    final from = a.noShowAllowedFrom;
    return from != null && !now.isBefore(from);
  }
}
