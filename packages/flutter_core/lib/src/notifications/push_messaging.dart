import 'dart:async';

import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';

/// A push that reached the phone while the app was open, or that the person tapped.
class PushEvent {
  const PushEvent({this.title, this.body, this.data = const {}});

  final String? title;
  final String? body;

  /// FCM data (`type`, `route`, `appointmentId`, `notificationId`, ...). Values are ids and small hints only.
  final Map<String, String> data;
}

/// What the apps need from a push service. The app works without it (inbox + 60-second polling), so every
/// method must be safe to call when Firebase is not configured.
abstract class PushMessaging {
  /// False when Firebase is not set up for this build (no `google-services.json` / `GoogleService-Info.plist`).
  Future<bool> initialize();

  /// Asks for the notification permission (Android 13+ and iOS). False when the person says no.
  Future<bool> requestPermission();

  Future<String?> token();
  Stream<String> get onTokenRefresh;

  /// A push that arrived while the app is in the foreground (the system shows nothing in that case).
  Stream<PushEvent> get onForeground;

  /// The person tapped a push while the app was in the background.
  Stream<PushEvent> get onOpened;

  /// The push that started the app from a closed state, if any.
  Future<PushEvent?> initialMessage();
}

/// Used when Firebase is not available (tests, or a build without the Firebase files).
class NoPushMessaging implements PushMessaging {
  const NoPushMessaging();

  @override
  Future<bool> initialize() async => false;
  @override
  Future<bool> requestPermission() async => false;
  @override
  Future<String?> token() async => null;
  @override
  Stream<String> get onTokenRefresh => const Stream.empty();
  @override
  Stream<PushEvent> get onForeground => const Stream.empty();
  @override
  Stream<PushEvent> get onOpened => const Stream.empty();
  @override
  Future<PushEvent?> initialMessage() async => null;
}

/// Firebase Cloud Messaging. It never throws into the app: a missing configuration simply means "no push".
class FirebasePushMessaging implements PushMessaging {
  bool _ready = false;

  PushEvent _event(RemoteMessage m) => PushEvent(
        title: m.notification?.title,
        body: m.notification?.body,
        data: m.data.map((k, v) => MapEntry(k, v.toString())),
      );

  @override
  Future<bool> initialize() async {
    if (_ready) return true;
    try {
      if (Firebase.apps.isEmpty) await Firebase.initializeApp();
      _ready = true;
    } catch (_) {
      _ready = false;
    }
    return _ready;
  }

  @override
  Future<bool> requestPermission() async {
    if (!_ready) return false;
    try {
      final settings = await FirebaseMessaging.instance.requestPermission();
      return settings.authorizationStatus == AuthorizationStatus.authorized || settings.authorizationStatus == AuthorizationStatus.provisional;
    } catch (_) {
      return false;
    }
  }

  @override
  Future<String?> token() async {
    if (!_ready) return null;
    try {
      return await FirebaseMessaging.instance.getToken();
    } catch (_) {
      return null; // for example the iOS APNs token is not ready yet: the refresh stream delivers it later
    }
  }

  @override
  Stream<String> get onTokenRefresh => _ready ? FirebaseMessaging.instance.onTokenRefresh : const Stream.empty();

  @override
  Stream<PushEvent> get onForeground => _ready ? FirebaseMessaging.onMessage.map(_event) : const Stream.empty();

  @override
  Stream<PushEvent> get onOpened => _ready ? FirebaseMessaging.onMessageOpenedApp.map(_event) : const Stream.empty();

  @override
  Future<PushEvent?> initialMessage() async {
    if (!_ready) return null;
    try {
      final m = await FirebaseMessaging.instance.getInitialMessage();
      return m == null ? null : _event(m);
    } catch (_) {
      return null;
    }
  }
}
