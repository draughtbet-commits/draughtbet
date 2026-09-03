import 'dart:async';
import 'dart:convert';

import 'package:dio/dio.dart';
import 'package:flutter_dotenv/flutter_dotenv.dart';
import 'package:riverpod/riverpod.dart';
import 'secure_storage.dart';

/// Broadcast bus for "session can no longer be refreshed" events. The auth
/// interceptor emits on it and the auth notifier subscribes, so the auth
/// state can drop back to logged-out without a hard riverpod ref.listen that
/// is not allowed during provider initialization.
class SessionExpiryBus {
  static final StreamController<void> _controller =
      StreamController<void>.broadcast();

  static Stream<void> get stream => _controller.stream;

  static void emit() {
    if (!_controller.isClosed) _controller.add(null);
  }
}

/// A single shared [Dio] instance used across the app so that the auth
/// interceptor runs for every request. This is the pattern required by
/// `04_FRONTEND_SPEC.md` (a central client instead of a raw `Dio()` per
/// provider).
final apiClientProvider = Provider<Dio>((ref) {
  final storage = SecureStorageService();

  final dio = Dio(BaseOptions(
    baseUrl: dotenv.isInitialized
        ? dotenv.env['BACKEND_URL']!
        : 'http://localhost:3000',
    connectTimeout: const Duration(seconds: 15),
    receiveTimeout: const Duration(seconds: 15),
  ));

  dio.interceptors.add(AuthInterceptor(
    dio: dio,
    storage: storage,
    onSessionExpired: SessionExpiryBus.emit,
  ));

  return dio;
});

/// Attaches the access token and transparently refreshes on a 401.
class AuthInterceptor extends QueuedInterceptor {
  AuthInterceptor({
    required this.dio,
    required this.storage,
    required this.onSessionExpired,
  });

  final Dio dio;
  final SecureStorageService storage;
  final void Function() onSessionExpired;

  /// Endpoints that must never trigger a refresh (they carry their own
  /// credentials or are the refresh/login calls themselves).
  static const _authPaths = <String>{
    '/auth/login',
    '/auth/register',
    '/auth/refresh',
    '/auth/logout',
  };

  bool _isAuthPath(String path) => _authPaths.contains(path);

  Future<void> _ensureToken(RequestOptions options) async {
    final token = await storage.accessToken;
    if (token != null && token.isNotEmpty) {
      options.headers['Authorization'] = 'Bearer $token';
    }
  }

  @override
  Future<void> onRequest(
    RequestOptions options,
    RequestInterceptorHandler handler,
  ) async {
    if (!_isAuthPath(options.path)) {
      await _ensureToken(options);
    }
    handler.next(options);
  }

  @override
  Future<void> onError(
    DioException err,
    ErrorInterceptorHandler handler,
  ) async {
    final status = err.response?.statusCode;
    final path = err.requestOptions.path;

    // Only attempt a refresh on a genuine 401 from a protected endpoint.
    if (status != 401 || _isAuthPath(path)) {
      handler.next(err);
      return;
    }

    final refreshToken = await storage.refreshToken;
    if (refreshToken == null || refreshToken.isEmpty) {
      handler.next(err);
      return;
    }

    String? userId;
    try {
      userId = await storage.userId;
    } catch (_) {
      userId = null;
    }
    // Fallback: decode userId from the current JWT if not in storage
    // (handles pre-refactor sessions that didn't persist userId).
    if (userId == null || userId.isEmpty) {
      try {
        final token = await storage.accessToken;
        if (token != null) {
          final parts = token.split('.');
          if (parts.length == 3) {
            final payload = utf8.decode(
              base64Url.decode(base64Url.normalize(parts[1])),
            );
            final json = jsonDecode(payload) as Map<String, dynamic>;
            userId = json['userId']?.toString();
            if (userId != null) await storage.setUserId(userId!);
          }
        }
      } catch (_) {}
    }
    if (userId == null || userId.isEmpty) {
      handler.next(err);
      return;
    }

    try {
      final tokens = await _refresh(userId, refreshToken);
      await storage.setAccessToken(tokens.accessToken);
      await storage.setRefreshToken(tokens.refreshToken);

      err.requestOptions.headers['Authorization'] = 'Bearer ${tokens.accessToken}';
      final cloned = await dio.fetch<void>(err.requestOptions);
      handler.resolve(cloned);
    } catch (refreshError) {
      await storage.clearCredentials();
      onSessionExpired();
      handler.next(err);
    }
  }

  Future<_RefreshResult> _refresh(String userId, String refreshToken) async {
    final res = await dio.post(
      '/auth/refresh',
      data: {'userId': userId, 'refreshToken': refreshToken},
    );
    return _RefreshResult(
      accessToken: res.data['accessToken'] as String,
      refreshToken: res.data['refreshToken'] as String,
    );
  }
}

class _RefreshResult {
  _RefreshResult({required this.accessToken, required this.refreshToken});
  final String accessToken;
  final String refreshToken;
}