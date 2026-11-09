import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;

import 'auth_config.dart';
import 'auth_errors.dart';
import 'auth_models.dart';

/// Thin HTTP client for the auth endpoints. Sends `X-Client-Type: mobile` so the API returns
/// refresh tokens in the JSON body (the web uses an httpOnly cookie instead).
class AuthApi {
  AuthApi({http.Client? client, String? baseUrl, this.timeout = const Duration(seconds: 15)})
      : _client = client ?? http.Client(),
        _baseUrl = (baseUrl ?? AuthConfig.apiBaseUrl).replaceAll(RegExp(r'/+$'), '');

  final http.Client _client;
  final String _baseUrl;
  final Duration timeout;

  static const _headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'X-Client-Type': 'mobile',
  };

  /// 202: the API never reveals whether the e-mail already exists.
  Future<void> register({
    required String email,
    required String password,
    required String fullName,
    required String accountType,
  }) async {
    await _send('POST', '/auth/register', {
      'email': email,
      'password': password,
      'fullName': fullName,
      'accountType': accountType,
    });
  }

  Future<AuthSession> login({required String email, required String password, String? mfaCode}) async {
    final data = await _send('POST', '/auth/login', {
      'email': email,
      'password': password,
      if (mfaCode != null && mfaCode.isNotEmpty) 'mfaCode': mfaCode,
    });
    return AuthSession.fromJson(_required(data));
  }

  Future<AuthSession> refresh(String refreshToken) async {
    final data = await _send('POST', '/auth/refresh', {'refreshToken': refreshToken});
    return AuthSession.fromJson(_required(data));
  }

  Future<void> logout(String refreshToken) async {
    await _send('POST', '/auth/logout', {'refreshToken': refreshToken});
  }

  Future<void> resendVerification(String email) async {
    await _send('POST', '/auth/resend-verification', {'email': email});
  }

  /// Returns the `data` object, or null for 204 responses.
  Future<Map<String, dynamic>?> _send(String method, String path, Map<String, dynamic>? body) async {
    final http.Response response;
    try {
      final request = http.Request(method, Uri.parse('$_baseUrl$path'))..headers.addAll(_headers);
      if (body != null) request.body = jsonEncode(body);
      final streamed = await _client.send(request).timeout(timeout);
      response = await http.Response.fromStream(streamed).timeout(timeout);
    } catch (_) {
      // Socket, DNS, TLS and timeout failures all look the same to the UI: "no connection".
      throw ApiException.network();
    }

    if (response.statusCode >= 200 && response.statusCode < 300) {
      if (response.body.isEmpty) return null;
      final decoded = jsonDecode(response.body);
      if (decoded is! Map<String, dynamic>) throw ApiException.fromResponse(response.statusCode, '');
      return decoded['data'] as Map<String, dynamic>?;
    }
    throw ApiException.fromResponse(response.statusCode, response.body);
  }

  Map<String, dynamic> _required(Map<String, dynamic>? data) {
    if (data == null) throw ApiException.fromResponse(500, '');
    return data;
  }

  void close() => _client.close();
}
