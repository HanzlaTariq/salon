/// Phase 14 models for the business app (owner and staff). Parsing never throws; a missing rating stays null.
String _s(Map<String, dynamic> j, String k, [String fallback = '']) => j[k] is String ? j[k] as String : fallback;
String? _sn(Map<String, dynamic> j, String k) => j[k] is String ? j[k] as String : null;
int _i(Map<String, dynamic> j, String k, [int fallback = 0]) => j[k] is num ? (j[k] as num).toInt() : fallback;
int? _in(Map<String, dynamic> j, String k) => j[k] is num ? (j[k] as num).toInt() : null;
double? _dn(Map<String, dynamic> j, String k) => j[k] is num ? (j[k] as num).toDouble() : null;
bool _b(Map<String, dynamic> j, String k) => j[k] == true;
List<Map<String, dynamic>> _list(Object? v) => v is List ? v.whereType<Map<String, dynamic>>().toList() : <Map<String, dynamic>>[];
DateTime? _dt(Map<String, dynamic> j, String k) => DateTime.tryParse(_s(j, k));

const int kResponseMax = 500;
const int kReportDetailsMax = 500;

/// Reasons a salon can give when reporting a review (the same codes the server accepts).
const kReportReasons = <String, String>{
  'OFFENSIVE': 'Offensive or abusive',
  'SPAM': 'Spam or advertising',
  'FAKE': 'Fake, not a real visit',
  'PRIVATE_INFO': 'Contains private information',
  'OTHER': 'Other (please explain)',
};

class Rating {
  const Rating({required this.average, required this.count, required this.distribution});
  final double? average;
  final int count;
  final Map<int, int> distribution;

  static const empty = Rating(average: null, count: 0, distribution: {1: 0, 2: 0, 3: 0, 4: 0, 5: 0});

  double share(int stars) => count == 0 ? 0 : (distribution[stars] ?? 0) / count;

  factory Rating.fromJson(Object? v) {
    if (v is! Map<String, dynamic>) return empty;
    final d = v['distribution'];
    return Rating(
      average: _dn(v, 'average'),
      count: _i(v, 'count'),
      distribution: {for (var s = 1; s <= 5; s++) s: d is Map && d['$s'] is num ? (d['$s'] as num).toInt() : 0},
    );
  }
}

class StaffRatingLine {
  const StaffRatingLine({required this.staffId, required this.name, required this.rating});
  final String staffId;
  final String name;
  final Rating rating;
  factory StaffRatingLine.fromJson(Map<String, dynamic> j) => StaffRatingLine(staffId: _s(j, 'staffId'), name: _s(j, 'name'), rating: Rating.fromJson(j));
}

class OwnerSummary {
  const OwnerSummary({required this.rating, required this.unanswered, required this.staff});
  final Rating rating;
  final int unanswered;
  final List<StaffRatingLine> staff;
  factory OwnerSummary.fromJson(Map<String, dynamic> j) =>
      OwnerSummary(rating: Rating.fromJson(j), unanswered: _i(j, 'unanswered'), staff: _list(j['staff']).map(StaffRatingLine.fromJson).toList());
}

class ReviewService {
  const ReviewService({required this.name, required this.rating});
  final String name;
  final int rating;
  factory ReviewService.fromJson(Map<String, dynamic> j) => ReviewService(name: _s(j, 'name'), rating: _i(j, 'rating'));
}

/// A review of the owner's salon. The customer is only ever "Sara K." (no id, e-mail or phone).
class OwnerReview {
  const OwnerReview({
    required this.id,
    required this.authorName,
    required this.rating,
    required this.services,
    required this.reported,
    required this.edited,
    this.staffName,
    this.staffRating,
    this.comment,
    this.response,
    this.responseAt,
    this.visitAt,
    this.createdAt,
  });
  final String id;
  final String authorName;
  final int rating;
  final int? staffRating;
  final String? staffName;
  final String? comment;
  final List<ReviewService> services;
  final String? response;
  final DateTime? responseAt;
  final DateTime? visitAt;
  final DateTime? createdAt;
  final bool reported;
  final bool edited;

  factory OwnerReview.fromJson(Map<String, dynamic> j) {
    final staff = j['staff'] is Map<String, dynamic> ? j['staff'] as Map<String, dynamic> : const <String, dynamic>{};
    final resp = j['response'] is Map<String, dynamic> ? j['response'] as Map<String, dynamic> : null;
    return OwnerReview(
      id: _s(j, 'id'),
      authorName: _s(j, 'authorName', 'Customer'),
      rating: _i(j, 'rating'),
      staffRating: _in(j, 'staffRating'),
      staffName: _sn(staff, 'name'),
      comment: _sn(j, 'comment'),
      services: _list(j['services']).map(ReviewService.fromJson).toList(),
      response: resp == null ? null : _sn(resp, 'text'),
      responseAt: resp == null ? null : _dt(resp, 'at'),
      visitAt: _dt(j, 'visitAt'),
      createdAt: _dt(j, 'createdAt'),
      reported: _b(j, 'reported'),
      edited: _b(j, 'edited'),
    );
  }
}

class OwnerReviewPage {
  const OwnerReviewPage({required this.items, required this.total, required this.page, required this.hasMore});
  final List<OwnerReview> items;
  final int total;
  final int page;
  final bool hasMore;
  factory OwnerReviewPage.fromJson(Map<String, dynamic> j) =>
      OwnerReviewPage(items: _list(j['items']).map(OwnerReview.fromJson).toList(), total: _i(j, 'total'), page: _i(j, 'page', 1), hasMore: _b(j, 'hasMore'));
}

