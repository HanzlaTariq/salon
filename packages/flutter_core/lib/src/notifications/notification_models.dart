/// Phase 10 models. They mirror the API (`{ data: ... }` envelopes are unwrapped by [NotificationApi]).
class AppNotification {
  const AppNotification({
    required this.id,
    required this.type,
    required this.category,
    required this.title,
    required this.body,
    required this.data,
    required this.createdAt,
    this.readAt,
  });

  final String id;
  final String type;
  final String category;
  final String title;
  final String body;

  /// Deep-link hints: `route` ("booking", "queue", "salon", "billing", "team", "schedule") and ids such as `appointmentId`.
  final Map<String, String> data;
  final DateTime createdAt;
  final DateTime? readAt;

  bool get isUnread => readAt == null;
  String? get route => data['route'];
  String? get appointmentId => data['appointmentId'];

  AppNotification markedRead(DateTime at) => AppNotification(
        id: id,
        type: type,
        category: category,
        title: title,
        body: body,
        data: data,
        createdAt: createdAt,
        readAt: readAt ?? at,
      );

  factory AppNotification.fromJson(Map<String, dynamic> j) {
    final raw = j['data'];
    final data = <String, String>{};
    if (raw is Map) {
      raw.forEach((key, value) {
        if (value != null) data[key.toString()] = value.toString();
      });
    }
    return AppNotification(
      id: j['id'] as String,
      type: j['type'] as String? ?? '',
      category: j['category'] as String? ?? '',
      title: j['title'] as String? ?? '',
      body: j['body'] as String? ?? '',
      data: data,
      createdAt: DateTime.tryParse(j['createdAt'] as String? ?? '')?.toLocal() ?? DateTime.now(),
      readAt: j['readAt'] == null ? null : DateTime.tryParse(j['readAt'] as String)?.toLocal(),
    );
  }
}

class NotificationPage {
  const NotificationPage({required this.items, required this.nextCursor, required this.unreadCount});

  final List<AppNotification> items;
  final String? nextCursor;
  final int unreadCount;

  factory NotificationPage.fromJson(Map<String, dynamic> j) => NotificationPage(
        items: ((j['items'] as List<dynamic>?) ?? const []).map((e) => AppNotification.fromJson(e as Map<String, dynamic>)).toList(),
        nextCursor: j['nextCursor'] as String?,
        unreadCount: (j['unreadCount'] as num?)?.toInt() ?? 0,
      );
}

/// Reminder times in minutes before the appointment (0 = at the appointment time).
const List<int> kReminderOffsets = [30, 20, 10, 0];

class NotificationPrefs {
  const NotificationPrefs({
    this.pushEnabled = true,
    this.language = 'en',
    this.bookings = true,
    this.reminders = true,
    this.queue = true,
    this.team = true,
    this.reminderOffsets = kReminderOffsets,
  });

  final bool pushEnabled;

  /// `en` or `ur`: the language of every notification the server writes for this person.
  final String language;
  final bool bookings;
  final bool reminders;
  final bool queue;
  final bool team;
  final List<int> reminderOffsets;

  NotificationPrefs copyWith({bool? pushEnabled, String? language, bool? bookings, bool? reminders, bool? queue, bool? team, List<int>? reminderOffsets}) =>
      NotificationPrefs(
        pushEnabled: pushEnabled ?? this.pushEnabled,
        language: language ?? this.language,
        bookings: bookings ?? this.bookings,
        reminders: reminders ?? this.reminders,
        queue: queue ?? this.queue,
        team: team ?? this.team,
        reminderOffsets: reminderOffsets ?? this.reminderOffsets,
      );

  factory NotificationPrefs.fromJson(Map<String, dynamic> j) => NotificationPrefs(
        pushEnabled: j['pushEnabled'] as bool? ?? true,
        language: j['language'] as String? ?? 'en',
        bookings: j['bookings'] as bool? ?? true,
        reminders: j['reminders'] as bool? ?? true,
        queue: j['queue'] as bool? ?? true,
        team: j['team'] as bool? ?? true,
        reminderOffsets: ((j['reminderOffsets'] as List<dynamic>?) ?? kReminderOffsets).map((e) => (e as num).toInt()).toList(),
      );

  Map<String, dynamic> toJson() => {
        'pushEnabled': pushEnabled,
        'language': language,
        'bookings': bookings,
        'reminders': reminders,
        'queue': queue,
        'team': team,
        'reminderOffsets': reminderOffsets,
      };
}

/// "now", "5 min ago", "3 h ago", "yesterday", "12 Nov". Pure, so it is unit-tested.
String timeAgo(DateTime at, DateTime now) {
  final diff = now.difference(at);
  if (diff.inSeconds < 60) return 'now';
  if (diff.inMinutes < 60) return '${diff.inMinutes} min ago';
  if (diff.inHours < 24) return '${diff.inHours} h ago';
  if (diff.inDays == 1) return 'yesterday';
  if (diff.inDays < 7) return '${diff.inDays} days ago';
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return '${at.day} ${months[at.month - 1]}';
}

/// True when the text is mostly Arabic-script (Urdu), so it is laid out right-to-left.
bool looksRtl(String text) {
  var rtl = 0;
  var latin = 0;
  for (final r in text.runes) {
    if (r >= 0x0600 && r <= 0x06FF) {
      rtl++;
    } else if ((r >= 0x41 && r <= 0x5A) || (r >= 0x61 && r <= 0x7A)) {
      latin++;
    }
  }
  return rtl > latin;
}
