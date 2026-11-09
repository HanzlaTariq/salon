/// Build-time configuration. Never put secrets here; the API base URL is not a secret.
///
/// Override per build:
///   flutter run --dart-define=API_BASE_URL=http://192.168.1.20:3000/api/v1
///   flutter build apk --dart-define=API_BASE_URL=https://api.example.com/api/v1
///
/// Default `10.0.2.2` is the Android emulator's alias for the host machine.
/// iOS simulator needs `localhost`, a physical phone needs your PC's LAN IP.
abstract final class AuthConfig {
  static const apiBaseUrl = String.fromEnvironment(
    'API_BASE_URL',
    defaultValue: 'http://10.0.2.2:3000/api/v1',
  );
}
