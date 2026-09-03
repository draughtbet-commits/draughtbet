import 'dart:async';
import 'dart:convert';

import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../services/api_client.dart';
import '../services/secure_storage.dart';

class AuthState {
  final bool isAuthenticated;
  final bool isLoading;
  final String? error;

  const AuthState({
    this.isAuthenticated = false,
    this.isLoading = false,
    this.error,
  });

  AuthState copyWith({
    bool? isAuthenticated,
    bool? isLoading,
    String? error,
  }) {
    return AuthState(
      isAuthenticated: isAuthenticated ?? this.isAuthenticated,
      isLoading: isLoading ?? this.isLoading,
      error: error,
    );
  }
}

class AuthNotifier extends StateNotifier<AuthState> {
  AuthNotifier(this._dio, this._storage)
      : super(const AuthState(isLoading: true)) {
    _sessionSub = SessionExpiryBus.stream.listen((_) => onSessionExpired());
    _restoreSession();
  }

  final Dio _dio;
  final SecureStorageService _storage;
  StreamSubscription<void>? _sessionSub;

  /// Called when the auth interceptor flags the session as expired, so the
  /// router can redirect to /login.
  void onSessionExpired() {
    state = state.copyWith(isAuthenticated: false, isLoading: false);
  }

  Future<void> _restoreSession() async {
    try {
      final token = await _storage.accessToken;
      state = state.copyWith(
        isAuthenticated: token != null && token.isNotEmpty,
        isLoading: false,
      );
    } catch (_) {
      state = state.copyWith(isLoading: false);
    }
  }

  Future<bool> login(String email, String password, {String? fcmToken}) async {
    try {
      state = state.copyWith(isLoading: true, error: null);
      final response = await _dio.post(
        '/auth/login',
        data: {
          'email': email,
          'password': password,
          if (fcmToken != null && fcmToken.isNotEmpty) 'fcmToken': fcmToken,
        },
      );

      if (response.statusCode == 200) {
        final accessToken = response.data['accessToken'] as String;
        final refreshToken = response.data['refreshToken'] as String;
        await _storage.setAccessToken(accessToken);
        await _storage.setRefreshToken(refreshToken);
        final userId = _extractUserId(accessToken);
        if (userId != null) await _storage.setUserId(userId);
        state = state.copyWith(isAuthenticated: true, isLoading: false);
        return true;
      }
      state = state.copyWith(isLoading: false, error: 'Login failed');
      return false;
    } on DioException catch (e) {
      state = state.copyWith(
        isLoading: false,
        error: _errorMessage(e, fallback: 'Login failed'),
      );
      return false;
    } catch (e) {
      state = state.copyWith(isLoading: false, error: 'Login failed');
      return false;
    }
  }

  Future<bool> register({
    required String email,
    required String password,
    required DateTime dateOfBirth,
  }) async {
    try {
      state = state.copyWith(isLoading: true, error: null);
      final response = await _dio.post(
        '/auth/register',
        data: {
          'email': email,
          'password': password,
          'dateOfBirth': dateOfBirth.toIso8601String(),
          'fingerprintHash': 'dev_device',
        },
      );

      state = state.copyWith(isLoading: false);
      return response.statusCode == 201;
    } on DioException catch (e) {
      state = state.copyWith(
        isLoading: false,
        error: _errorMessage(e, fallback: 'Registration failed'),
      );
      return false;
    } catch (e) {
      state = state.copyWith(isLoading: false, error: 'Registration failed');
      return false;
    }
  }

  Future<void> logout() async {
    try {
      final token = await _storage.accessToken;
      final refreshToken = await _storage.refreshToken;
      if (token != null && refreshToken != null) {
        await _dio.post(
          '/auth/logout',
          data: {'refreshToken': refreshToken},
          options: Options(headers: {'Authorization': 'Bearer $token'}),
        );
      }
    } catch (_) {
      // Ignore errors on logout; always clear local session.
    }
    await _storage.clearCredentials();
    state = state.copyWith(isAuthenticated: false, error: null);
  }

  /// Decodes the JWT payload (base64url) to recover the `userId` claim the
  /// backend signs into the access token.
  String? _extractUserId(String accessToken) {
    try {
      final parts = accessToken.split('.');
      if (parts.length != 3) return null;
      final payload = utf8.decode(base64Url.decode(base64Url.normalize(parts[1])));
      final json = jsonDecode(payload) as Map<String, dynamic>;
      final id = json['userId'];
      return id?.toString();
    } catch (_) {
      return null;
    }
  }

  String _errorMessage(DioException e, {required String fallback}) {
    final data = e.response?.data;
    if (data is Map) {
      final error = data['error'];
      if (error is String && error.isNotEmpty) return error;
      final errors = data['errors'];
      if (errors is List && errors.isNotEmpty) {
        final messages = errors
            .whereType<Map>()
            .map((m) => m['message'])
            .whereType<String>()
            .toList();
        if (messages.isNotEmpty) return messages.join('\n');
      }
    }
    return fallback;
  }

  @override
  void dispose() {
    _sessionSub?.cancel();
    super.dispose();
  }
}

final authProvider = StateNotifierProvider<AuthNotifier, AuthState>((ref) {
  return AuthNotifier(
    ref.watch(apiClientProvider),
    SecureStorageService(),
  );
});