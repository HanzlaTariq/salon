import 'dart:convert';
import 'dart:math';

/// Operation kinds, exactly as the server (Phase 12 `sync.types.ts`) names them.
abstract final class SyncKind {
  static const start = 'APPT_START';
  static const complete = 'APPT_COMPLETE';
  static const noShow = 'APPT_NO_SHOW';
  static const walkIn = 'WALK_IN_CREATE';
  static const note = 'NOTE_ADD';
}

/// A random UUID v4 (the server accepts only real UUIDs as operation and device ids).
String newUuid([Random? random]) {
  final r = random ?? Random.secure();
  final b = List<int>.generate(16, (_) => r.nextInt(256));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  String h(int from, int to) => b.sublist(from, to).map((x) => x.toRadixString(16).padLeft(2, '0')).join();
  return '${h(0, 4)}-${h(4, 6)}-${h(6, 8)}-${h(8, 10)}-${h(10, 16)}';
}

/// pending: waiting to be sent (or to be retried).
/// applied: the server did it; kept only until the next pull has delivered the new state, so the screen never flickers back.
/// rejected: the server refused it FINALLY (a rule: the customer cancelled online, the grace period was not over...). Needs a person.
/// failed: technical failures kept repeating; needs a person (retry or discard).
enum OpState { pending, applied, rejected, failed }

class PendingOp {
  const PendingOp({
    required this.id,
    required this.kind,
    required this.createdAt,
    this.appointmentId,
    this.refOperationId,
    this.payload = const {},
    this.local = const {},
    this.state = OpState.pending,
    this.attempts = 0,
    this.code,
    this.message,
    this.serverAppointmentId,
    this.seq = 0,
  });

  final String id;
  final String kind;
  /// The device clock when the person acted. The server bounds it (never in the future, never older than 48 h).
  final DateTime createdAt;
  final String? appointmentId;
  final String? refOperationId;
  /// Sent to the server. Never contains prices, durations, the salon id or the staff id of a staff account.
  final Map<String, dynamic> payload;
  /// Stays on the device: text to show while the operation waits (names, the price that was displayed).
  final Map<String, dynamic> local;
  final OpState state;
  final int attempts;
  final String? code;
  final String? message;
  final String? serverAppointmentId;
  final int seq;

  PendingOp copyWith({OpState? state, int? attempts, String? code, String? message, String? serverAppointmentId, int? seq}) => PendingOp(
        id: id, kind: kind, createdAt: createdAt, appointmentId: appointmentId, refOperationId: refOperationId, payload: payload, local: local,
        state: state ?? this.state, attempts: attempts ?? this.attempts, code: code ?? this.code, message: message ?? this.message,
        serverAppointmentId: serverAppointmentId ?? this.serverAppointmentId, seq: seq ?? this.seq,
      );

  /// The request body of one operation (the `local` part never leaves the phone).
  Map<String, dynamic> toApi() => {
        'operationId': id,
        'kind': kind,
        'createdAt': createdAt.toUtc().toIso8601String(),
        if (appointmentId != null) 'appointmentId': appointmentId,
        if (refOperationId != null) 'refOperationId': refOperationId,
        if (payload.isNotEmpty) 'payload': payload,
      };

  String toStorage() => jsonEncode({
        'id': id, 'kind': kind, 'createdAt': createdAt.toUtc().toIso8601String(), 'appointmentId': appointmentId, 'refOperationId': refOperationId,
        'payload': payload, 'local': local, 'state': state.name, 'attempts': attempts, 'code': code, 'message': message, 'serverAppointmentId': serverAppointmentId,
      });

  factory PendingOp.fromStorage(String json, {int seq = 0}) {
    final j = jsonDecode(json) as Map<String, dynamic>;
    return PendingOp(
      id: j['id'] as String,
      kind: j['kind'] as String,
      createdAt: DateTime.parse(j['createdAt'] as String).toUtc(),
      appointmentId: j['appointmentId'] as String?,
      refOperationId: j['refOperationId'] as String?,
      payload: Map<String, dynamic>.from(j['payload'] as Map? ?? const {}),
      local: Map<String, dynamic>.from(j['local'] as Map? ?? const {}),
      state: OpState.values.firstWhere((s) => s.name == j['state'], orElse: () => OpState.pending),
      attempts: (j['attempts'] as num?)?.toInt() ?? 0,
      code: j['code'] as String?,
      message: j['message'] as String?,
      serverAppointmentId: j['serverAppointmentId'] as String?,
      seq: seq,
    );
  }

