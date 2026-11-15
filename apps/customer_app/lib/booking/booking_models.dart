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

/// The salon's forecast when the day runs late. The ORIGINAL time (`Booking.time`) is never replaced by it: both are shown.
class EtaEstimate {
  const EtaEstimate({required this.time, required this.delayMinutes, this.updatedAt});
  /// Karachi clock (HH:MM) of the estimated start.
  final String time;
  final int delayMinutes;
  final DateTime? updatedAt;

  factory EtaEstimate.fromJson(Map<String, dynamic> j) =>
      EtaEstimate(time: _s(j, 'time'), delayMinutes: _i(j, 'delayMinutes'), updatedAt: DateTime.tryParse(_s(j, 'updatedAt')));
}

/// What the customer told the salon ("on my way" / "running late") and when they expect to arrive.
class CustomerEta {
  const CustomerEta({required this.state, this.etaTime});
  /// ON_THE_WAY or RUNNING_LATE.
  final String state;
  final String? etaTime;

  factory CustomerEta.fromJson(Map<String, dynamic> j) => CustomerEta(state: _s(j, 'state'), etaTime: _sn(j, 'etaTime'));
}

/// "Your stylist is free earlier." Nothing changes until the customer accepts; declining costs nothing.
class EarlyOffer {
  const EarlyOffer({required this.id, required this.offeredTime, required this.originalTime, required this.savesMinutes, required this.expiresAt});
  final String id;
  final String offeredTime;
  final String originalTime;
  final int savesMinutes;
  final DateTime? expiresAt;

  factory EarlyOffer.fromJson(Map<String, dynamic> j) => EarlyOffer(
        id: _s(j, 'id'),
        offeredTime: _s(j, 'offeredTime'),
        originalTime: _s(j, 'originalTime'),
        savesMinutes: _i(j, 'savesMinutes'),
        expiresAt: DateTime.tryParse(_s(j, 'expiresAt')),
      );
}

/// Quick ETA choices (minutes). Any whole number from 1 to 120 is accepted by the server.
const kEtaChoices = <int>[5, 10, 15, 20, 30];
const kEtaMaxMinutes = 120;

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
    this.estimate,
    this.customerEta,
    this.earlyOffer,
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

  /// Phase 9: the salon's forecast (null = on time), the customer's own arrival report, and an open early offer.
  final EtaEstimate? estimate;
  final CustomerEta? customerEta;
  final EarlyOffer? earlyOffer;

  /// The salon is running behind: `time` stays the booked time, `estimate.time` is the forecast.
  bool get isDelayed => estimate != null && (status == 'CONFIRMED' || status == 'PENDING');

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
      estimate: j['estimate'] is Map<String, dynamic> ? EtaEstimate.fromJson(j['estimate'] as Map<String, dynamic>) : null,
      customerEta: j['customerEta'] is Map<String, dynamic> ? CustomerEta.fromJson(j['customerEta'] as Map<String, dynamic>) : null,
      earlyOffer: j['earlyOffer'] is Map<String, dynamic> ? EarlyOffer.fromJson(j['earlyOffer'] as Map<String, dynamic>) : null,
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

/// "The salon is running about 10 minutes behind. New estimate: 11:40 (booked for 11:30)." Null when on time.
String? delayMessage(Booking b) {
  final e = b.estimate;
  if (!b.isDelayed || e == null) return null;
  return 'The salon is running about ${e.delayMinutes} minutes behind. Estimated start: ${e.time} (you booked ${b.time}). Your booking is not changed.';
}

/// True for a whole number of minutes the server accepts as an ETA.
bool isValidEta(int? minutes) => minutes != null && minutes >= 1 && minutes <= kEtaMaxMinutes;
