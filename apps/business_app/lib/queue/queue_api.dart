import 'dart:convert';

import 'package:flutter_core/flutter_core.dart';
import 'package:http/http.dart' as http;

import 'queue_models.dart';

/// Client for the Phase 9 queue endpoints.
///
/// Owner and staff share one client: [owner] selects the route prefix (`/salons/mine` or `/staff/me`). Neither the salon id nor
/// the staff id of a staff member is ever sent for a staff account: the server derives them from the session.
class QueueApi {
  QueueApi({required this.repository, http.Client? client, String? baseUrl})
      : _client = client ?? http.Client(),
        _base = (baseUrl ?? AuthConfig.apiBaseUrl).replaceAll(RegExp(r'/+$'), '');

  final AuthRepository repository;
  final http.Client _client;
  final String _base;

  String _prefix(bool owner) => owner ? '/salons/mine' : '/staff/me';

  Future<QueueSnapshot> queue({required bool owner}) async => QueueSnapshot.fromJson(await _data('GET', '${_prefix(owner)}/queue'));

  /// The services a staff member offers (staff: themselves; owner: `staffId`). Feeds the walk-in form.
  Future<List<OfferedService>> services({required bool owner, String? staffId}) async {
    final data = await _data('GET', '${_prefix(owner)}/queue/services${owner && staffId != null ? '?staffId=$staffId' : ''}');
    return (data['items'] is List ? data['items'] as List : const []).whereType<Map<String, dynamic>>().map(OfferedService.fromJson).toList();
  }

  Future<void> start(String id, {required bool owner}) => _data('POST', '${_prefix(owner)}/appointments/$id/start', const {});

  Future<void> complete(String id, {required bool owner}) => _data('POST', '${_prefix(owner)}/appointments/$id/complete', const {});

  Future<void> noShow(String id, {required bool owner, String? reason}) =>
      _data('POST', '${_prefix(owner)}/appointments/$id/no-show', {if (reason != null && reason.trim().isNotEmpty) 'reason': reason.trim()});

  /// Starts the next customer. `completeCurrent` is true ONLY after the person confirmed the warning.
  Future<void> next({required bool owner, String? staffId, bool completeCurrent = false}) => _data('POST', '${_prefix(owner)}/queue/next', {
        if (owner && staffId != null) 'staffId': staffId,
        if (completeCurrent) 'completeCurrent': true,
      });

  /// Price and duration come from the catalogue on the server; only names, the phone and the service ids are sent.
  /// The same [idempotencyKey] on a retry returns the same walk-in instead of a second one.
  Future<void> addWalkIn({
    required bool owner,
    String? staffId,
    required String customerName,
    String? phone,
    required List<String> serviceIds,
    String? note,
    required String idempotencyKey,
  }) =>
      _data(
        'POST',
        '${_prefix(owner)}/walk-ins',
        {
          if (owner && staffId != null) 'staffId': staffId,
          'customerName': customerName.trim(),
          if (phone != null && phone.trim().isNotEmpty) 'phone': phone.trim(),
          'serviceIds': serviceIds,
          if (note != null && note.trim().isNotEmpty) 'note': note.trim(),
        },
        {'Idempotency-Key': idempotencyKey},
      );

  /// Sends "your stylist is free earlier" to the customer. `time` (HH:MM) is optional: the server picks the earliest possible time.
  Future<void> offerEarly(String id, {required bool owner, String? time}) =>
      _data('POST', '${_prefix(owner)}/appointments/$id/early-offer', {if (time != null) 'time': time});

  Future<void> withdrawOffer(String id, {required bool owner}) => _data('DELETE', '${_prefix(owner)}/appointments/$id/early-offer');

  Future<Map<String, dynamic>> _data(String method, String path, [Map<String, dynamic>? body, Map<String, String> headers = const {}]) async {
    final res = await repository.authorized((token) => _raw(method, path, body, {...headers, 'Authorization': 'Bearer $token'}));
    final decoded = res.body.isEmpty ? null : jsonDecode(res.body);
    final data = decoded is Map<String, dynamic> ? decoded['data'] : null;
    if (data is! Map<String, dynamic>) throw ApiException.fromResponse(500, '');
    return data;
  }

  Future<http.Response> _raw(String method, String path, Map<String, dynamic>? body, Map<String, String> headers) async {
    http.Response res;
    try {
      final request = http.Request(method, Uri.parse('$_base$path'))
        ..headers.addAll({
          ...headers,
          'Accept': 'application/json',
          'X-Client-Type': 'mobile',
          if (body != null) 'Content-Type': 'application/json',
        });
      if (body != null) request.body = jsonEncode(body);
      res = await http.Response.fromStream(await _client.send(request).timeout(const Duration(seconds: 20)));
    } on Exception {
      throw ApiException.network();
    }
    if (res.statusCode >= 200 && res.statusCode < 300) return res;
    throw ApiException.fromResponse(res.statusCode, res.body);
  }
}
