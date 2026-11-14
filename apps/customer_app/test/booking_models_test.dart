import 'dart:math';

import 'package:flutter_test/flutter_test.dart';
import 'package:saloon/booking/booking_api.dart';
import 'package:saloon/booking/booking_models.dart';

void main() {
  test('a booking is parsed with the server snapshot and the server decides cancel / reschedule', () {
    final b = Booking.fromJson({
      'id': 'b1', 'status': 'CONFIRMED', 'salon': {'id': 's1', 'name': 'Rose'}, 'staff': {'id': 'st1', 'name': 'Ali'},
      'date': '2026-11-16', 'time': '11:00', 'endTime': '11:45', 'durationMinutes': 45, 'totalPrice': '450.00',
      'services': [
        {'serviceId': 'a', 'name': 'Haircut', 'durationMinutes': 30, 'price': '300.00'},
        {'serviceId': 'b', 'name': 'Beard Trim', 'durationMinutes': 15, 'price': '150.00'},
      ],
      'note': null, 'rescheduleCount': 1, 'reschedulesLeft': 1, 'canCancel': true, 'canReschedule': false,
      'cancelBefore': '2026-11-16T04:00:00.000Z', 'cancellation': null,
    });
    expect(b.salonName, 'Rose');
    expect(b.staffName, 'Ali');
    expect(b.services.map((s) => s.price), ['300.00', '150.00']);
    expect(b.totalPrice, '450.00');
    expect(b.canCancel, isTrue);
    expect(b.canReschedule, isFalse);
    expect(b.isOpen, isTrue);
    expect(b.note, isNull);
  });

  test('a cancelled booking exposes who cancelled and why; missing fields do not crash', () {
    final b = Booking.fromJson({'id': 'x', 'status': 'CANCELLED', 'cancellation': {'by': 'SALON', 'reason': 'Stylist is ill'}});
    expect(b.cancelledBy, 'SALON');
    expect(b.cancellationReason, 'Stylist is ill');
    expect(b.isOpen, isFalse);
    expect(b.services, isEmpty);
    expect(BookingPage.fromJson({}).items, isEmpty);
  });

  test('status labels are readable', () {
    expect(statusLabel('CONFIRMED'), 'Confirmed');
    expect(statusLabel('NO_SHOW'), 'No show');
  });

  test('idempotency keys are 32 hex characters and unique', () {
    final a = newIdempotencyKey();
    final b = newIdempotencyKey();
    expect(a, matches(RegExp(r'^[0-9a-f]{32}$')));
    expect(a, isNot(b));
    expect(newIdempotencyKey(Random(1)), newIdempotencyKey(Random(1)));
  });
}
