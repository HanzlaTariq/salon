/// Phase 14 models for the customer app. Parsing never throws: missing or odd values become honest defaults / nulls
/// (a missing rating stays null, it is never shown as a number the server did not send).
String _s(Map<String, dynamic> j, String k, [String fallback = '']) => j[k] is String ? j[k] as String : fallback;
String? _sn(Map<String, dynamic> j, String k) => j[k] is String ? j[k] as String : null;
int _i(Map<String, dynamic> j, String k, [int fallback = 0]) => j[k] is num ? (j[k] as num).toInt() : fallback;
int? _in(Map<String, dynamic> j, String k) => j[k] is num ? (j[k] as num).toInt() : null;
double? _dn(Map<String, dynamic> j, String k) => j[k] is num ? (j[k] as num).toDouble() : null;
bool _b(Map<String, dynamic> j, String k) => j[k] == true;
List<Map<String, dynamic>> _list(Object? v) => v is List ? v.whereType<Map<String, dynamic>>().toList() : <Map<String, dynamic>>[];
DateTime? _dt(Map<String, dynamic> j, String k) => DateTime.tryParse(_s(j, k));

/// A valid star value is a whole number from 1 to 5.
bool isValidStars(int? v) => v != null && v >= 1 && v <= 5;

/// Longest comment the server accepts.
const int kReviewCommentMax = 1000;

/// Average, number of reviews and how many reviews each star got (keys 1 to 5).
class RatingSummary {
  const RatingSummary({required this.average, required this.count, required this.distribution});
  final double? average;
  final int count;
  final Map<int, int> distribution;

  static const empty = RatingSummary(average: null, count: 0, distribution: {1: 0, 2: 0, 3: 0, 4: 0, 5: 0});

  /// Share (0..1) of reviews with this many stars; 0 when there are no reviews.
  double share(int stars) => count == 0 ? 0 : (distribution[stars] ?? 0) / count;

  factory RatingSummary.fromJson(Object? v) {
    if (v is! Map<String, dynamic>) return empty;
    final d = v['distribution'];
    final map = <int, int>{for (var s = 1; s <= 5; s++) s: d is Map && d['$s'] is num ? (d['$s'] as num).toInt() : 0};
    return RatingSummary(average: _dn(v, 'average'), count: _i(v, 'count'), distribution: map);
  }
}

class ServiceRating {
  const ServiceRating({required this.serviceId, required this.name, required this.rating});
  final String serviceId;
  final String name;
  final int rating;
  factory ServiceRating.fromJson(Map<String, dynamic> j) => ServiceRating(serviceId: _s(j, 'serviceId'), name: _s(j, 'name'), rating: _i(j, 'rating'));
}

class OwnerResponse {
  const OwnerResponse({required this.text, this.at});
  final String text;
  final DateTime? at;
  static OwnerResponse? fromJson(Object? v) => v is Map<String, dynamic> && _s(v, 'text').isNotEmpty ? OwnerResponse(text: _s(v, 'text'), at: _dt(v, 'at')) : null;
}

/// A review as the public sees it (no ids, no private data).
class PublicReview {
  const PublicReview({
    required this.id,
    required this.authorName,
    required this.rating,
    required this.services,
    required this.edited,
    this.staffRating,
    this.staffName,
    this.comment,
    this.response,
    this.createdAt,
  });
  final String id;
  final String authorName;
  final int rating;
  final int? staffRating;
  final String? staffName;
  final String? comment;
  final List<ServiceRating> services;
  final OwnerResponse? response;
  final DateTime? createdAt;
  final bool edited;

  factory PublicReview.fromJson(Map<String, dynamic> j) => PublicReview(
        id: _s(j, 'id'),
        authorName: _s(j, 'authorName', 'Customer'),
        rating: _i(j, 'rating'),
        staffRating: _in(j, 'staffRating'),
        staffName: _sn(j, 'staffName'),
        comment: _sn(j, 'comment'),
        services: _list(j['services']).map(ServiceRating.fromJson).toList(),
        response: OwnerResponse.fromJson(j['response']),
        createdAt: _dt(j, 'createdAt'),
        edited: _b(j, 'edited'),
      );
}

class StaffRatingSummary {
  const StaffRatingSummary({required this.staffId, required this.name, required this.summary});
  final String staffId;
  final String name;
  final RatingSummary summary;
  factory StaffRatingSummary.fromJson(Map<String, dynamic> j) =>
      StaffRatingSummary(staffId: _s(j, 'staffId'), name: _s(j, 'name'), summary: RatingSummary.fromJson(j));
}

class SalonReviewsPage {
  const SalonReviewsPage({required this.summary, required this.staff, required this.items, required this.page, required this.total, required this.hasMore});
  final RatingSummary summary;
  final List<StaffRatingSummary> staff;
  final List<PublicReview> items;
  final int page;
  final int total;
  final bool hasMore;

  factory SalonReviewsPage.fromJson(Map<String, dynamic> j) => SalonReviewsPage(
        summary: RatingSummary.fromJson(j['summary']),
        staff: _list(j['staff']).map(StaffRatingSummary.fromJson).toList(),
        items: _list(j['items']).map(PublicReview.fromJson).toList(),
        page: _i(j, 'page', 1),
        total: _i(j, 'total'),
        hasMore: _b(j, 'hasMore'),
      );
}

