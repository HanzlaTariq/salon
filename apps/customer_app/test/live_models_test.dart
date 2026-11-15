import 'package:flutter_test/flutter_test.dart';
import 'package:saloon/booking/booking_models.dart';

Map<String, dynamic> base(Map<String, dynamic> extra) => {
      'id': 'b1', 'status': 'CONFIRMED', 'salon': {'id': 's1', 'name': 'Rose'}, 'staff': {'id': 'st1', 'name': 'Ali'},
      'date': '2026-11-16', 'time': '11:30', 'endTime': '12:00', 'durationMinutes': 30, 'totalPrice': '300.00', 'services': [],
      ...extra,
    };

void main() {
  test('the original time and the salon estimate are kept apart and the delay message shows both', () {
    final b = Booking.fromJson(base({'estimate': {'startsAt': '2026-11-16T06:40:00.000Z', 'time': '11:40', 'delayMinutes': 10, 'updatedAt': '2026-11-16T06:31:00.000Z'}}));
    expect(b.time, '11:30');
    expect(b.estimate?.time, '11:40');
    expect(b.isDelayed, isTrue);
    expect(delayMessage(b), contains('10 minutes behind'));
    expect(delayMessage(b), contains('11:40'));
    expect(delayMessage(b), contains('11:30'));
  });

  test('on time: no estimate, no delay message; a finished booking never shows a delay', () {
    expect(delayMessage(Booking.fromJson(base({}))), isNull);
    final done = Booking.fromJson(base({'status': 'COMPLETED', 'estimate': {'time': '11:40', 'delayMinutes': 10}}));
    expect(done.isDelayed, isFalse);
    expect(delayMessage(done), isNull);
  });

  test('an early offer and the customer ETA are parsed; missing fields do not crash', () {
    final b = Booking.fromJson(base({
      'earlyOffer': {'id': 'o1', 'offeredTime': '11:25', 'originalTime': '12:00', 'savesMinutes': 35, 'expiresAt': '2026-11-16T06:25:00.000Z'},
      'customerEta': {'state': 'RUNNING_LATE', 'etaTime': '11:35'},
    }));
    expect(b.earlyOffer?.id, 'o1');
    expect(b.earlyOffer?.savesMinutes, 35);
    expect(b.earlyOffer?.expiresAt, isNotNull);
    expect(b.customerEta?.state, 'RUNNING_LATE');
    expect(Booking.fromJson({'id': 'x', 'earlyOffer': 'broken', 'estimate': 5}).earlyOffer, isNull);
  });

  test('ETA input: whole minutes from 1 to 120 only; quick choices are valid', () {
    expect([null, 0, 1, 120, 121, -5].map(isValidEta), [false, false, true, true, false, false]);
    expect(kEtaChoices.every(isValidEta), isTrue);
    expect(kEtaChoices, [5, 10, 15, 20, 30]);
  });
}
