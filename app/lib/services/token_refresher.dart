import 'dart:convert';

import 'package:dio/dio.dart';
import 'package:flutter_dotenv/flutter_dotenv.dart';

import 'secure_storage.dart';

/// A fresh token pair from `POST /auth/refresh`.
class RefreshedTokens {
  RefreshedTokens({required this.accessToken, required this.refreshToken});
  final String accessToken;
  final String refreshToken;
}

/// Exchanges the stored refresh token for a new access token.
///
/// The REST interceptor and the socket both need this, and they need it for the
/// same reason: an access token that is still sitting in secure storage can be
/// expired, and re-reading storage alone cannot fix that. Keeping one
/// implementation also keeps the dedupe of concurrent refreshes in a single
/// place, so a socket retry and an in-flight REST 401 cannot race into two
/// refresh calls and invalidate each other's rotated refresh token.
class TokenRefresher {
  TokenRefresher({required this.storage, Dio? dio}) : _dio = dio ?? Dio();

  final SecureStorageService storage;
  final Dio _dio;
  Future<RefreshedTokens>? _inFlight;

  Future<RefreshedTokens> refresh() {
    final inFlight = _inFlight;
    if (inFlight != null) return inFlight;
    final future = _doRefresh().whenComplete(() => _inFlight = null);
    _inFlight = future;
    return future;
  }

  Future<RefreshedTokens> _doRefresh() async {
    final refreshToken = await storage.refreshToken;
    if (refreshToken == null || refreshToken.isEmpty) {
      throw TokenRefreshException('No refresh token available');
    }

    var userId = await storage.userId;
    if (userId == null || userId.isEmpty) {
      // Fall back to decoding the userId out of the current JWT, for sessions
      // that predate persisting it.
      userId = await _userIdFromAccessToken();
    }
    if (userId == null || userId.isEmpty) {
      throw TokenRefreshException('No user id available to refresh with');
    }

    final baseUrl = dotenv.env['BACKEND_URL'] ?? 'http://localhost:3000';
    final res = await _dio.post<Map<String, dynamic>>(
      '$baseUrl/api/v1/auth/refresh',
      data: {'userId': userId, 'refreshToken': refreshToken},
    );
    final data = res.data;
    if (data == null ||
        data['accessToken'] is! String ||
        data['refreshToken'] is! String) {
      throw TokenRefreshException('Refresh response was malformed');
    }

    final tokens = RefreshedTokens(
      accessToken: data['accessToken'] as String,
      refreshToken: data['refreshToken'] as String,
    );
    await storage.setAccessToken(tokens.accessToken);
    await storage.setRefreshToken(tokens.refreshToken);
    return tokens;
  }

  Future<String?> _userIdFromAccessToken() async {
    try {
      final token = await storage.accessToken;
      if (token == null) return null;
      final parts = token.split('.');
      if (parts.length != 3) return null;
      final payload = jsonDecode(
        utf8.decode(base64Url.decode(base64Url.normalize(parts[1]))),
      );
      if (payload is Map<String, dynamic>) {
        final id = payload['userId']?.toString();
        if (id != null && id.isNotEmpty) {
          await storage.setUserId(id);
          return id;
        }
      }
    } catch (_) {}
    return null;
  }
}

class TokenRefreshException implements Exception {
  TokenRefreshException(this.message);
  final String message;
  @override
  String toString() => 'TokenRefreshException: $message';
}