import 'package:saloon/discovery/format.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('money and time text', () {
    test('formatPkr drops .00, keeps paisa, groups thousands', () {
      expect(formatPkr('300.00'), 'Rs. 300');
      expect(formatPkr('150.50'), 'Rs. 150.50');
      expect(formatPkr('12500.00'), 'Rs. 12,500');
      expect(formatPkr('1000000.00'), 'Rs. 1,000,000');
      expect(formatPkr('abc'), 'Rs. abc');
    });
    test('price range collapses when both ends match', () {
      expect(formatPriceRange('300.00', '300.00'), 'Rs. 300');
      expect(formatPriceRange('300.00', '1000.00'), 'Rs. 300 - Rs. 1,000');
    });
    test('durations and clock times', () {
      expect(formatDuration(45), '45 min');
      expect(formatDuration(90), '1 h 30 min');
      expect(formatDuration(120), '2 h');
      expect(formatClock('00:15'), '12:15 AM');
      expect(formatClock('12:00'), '12:00 PM');
      expect(formatClock('17:30'), '5:30 PM');
    });
  });

  group('Karachi calendar', () {
    test('uses UTC+5 whatever the phone time zone is', () {
      expect(isoDate(karachiToday(DateTime.utc(2026, 11, 16, 18, 59))), '2026-11-16');
      expect(isoDate(karachiToday(DateTime.utc(2026, 11, 16, 19, 0))), '2026-11-17');
    });
    test('describeNextSlot says Today, Tomorrow or the weekday', () {
      final now = DateTime.utc(2026, 11, 16, 5, 0); // 10:00 in Karachi, Monday
      expect(describeNextSlot('2026-11-16', '14:30', now: now), 'Today at 2:30 PM');
      expect(describeNextSlot('2026-11-17', '10:00', now: now), 'Tomorrow at 10:00 AM');
      expect(describeNextSlot('2026-11-20', '10:00', now: now), 'Fri 20 Nov at 10:00 AM');
    });
  });
}
