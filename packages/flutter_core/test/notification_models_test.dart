import 'package:flutter_core/flutter_core.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('AppNotification parses the API shape and keeps only string data', () {
    final n = AppNotification.fromJson({
      'id': 'a1',
      'type': 'BOOKING_CONFIRMED',
      'category': 'BOOKINGS',
      'title': 'Booking confirmed',
      'body': 'Glow Studio with Ali',
      'data': {'route': 'booking', 'appointmentId': 'x-1', 'offset': 30},
      'createdAt': '2026-11-16T10:05:00.000Z',
      'readAt': null,
    });
    expect(n.isUnread, isTrue);
    expect(n.route, 'booking');
    expect(n.appointmentId, 'x-1');
    expect(n.data['offset'], '30');
    expect(n.markedRead(DateTime(2026, 11, 16)).isUnread, isFalse);
  });

  test('NotificationPage and preferences round-trip', () {
    final page = NotificationPage.fromJson({'items': [], 'nextCursor': null, 'unreadCount': 4});
    expect(page.unreadCount, 4);
    final prefs = NotificationPrefs.fromJson({'pushEnabled': false, 'language': 'ur', 'bookings': true, 'reminders': false, 'queue': true, 'team': true, 'reminderOffsets': [30, 0]});
    expect(prefs.language, 'ur');
    expect(prefs.toJson()['reminderOffsets'], [30, 0]);
    expect(prefs.copyWith(language: 'en').language, 'en');
    expect(const NotificationPrefs().reminderOffsets, [30, 20, 10, 0]);
  });

  test('timeAgo and looksRtl', () {
    final now = DateTime(2026, 11, 16, 12);
    expect(timeAgo(now.subtract(const Duration(seconds: 20)), now), 'now');
    expect(timeAgo(now.subtract(const Duration(minutes: 5)), now), '5 min ago');
    expect(timeAgo(now.subtract(const Duration(hours: 3)), now), '3 h ago');
    expect(timeAgo(now.subtract(const Duration(days: 1, hours: 1)), now), 'yesterday');
    expect(timeAgo(DateTime(2026, 11, 1), now), '1 Nov');
    expect(looksRtl('بکنگ کنفرم ہو گئی'), isTrue);
    expect(looksRtl('Booking confirmed'), isFalse);
  });
}
