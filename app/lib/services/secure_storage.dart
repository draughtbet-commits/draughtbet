import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// Central wrapper around [FlutterSecureStorage].
///
/// The design doc mandates that credentials live in secure storage and that
/// providers never touch [FlutterSecureStorage] directly. All token/preference
/// keys are defined here so the rest of the app reads and writes them through
/// this single source of truth.
class SecureStorageService {
  SecureStorageService([FlutterSecureStorage? storage])
      : _storage = storage ?? const FlutterSecureStorage();

  static const _accessTokenKey = 'jwt';
  static const _refreshTokenKey = 'refresh_token';
  static const _userIdKey = 'user_id';

  final FlutterSecureStorage _storage;

  Future<String?> get accessToken => _storage.read(key: _accessTokenKey);
  Future<String?> get refreshToken => _storage.read(key: _refreshTokenKey);
  Future<String?> get userId => _storage.read(key: _userIdKey);

  Future<void> setAccessToken(String token) =>
      _storage.write(key: _accessTokenKey, value: token);

  Future<void> setRefreshToken(String token) =>
      _storage.write(key: _refreshTokenKey, value: token);

  Future<void> setUserId(String id) =>
      _storage.write(key: _userIdKey, value: id);

  /// Wipes every credential the app owns (used on logout / expiry).
  Future<void> clearCredentials() async {
    await _storage.delete(key: _accessTokenKey);
    await _storage.delete(key: _refreshTokenKey);
    await _storage.delete(key: _userIdKey);
  }

  Future<String?> read({required String key}) => _storage.read(key: key);

  Future<void> write({required String key, required String value}) =>
      _storage.write(key: key, value: value);
}
