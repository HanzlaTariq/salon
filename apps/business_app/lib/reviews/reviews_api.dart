import 'dart:convert';

import 'package:flutter_core/flutter_core.dart';
import 'package:http/http.dart' as http;

import 'reviews_models.dart';

/// Client for the Phase 14 salon-side endpoints. The salon id, staff id and customer ownership are NEVER sent by the app:
/// the server derives them from the session. Reviews need a connection (the offline-first screens of Phase 12 are unaffected).
class ReviewsApi {
  ReviewsApi({required this.repository, http.Client? client, String? baseUrl})
      : _client = client ?? http.Client(),
        _base = (baseUrl ?? AuthConfig.apiBaseUrl).replaceAll(RegExp(r'/+$'), '');

  final AuthRepository repository;
  final http.Client _client;
  final String _base;

  // ---- owner
  Future<OwnerSummary> summary() async => OwnerSummary.fromJson(await _json('GET', '/salons/mine/reviews/summary'));

  Future<OwnerReviewPage> reviews({int page = 1, bool unansweredOnly = false, int? rating}) async =>
      OwnerReviewPage.fromJson(await _json('GET', '/salons/mine/reviews?page=$page&pageSize=20${unansweredOnly ? '&unanswered=true' : ''}${rating == null ? '' : '&rating=$rating'}'));

  Future<OwnerReview> respond(String reviewId, String text) async => OwnerReview.fromJson(await _json('PUT', '/salons/mine/reviews/$reviewId/response', {'text': text.trim()}));

  Future<void> removeResponse(String reviewId) async => _json('DELETE', '/salons/mine/reviews/$reviewId/response');

  Future<void> report(String reviewId, {required String reason, String? details}) async =>
      _json('POST', '/salons/mine/reviews/$reviewId/report', {'reason': reason, if (details != null && details.trim().isNotEmpty) 'details': details.trim()});

  Future<CustomerPage> customers({int page = 1, String? query, String sort = 'recent'}) async {
    final q = Uri(queryParameters: {'page': '$page', 'pageSize': '20', 'sort': sort, if (query != null && query.trim().isNotEmpty) 'q': query.trim()}).query;
    return CustomerPage.fromJson(await _json('GET', '/salons/mine/customers?$q'));
  }

  Future<CustomerDetail> customer(String customerId) async => CustomerDetail.fromJson(await _json('GET', '/salons/mine/customers/$customerId'));

  // ---- staff
  Future<StaffReviewPage> myStaffReviews({int page = 1}) async => StaffReviewPage.fromJson(await _json('GET', '/staff/me/reviews?page=$page&pageSize=20'));

  // ---- plumbing
  Future<Map<String, dynamic>> _json(String method, String path, [Map<String, dynamic>? body]) {
    return repository.authorized((token) async {
      http.Response res;
      try {
        final request = http.Request(method, Uri.parse('$_base$path'))
          ..headers.addAll({'Authorization': 'Bearer $token', 'Accept': 'application/json', 'X-Client-Type': 'mobile', if (body != null) 'Content-Type': 'application/json'});
        if (body != null) request.body = jsonEncode(body);
        res = await http.Response.fromStream(await _client.send(request)).timeout(const Duration(seconds: 20));
      } catch (_) {
        throw ApiException.network();
      }
      if (res.statusCode < 200 || res.statusCode >= 300) throw ApiException.fromResponse(res.statusCode, res.body);
      if (res.statusCode == 204 || res.body.isEmpty) return const <String, dynamic>{};
      final decoded = jsonDecode(res.body);
      final data = decoded is Map<String, dynamic> ? decoded['data'] : null;
      if (data is! Map<String, dynamic>) throw ApiException.fromResponse(500, '');
      return data;
    });
  }

  void close() => _client.close();
}
