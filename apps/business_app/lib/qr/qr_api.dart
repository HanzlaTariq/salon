import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_core/flutter_core.dart';
import 'package:http/http.dart' as http;

import 'qr_models.dart';

/// Owner-side client for the salon link, QR image and poster. The salon id is never sent: the server derives it from the session.
class QrApi {
  QrApi({required this.repository, http.Client? client, String? baseUrl})
      : _client = client ?? http.Client(),
        _base = (baseUrl ?? AuthConfig.apiBaseUrl).replaceAll(RegExp(r'/+$'), '');

  final AuthRepository repository;
  final http.Client _client;
  final String _base;

  Future<SalonQrInfo> info() async {
    final res = await _get('/salons/mine/qr', json: true);
    final decoded = jsonDecode(res.body);
    final data = decoded is Map<String, dynamic> ? decoded['data'] : null;
    if (data is! Map<String, dynamic>) throw ApiException.fromResponse(500, '');
    return SalonQrInfo.fromJson(data);
  }

  /// PNG of the QR code (white background, quiet zone included).
  Future<Uint8List> image({int size = 1024}) async => (await _get('/salons/mine/qr/image?format=png&size=$size')).bodyBytes;

  /// One-page printable PDF. [size] is A4 or A5, [theme] is light or dark.
  Future<Uint8List> poster({String size = 'A4', String theme = 'light'}) async =>
      (await _get('/salons/mine/qr/poster?size=$size&theme=$theme', timeout: const Duration(seconds: 40))).bodyBytes;

  Future<http.Response> _get(String path, {bool json = false, Duration timeout = const Duration(seconds: 20)}) {
    return repository.authorized((token) async {
      final http.Response res;
      try {
        res = await _client.get(Uri.parse('$_base$path'), headers: {
          'Authorization': 'Bearer $token',
          'Accept': json ? 'application/json' : '*/*',
          'X-Client-Type': 'mobile',
        }).timeout(timeout);
      } catch (_) {
        throw ApiException.network();
      }
      if (res.statusCode < 200 || res.statusCode >= 300) throw ApiException.fromResponse(res.statusCode, res.body);
      return res;
    });
  }

  void close() => _client.close();
}
