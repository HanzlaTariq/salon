import 'dart:async';
import 'dart:convert';

import 'package:flutter_core/flutter_core.dart';
import 'package:http/http.dart' as http;

import 'catalog_models.dart';

/// Client for the owner catalogue endpoints. The salon id is NEVER sent: the server derives it from the session.
class CatalogApi {
  CatalogApi({required this.repository, http.Client? client, String? baseUrl})
      : _client = client ?? http.Client(),
        _base = (baseUrl ?? AuthConfig.apiBaseUrl).replaceAll(RegExp(r'/+$'), '');

  final AuthRepository repository;
  final http.Client _client;
  final String _base;

  Future<CatalogOverview> getCatalog() async => CatalogOverview.fromJson(await _map('GET', '/salons/mine/catalog'));

  Future<void> createCategory(String name, String? description) =>
      _map('POST', '/salons/mine/categories', {'name': name, if (description != null && description.isNotEmpty) 'description': description});

  Future<void> updateCategory(String id, Map<String, dynamic> body) => _map('PATCH', '/salons/mine/categories/$id', body);

  Future<void> deleteCategory(String id) => _send('DELETE', '/salons/mine/categories/$id');

  Future<void> createService(Map<String, dynamic> body) => _map('POST', '/salons/mine/services', body);

  Future<void> updateService(String id, Map<String, dynamic> body) => _map('PATCH', '/salons/mine/services/$id', body);

  Future<void> deleteService(String id) => _send('DELETE', '/salons/mine/services/$id');

  Future<void> createStaff({String? displayName, bool self = false}) =>
      _map('POST', '/salons/mine/staff', {if (self) 'self': true, if (displayName != null) 'displayName': displayName});

  Future<void> updateStaff(String id, Map<String, dynamic> body) => _map('PATCH', '/salons/mine/staff/$id', body);

  Future<void> deleteStaff(String id) => _send('DELETE', '/salons/mine/staff/$id');

  Future<List<OpeningDay>> getHours() async {
    final data = await _map('GET', '/salons/mine/opening-hours');
    return (data['days'] as List<dynamic>).map((e) => OpeningDay.fromJson(e as Map<String, dynamic>)).toList();
  }

  Future<List<OpeningDay>> setHours(List<OpeningDay> days) async {
    final data = await _map('PUT', '/salons/mine/opening-hours', {'days': days.map((d) => d.toJson()).toList()});
    return (data['days'] as List<dynamic>).map((e) => OpeningDay.fromJson(e as Map<String, dynamic>)).toList();
  }

  Future<Map<String, dynamic>> _map(String method, String path, [Map<String, dynamic>? body]) async {
    final res = await _send(method, path, body);
    final decoded = res.body.isEmpty ? null : jsonDecode(res.body);
    final data = decoded is Map<String, dynamic> ? decoded['data'] : null;
    if (data is! Map<String, dynamic>) throw ApiException.fromResponse(500, '');
    return data;
  }

  Future<http.Response> _send(String method, String path, [Map<String, dynamic>? body]) {
    return repository.authorized((token) async {
      http.Response res;
      try {
        final request = http.Request(method, Uri.parse('$_base$path'))
          ..headers.addAll({
            'Authorization': 'Bearer $token',
            'Accept': 'application/json',
            'X-Client-Type': 'mobile',
            if (body != null) 'Content-Type': 'application/json',
          });
        if (body != null) request.body = jsonEncode(body);
        res = await http.Response.fromStream(await _client.send(request)).timeout(const Duration(seconds: 20));
      } on ApiException {
        rethrow;
      } catch (_) {
        throw ApiException.network();
      }
      if (res.statusCode < 200 || res.statusCode >= 300) throw ApiException.fromResponse(res.statusCode, res.body);
      return res;
    });
  }

  void close() => _client.close();
}
