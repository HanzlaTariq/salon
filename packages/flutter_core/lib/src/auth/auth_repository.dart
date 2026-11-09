import 'dart:async';

import 'package:flutter/foundation.dart';

import 'auth_api.dart';
import 'auth_errors.dart';
import 'auth_models.dart';
import 'token_store.dart';

/// Owns the signed-in state for one app.
///
/// Guarantees:
/// * Refresh tokens rotate on every use, so concurrent callers must share ONE refresh (single-flight).
///   Otherwise the second request replays a spent token and the server revokes the whole session (R6).
/// * A network failure during refresh keeps the stored token: an offline start must not sign the user out.
/// * A dead session (401, suspended, unverified) clears the stored token and notifies listeners.
class AuthRepository extends ChangeNotifier {
  AuthRepository({required AuthApi api, RefreshTokenStore? store})
      : _api = api,
        _store = store ?? SecureRefreshTokenStore();

  final AuthApi _api;
  final RefreshTokenStore _store;

  AuthSession? _session;
  Future<AuthSession>? _inFlightRefresh;

  AuthSession? get session => _session;
  bool get isSignedIn => _session != null;

  /// Called on app start. Throws [ApiException] only for network problems (caller shows retry).
  Future<void> restoreSession() async {
    if (await _store.read() == null) return;
    try {
      await _refreshShared();
    } on ApiException catch (e) {
      if (!e.isSessionDead) rethrow;
    }
  }

  Future<AuthSession> login({required String email, required String password, String? mfaCode}) async {
    final session = await _api.login(email: email, password: password, mfaCode: mfaCode);
    await _store.write(session.refreshToken);
    _setSession(session);
    return session;
  }

  /// Registration does not sign in: the account must verify its e-mail first.
  Future<void> register({
    required String email,
    required String password,
    required String fullName,
    required String accountType,
  }) =>
      _api.register(email: email, password: password, fullName: fullName, accountType: accountType);

  Future<void> resendVerification(String email) => _api.resendVerification(email);

  /// Always clears local state, even when the server cannot be reached.
  Future<void> logout() async {
    final stored = await _store.read();
    if (stored != null) {
      try {
        await _api.logout(stored);
      } on ApiException {
        // Server-side revoke failed (offline). The local token is still removed below; the
        // refresh token expires on its own (30 days) and can be revoked from "sign out everywhere".
      }
    }
    await _clear();
  }

  /// Runs [call] with a valid access token. On a 401 it refreshes once (shared with concurrent
  /// callers) and retries once. A second 401 is returned to the caller.
  Future<T> authorized<T>(Future<T> Function(String accessToken) call) async {
    final current = _session;
    final token = (current != null && !current.expiresSoon)
        ? current.accessToken
        : (await _refreshShared()).accessToken;
    try {
      return await call(token);
    } on ApiException catch (e) {
      if (e.statusCode != 401) rethrow;
      final refreshed = await _refreshShared();
      return call(refreshed.accessToken);
    }
  }

  /// Single-flight: every caller awaits the same in-flight refresh.
  Future<AuthSession> _refreshShared() {
    return _inFlightRefresh ??= _doRefresh().whenComplete(() => _inFlightRefresh = null);
  }

  Future<AuthSession> _doRefresh() async {
    // Read the stored token here (not captured earlier) so we always use the latest rotated value.
    final current = await _store.read();
    if (current == null) {
      _session = null;
      throw ApiException.sessionEnded();
    }
    try {
      final next = await _api.refresh(current);
      await _store.write(next.refreshToken);
      _setSession(next);
      return next;
    } on ApiException catch (e) {
      if (e.isSessionDead) await _clear();
      rethrow;
    }
  }

  void _setSession(AuthSession session) {
    _session = session;
    notifyListeners();
  }

  Future<void> _clear() async {
    _session = null;
    await _store.clear();
    notifyListeners();
  }
}
