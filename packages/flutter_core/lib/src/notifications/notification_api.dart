import 'dart:convert';

import 'package:http/http.dart' as http;

import '../auth/auth_config.dart';
import '../auth/auth_errors.dart';
import '../auth/auth_repository.dart';
import 'notification_models.dart';

/// Devices, inbox and preferences of the signed-in person. Every call goes through [AuthRepository.authorized]
/// (single-flight token refresh). The person is always the caller: no user id is ever sent.
class NotificationApi {
  NotificationApi({required this.repository, http.Client? client, String? baseUrl})
      : _client = client ?? http.Client(),
        _base = (baseUrl ?? AuthConfig.apiBaseUrl).replaceAll(RegExp(r'/+$'), '');

  final AuthRepository repository;
  final http.Client _client;
  final String _base;

  /// `app` is `CUSTOMER` or `BUSINESS`; `platform` is `ANDROID` or `IOS`.
  Future<void> registerDevice({required String token, required String platform, required String app, String? appVersion}) =>
      _data('POST', '/devices', {'token': token, 'platform': platform, 'app': app, if (appVersion != null) 'appVersion': appVersion});

  Future<void> unregisterDevice(String token) => _data('DELETE', '/devices', {'token': token});

  Future<NotificationPage> inbox({String? cursor, bool unreadOnly = false, int limit = 30}) async => NotificationPage.fromJson(await _data('GET', '/notifications', null, {
        'limit': '$limit',
        if (cursor != null) 'cursor': cursor,
        if (unreadOnly) 'unread': 'true',
      }));

  Future<int> unreadCount() async => ((await _data('GET', '/notifications/unread-count'))['unreadCount'] as num?)?.toInt() ?? 0;

  Future<int> markRead(String id) async => ((await _data('POST', '/notifications/$id/read', {}))['unreadCount'] as num?)?.toInt() ?? 0;

  Future<void> markAllRead() => _data('POST', '/notifications/read-all', {});

  Future<NotificationPrefs> preferences() async => NotificationPrefs.fromJson(await _data('GET', '/notifications/preferences'));

  Future<NotificationPrefs> savePreferences(NotificationPrefs prefs) async => NotificationPrefs.fromJson(await _data('PUT', '/notifications/preferences', prefs.toJson()));

  /// Unwraps `{ data: ... }`; an empty body (204) gives an empty map.
  Future<Map<String, dynamic>> _data(String method, String path, [Map<String, dynamic>? body, Map<String, String>? query]) async {
    final res = await repository.authorized((token) => _send(method, path, token, body, query));
    if (res.body.isEmpty) return const {};
    final decoded = jsonDecode(res.body);
    final data = decoded is Map<String, dynamic> ? decoded['data'] : null;
    return data is Map<String, dynamic> ? data : const {};
  }

  Future<http.Response> _send(String method, String path, String token, Map<String, dynamic>? body, Map<String, String>? query) async {
    final http.Response res;
    try {
      final uri = Uri.parse('$_base$path').replace(queryParameters: query == null || query.isEmpty ? null : query);
      final request = http.Request(method, uri)
        ..headers.addAll({
          'Authorization': 'Bearer $token',
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
