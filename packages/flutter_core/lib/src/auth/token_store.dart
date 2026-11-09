import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// Where the rotating refresh token lives between app launches.
abstract interface class RefreshTokenStore {
  Future<String?> read();
  Future<void> write(String token);
  Future<void> clear();
}

/// iOS Keychain / Android Keystore-backed storage (via flutter_secure_storage).
/// The access token is never persisted; it is kept in memory by AuthRepository.
class SecureRefreshTokenStore implements RefreshTokenStore {
  SecureRefreshTokenStore([FlutterSecureStorage? storage])
      : _storage = storage ??
            FlutterSecureStorage(
              aOptions: const AndroidOptions(encryptedSharedPreferences: true),
              iOptions: const IOSOptions(accessibility: KeychainAccessibility.first_unlock_this_device),
            );

  static const _key = 'auth.refresh_token';
  final FlutterSecureStorage _storage;

  @override
  Future<String?> read() => _storage.read(key: _key);

  @override
  Future<void> write(String token) => _storage.write(key: _key, value: token);

  @override
  Future<void> clear() => _storage.delete(key: _key);
}

/// In-memory store for tests only.
class MemoryRefreshTokenStore implements RefreshTokenStore {
  String? _token;

  @override
  Future<String?> read() async => _token;

  @override
  Future<void> write(String token) async => _token = token;

  @override
  Future<void> clear() async => _token = null;
}