/// The author's own review. `canEdit` and `editableUntil` come from the server (7-day window).
class MyReview {
  const MyReview({
    required this.id,
    required this.appointmentId,
    required this.salonId,
    required this.salonName,
    required this.rating,
    required this.status,
    required this.services,
    required this.edited,
    required this.canEdit,
    this.staffName,
    this.staffRating,
    this.comment,
    this.hiddenReason,
    this.response,
    this.visitAt,
    this.createdAt,
    this.editableUntil,
  });
  final String id;
  final String appointmentId;
  final String salonId;
  final String salonName;
  final String? staffName;
  final int rating;
  final int? staffRating;
  final String? comment;
  final List<ServiceRating> services;

  /// PUBLISHED or HIDDEN (hidden by the platform; `hiddenReason` says why).
  final String status;
  final String? hiddenReason;
  final OwnerResponse? response;
  final DateTime? visitAt;
  final DateTime? createdAt;
  final DateTime? editableUntil;
  final bool edited;
  final bool canEdit;

  bool get isHidden => status == 'HIDDEN';

  factory MyReview.fromJson(Map<String, dynamic> j) {
    final salon = j['salon'] is Map<String, dynamic> ? j['salon'] as Map<String, dynamic> : const <String, dynamic>{};
    final staff = j['staff'] is Map<String, dynamic> ? j['staff'] as Map<String, dynamic> : const <String, dynamic>{};
    return MyReview(
      id: _s(j, 'id'),
      appointmentId: _s(j, 'appointmentId'),
      salonId: _s(salon, 'id'),
      salonName: _s(salon, 'name'),
      staffName: _sn(staff, 'name'),
      rating: _i(j, 'rating'),
      staffRating: _in(j, 'staffRating'),
      comment: _sn(j, 'comment'),
      services: _list(j['services']).map(ServiceRating.fromJson).toList(),
      status: _s(j, 'status', 'PUBLISHED'),
      hiddenReason: _sn(j, 'hiddenReason'),
      response: OwnerResponse.fromJson(j['response']),
      visitAt: _dt(j, 'visitAt'),
      createdAt: _dt(j, 'createdAt'),
      editableUntil: _dt(j, 'editableUntil'),
      edited: _b(j, 'edited'),
      canEdit: _b(j, 'canEdit'),
    );
  }
}

class MyReviewsPage {
  const MyReviewsPage({required this.items, required this.total, required this.hasMore, required this.page});
  final List<MyReview> items;
  final int total;
  final bool hasMore;
  final int page;
  factory MyReviewsPage.fromJson(Map<String, dynamic> j) =>
      MyReviewsPage(items: _list(j['items']).map(MyReview.fromJson).toList(), total: _i(j, 'total'), hasMore: _b(j, 'hasMore'), page: _i(j, 'page', 1));
}

class ReviewableService {
  const ReviewableService({required this.serviceId, required this.name});
  final String serviceId;
  final String name;
}

/// A completed visit that can still be reviewed.
class PendingReview {
  const PendingReview({required this.appointmentId, required this.salonId, required this.salonName, required this.staffName, required this.services, this.visitAt, this.reviewBefore});
  final String appointmentId;
  final String salonId;
  final String salonName;
  final String staffName;
  final List<ReviewableService> services;
  final DateTime? visitAt;
  final DateTime? reviewBefore;

  factory PendingReview.fromJson(Map<String, dynamic> j) {
    final salon = j['salon'] is Map<String, dynamic> ? j['salon'] as Map<String, dynamic> : const <String, dynamic>{};
    final staff = j['staff'] is Map<String, dynamic> ? j['staff'] as Map<String, dynamic> : const <String, dynamic>{};
    return PendingReview(
      appointmentId: _s(j, 'appointmentId'),
      salonId: _s(salon, 'id'),
      salonName: _s(salon, 'name'),
      staffName: _s(staff, 'name'),
      services: _list(j['services']).map((s) => ReviewableService(serviceId: _s(s, 'serviceId'), name: _s(s, 'name'))).toList(),
      visitAt: _dt(j, 'visitAt'),
      reviewBefore: _dt(j, 'reviewBefore'),
    );
  }
}

class FavouriteSalon {
  const FavouriteSalon({required this.salonId, required this.name, required this.city, required this.area, required this.ratingCount, this.rating, this.coverUrl});
  final String salonId;
  final String name;
  final String city;
  final String area;
  final double? rating;
  final int ratingCount;
  final String? coverUrl;
  factory FavouriteSalon.fromJson(Map<String, dynamic> j) => FavouriteSalon(
        salonId: _s(j, 'salonId'), name: _s(j, 'name'), city: _s(j, 'city'), area: _s(j, 'area'), rating: _dn(j, 'rating'), ratingCount: _i(j, 'ratingCount'), coverUrl: _sn(j, 'coverUrl'),
      );
}

/// "4.3 (12 reviews)", "1 review", or "No reviews yet". Never invents a number.
String ratingLabel(double? average, int count) {
  if (average == null || count <= 0) return 'No reviews yet';
  return '${average.toStringAsFixed(1)} ($count ${count == 1 ? 'review' : 'reviews'})';
}

/// Comment text after trimming, or null when empty. The server applies the same rule.
String? cleanComment(String? text) {
  final t = text?.trim() ?? '';
  return t.isEmpty ? null : t;
}

/// Why a comment cannot be sent (null when fine): too long or containing angle brackets.
String? commentProblem(String? text) {
  final t = cleanComment(text);
  if (t == null) return null;
  if (t.length > kReviewCommentMax) return 'Please keep it under $kReviewCommentMax characters.';
  if (t.contains('<') || t.contains('>')) return 'The characters < and > are not allowed.';
  return null;
}
