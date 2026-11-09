import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_core/flutter_core.dart';
import 'package:http/http.dart' as http;

import 'salon_models.dart';

/// Client for the owner-side salon endpoints. Every call goes through [AuthRepository.authorized]
/// (single-flight token refresh). The salon id is NEVER sent: the server derives it from the session.
class SalonApi {
  SalonApi({required this.repository, http.Client? client, String? baseUrl})
      : _client = client ?? http.Client(),
        _base = (baseUrl ?? AuthConfig.apiBaseUrl).replaceAll(RegExp(r'/+$'), '');

  final AuthRepository repository;
  final http.Client _client;
  final String _base;

  Map<String, String> _headers(String token, {bool json = true}) => {
        'Authorization': 'Bearer $token',
        'Accept': 'application/json',
        'X-Client-Type': 'mobile',
        if (json) 'Content-Type': 'application/json',
      };

  /// Returns null when the owner has not registered a salon yet (404).
  Future<SalonOverview?> getMine() async {
    try {
      final data = await _json('GET', '/salons/mine');
      return SalonOverview.fromJson(data);
    } on ApiException catch (e) {
      if (e.statusCode == 404) return null;
      rethrow;
    }
  }

  Future<SalonOverview> create(Map<String, dynamic> body) async => SalonOverview.fromJson(await _json('POST', '/salons', body));

  Future<SalonOverview> update(Map<String, dynamic> body) async => SalonOverview.fromJson(await _json('PATCH', '/salons/mine', body));

  Future<SalonOverview> submit() async => SalonOverview.fromJson(await _json('POST', '/salons/mine/submit'));

  Future<void> deleteFile(String fileId) async {
    await repository.authorized((token) async {
      final res = await _send(() => _client.delete(Uri.parse('$_base/salons/mine/files/$fileId'), headers: _headers(token)));
      if (res.statusCode != 204 && (res.statusCode < 200 || res.statusCode >= 300)) {
        throw ApiException.fromResponse(res.statusCode, res.body);
      }
    });
  }

  /// [kind] is DOCUMENT or PHOTO. The server validates the real file type, re-encodes it and enforces limits.
  Future<void> uploadFile({
    required String kind,
    required String docType,
    required Uint8List bytes,
    required String filename,
  }) async {
    await repository.authorized((token) async {
      final request = http.MultipartRequest('POST', Uri.parse('$_base/salons/mine/files'))
        ..headers.addAll(_headers(token, json: false))
        ..fields['kind'] = kind
        ..fields['docType'] = docType
        ..files.add(http.MultipartFile.fromBytes('file', bytes, filename: filename));
      final res = await _send(() async {
        final streamed = await _client.send(request);
        return http.Response.fromStream(streamed);
      }, timeout: const Duration(seconds: 90));
      if (res.statusCode < 200 || res.statusCode >= 300) throw ApiException.fromResponse(res.statusCode, res.body);
    });
  }

  Future<Map<String, dynamic>> _json(String method, String path, [Map<String, dynamic>? body]) {
    return repository.authorized((token) async {
      final uri = Uri.parse('$_base$path');
      final res = await _send(() async {
        final request = http.Request(method, uri)..headers.addAll(_headers(token));
        if (body != null) request.body = jsonEncode(body);
        return http.Response.fromStream(await _client.send(request));
      });
      if (res.statusCode < 200 || res.statusCode >= 300) throw ApiException.fromResponse(res.statusCode, res.body);
      final decoded = jsonDecode(res.body);
      final data = decoded is Map<String, dynamic> ? decoded['data'] : null;
      if (data is! Map<String, dynamic>) throw ApiException.fromResponse(500, '');
      return data;
    });
  }

  Future<http.Response> _send(Future<http.Response> Function() call, {Duration timeout = const Duration(seconds: 20)}) async {
    try {
      return await call().timeout(timeout);
    } on ApiException {
      rethrow;
    } catch (_) {
      throw ApiException.network();
    }
  }

  void close() => _client.close();
}
