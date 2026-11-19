import 'package:flutter_core/flutter_core.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:salon_business/offline/offline_models.dart';
import 'package:salon_business/offline/offline_overlay.dart';
import 'package:salon_business/offline/sync_engine.dart';

import 'support/offline_fakes.dart';

PendingOp start(String appt, {String? id}) => PendingOp(id: id ?? newUuid(), kind: SyncKind.start, createdAt: DateTime.utc(2026, 11, 20, 6), appointmentId: appt);

void main() {
  late MemoryStore store;
  late FakeGateway gateway;
  late FakeProbe probe;
  late SyncEngine engine;

  setUp(() {
    store = MemoryStore();
    gateway = FakeGateway()..appointments = [apptJson('a1')];
    probe = FakeProbe();
    engine = SyncEngine(store: store, gateway: gateway, probe: probe, deviceId: newUuid(), clock: () => DateTime.utc(2026, 11, 20, 7), maxAttempts: 3);
  });
  tearDown(() => engine.dispose());

  test('offline: the change is saved on the phone and nothing is sent; online again: it is sent, then the state is downloaded', () async {
    probe.online = false;
    engine.start();
    await engine.enqueue(start('a1'));
    await pumpEventQueue();
    expect(engine.status.phase, SyncPhase.offline);
    expect(engine.status.waiting, 1);
    expect(gateway.pushes, isEmpty);
    expect((await store.ops()).single.state, OpState.pending);

    probe.set(true); // a network appears
    await pumpEventQueue();
    expect(gateway.pushes, hasLength(1));
    expect(engine.status.phase, SyncPhase.synced);
    expect(engine.status.waiting, 0);
    expect(await store.ops(), isEmpty); // applied and delivered by the pull
    expect((await store.appointments()).single.id, 'a1');
    expect((await store.catalog())!.staff.single.services.single.name, 'Haircut');
  });

  test('a lost answer never duplicates: the server applied it, the phone sends it again, the server replays', () async {
    final op = await store.enqueue(start('a1'));
    gateway.failAfter = ApiException.network();
    await engine.syncNow();
    expect(engine.status.phase, SyncPhase.offline);
    expect(gateway.applied, 1);
    expect((await store.ops()).single.state, OpState.pending); // the phone does not know it worked

    await engine.syncNow();
    expect(gateway.applied, 1); // still ONE
    expect(gateway.pushes.last, [op.id]);
    expect(await store.ops(), isEmpty);
    expect(engine.status.phase, SyncPhase.synced);
  });

  test('a final refusal is kept for a person, not retried, and can be dismissed', () async {
    await store.enqueue(start('a1', id: 'refused'));
    gateway.decide = (o) => OpResult(operationId: o.id, status: 'REJECTED', code: 'STATUS', message: 'This appointment was cancelled.');
    await engine.syncNow();
    final ops = await store.ops();
    expect(ops.single.state, OpState.rejected);
    expect(ops.single.message, contains('cancelled'));
    expect(engine.status.needsAttention, 1);
    expect(engine.status.waiting, 0);

    await engine.syncNow();
    expect(gateway.pushes, hasLength(1)); // never sent again
    await engine.discardOp('refused');
    expect(await store.ops(), isEmpty);
    expect(engine.status.needsAttention, 0);
  });

  test('technical failures are retried, then wait for a person; "try again" starts over', () async {
    final op = await store.enqueue(start('a1'));
    gateway.decide = (o) => OpResult(operationId: o.id, status: 'RETRY', code: 'TEMPORARY', message: 'busy');
    for (var i = 0; i < 3; i++) {
      await engine.syncNow();
    }
    expect((await store.ops()).single.state, OpState.failed);
    expect(engine.status.needsAttention, 1);
    expect(gateway.ledger, isEmpty); // a RETRY is never stored by the server

    gateway.decide = null;
    await engine.retryOp(op.id);
    await pumpEventQueue();
    expect(await store.ops(), isEmpty);
    expect(gateway.applied, 1);
  });

  test('operations the server skipped after an earlier failure are not blamed', () async {
    final first = await store.enqueue(start('a1'));
    final second = await store.enqueue(start('a2'));
    gateway.decide = (o) => o.id == first.id
        ? OpResult(operationId: o.id, status: 'RETRY', code: 'TEMPORARY', message: 'busy')
        : OpResult(operationId: o.id, status: 'RETRY', code: 'SKIPPED', message: 'not tried');
    await engine.syncNow();
    final ops = await store.ops();
    expect(ops.firstWhere((o) => o.id == first.id).attempts, 1);
    expect(ops.firstWhere((o) => o.id == second.id).attempts, 0);
    expect(engine.status.phase, SyncPhase.failed);
    expect(engine.status.waiting, 2);
  });

  test('operations go out in the order they were done, in batches the server accepts', () async {
    final ids = <String>[];
    for (var i = 0; i < 30; i++) {
      final saved = await store.enqueue(start('a$i'));
      ids.add(saved.id);
    }
    await engine.syncNow();
    expect(gateway.pushes, hasLength(2));
    expect(gateway.pushes[0], ids.sublist(0, 25));
    expect(gateway.pushes[1], ids.sublist(25));
    expect(await store.ops(), isEmpty);
  });

  test('a walk-in written offline and acted on offline is sent as one ordered batch and ends up as the real appointment', () async {
    final walk = await store.enqueue(PendingOp(
      id: newUuid(), kind: SyncKind.walkIn, createdAt: DateTime.utc(2026, 11, 20, 6), payload: {'customerName': 'Bilal', 'serviceIds': ['svc1']}, local: {'staffId': 's1', 'staffName': 'Ali', 'price': '300.00', 'minutes': 30},
    ));
    await store.enqueue(PendingOp(id: newUuid(), kind: SyncKind.start, createdAt: DateTime.utc(2026, 11, 20, 6, 1), refOperationId: walk.id));
    await store.enqueue(PendingOp(id: newUuid(), kind: SyncKind.complete, createdAt: DateTime.utc(2026, 11, 20, 6, 31), refOperationId: walk.id));

    // before the sync: provisional
    var shown = overlayLocal(cached: await store.appointments(), notes: await store.notes(), ops: await store.ops());
    expect(shown.single.provisional, isTrue);
    expect(shown.single.status, 'COMPLETED');

    gateway.appointments = [apptJson('server-${walk.id}', status: 'COMPLETED')];
    await engine.syncNow();
    expect(gateway.pushes.single, hasLength(3));
    shown = overlayLocal(cached: await store.appointments(), notes: await store.notes(), ops: await store.ops());
    expect(shown.single.id, 'server-${walk.id}');
    expect(shown.single.provisional, isFalse);
  });

  test('a dead session stops the sync without losing anything', () async {
    await store.enqueue(start('a1'));
    gateway.failBefore = ApiException.sessionEnded();
    await engine.syncNow();
    expect(engine.status.phase, SyncPhase.failed);
    expect(engine.status.message, contains('Sign in again'));
    expect((await store.ops()).single.state, OpState.pending);
  });

  test('a failed download after a good upload keeps the applied operation visible until a pull succeeds', () async {
    await store.enqueue(start('a1'));
    gateway.failPull = ApiException.network();
    await engine.syncNow();
    expect((await store.ops()).single.state, OpState.applied); // not dropped yet: the screen must not flicker back
    expect(engine.status.phase, SyncPhase.offline);

    await engine.syncNow();
    expect(await store.ops(), isEmpty);
    expect(gateway.applied, 1);
  });

  test('syncing is single-flight: calls that arrive during a sync are merged', () async {
    await store.enqueue(start('a1'));
    await Future.wait([engine.syncNow(), engine.syncNow(), engine.syncNow()]);
    expect(gateway.applied, 1);
    expect(gateway.pushes.length, lessThanOrEqualTo(2));
  });
}
