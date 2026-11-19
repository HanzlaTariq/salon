import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter_core/flutter_core.dart';

import 'connectivity_probe.dart';
import 'local_store.dart';
import 'offline_models.dart';
import 'sync_gateway.dart';

/// Keeps the phone and the server in step (requirement 15):
///
///  1. detect the network (a network appearing starts a sync; a failed request means offline);
///  2. upload the waiting operations IN ORDER, in batches. Every operation has its own id: sending it twice is harmless because the
///     server applies each id once and answers the same afterwards;
///  3. the server validates every operation again (it is the authority). A refusal is final and is kept for a person to read;
///  4. download the new state (a delta; a full refresh every few minutes) and store it;
///  5. show one of five states: online, offline, syncing, sync failed, synced.
///
/// Nothing is promised while offline: a walk-in stays PROVISIONAL (no confirmed time) until the server has placed it.
class SyncEngine extends ChangeNotifier {
  SyncEngine({
    required this.store,
    required this.gateway,
    required this.probe,
    required this.deviceId,
    DateTime Function()? clock,
    this.interval = const Duration(seconds: 30),
    this.maxAttempts = 8,
    this.batchSize = 25,
    this.fullRefreshEvery = const Duration(minutes: 10),
  }) : _now = clock ?? DateTime.now;

  final LocalStore store;
  final SyncGateway gateway;
  final ConnectivityProbe probe;
  final String deviceId;
  final Duration interval;
  /// After this many technical failures of the same operation it becomes `failed` and waits for a person (retry / discard).
  final int maxAttempts;
  /// The server accepts at most 25 operations per push.
  final int batchSize;
  final Duration fullRefreshEvery;
  final DateTime Function() _now;

  SyncStatus _status = const SyncStatus();
  SyncStatus get status => _status;

  bool _running = false;
  bool _again = false;
  bool _disposed = false;
  StreamSubscription<bool>? _sub;
  Timer? _timer;

  void start() {
    _sub = probe.changes.listen((online) {
      if (online) {
        unawaited(syncNow());
      } else {
        _set(_status.copyWith(phase: SyncPhase.offline));
      }
    });
    _timer = Timer.periodic(interval, (_) => unawaited(syncNow()));
    unawaited(_refreshCounts().then((_) => syncNow()));
  }

  /// Saves an operation on the phone FIRST (it survives a crash), then tries to send it.
  Future<PendingOp> enqueue(PendingOp op) async {
    final saved = await store.enqueue(op);
    await _refreshCounts();
    unawaited(syncNow());
    return saved;
  }

  /// Sends the waiting operations and downloads the new state. Calls that arrive while a sync is running are merged into one more round.
  Future<void> syncNow({bool full = false}) async {
    if (_disposed) return;
    if (_running) {
      _again = true;
      return;
    }
    _running = true;
    try {
      var forceFull = full;
      do {
        _again = false;
        await _cycle(forceFull);
        forceFull = false;
      } while (_again && !_disposed);
    } finally {
      _running = false;
    }
  }

  /// A refused or failed operation: try it again (the person decided it is still wanted).
  Future<void> retryOp(String id) async {
    for (final o in await store.ops()) {
      if (o.id == id && (o.state == OpState.failed)) {
        await store.updateOp(o.copyWith(state: OpState.pending, attempts: 0));
      }
    }
    await _refreshCounts();
    unawaited(syncNow());
  }

  /// Throws the operation away (the person read the refusal). The server never applied it.
  Future<void> discardOp(String id) async {
    for (final o in await store.ops()) {
      if (o.id == id && (o.state == OpState.rejected || o.state == OpState.failed)) await store.removeOp(id);
    }
    await _refreshCounts();
  }

  Future<void> _cycle(bool forceFull) async {
    if (!await probe.isOnline()) {
      await _refreshCounts(phase: SyncPhase.offline);
      return;
    }
    _set(_status.copyWith(phase: SyncPhase.syncing));
    try {
      final complete = await _pushAll();
      await _pull(forceFull);
      await _dropApplied();
      final c = await _counts();
      final now = _now();
      await store.setMeta(MetaKey.lastSyncedAt, now.toUtc().toIso8601String());
      _set(_status.copyWith(
        phase: complete ? SyncPhase.synced : SyncPhase.failed,
        waiting: c.waiting,
        needsAttention: c.attention,
        lastSyncedAt: now,
        message: complete ? null : 'Some changes could not be sent yet. They will be tried again.',
        clearMessage: complete,
      ));
    } on ApiException catch (e) {
      final c = await _counts();
      if (e.isNetwork) {
        _set(_status.copyWith(phase: SyncPhase.offline, waiting: c.waiting, needsAttention: c.attention, clearMessage: true));
      } else if (e.isSessionDead || e.statusCode == 401) {
        _set(_status.copyWith(phase: SyncPhase.failed, waiting: c.waiting, needsAttention: c.attention, message: 'Your session has ended. Sign in again to sync.'));
      } else {
        _set(_status.copyWith(phase: SyncPhase.failed, waiting: c.waiting, needsAttention: c.attention, message: e.message));
      }
    } catch (_) {
      final c = await _counts();
      _set(_status.copyWith(phase: SyncPhase.failed, waiting: c.waiting, needsAttention: c.attention, message: 'Sync failed. It will be tried again.'));
    }
  }

