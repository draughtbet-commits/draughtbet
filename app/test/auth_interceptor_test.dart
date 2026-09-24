import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:draughts_arena/services/api_client.dart';
import 'package:draughts_arena/services/secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

/// Fake transport so the interceptor (and its dedicated refresh client) can
/// be exercised without real network. Both the main Dio and the
/// AuthInterceptor's internal refresh client share this adapter, which is
/// what lets a refresh 401 surface as a genuine DioException.
class FakeAdapter implements HttpClientAdapter {
  FakeAdapter(this.handler);
  final ResponseBody Function(RequestOptions) handler;

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async =>
      handler(options);

  @override
  void close({bool force = false}) {}
}

class MockStorage extends Mock implements SecureStorageService {
  String? _accessToken = 'stale.access.token';
  String? _refreshToken = 'dead.refresh.token';
  String? _userId = 'user-1';
  int cleared = 0;

  @override
  Future<String?> get accessToken async => _accessToken;
  @override
  Future<String?> get refreshToken async => _refreshToken;
  @override
  Future<String?> get userId async => _userId;
  @override
  Future<void> setAccessToken(String token) async => _accessToken = token;
  @override
  Future<void> setRefreshToken(String token) async => _refreshToken = token;
  @override
  Future<void> clearCredentials() async {
    _accessToken = null;
    _refreshToken = null;
    _userId = null;
    cleared++;
  }
}

Dio _buildDio(FakeAdapter adapter, MockStorage storage, void Function() onSessionExpired) {
  final dio = Dio(
    BaseOptions(baseUrl: 'http://test', connectTimeout: Duration(seconds: 3)),
  );
  dio.httpClientAdapter = adapter;
  dio.interceptors.add(
    AuthInterceptor(dio: dio, storage: storage, onSessionExpired: onSessionExpired),
  );
  return dio;
}

ResponseBody _json(Object body, int status) => ResponseBody.fromString(
      jsonEncode(body),
      status,
      headers: const {'content-type': ['application/json']},
    );

void main() {
  test('dead refresh token (401) signs out, clears credentials, and does not hang', () async {
    final storage = MockStorage();
    final adapter = FakeAdapter((options) {
      if (options.path == '/auth/refresh') {
        return _json({'error': 'Refresh token is invalid or expired'}, 401);
      }
      return _json({'error': 'Unauthorized'}, 401);
    });
    var signedOut = false;
    final unhandled = <Object>[];

    await runZonedGuarded(
      () async {
        final dio = _buildDio(adapter, storage, () => signedOut = true);
        Object? error;
        try {
          await dio
              .get('/me')
              .timeout(const Duration(seconds: 8), onTimeout: () {
                throw TimeoutException('request never completed');
              });
        } catch (e) {
          error = e;
        }
        // A dead refresh token must NOT leave the request pending forever.
        expect(error, isA<DioException>(), reason: 'request must complete');
      },
      (e, s) => unhandled.add(e),
    );

    expect(unhandled, isEmpty, reason: 'no unhandled async errors escaped');
    expect(signedOut, isTrue, reason: 'dead refresh token must sign the session out');
    expect(storage.cleared, greaterThan(0), reason: 'credentials must be cleared');
  });

  test('valid refresh rotates tokens, retries the request, and does not sign out', () async {
    final storage = MockStorage();
    final adapter = FakeAdapter((options) {
      if (options.path == '/auth/refresh') {
        return _json({'accessToken': 'fresh.access', 'refreshToken': 'fresh.refresh'}, 200);
      }
      if (options.headers['Authorization'] == 'Bearer fresh.access') {
        return _json({'ok': true}, 200);
      }
      return _json({'error': 'Unauthorized'}, 401);
    });
    var signedOut = false;

    final dio = _buildDio(adapter, storage, () => signedOut = true);
    final res = await dio.get('/me', options: Options(headers: {'Authorization': 'Bearer stale.access.token'}));

    expect(res.statusCode, 200);
    expect(signedOut, isFalse);
    expect(storage.cleared, 0);
    expect(await storage.accessToken, 'fresh.access');
  });
}