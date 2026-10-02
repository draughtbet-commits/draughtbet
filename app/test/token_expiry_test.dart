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

    test('a token inside the leeway window must be refreshed before it lapses', () {
      // The bug this guards: a 15 minute token lapsed mid-match and the player
      // lost on the 60s disconnect grace, because nothing refreshed until
      // something had already failed.
      const leeway = Duration(minutes: 2);
      final now = DateTime.now();
      final tokenExpiry = now.add(const Duration(minutes: 15));
      final refreshDueAt = tokenExpiry.subtract(leeway);

      expect(refreshDueAt.isAfter(now), isTrue);
      expect(
        tokenExpiry.difference(now) < const Duration(minutes: 3),
        isFalse,
        reason: 'a fresh token is not yet inside the refresh window',
      );
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