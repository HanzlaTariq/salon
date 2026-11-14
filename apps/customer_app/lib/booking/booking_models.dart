String _s(Map<String, dynamic> j, String k, [String fallback = '']) => j[k] is String ? j[k] as String : fallback;
String? _sn(Map<String, dynamic> j, String k) => j[k] is String ? j[k] as String : null;
int _i(Map<String, dynamic> j, String k, [int fallback = 0]) => j[k] is num ? (j[k] as num).toInt() : fallback;
bool _b(Map<String, dynamic> j, String k) => j[k] == true;
List<Map<String, dynamic>> _list(Object? v) => v is List ? v.whereType<Map<String, dynamic>>().toList() : <Map<String, dynamic>>[];

/// One booked service. Price and duration are the SNAPSHOT taken at booking time.
class BookingLine {
  const BookingLine({required this.serviceId, required this.name, required this.durationMinutes, required this.price});
  final String serviceId;
  final String name;
  final int durationMinutes;
  final String price;

  factory BookingLine.fromJson(Map<String, dynamic> j) => BookingLine(
        serviceId: _s(j, 'serviceId'),
        name: _s(j, 'name'),
        durationMinutes: _i(j, 'durationMinutes'),
        price: _s(j, 'price', '0'),
      );
}

/// A customer's own booking. `canCancel` / `canReschedule` come from the server (salon policy); the app never decides.
class Booking {
  const Booking({
    required this.id,
    required this.status,
    required this.salonId,
    required this.salonName,
    required this.staffId,
    required this.staffName,
    required this.date,
    required this.time,
    required this.endTime,
    required this.durationMinutes,
    required this.totalPrice,
    required this.services,
    required this.note,
    required this.rescheduleCount,
    required this.reschedulesLeft,
    required this.canCancel,
    required this.canReschedule,
    required this.cancelBefore,
    required this.cancelledBy,
    required this.cancellationReason,
  });

  final String id;
  /// CONFIRMED, CANCELLED, COMPLETED, NO_SHOW, IN_PROGRESS, DELAYED, PENDING.
  final String status;
  final String salonId;
  final String salonName;
  final String staffId;
  final String staffName;

  /// Karachi date (YYYY-MM-DD) and clock (HH:MM) of the start and the end.
  final String date;
  final String time;
  final String endTime;
  final int durationMinutes;
  final String totalPrice;
  final List<BookingLine> services;
  final String? note;
  final int rescheduleCount;
  final int reschedulesLeft;
  final bool canCancel;
  final bool canReschedule;
  final String? cancelBefore;
  final String? cancelledBy;
  final String? cancellationReason;

  bool get isOpen => status == 'CONFIRMED' || status == 'PENDING' || status == 'IN_PROGRESS' || status == 'DELAYED';

  factory Booking.fromJson(Map<String, dynamic> j) {
    final salon = j['salon'] is Map<String, dynamic> ? j['salon'] as Map<String, dynamic> : <String, dynamic>{};
    final staff = j['staff'] is Map<String, dynamic> ? j['staff'] as Map<String, dynamic> : <String, dynamic>{};
    final cancellation = j['cancellation'] is Map<String, dynamic> ? j['cancellation'] as Map<String, dynamic> : null;
    return Booking(
      id: _s(j, 'id'),
      status: _s(j, 'status'),
      salonId: _s(salon, 'id'),
      salonName: _s(salon, 'name'),
      staffId: _s(staff, 'id'),
      staffName: _s(staff, 'name'),
      date: _s(j, 'date'),
      time: _s(j, 'time'),
      endTime: _s(j, 'endTime'),
      durationMinutes: _i(j, 'durationMinutes'),
      totalPrice: _s(j, 'totalPrice', '0'),
      services: _list(j['services']).map(BookingLine.fromJson).toList(),
      note: _sn(j, 'note'),
      rescheduleCount: _i(j, 'rescheduleCount'),
      reschedulesLeft: _i(j, 'reschedulesLeft'),
      canCancel: _b(j, 'canCancel'),
      canReschedule: _b(j, 'canReschedule'),
      cancelBefore: _sn(j, 'cancelBefore'),
      cancelledBy: cancellation == null ? null : _sn(cancellation, 'by'),
      cancellationReason: cancellation == null ? null : _sn(cancellation, 'reason'),
    );
  }
}

class BookingPage {
  const BookingPage({required this.items, required this.total, required this.hasMore});
  final List<Booking> items;
  final int total;
  final bool hasMore;

  factory BookingPage.fromJson(Map<String, dynamic> j) => BookingPage(
        items: _list(j['items']).map(Booking.fromJson).toList(),
        total: _i(j, 'total'),
        hasMore: _b(j, 'hasMore'),
      );
}

/// "CONFIRMED" -> "Confirmed", "NO_SHOW" -> "No show".
String statusLabel(String status) {
  final words = status.toLowerCase().split('_');
  if (words.isEmpty || words.first.isEmpty) return status;
  final text = words.join(' ');
  return text[0].toUpperCase() + text.substring(1);
}
