import 'dart:async';
import 'dart:convert';

import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../config/backend_url.dart';
import 'secure_storage.dart';
import 'token_refresher.dart';

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

  final dio = Dio(
    BaseOptions(
      baseUrl: resolveBackendUrl(),
      connectTimeout: const Duration(seconds: 15),
      receiveTimeout: const Duration(seconds: 15),
    ),
  );

  dio.interceptors.add(
    AuthInterceptor(
      dio: dio,
      storage: storage,
      onSessionExpired: SessionExpiryBus.emit,
    ),
  );

  return dio;
});

/// Attaches the access token and transparently refreshes on a 401.
class AuthInterceptor extends QueuedInterceptor {
  AuthInterceptor({
    required this.dio,
    required this.storage,
    required this.onSessionExpired,
    TokenRefresher? refresher,
  }) : refresher =
           refresher ??
           TokenRefresher(
             storage: storage,
             // Isolated from the app-wide [Dio] so a refresh round-trip cannot
             // deadlock the QueuedInterceptor chain (an inner error on the same
             // interceptor would await the very request blocked on it). Shares
             // the transport adapter and base options, carries no
             // AuthInterceptor of its own.
             dio: Dio(dio.options)..httpClientAdapter = dio.httpClientAdapter,
           );

  final Dio dio;
  final SecureStorageService storage;
  final void Function() onSessionExpired;

  /// Shared with [SocketService] so concurrent refreshes collapse into one
  /// call. Refresh tokens are single-use: a second concurrent exchange is
  /// detected server-side as reuse and revokes the user's sessions.
  final TokenRefresher refresher;

  /// Endpoints that must never trigger a refresh (they carry their own
  /// credentials or are the refresh/login calls themselves).
  static const _authPaths = <String>{
    '/auth/login',
    '/auth/register',
    '/auth/google',
    '/auth/refresh',
    '/auth/logout',
    '/auth/geo-locate',
    '/auth/check-availability',
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

    final current = await storage.accessToken;
    final failedAuth = err.requestOptions.headers['Authorization'];

    // A burst of parallel 401s all see the same stale token. The first one
    // refreshes and updates storage; the rest can just retry with the new
    // token instead of each firing another refresh.
    if (failedAuth != null &&
        current != null &&
        failedAuth != 'Bearer $current') {
      err.requestOptions.headers['Authorization'] = 'Bearer $current';
      final cloned = await dio.fetch<void>(err.requestOptions);
      handler.resolve(cloned);
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
            if (userId != null) await storage.setUserId(userId);
          }
        }
      } catch (_) {}
    }
    if (userId == null || userId.isEmpty) {
      handler.next(err);
      return;
    }

    try {
      // Delegates to the shared TokenRefresher so a REST 401 and a socket
      // refresh cannot race: two concurrent refreshes rotate the refresh token
      // twice, and the backend treats the second as token reuse and revokes
      // every session for the user.
      final tokens = await refresher.refresh();

      err.requestOptions.headers['Authorization'] =
          'Bearer ${tokens.accessToken}';
      final cloned = await dio.fetch<void>(err.requestOptions);
      handler.resolve(cloned);
    } on TokenRefreshException {
      // Missing refresh token / user id, or a malformed response: the session
      // cannot be recovered.
      await storage.clearCredentials();
      onSessionExpired();
      handler.next(err);
    } on DioException catch (refreshError) {
      final refreshStatus = refreshError.response?.statusCode;
      // A rate-limited refresh is not a dead session; let the request fail so
      // the UI shows an error instead of logging the user out.
      if (refreshStatus == 429) {
        handler.next(err);
        return;
      }
      await storage.clearCredentials();
      onSessionExpired();
      handler.next(err);
    }
  }
}