  /// Short, human description for the "waiting to sync" list.
  String get title {
    switch (kind) {
      case SyncKind.start: return 'Start service';
      case SyncKind.complete: return 'Complete service';
      case SyncKind.noShow: return 'Mark no-show';
      case SyncKind.walkIn: return 'Walk-in';
      case SyncKind.note: return 'Note';
      default: return kind;
    }
  }

  String get subject => (local['label'] as String?) ?? '';
}

class OfflineNote {
  const OfflineNote({required this.id, required this.appointmentId, required this.author, required this.mine, required this.body, required this.createdAt});
  final String id;
  final String appointmentId;
  final String author;
  final bool mine;
  final String body;
  final DateTime createdAt;

  factory OfflineNote.fromJson(Map<String, dynamic> j) => OfflineNote(
        id: j['id'] as String,
        appointmentId: j['appointmentId'] as String,
        author: (j['author'] as String?) ?? '',
        mine: j['mine'] == true,
        body: (j['body'] as String?) ?? '',
        createdAt: DateTime.parse(j['createdAt'] as String).toUtc(),
      );

  Map<String, dynamic> toJson() => {'id': id, 'appointmentId': appointmentId, 'author': author, 'mine': mine, 'body': body, 'createdAt': createdAt.toUtc().toIso8601String()};
}

/// One appointment of the cached window, as the server's `GET /sync/pull` delivered it (the live-queue view without forecasts).
class OfflineAppointment {
  const OfflineAppointment(this.json);
  final Map<String, dynamic> json;

  String get id => json['id'] as String;
  String get status => json['status'] as String;
  String get staffId => ((json['staff'] as Map?)?['id'] as String?) ?? '';
  String get staffName => ((json['staff'] as Map?)?['name'] as String?) ?? '';
  bool get walkIn => json['walkIn'] == true;
  String get customerName => ((json['customer'] as Map?)?['name'] as String?) ?? '';
  String? get customerPhone => (json['customer'] as Map?)?['phone'] as String?;
  DateTime get startsAt => DateTime.parse(json['startsAt'] as String).toUtc();
  String get time => (json['time'] as String?) ?? '';
  String get endTime => (json['endTime'] as String?) ?? '';
  int get durationMinutes => (json['durationMinutes'] as num?)?.toInt() ?? 0;
  String get totalPrice => (json['totalPrice'] as String?) ?? '0';
  DateTime? get startedAt => _dt(json['startedAt']);
  DateTime? get completedAt => _dt(json['completedAt']);
  DateTime? get startAllowedFrom => _dt(json['startAllowedFrom']);
  DateTime? get noShowAllowedFrom => _dt((json['noShow'] as Map?)?['allowedFrom']);
  List<String> get serviceNames => ((json['services'] as List?) ?? const []).whereType<Map>().map((s) => (s['name'] as String?) ?? '').where((n) => n.isNotEmpty).toList();

  static DateTime? _dt(Object? v) => v is String ? DateTime.tryParse(v)?.toUtc() : null;
}

class CatalogService {
  const CatalogService({required this.id, required this.name, required this.durationMinutes, required this.price});
  final String id;
  final String name;
  final int durationMinutes;
  final String price;
  factory CatalogService.fromJson(Map<String, dynamic> j) => CatalogService(
        id: j['id'] as String, name: (j['name'] as String?) ?? '', durationMinutes: (j['durationMinutes'] as num?)?.toInt() ?? 0, price: (j['price'] as String?) ?? '0');
}

class CatalogStaff {
  const CatalogStaff({required this.id, required this.name, required this.isOwner, required this.canAddWalkIn, required this.services});
  final String id;
  final String name;
  final bool isOwner;
  final bool canAddWalkIn;
  final List<CatalogService> services;
  factory CatalogStaff.fromJson(Map<String, dynamic> j) => CatalogStaff(
        id: j['id'] as String,
        name: (j['name'] as String?) ?? '',
        isOwner: j['isOwner'] == true,
        canAddWalkIn: j['canAddWalkIn'] == true,
        services: ((j['services'] as List?) ?? const []).whereType<Map<String, dynamic>>().map(CatalogService.fromJson).toList(),
      );
}

/// Staff, their services and the policy: what the walk-in form and the no-show button need while offline.
class OfflineCatalog {
  const OfflineCatalog({required this.role, required this.ownStaffId, required this.noShowGraceMinutes, required this.staff});
  final String role;
  final String? ownStaffId;
  final int noShowGraceMinutes;
  final List<CatalogStaff> staff;
  bool get isOwner => role == 'OWNER';

