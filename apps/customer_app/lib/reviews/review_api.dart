import 'dart:convert';

import 'package:flutter_core/flutter_core.dart';
import 'package:http/http.dart' as http;

import 'review_models.dart';

/// Reviews and favourites client. Every call goes through [AuthRepository.authorized] (single-flight token refresh).
/// The app sends only WHAT the customer says (ratings, comment); salon, staff and visit data are decided by the server.
class ReviewApi {
  ReviewApi({required this.repository, http.Client? client, String? baseUrl})
      : _client = client ?? http.Client(),
        _base = (baseUrl ?? AuthConfig.apiBaseUrl).replaceAll(RegExp(r'/+$'), '');

  final AuthRepository repository;
  final http.Client _client;
  final String _base;

  Future<SalonReviewsPage> salonReviews(String salonId, {String sort = 'recent', int page = 1, int pageSize = 20}) async =>
      SalonReviewsPage.fromJson(await _data('GET', '/public/discovery/salons/$salonId/reviews', query: {'sort': sort, 'page': '$page', 'pageSize': '$pageSize'}));

  Future<MyReviewsPage> myReviews({int page = 1}) async => MyReviewsPage.fromJson(await _data('GET', '/customers/me/reviews', query: {'page': '$page', 'pageSize': '20'}));

  Future<List<PendingReview>> pending() async {
    final data = await _data('GET', '/customers/me/reviews/pending');
    final items = data['items'];
    return items is List ? items.whereType<Map<String, dynamic>>().map(PendingReview.fromJson).toList() : <PendingReview>[];
  }

  Future<MyReview> create({
    required String appointmentId,
    required int salonRating,
    int? staffRating,
    String? comment,
    Map<String, int> serviceRatings = const {},
  }) async =>
      MyReview.fromJson(await _data('POST', '/customers/me/reviews', body: {
        'appointmentId': appointmentId,
        'salonRating': salonRating,
        if (staffRating != null) 'staffRating': staffRating,
        if (cleanComment(comment) != null) 'comment': cleanComment(comment),
        if (serviceRatings.isNotEmpty) 'services': [for (final e in serviceRatings.entries) {'serviceId': e.key, 'rating': e.value}],
      }));

  /// Sends the full new state of the three editable fields (`null` clears the staff rating / the comment).
  Future<MyReview> update(String id, {required int salonRating, int? staffRating, String? comment}) async =>
      MyReview.fromJson(await _data('PATCH', '/customers/me/reviews/$id', body: {'salonRating': salonRating, 'staffRating': staffRating, 'comment': cleanComment(comment)}));

  Future<List<FavouriteSalon>> favourites() async {
    final data = await _data('GET', '/customers/me/favourites');
    final items = data['items'];
    return items is List ? items.whereType<Map<String, dynamic>>().map(FavouriteSalon.fromJson).toList() : <FavouriteSalon>[];
  }

  Future<void> addFavourite(String salonId) async => _data('PUT', '/customers/me/favourites/$salonId');

  Future<void> removeFavourite(String salonId) async => _data('DELETE', '/customers/me/favourites/$salonId', expectBody: false);

  Future<Map<String, dynamic>> _data(String method, String path, {Map<String, dynamic>? body, Map<String, String>? query, bool expectBody = true}) async {
    final res = await repository.authorized((token) => _raw(method, path, body, query, {'Authorization': 'Bearer $token'}));
    if (!expectBody || res.body.isEmpty) return const <String, dynamic>{};
    final decoded = jsonDecode(res.body);
    final data = decoded is Map<String, dynamic> ? decoded['data'] : null;
    if (data is! Map<String, dynamic>) throw ApiException.fromResponse(500, '');
    return data;
  }

  Future<http.Response> _raw(String method, String path, Map<String, dynamic>? body, Map<String, String>? query, Map<String, String> headers) async {
    http.Response res;
    try {
      final uri = Uri.parse('$_base$path').replace(queryParameters: query == null || query.isEmpty ? null : query);
      final request = http.Request(method, uri)
        ..headers.addAll({...headers, 'Accept': 'application/json', 'X-Client-Type': 'mobile', if (body != null) 'Content-Type': 'application/json'});
      if (body != null) request.body = jsonEncode(body);
      res = await http.Response.fromStream(await _client.send(request)).timeout(const Duration(seconds: 20));
    } catch (_) {
      throw ApiException.network();
    }
    if (res.statusCode < 200 || res.statusCode >= 300) throw ApiException.fromResponse(res.statusCode, res.body);
    return res;
  }

  void close() => _client.close();
}
