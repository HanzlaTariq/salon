import 'package:flutter_test/flutter_test.dart';
import 'package:salon_business/offline/offline_models.dart';
import 'package:salon_business/offline/walk_in_sheet.dart';

void main() {
  test('operation ids are real UUID v4 (the server rejects anything else)', () {
    final re = RegExp(r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$');
    final ids = List.generate(200, (_) => newUuid());
    expect(ids.every(re.hasMatch), isTrue);
    expect(ids.toSet().length, 200);
  });

  test('the request carries only what the server needs: local display data never leaves the phone', () {
    final op = PendingOp(
      id: newUuid(), kind: SyncKind.walkIn, createdAt: DateTime.utc(2026, 11, 20, 6),
      payload: {'customerName': 'Bilal', 'serviceIds': ['x']}, local: {'price': '300.00', 'minutes': 30, 'label': 'Bilal'},
    );
    final api = op.toApi();
    expect(api.keys, containsAll(['operationId', 'kind', 'createdAt', 'payload']));
    expect(api.containsKey('local'), isFalse);
    expect(api.containsKey('salonId'), isFalse);
    expect(api.containsKey('appointmentId'), isFalse);
    expect(api['createdAt'], '2026-11-20T06:00:00.000Z');
  });

  test('an operation survives the trip to SQLite and back', () {
    final op = PendingOp(
      id: newUuid(), kind: SyncKind.start, createdAt: DateTime.utc(2026, 11, 20, 6), refOperationId: 'walk', local: {'label': 'Sara'},
      state: OpState.rejected, attempts: 3, code: 'STATUS', message: 'Nope', serverAppointmentId: 'srv',
    );
    final back = PendingOp.fromStorage(op.toStorage(), seq: 7);
    expect(back.id, op.id);
    expect(back.state, OpState.rejected);
    expect(back.refOperationId, 'walk');
    expect(back.code, 'STATUS');
    expect(back.serverAppointmentId, 'srv');
    expect(back.seq, 7);
    expect(back.subject, 'Sara');
  });

  test('prices add up exactly (no floating point)', () {
    expect(sumPrices(['300.00', '150.50', '99.99']), '550.49');
    expect(sumPrices(['0.1', '0.2']), '0.30');
    expect(sumPrices(const []), '0.00');
  });

  test('a pull answer is parsed, including the catalogue that feeds the walk-in form', () {
    final r = PullResponse.fromJson({
      'serverTime': '2026-11-20T07:00:00.000Z', 'mode': 'FULL', 'truncated': true,
      'window': {'from': '2026-11-19T00:00:00.000Z', 'to': '2026-11-28T00:00:00.000Z'},
      'appointments': [{'id': 'a', 'status': 'CONFIRMED', 'staff': {'id': 's1', 'name': 'Ali'}, 'customer': {'name': 'Sara', 'phone': null}, 'startsAt': '2026-11-20T06:00:00.000Z'}],
      'notes': [{'id': 'n', 'appointmentId': 'a', 'author': 'Ali', 'mine': true, 'body': 'Hi', 'createdAt': '2026-11-20T06:30:00.000Z'}],
      'catalog': {'role': 'OWNER', 'ownStaffId': null, 'noShowGraceMinutes': 20, 'staff': [{'id': 's1', 'name': 'Ali', 'isOwner': false, 'canAddWalkIn': true, 'services': [{'id': 'x', 'name': 'Haircut', 'durationMinutes': 30, 'price': '300.00'}]}]},
    });
    expect(r.full, isTrue);
    expect(r.truncated, isTrue);
    expect(r.appointments.single.staffId, 's1');
    expect(r.notes.single.mine, isTrue);
    expect(r.catalog!.isOwner, isTrue);
    expect(r.catalog!.noShowGraceMinutes, 20);
    expect(r.catalog!.staff.single.services.single.price, '300.00');
  });

  test('a wrong phone clock is detected', () {
    expect(const SyncStatus(clockSkew: Duration(minutes: 1)).clockLooksWrong, isFalse);
    expect(const SyncStatus(clockSkew: Duration(minutes: -10)).clockLooksWrong, isTrue);
  });
}
