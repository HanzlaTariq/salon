/// Small pure helpers shared by the discovery screens (unit-tested in test/format_test.dart).

/// "300.00" -> "Rs. 300", "150.50" -> "Rs. 150.50". Money always arrives from the API as a decimal STRING.
String formatPkr(String amount) {
  final value = double.tryParse(amount);
  if (value == null) return 'Rs. $amount';
  final whole = value == value.truncateToDouble();
  final text = whole ? value.toStringAsFixed(0) : value.toStringAsFixed(2);
  final parts = text.split('.');
  final digits = parts.first;
  final grouped = StringBuffer();
  for (var i = 0; i < digits.length; i++) {
    final fromEnd = digits.length - i;
    grouped.write(digits[i]);
    if (fromEnd > 1 && fromEnd % 3 == 1) grouped.write(',');
  }
  return 'Rs. ${grouped.toString()}${parts.length > 1 ? '.${parts[1]}' : ''}';
}

/// "Rs. 300" for a single price, "Rs. 300 - Rs. 500" for a range.
String formatPriceRange(String from, String to) => from == to ? formatPkr(from) : '${formatPkr(from)} - ${formatPkr(to)}';

/// 45 -> "45 min", 90 -> "1 h 30 min", 120 -> "2 h".
String formatDuration(int minutes) {
  if (minutes < 60) return '$minutes min';
  final h = minutes ~/ 60;
  final m = minutes % 60;
  return m == 0 ? '$h h' : '$h h $m min';
}

/// "14:30" -> "2:30 PM".
String formatClock(String hhmm) {
  final parts = hhmm.split(':');
  if (parts.length != 2) return hhmm;
  final h = int.tryParse(parts[0]);
  final m = int.tryParse(parts[1]);
  if (h == null || m == null) return hhmm;
  final suffix = h >= 12 ? 'PM' : 'AM';
  final h12 = h % 12 == 0 ? 12 : h % 12;
  return '$h12:${m.toString().padLeft(2, '0')} $suffix';
}

/// Today's calendar date in Pakistan (UTC+5, no daylight saving time). The API counts days in this time zone,
/// so the app does too, whatever time zone the phone is set to.
DateTime karachiToday([DateTime? now]) {
  final k = (now ?? DateTime.now()).toUtc().add(const Duration(hours: 5));
  return DateTime.utc(k.year, k.month, k.day);
}

/// YYYY-MM-DD.
String isoDate(DateTime d) => '${d.year.toString().padLeft(4, '0')}-${d.month.toString().padLeft(2, '0')}-${d.day.toString().padLeft(2, '0')}';

const _weekdays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const _months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/// "Mon" for weekday 1..7 (ISO).
String weekdayShort(int isoWeekday) => _weekdays[(isoWeekday - 1) % 7];

/// "Mon 16 Nov".
String formatDay(DateTime d) => '${_weekdays[d.weekday - 1]} ${d.day} ${_months[d.month - 1]}';

/// "Today at 2:30 PM" / "Tomorrow at ..." / "Mon 16 Nov at ...".
String describeNextSlot(String date, String time, {DateTime? now}) {
  final today = karachiToday(now);
  final d = DateTime.tryParse('${date}T00:00:00Z');
  if (d == null) return '$date ${formatClock(time)}';
  final diff = d.difference(today).inDays;
  final day = diff == 0 ? 'Today' : diff == 1 ? 'Tomorrow' : formatDay(d);
  return '$day at ${formatClock(time)}';
}
