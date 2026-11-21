import 'package:flutter/foundation.dart' show kReleaseMode;

/// Build-time configuration. Never put secrets here; the API base URL is not a secret.
///
/// Override per build:
///   flutter run --dart-define=API_BASE_URL=http://192.168.1.20:3000/api/v1
///   flutter build appbundle --release --dart-define=API_BASE_URL=https://api.yourdomain.com/api/v1
///
/// Default `10.0.2.2` is the Android emulator's alias for the host machine.
/// iOS simulator needs `localhost`, a physical phone needs your PC's LAN IP.
abstract final class AuthConfig {
  static const apiBaseUrl = String.fromEnvironment(
    'API_BASE_URL',
    defaultValue: 'http://10.0.2.2:3000/api/v1',
  );

  /// Call first thing in `main()`. A RELEASE build that still points at the emulator address (the `--dart-define` was forgotten)
  /// or at plain http would ship an app that cannot work, and plain http would also send passwords unencrypted.
  /// Debug and profile builds are never affected.
  static void assertReleaseReady() {
    if (!kReleaseMode) return;
    if (!apiBaseUrl.startsWith('https://')) {
      throw StateError(
        'API_BASE_URL must be an https:// address in a release build. '
        'Build with --dart-define=API_BASE_URL=https://api.yourdomain.com/api/v1',
      );
    }
  }
}