  /// Returns false when the server could not apply some operation right now (they stay waiting).
  Future<bool> _pushAll() async {
    while (true) {
      final pending = (await store.ops()).where((o) => o.state == OpState.pending).toList()..sort((a, b) => a.seq.compareTo(b.seq));
      if (pending.isEmpty) return true;
      final batch = pending.take(batchSize).toList();

      PushResponse res;
      try {
        res = await gateway.push(deviceId: deviceId, ops: batch);
      } on ApiException catch (e) {
        // No answer, access problems and server errors keep the operations untouched: the server may or may not have applied them,
        // and the ledger makes sending them again safe. Only a 400 (a bug of this app) counts as an attempt, so it cannot loop forever.
        if (e.statusCode == 400) await _countAttempt(batch, 'BAD_REQUEST', e.message);
        rethrow;
      }

      final answers = {for (final r in res.results) r.operationId: r};
      var allDone = true;
      for (final op in batch) {
        final r = answers[op.id];
        if (r != null && r.status == 'APPLIED') {
          await store.updateOp(op.copyWith(state: OpState.applied, serverAppointmentId: r.appointmentId));
        } else if (r != null && r.status == 'REJECTED') {
          await store.updateOp(op.copyWith(state: OpState.rejected, code: r.code, message: r.message));
        } else if (r != null && r.code == 'SKIPPED') {
          allDone = false; // not tried by the server because an earlier change failed: not this change's fault
        } else {
          allDone = false;
          await _countAttempt([op], r?.code ?? 'NO_ANSWER', r?.message ?? 'The server did not answer for this change.');
        }
      }
      if (!allDone) return false; // keep the order: later changes may depend on the one that is still waiting
      await _refreshCounts();
    }
  }

  Future<void> _countAttempt(List<PendingOp> ops, String code, String message) async {
    for (final op in ops) {
      final attempts = op.attempts + 1;
      await store.updateOp(op.copyWith(attempts: attempts, code: code, message: message, state: attempts >= maxAttempts ? OpState.failed : OpState.pending));
    }
  }

  Future<void> _pull(bool forceFull) async {
    final cursor = DateTime.tryParse(await store.meta(MetaKey.cursor) ?? '');
    final lastFull = DateTime.tryParse(await store.meta(MetaKey.lastFullAt) ?? '');
    final needFull = forceFull || cursor == null || lastFull == null || _now().difference(lastFull) > fullRefreshEvery;
    final haveCatalog = await store.catalog() != null;

    final res = await gateway.pull(since: needFull ? null : cursor, catalog: !needFull && !haveCatalog);

    final keep = <String>{};
    for (final o in await store.ops()) {
      if (o.state == OpState.pending || o.state == OpState.applied) {
        if (o.appointmentId != null) keep.add(o.appointmentId!);
        if (o.serverAppointmentId != null) keep.add(o.serverAppointmentId!);
      }
    }
    await store.applyPull(
      full: res.full,
      appointments: res.appointments,
      notes: res.notes,
      catalogJson: res.catalogJson,
      windowFrom: res.windowFrom,
      keepIds: keep,
    );
    await store.setMeta(MetaKey.cursor, res.serverTime.toUtc().toIso8601String());
    if (res.full) await store.setMeta(MetaKey.lastFullAt, _now().toUtc().toIso8601String());
    _set(_status.copyWith(clockSkew: res.serverTime.difference(_now().toUtc()), message: res.truncated ? 'Only part of the schedule could be loaded.' : null, clearMessage: !res.truncated));
  }

  Future<void> _dropApplied() async {
    for (final o in await store.ops()) {
      if (o.state == OpState.applied) await store.removeOp(o.id);
    }
  }

  Future<({int waiting, int attention})> _counts() async {
    final ops = await store.ops();
    return (
      waiting: ops.where((o) => o.state == OpState.pending).length,
      attention: ops.where((o) => o.state == OpState.rejected || o.state == OpState.failed).length,
    );
  }

  Future<void> _refreshCounts({SyncPhase? phase}) async {
    final c = await _counts();
    _set(_status.copyWith(phase: phase, waiting: c.waiting, needsAttention: c.attention));
  }

  void _set(SyncStatus s) {
    if (_disposed) return;
    _status = s;
    notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    _timer?.cancel();
    unawaited(_sub?.cancel());
    super.dispose();
  }
}
