import 'package:flutter_test/flutter_test.dart';
import 'package:salon_business/offline/offline_models.dart';
import 'package:salon_business/offline/offline_overlay.dart';

import 'support/offline_fakes.dart';

PendingOp op(String kind, {String? id, String? appt, String? ref, Map<String, dynamic> payload = const {}, Map<String, dynamic> local = const {}, OpState state = OpState.pending, String? server, int seq = 1}) =>
    PendingOp(id: id ?? 'op$seq', kind: kind, createdAt: DateTime.utc(2026, 11, 20, 6, 5), appointmentId: appt, refOperationId: ref, payload: payload, local: local, state: state, serverAppointmentId: server, seq: seq);

void main() {
  final a1 = OfflineAppointment(apptJson('a1'));
  final a2 = OfflineAppointment(apptJson('a2', starts: '2026-11-20T07:00:00.000Z'));

  test('waiting actions are shown on top of the server state, in the order they were done', () {
    final list = overlayLocal(cached: [a1, a2], notes: const [], ops: [op(SyncKind.start, appt: 'a1', seq: 1), op(SyncKind.complete, appt: 'a1', seq: 2), op(SyncKind.noShow, appt: 'a2', seq: 3)]);
    expect(list.map((x) => (x.id, x.status)), [('a1', 'COMPLETED'), ('a2', 'NO_SHOW')]);
    expect(list.first.waitingActions, 2);
    expect(list.first.startedAt, DateTime.utc(2026, 11, 20, 6, 5));
  });

  test('a complete without a start changes nothing (the server would refuse it too)', () {
    final list = overlayLocal(cached: [a1], notes: const [], ops: [op(SyncKind.complete, appt: 'a1')]);
    expect(list.single.status, 'CONFIRMED');
  });

  test('refused and failed operations are NOT applied: the screen shows the server truth', () {
    final list = overlayLocal(cached: [a1], notes: const [], ops: [op(SyncKind.start, appt: 'a1', state: OpState.rejected), op(SyncKind.start, id: 'x', appt: 'a1', state: OpState.failed, seq: 2)]);
    expect(list.single.status, 'CONFIRMED');
    expect(list.single.waitingActions, 0);
  });

  test('an offline walk-in is PROVISIONAL (no time) and later actions on it use its operation id', () {
    final walk = op(SyncKind.walkIn, id: 'w1', payload: {'customerName': 'Bilal', 'serviceIds': ['svc1']}, local: {'staffId': 's1', 'staffName': 'Ali', 'serviceNames': ['Haircut'], 'price': '300.00', 'minutes': 30}, seq: 1);
    final list = overlayLocal(cached: [a1], notes: const [], ops: [walk, op(SyncKind.start, ref: 'w1', seq: 2), op(SyncKind.note, ref: 'w1', payload: {'body': 'Fade'}, seq: 3)]);
    final w = list.firstWhere((x) => x.id == 'w1');
    expect(w.provisional, isTrue);
    expect(w.status, 'IN_PROGRESS');
    expect(w.time, '');
    expect(w.startsAt, isNull);
    expect(w.notes.single.body, 'Fade');
    expect(list.last.id, 'w1'); // no time yet: after the booked ones
  });

  test('once the server placed the walk-in and the pull delivered it, nothing provisional is left', () {
    final walk = op(SyncKind.walkIn, id: 'w1', state: OpState.applied, server: 'srv1', local: {'staffId': 's1'}, payload: {'customerName': 'Bilal'});
    final real = OfflineAppointment(apptJson('srv1', status: 'COMPLETED'));
    final list = overlayLocal(cached: [real], notes: const [], ops: [walk]);
    expect(list.map((x) => x.id), ['srv1']);
    expect(list.single.provisional, isFalse);
  });

  test('an applied walk-in the pull has not delivered yet stays visible under its real id (no flicker)', () {
    final walk = op(SyncKind.walkIn, id: 'w1', state: OpState.applied, server: 'srv1', local: {'staffId': 's1'}, payload: {'customerName': 'Bilal'});
    final list = overlayLocal(cached: const [], notes: const [], ops: [walk]);
    expect(list.single.id, 'srv1');
  });

  group('LocalRules', () {
    final running = OfflineAppointment(apptJson('r', status: 'IN_PROGRESS'));
    final now = DateTime.utc(2026, 11, 20, 6, 20);

    test('one service at a time per staff member', () {
      final all = overlayLocal(cached: [running, a1], notes: const [], ops: const []);
      final rules = LocalRules(all);
      final waiting = all.firstWhere((x) => x.id == 'a1');
      expect(rules.canStart(waiting, now), isFalse);
      expect(rules.canComplete(all.firstWhere((x) => x.id == 'r')), isTrue);
    });

    test('start is not offered more than the allowed time before the booking', () {
      final rules = LocalRules(overlayLocal(cached: [a1], notes: const [], ops: const []));
      final item = rules.all.single;
      expect(rules.canStart(item, DateTime.utc(2026, 11, 20, 4)), isFalse);
      expect(rules.canStart(item, DateTime.utc(2026, 11, 20, 5, 30)), isTrue);
    });

    test('no-show only after the grace period, never for a walk-in', () {
      final rules = LocalRules(overlayLocal(cached: [a1], notes: const [], ops: const []));
      final item = rules.all.single;
      expect(rules.canNoShow(item, DateTime.utc(2026, 11, 20, 6, 10)), isFalse);
      expect(rules.canNoShow(item, DateTime.utc(2026, 11, 20, 6, 15)), isTrue);
      final walk = overlayLocal(cached: const [], notes: const [], ops: [op(SyncKind.walkIn, id: 'w', payload: {'customerName': 'B'}, local: {'staffId': 's1'})]);
      expect(LocalRules(walk).canNoShow(walk.single, DateTime.utc(2026, 11, 21)), isFalse);
    });
  });
}
