import 'dart:convert';

import 'package:flutter_core/flutter_core.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

Map<String, dynamic> _sessionJson({String access = 'access-1', String refresh = 'refresh-1', int expiresIn = 900}) => {
      'data': {
        'accessToken': access,
        'expiresIn': expiresIn,
        'refreshToken': refresh,
        'mfaEnrollmentRequired': false,
        'user': {
          'id': '00000000-0000-4000-8000-000000000001',
          'email': 'owner@example.com',
          'fullName': 'Owner Test',
          'phone': null,
          'role': 'SALON_OWNER',
          'status': 'ACTIVE',
          'emailVerified': true,
          'mfaEnabled': false,
        },
      },
    };

http.Response _error(int status, String code, [String message = 'msg']) => http.Response(
      jsonEncode({
        'error': {'code': code, 'message': message, 'requestId': 'req-1'},
      }),
      status,
      headers: {'content-type': 'application/json'},
    );

AuthRepository _repo(MockClient client, RefreshTokenStore store) =>
    AuthRepository(api: AuthApi(client: client, baseUrl: 'https://api.test/api/v1'), store: store);

void main() {
  test('login sends the mobile header and stores the rotating refresh token', () async {
    final store = MemoryRefreshTokenStore();
    late http.Request seen;
    final repo = _repo(
      MockClient((request) async {
        seen = request;
        return http.Response(jsonEncode(_sessionJson()), 200);
      }),
      store,
    );

    await repo.login(email: 'owner@example.com', password: 'violet-Harbor-lamp-91');

    expect(seen.headers['X-Client-Type'], 'mobile');
    expect(seen.url.path, '/api/v1/auth/login');
    expect(await store.read(), 'refresh-1');
    expect(repo.isSignedIn, isTrue);
  });

  test('concurrent authorized calls with an expired token share ONE refresh (single-flight, R6)', () async {
    final store = MemoryRefreshTokenStore();
    await store.write('refresh-0');
    var refreshCalls = 0;
    final repo = _repo(
      MockClient((request) async {
        if (request.url.path.endsWith('/auth/refresh')) {
          refreshCalls++;
          await Future<void>.delayed(const Duration(milliseconds: 20));
          return http.Response(jsonEncode(_sessionJson(access: 'access-2', refresh: 'refresh-2')), 200);
        }
        return http.Response('{"data":{"ok":true}}', 200);
      }),
      store,
    );

    await Future.wait([
      repo.authorized((token) async => token),
      repo.authorized((token) async => token),
      repo.authorized((token) async => token),
    ]);

    expect(refreshCalls, 1);
    expect(await store.read(), 'refresh-2');
  });

  test('a 401 on a protected call refreshes once and retries with the new token', () async {
    final store = MemoryRefreshTokenStore();
    final repo = _repo(
      MockClient((request) async {
        if (request.url.path.endsWith('/auth/login')) return http.Response(jsonEncode(_sessionJson()), 200);
        if (request.url.path.endsWith('/auth/refresh')) {
          return http.Response(jsonEncode(_sessionJson(access: 'access-new', refresh: 'refresh-new')), 200);
        }
        return http.Response('{"data":{"ok":true}}', 200);
      }),
      store,
    );
    await repo.login(email: 'owner@example.com', password: 'violet-Harbor-lamp-91');

    // The protected call is simulated: it rejects any token except the rotated one.
    final result = await repo.authorized((token) async {
      if (token != 'access-new') throw ApiException.fromResponse(401, '');
      return token;
    });

    expect(result, 'access-new');
    expect(await store.read(), 'refresh-new');
  });

  test('a rejected refresh ends the session and clears the stored token', () async {
    final store = MemoryRefreshTokenStore();
    await store.write('stale-token');
    var notified = 0;
    final repo = _repo(
      MockClient((request) async => _error(401, 'UNAUTHENTICATED', 'Session is no longer valid.')),
      store,
    )..addListener(() => notified++);

    await expectLater(repo.restoreSession(), completes);

    expect(repo.isSignedIn, isFalse);
    expect(await store.read(), isNull);
    expect(notified, 1, reason: 'clearing a dead session notifies so AuthGate shows sign-in');
  });

  test('an offline refresh keeps the stored token, so an offline start does not sign the user out', () async {
    final store = MemoryRefreshTokenStore();
    await store.write('refresh-keep');
    final repo = _repo(
      MockClient((request) async => throw http.ClientException('Network is unreachable')),
      store,
    );

    await expectLater(
      repo.restoreSession(),
      throwsA(isA<ApiException>().having((e) => e.isNetwork, 'isNetwork', isTrue)),
    );
    expect(await store.read(), 'refresh-keep');
  });

  test('logout clears local state even when the server cannot be reached', () async {
    final store = MemoryRefreshTokenStore();
    final repo = _repo(
      MockClient((request) async {
        if (request.url.path.endsWith('/auth/login')) return http.Response(jsonEncode(_sessionJson()), 200);
        throw http.ClientException('offline');
      }),
      store,
    );
    await repo.login(email: 'owner@example.com', password: 'violet-Harbor-lamp-91');

    await repo.logout();

    expect(repo.isSignedIn, isFalse);
    expect(await store.read(), isNull);
  });

  test('error envelope is parsed and non-JSON bodies fall back to a generic message', () {
    final parsed = ApiException.fromResponse(
      400,
      jsonEncode({
        'error': {'code': 'VALIDATION_FAILED', 'message': 'Password does not meet requirements.', 'details': ['too short']},
      }),
    );
    expect(parsed.code, 'VALIDATION_FAILED');
    expect(parsed.details, ['too short']);

    final html = ApiException.fromResponse(502, '<html>bad gateway</html>');
    expect(html.code, 'UNKNOWN');
    expect(html.message, 'Something went wrong. Please try again.');
  });
}
