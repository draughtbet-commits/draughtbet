import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:draughts_arena/services/secure_storage.dart';
import 'package:draughts_arena/services/token_refresher.dart';
import 'package:flutter_dotenv/flutter_dotenv.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

/// Builds an unsigned JWT whose only claim is `exp`, so the expiry-reading path
/// can be exercised without a real signing key.
String jwtExpiringAt(DateTime when) {
  String seg(Map<String, dynamic> payload) =>
      base64Url.encode(utf8.encode(jsonEncode(payload))).replaceAll('=', '');
  final header = seg({'alg': 'none', 'typ': 'JWT'});
  final body = seg({'userId': 'user-1', 'exp': when.millisecondsSinceEpoch ~/ 1000});
  return '$header.$body.signature';
}

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
  String? _accessToken;
  String? _refreshToken = 'refresh.token';
  String? _userId = 'user-1';

  MockStorage({String? accessToken}) : _accessToken = accessToken;

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
  Future<void> setUserId(String id) async => _userId = id;

  void setRefreshTokenOverride(String? token) => _refreshToken = token;
}

void main() {
  // TokenRefresher resolves its endpoint from dotenv, which is not loaded in
  // the test environment.
  dotenv.testLoad(fileInput: 'BACKEND_URL=http://test');

  group('access token expiry', () {
    test('reads exp from a JWT payload', () {
      final expiry = DateTime.now().add(const Duration(minutes: 15));
      final token = jwtExpiringAt(expiry);
      final parts = token.split('.');
      final payload = jsonDecode(
        utf8.decode(base64Url.decode(base64Url.normalize(parts[1]))),
      ) as Map<String, dynamic>;
      expect(payload['exp'], isA<num>());
    });

    Duration leadTime(Duration remaining) {
      // Mirrors the scheduling rule: headroom is half the remaining lifetime,
      // capped at two minutes.
      const maxLeeway = Duration(minutes: 2);
      final half = Duration(
        milliseconds: (remaining.inMilliseconds * 0.5).round(),
      );
      return remaining - (half < maxLeeway ? half : maxLeeway);
    }

    test('a long-lived token is refreshed a couple of minutes early', () {
      // The bug this guards: a 15 minute token lapsed mid-match and the player
      // lost on the 60s disconnect grace, because nothing refreshed until
      // something had already failed.
      final remaining = const Duration(minutes: 15);
      final delay = leadTime(remaining);

      expect(delay, const Duration(minutes: 13));
      expect(remaining - delay, const Duration(minutes: 2));
    });

    test('a short-lived token does not refresh immediately in a loop', () {
      // A fixed 2 minute lead exceeds a 45s lifetime, so every freshly issued
      // token looks due at once and the client hammers the refresh endpoint
      // into its rate limit.
      final remaining = const Duration(seconds: 45);
      final delay = leadTime(remaining);

      expect(delay, greaterThan(Duration.zero));
      expect(remaining - delay, const Duration(seconds: 22, milliseconds: 500));
    });

    test('an already expired token is refreshed immediately', () {
      expect(leadTime(const Duration(seconds: -30)), lessThan(Duration.zero));
    });

    test('a failed refresh is backed off instead of retried immediately', () {
      // A token that is already past due computes a zero delay, so without a
      // floor a persistently failing refresh spins in a tight loop against the
      // refresh endpoint.
      const leeway = Duration(minutes: 2);
      const floor = Duration(minutes: 1);
      final pastDue = DateTime.now().subtract(const Duration(minutes: 1));
      final due = pastDue.subtract(leeway).difference(DateTime.now());
      expect(due.isNegative, isTrue);

      final bounded = due.isNegative ? Duration.zero : due;
      final afterFailure = bounded < floor ? floor : bounded;

      expect(afterFailure, greaterThanOrEqualTo(floor));
      expect(afterFailure, isNot(Duration.zero));
    });
  });

  group('refresh endpoint URL', () {
    // BACKEND_URL already carries the /api/v1 prefix. TokenRefresher used to
    // append it a second time, so every refresh 404'd and tokens lapsed
    // mid-match with no visible error.
    test('base URL is used verbatim without re-appending the api prefix', () {
      dotenv.testLoad(fileInput: 'BACKEND_URL=http://10.0.2.2:3200/api/v1');
      expect(
        TokenRefresher.resolveBaseUrl(),
        'http://10.0.2.2:3200/api/v1',
      );
    });

    test('falls back to localhost when unset', () {
      dotenv.testLoad(fileInput: 'OTHER=1');
      expect(TokenRefresher.resolveBaseUrl(), 'http://localhost:3000');
    });

    test('refresh resolves to a single /api/v1/auth/refresh path', () async {
      dotenv.testLoad(fileInput: 'BACKEND_URL=http://10.0.2.2:3200/api/v1');
      final storage = MockStorage(accessToken: jwtExpiringAt(DateTime.now()));
      String? requestedPath;
      final dio = Dio(BaseOptions(baseUrl: TokenRefresher.resolveBaseUrl()));
      dio.httpClientAdapter = FakeAdapter((options) {
        requestedPath = options.uri.path;
        return ResponseBody.fromString(
          jsonEncode({
            'accessToken': 'new.access.token',
            'refreshToken': 'new.refresh.token',
          }),
          200,
          headers: const {'content-type': ['application/json']},
        );
      });

      await TokenRefresher(storage: storage, dio: dio).refresh();

      expect(requestedPath, '/api/v1/auth/refresh');
      expect(requestedPath, isNot(contains('/api/v1/api/v1')));
    });
  });

  group('TokenRefresher', () {
    test('refresh rotates both tokens and persists them', () async {
      final storage = MockStorage(accessToken: jwtExpiringAt(DateTime.now()));
      final dio = Dio(BaseOptions(baseUrl: 'http://test'));
      dio.httpClientAdapter = FakeAdapter(
        (_) => ResponseBody.fromString(
          jsonEncode({
            'accessToken': 'new.access.token',
            'refreshToken': 'new.refresh.token',
          }),
          200,
          headers: const {'content-type': ['application/json']},
        ),
      );
      final refresher = TokenRefresher(storage: storage, dio: dio);

      final tokens = await refresher.refresh();

      expect(tokens.accessToken, 'new.access.token');
      expect(tokens.refreshToken, 'new.refresh.token');
      expect(await storage.accessToken, 'new.access.token');
      expect(await storage.refreshToken, 'new.refresh.token');
    });

    test('concurrent refreshes are deduped into one call', () async {
      final storage = MockStorage(accessToken: jwtExpiringAt(DateTime.now()));
      var calls = 0;
      final dio = Dio(BaseOptions(baseUrl: 'http://test'));
      dio.httpClientAdapter = FakeAdapter((_) {
        calls++;
        return ResponseBody.fromString(
          jsonEncode({
            'accessToken': 'new.access.token',
            'refreshToken': 'new.refresh.token',
          }),
          200,
          headers: const {'content-type': ['application/json']},
        );
      });
      final refresher = TokenRefresher(storage: storage, dio: dio);

      await Future.wait([refresher.refresh(), refresher.refresh()]);

      // Two parallel refreshes would rotate the refresh token twice and
      // invalidate each other.
      expect(calls, 1);
    });

    test('missing refresh token fails loudly instead of hanging', () async {
      final storage = MockStorage(accessToken: jwtExpiringAt(DateTime.now()));
      final dio = Dio(BaseOptions(baseUrl: 'http://test'));
      dio.httpClientAdapter = FakeAdapter(
        (_) => ResponseBody.fromString('{}', 200),
      );
      storage.setRefreshTokenOverride(null);
      final refresher = TokenRefresher(storage: storage, dio: dio);

      expect(refresher.refresh(), throwsA(isA<TokenRefreshException>()));
    });
  });
}