/// What a staff member sees about their own work.
class StaffReview {
  const StaffReview({required this.id, required this.authorName, required this.salonRating, required this.services, this.staffRating, this.comment, this.visitAt});
  final String id;
  final String authorName;
  final int salonRating;
  final int? staffRating;
  final String? comment;
  final List<ReviewService> services;
  final DateTime? visitAt;
  factory StaffReview.fromJson(Map<String, dynamic> j) => StaffReview(
        id: _s(j, 'id'),
        authorName: _s(j, 'authorName', 'Customer'),
        salonRating: _i(j, 'salonRating'),
        staffRating: _in(j, 'staffRating'),
        comment: _sn(j, 'comment'),
        services: _list(j['services']).map(ReviewService.fromJson).toList(),
        visitAt: _dt(j, 'visitAt'),
      );
}

class StaffReviewPage {
  const StaffReviewPage({required this.rating, required this.items, required this.hasMore, required this.page, required this.total});
  final Rating rating;
  final List<StaffReview> items;
  final bool hasMore;
  final int page;
  final int total;
  factory StaffReviewPage.fromJson(Map<String, dynamic> j) => StaffReviewPage(
        rating: Rating.fromJson(j['summary']), items: _list(j['items']).map(StaffReview.fromJson).toList(), hasMore: _b(j, 'hasMore'), page: _i(j, 'page', 1), total: _i(j, 'total'),
      );
}

/// A customer of this salon with the numbers that matter for the owner. Money arrives as a decimal STRING.
class CustomerSummary {
  const CustomerSummary({
    required this.customerId,
    required this.name,
    required this.visits,
    required this.noShows,
    required this.cancelled,
    required this.upcoming,
    required this.totalSpent,
    this.phone,
    this.firstVisitAt,
    this.lastVisitAt,
  });
  final String customerId;
  final String name;
  final String? phone;
  final int visits;
  final int noShows;
  final int cancelled;
  final int upcoming;
  final String totalSpent;
  final DateTime? firstVisitAt;
  final DateTime? lastVisitAt;

  factory CustomerSummary.fromJson(Map<String, dynamic> j) => CustomerSummary(
        customerId: _s(j, 'customerId'),
        name: _s(j, 'name'),
        phone: _sn(j, 'phone'),
        visits: _i(j, 'visits'),
        noShows: _i(j, 'noShows'),
        cancelled: _i(j, 'cancelled'),
        upcoming: _i(j, 'upcoming'),
        totalSpent: _s(j, 'totalSpent', '0'),
        firstVisitAt: _dt(j, 'firstVisitAt'),
        lastVisitAt: _dt(j, 'lastVisitAt'),
      );
}

class CustomerPage {
  const CustomerPage({required this.items, required this.total, required this.page, required this.hasMore});
  final List<CustomerSummary> items;
  final int total;
  final int page;
  final bool hasMore;
  factory CustomerPage.fromJson(Map<String, dynamic> j) =>
      CustomerPage(items: _list(j['items']).map(CustomerSummary.fromJson).toList(), total: _i(j, 'total'), page: _i(j, 'page', 1), hasMore: _b(j, 'hasMore'));
}

class HistoryLine {
  const HistoryLine({required this.id, required this.status, required this.staffName, required this.totalPrice, required this.services, this.startsAt});
  final String id;
  final String status;
  final String staffName;
  final String totalPrice;
  final List<String> services;
  final DateTime? startsAt;
  factory HistoryLine.fromJson(Map<String, dynamic> j) => HistoryLine(
        id: _s(j, 'id'),
        status: _s(j, 'status'),
        staffName: _s(j, 'staffName'),
        totalPrice: _s(j, 'totalPrice', '0'),
        services: j['services'] is List ? (j['services'] as List).whereType<String>().toList() : <String>[],
        startsAt: _dt(j, 'startsAt'),
      );
}

class CustomerDetail {
  const CustomerDetail({required this.summary, required this.history, required this.reviews});
  final CustomerSummary summary;
  final List<HistoryLine> history;
  final List<OwnerReview> reviews;
  factory CustomerDetail.fromJson(Map<String, dynamic> j) => CustomerDetail(
        summary: CustomerSummary.fromJson(j), history: _list(j['history']).map(HistoryLine.fromJson).toList(), reviews: _list(j['reviews']).map(OwnerReview.fromJson).toList(),
      );
}

String ratingText(double? average, int count) => average == null || count <= 0 ? 'No reviews yet' : '${average.toStringAsFixed(1)} ($count ${count == 1 ? 'review' : 'reviews'})';

/// "450.00" -> "Rs. 450", "1200.5" -> "Rs. 1,200.50". Money is never parsed into a float for storage, only for display.
String pkrText(String amount) {
  final v = double.tryParse(amount);
  if (v == null) return 'Rs. $amount';
  final whole = v == v.truncateToDouble();
  final parts = (whole ? v.toStringAsFixed(0) : v.toStringAsFixed(2)).split('.');
  final digits = parts.first;
  final b = StringBuffer();
  for (var i = 0; i < digits.length; i++) {
    final fromEnd = digits.length - i;
    b.write(digits[i]);
    if (fromEnd > 1 && fromEnd % 3 == 1) b.write(',');
  }
  return 'Rs. $b${parts.length > 1 ? '.${parts[1]}' : ''}';
}

/// Why a response / report text cannot be sent (null when fine). Same rules as the server.
String? textProblem(String text, {required int max, bool required = true}) {
  final t = text.trim();
  if (t.isEmpty) return required ? 'Please write something.' : null;
  if (t.length > max) return 'Please keep it under $max characters.';
  if (t.contains('<') || t.contains('>')) return 'The characters < and > are not allowed.';
  return null;
}

String dateText(DateTime? d) {
  if (d == null) return '-';
  const m = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  final l = d.toLocal();
  return '${l.day} ${m[l.month - 1]} ${l.year}';
}
