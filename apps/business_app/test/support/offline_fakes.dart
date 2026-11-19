import 'dart:async';

import 'package:flutter_core/flutter_core.dart';
import 'package:salon_business/offline/connectivity_probe.dart';
import 'package:salon_business/offline/local_store.dart';
import 'package:salon_business/offline/offline_models.dart';
import 'package:salon_business/offline/sync_gateway.dart';

/// [LocalStore] in memory (the real one is SQLite). Behaves the same as DriftLocalStore for what the engine relies on.
class MemoryStore implements LocalStore {
  final Map<String, OfflineAppointment> _appts = {};
  final Map<String, OfflineNote> _notes = {};
  final List<PendingOp> _ops = [];
  final Map<String, String> _meta = {};
  Map<String, dynamic>? _catalog;
  int _seq = 0;

  @override
  Future<List<OfflineAppointment>> appointments() async => _appts.values.toList();
  @override
  Future<List<OfflineNote>> notes() async => _notes.values.toList();
  @override
  Future<OfflineCatalog?> catalog() async => _catalog == null ? null : OfflineCatalog.fromJson(_catalog!);

  @override
  Future<void> applyPull({
    required bool full,
    required List<OfflineAppointment> appointments,
    required List<OfflineNote> notes,
    required Map<String, dynamic>? catalogJson,
    required DateTime windowFrom,
    required Set<String> keepIds,
  }) async {
    if (full) {
      final incoming = appointments.map((a) => a.id).toSet();
      _appts.removeWhere((id, _) => !incoming.contains(id) && !keepIds.contains(id));
    }
    for (final a in appointments) {
      _appts[a.id] = a;
    }
    for (final n in notes) {
      _notes[n.id] = n;
    }
    if (catalogJson != null) _catalog = catalogJson;
  }

  @override
  Future<List<PendingOp>> ops() async => List.of(_ops)..sort((a, b) => a.seq.compareTo(b.seq));
  @override
  Future<PendingOp> enqueue(PendingOp op) async {
    final saved = op.copyWith(seq: ++_seq);
    _ops.add(saved);
    return saved;
  }

  @override
  Future<void> updateOp(PendingOp op) async {
    final i = _ops.indexWhere((o) => o.id == op.id);
    if (i >= 0) _ops[i] = op;
  }

  @override
  Future<void> removeOp(String id) async => _ops.removeWhere((o) => o.id == id);
  @override
  Future<String?> meta(String key) async => _meta[key];
  @override
  Future<void> setMeta(String key, String value) async => _meta[key] = value;
  @override
  Future<void> wipe() async {
    _appts.clear();
    _notes.clear();
    _ops.clear();
    _meta.clear();
    _catalog = null;
  }

  @override
  Future<void> close() async {}
}

class FakeProbe implements ConnectivityProbe {
  bool online = true;
  final _c = StreamController<bool>.broadcast();
  @override
  Stream<bool> get changes => _c.stream;
  @override
  Future<bool> isOnline() async => online;
  void set(bool v) {
    online = v;
    _c.add(v);
  }
}

Map<String, dynamic> apptJson(String id, {String status = 'CONFIRMED', String staffId = 's1', String starts = '2026-11-20T06:00:00.000Z'}) => {
      'id': id, 'status': status, 'staff': {'id': staffId, 'name': 'Ali'}, 'walkIn': false, 'customer': {'name': 'Sara', 'phone': null},
      'startsAt': starts, 'time': '11:00', 'endTime': '11:30', 'durationMinutes': 30, 'totalPrice': '300.00', 'services': [{'name': 'Haircut'}],
      'startAllowedFrom': '2026-11-20T05:00:00.000Z', 'noShow': {'allowed': false, 'allowedFrom': '2026-11-20T06:15:00.000Z', 'graceMinutes': 15},
    };

/// A tiny server: a ledger that applies each operation id once (like the real one), scripted failures, and a scripted pull.
class FakeGateway implements SyncGateway {
  final Map<String, OpResult> ledger = {};
  final List<List<String>> pushes = [];
  int applied = 0;
  int pullCount = 0;
  DateTime serverNow = DateTime.utc(2026, 11, 20, 7);

  /// Throw this on the next push BEFORE the server saw it / AFTER the server applied it (the answer got lost).
  ApiException? failBefore;
  ApiException? failAfter;
  ApiException? failPull;
  /// Decides the answer for an operation the ledger has not seen. Default: APPLIED.
  OpResult Function(PendingOp op)? decide;
  List<Map<String, dynamic>> appointments = [];
  Map<String, dynamic>? catalog = {
    'role': 'STAFF', 'ownStaffId': 's1', 'noShowGraceMinutes': 15,
    'staff': [{'id': 's1', 'name': 'Ali', 'isOwner': false, 'canAddWalkIn': true, 'services': [{'id': 'svc1', 'name': 'Haircut', 'durationMinutes': 30, 'price': '300.00'}]}],
  };

  @override
  Future<PushResponse> push({required String deviceId, required List<PendingOp> ops}) async {
    pushes.add(ops.map((o) => o.id).toList());
    final before = failBefore;
    if (before != null) {
      failBefore = null;
      throw before;
    }
    final results = <OpResult>[];
    for (final op in ops) {
      final prior = ledger[op.id];
      if (prior != null) {
        results.add(OpResult(operationId: op.id, status: prior.status, replayed: true, appointmentId: prior.appointmentId, code: prior.code, message: prior.message));
        continue;
      }
      final r = decide?.call(op) ?? OpResult(operationId: op.id, status: 'APPLIED', appointmentId: op.appointmentId ?? 'server-${op.id}');
      if (r.status != 'RETRY') {
        ledger[op.id] = r;
        if (r.status == 'APPLIED') applied++;
      }
      results.add(r);
    }
    final after = failAfter;
    if (after != null) {
      failAfter = null;
      throw after;
    }
    return PushResponse(serverTime: serverNow, results: results);
  }

  @override
  Future<PullResponse> pull({DateTime? since, bool catalog = false}) async {
    pullCount++;
    final f = failPull;
    if (f != null) {
      failPull = null;
      throw f;
    }
    return PullResponse.fromJson({
      'serverTime': serverNow.toIso8601String(),
      'mode': since == null ? 'FULL' : 'DELTA',
      'truncated': false,
      'window': {'from': '2026-11-19T00:00:00.000Z', 'to': '2026-11-28T00:00:00.000Z'},
      'appointments': appointments,
      'notes': <Map<String, dynamic>>[],
      if (since == null || catalog) 'catalog': this.catalog,
    });
  }
}
