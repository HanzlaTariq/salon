import 'dart:convert';

import 'package:flutter_core/flutter_core.dart';
import 'package:http/http.dart' as http;

import 'offline_models.dart';

/// The two server calls of Phase 12. An interface, so the engine can be tested without a network.
abstract class SyncGateway {
  Future<PushResponse> push({required String deviceId, required List<PendingOp> ops});
  Future<PullResponse> pull({DateTime? since, bool catalog = false});
}

/// `POST /sync/push` and `GET /sync/pull`. The salon, the user and the staff member are never sent: the server reads them from the session.
class SyncApi implements SyncGateway {
  SyncApi({required this.repository, http.Client? client, String? baseUrl})
      : _client = client ?? http.Client(),
        _base = (baseUrl ?? AuthConfig.apiBaseUrl).replaceAll(RegExp(r'/+$'), '');

  final AuthRepository repository;
  final http.Client _client;
  final String _base;

  @override
  Future<PushResponse> push({required String deviceId, required List<PendingOp> ops}) async =>
      PushResponse.fromJson(await _data('POST', '/sync/push', {'deviceId': deviceId, 'operations': ops.map((o) => o.toApi()).toList()}));

  @override
  Future<PullResponse> pull({DateTime? since, bool catalog = false}) async {
    final q = <String>[if (since != null) 'since=${Uri.encodeQueryComponent(since.toUtc().toIso8601String())}', if (catalog) 'catalog=true'];
    return PullResponse.fromJson(await _data('GET', '/sync/pull${q.isEmpty ? '' : '?${q.join('&')}'}'));
  }

  Future<Map<String, dynamic>> _data(String method, String path, [Map<String, dynamic>? body]) async {
    final res = await repository.authorized((token) => _raw(method, path, body, {'Authorization': 'Bearer $token'}));
    final decoded = res.body.isEmpty ? null : jsonDecode(res.body);
    final data = decoded is Map<String, dynamic> ? decoded['data'] : null;
    if (data is! Map<String, dynamic>) throw ApiException.fromResponse(500, '');
    return data;
  }

  Future<http.Response> _raw(String method, String path, Map<String, dynamic>? body, Map<String, String> headers) async {
    http.Response res;
    try {
      final request = http.Request(method, Uri.parse('$_base$path'))
        ..headers.addAll({...headers, 'Accept': 'application/json', 'X-Client-Type': 'mobile', if (body != null) 'Content-Type': 'application/json'});
      if (body != null) request.body = jsonEncode(body);
      res = await http.Response.fromStream(await _client.send(request).timeout(const Duration(seconds: 25)));
    } on Exception {
      throw ApiException.network();
    }
    if (res.statusCode >= 200 && res.statusCode < 300) return res;
    throw ApiException.fromResponse(res.statusCode, res.body);
  }
}