  factory OfflineCatalog.fromJson(Map<String, dynamic> j) => OfflineCatalog(
        role: (j['role'] as String?) ?? 'STAFF',
        ownStaffId: j['ownStaffId'] as String?,
        noShowGraceMinutes: (j['noShowGraceMinutes'] as num?)?.toInt() ?? 15,
        staff: ((j['staff'] as List?) ?? const []).whereType<Map<String, dynamic>>().map(CatalogStaff.fromJson).toList(),
      );
}

/// The five states the person sees (requirement 15).
enum SyncPhase { online, offline, syncing, failed, synced }

class SyncStatus {
  const SyncStatus({this.phase = SyncPhase.online, this.waiting = 0, this.needsAttention = 0, this.lastSyncedAt, this.message, this.clockSkew});
  final SyncPhase phase;
  /// Operations that still have to reach the server.
  final int waiting;
  /// Operations the server refused, or that kept failing: a person must look at them.
  final int needsAttention;
  final DateTime? lastSyncedAt;
  final String? message;
  /// Server time minus phone time. A large value means the phone's clock is wrong (times of offline actions are then unreliable).
  final Duration? clockSkew;

  bool get clockLooksWrong => clockSkew != null && clockSkew!.abs() > const Duration(minutes: 3);

  SyncStatus copyWith({SyncPhase? phase, int? waiting, int? needsAttention, DateTime? lastSyncedAt, String? message, bool clearMessage = false, Duration? clockSkew}) => SyncStatus(
        phase: phase ?? this.phase, waiting: waiting ?? this.waiting, needsAttention: needsAttention ?? this.needsAttention,
        lastSyncedAt: lastSyncedAt ?? this.lastSyncedAt, message: clearMessage ? null : (message ?? this.message), clockSkew: clockSkew ?? this.clockSkew,
      );
}

/// What the server answered for one pushed operation.
class OpResult {
  const OpResult({required this.operationId, required this.status, this.replayed = false, this.appointmentId, this.code, this.message});
  final String operationId;
  /// APPLIED | REJECTED | RETRY
  final String status;
  final bool replayed;
  final String? appointmentId;
  final String? code;
  final String? message;

  factory OpResult.fromJson(Map<String, dynamic> j) => OpResult(
        operationId: j['operationId'] as String,
        status: j['status'] as String,
        replayed: j['replayed'] == true,
        appointmentId: j['appointmentId'] as String?,
        code: j['code'] as String?,
        message: j['message'] as String?,
      );
}

class PushResponse {
  const PushResponse({required this.serverTime, required this.results});
  final DateTime serverTime;
  final List<OpResult> results;
  factory PushResponse.fromJson(Map<String, dynamic> j) => PushResponse(
        serverTime: DateTime.parse(j['serverTime'] as String).toUtc(),
        results: ((j['results'] as List?) ?? const []).whereType<Map<String, dynamic>>().map(OpResult.fromJson).toList(),
      );
}

class PullResponse {
  const PullResponse({required this.serverTime, required this.full, required this.truncated, required this.windowFrom, required this.windowTo, required this.appointments, required this.notes, this.catalog, this.catalogJson});
  final DateTime serverTime;
  final bool full;
  final bool truncated;
  final DateTime windowFrom;
  final DateTime windowTo;
  final List<OfflineAppointment> appointments;
  final List<OfflineNote> notes;
  final OfflineCatalog? catalog;
  /// The catalogue exactly as received, so the store can keep it for offline starts.
  final Map<String, dynamic>? catalogJson;

  factory PullResponse.fromJson(Map<String, dynamic> j) {
    final window = (j['window'] as Map?) ?? const {};
    final catalog = j['catalog'];
    return PullResponse(
      serverTime: DateTime.parse(j['serverTime'] as String).toUtc(),
      full: j['mode'] == 'FULL',
      truncated: j['truncated'] == true,
      windowFrom: DateTime.parse(window['from'] as String).toUtc(),
      windowTo: DateTime.parse(window['to'] as String).toUtc(),
      appointments: ((j['appointments'] as List?) ?? const []).whereType<Map<String, dynamic>>().map(OfflineAppointment.new).toList(),
      notes: ((j['notes'] as List?) ?? const []).whereType<Map<String, dynamic>>().map(OfflineNote.fromJson).toList(),
      catalog: catalog is Map<String, dynamic> ? OfflineCatalog.fromJson(catalog) : null,
      catalogJson: catalog is Map<String, dynamic> ? catalog : null,
    );
  }
}
