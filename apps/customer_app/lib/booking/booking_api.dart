import 'dart:convert';
import 'dart:math';

import 'package:flutter_core/flutter_core.dart';
import 'package:http/http.dart' as http;

import 'booking_models.dart';

/// A random key (32 hex characters). Sent as `Idempotency-Key`, so a retry of the SAME booking request after a network
/// failure returns the original booking instead of creating a second one.
String newIdempotencyKey([Random? random]) {
  final r = random ?? Random.secure();
  return List<int>.generate(16, (_) => r.nextInt(256)).map((b) => b.toRadixString(16).padLeft(2, '0')).join();
}

/// Customer booking client. Every call goes through [AuthRepository.authorized] (single-flight token refresh).
/// The app sends only WHAT and WHEN: price, duration and names are always decided by the server.
class BookingApi {
  BookingApi({required this.repository, http.Client? client, String? baseUrl})
      : _client = client ?? http.Client(),
        _base = (baseUrl ?? AuthConfig.apiBaseUrl).replaceAll(RegExp(r'/+$'), '');

  final AuthRepository repository;
  final http.Client _client;
  final String _base;

  Future<Booking> create({
    required String salonId,
    required String staffId,
    required List<String> serviceIds,
    required String date,
    required String time,
    required String idempotencyKey,
    String? note,
  }) async =>
      Booking.fromJson(await _data('POST', '/bookings', {
        'salonId': salonId,
        'staffId': staffId,
        'serviceIds': serviceIds,
        'date': date,
        'time': time,
        if (note != null && note.trim().isNotEmpty) 'note': note.trim(),
      }, headers: {'Idempotency-Key': idempotencyKey}));

  Future<BookingPage> list({String scope = 'upcoming'}) async =>
      BookingPage.fromJson(await _data('GET', '/bookings', null, query: {'scope': scope, 'pageSize': '50'}));

  Future<Booking> get(String id) async => Booking.fromJson(await _data('GET', '/bookings/$id'));

  Future<Booking> cancel(String id, {String? reason}) async =>
      Booking.fromJson(await _data('POST', '/bookings/$id/cancel', {if (reason != null && reason.trim().isNotEmpty) 'reason': reason.trim()}));

  Future<Booking> reschedule(String id, {required String date, required String time}) async =>
      Booking.fromJson(await _data('POST', '/bookings/$id/reschedule', {'date': date, 'time': time}));

  Future<Map<String, dynamic>> _data(String method, String path, [Map<String, dynamic>? body, Map<String, String>? query, Map<String, String> headers = const {}]) async {
    final res = await repository.authorized((token) => _raw(method, path, body, query, {...headers, 'Authorization': 'Bearer $token'}));
    final decoded = res.body.isEmpty ? null : jsonDecode(res.body);
    final data = decoded is Map<String, dynamic> ? decoded['data'] : null;
    if (data is! Map<String, dynamic>) throw ApiException.fromResponse(500, '');
    return data;
  }

  Future<http.Response> _raw(String method, String path, Map<String, dynamic>? body, Map<String, String>? query, Map<String, String> headers) async {
    http.Response res;
    try {
      final uri = Uri.parse('$_base$path').replace(queryParameters: query == null || query.isEmpty ? null : query);
      final request = http.Request(method, uri)
        ..headers.addAll({
          ...headers,
          'Accept': 'application/json',
          'X-Client-Type': 'mobile',
          if (body != null) 'Content-Type': 'application/json',
        });
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
