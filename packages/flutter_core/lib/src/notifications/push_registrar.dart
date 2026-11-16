import 'dart:async';

import 'package:flutter/foundation.dart';

import '../auth/auth_errors.dart';
import 'notification_api.dart';
import 'push_messaging.dart';

/// Registers this phone for push after sign-in and keeps the token fresh.
///
/// * Safe without Firebase (everything becomes a no-op).
/// * A failed registration (offline) is retried the next time the token refreshes or the app starts; the inbox works anyway.
/// * On sign-out the server stops pushing to this phone by itself (the session is revoked); [unregister] is an extra courtesy
///   that the app may call BEFORE signing out.
class PushRegistrar {
  PushRegistrar({required this.api, required this.messaging, required this.app});

  final NotificationApi api;
  final PushMessaging messaging;

  /// `CUSTOMER` or `BUSINESS`.
  final String app;

  StreamSubscription<String>? _refresh;
  String? _token;
  bool _started = false;

  String get _platform => defaultTargetPlatform == TargetPlatform.iOS ? 'IOS' : 'ANDROID';

  Future<void> start() async {
    if (_started) return;
    _started = true;
    if (!await messaging.initialize()) return;
    if (!await messaging.requestPermission()) return;
    final token = await messaging.token();
    if (token != null) await _register(token);
    _refresh = messaging.onTokenRefresh.listen(_register);
  }

  Future<void> _register(String token) async {
    _token = token;
    try {
      await api.registerDevice(token: token, platform: _platform, app: app);
    } on ApiException {
      // Offline or signed out: the next token refresh or app start registers again.
    }
  }

  Future<void> unregister() async {
    final token = _token;
    if (token == null) return;
    try {
      await api.unregisterDevice(token);
    } on ApiException {
      // The server stops pushing when the session ends anyway.
    }
  }

  Future<void> dispose() async {
    await _refresh?.cancel();
    _refresh = null;
  }
}
