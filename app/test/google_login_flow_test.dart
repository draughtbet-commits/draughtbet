import 'package:dio/dio.dart';
import 'package:draughts_arena/providers/auth_provider.dart';
import 'package:draughts_arena/services/google_auth_service.dart';
import 'package:draughts_arena/services/secure_storage.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

class MockDio extends Mock implements Dio {}

class MockStorage extends Mock implements SecureStorageService {
  String? _accessToken;
  String? _refreshToken;
  String? _userId;

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
  @override
  Future<void> clearCredentials() async {
    _accessToken = null;
    _refreshToken = null;
    _userId = null;
  }
}

Response<dynamic> _response(String path, int status, Object? body) =>
    Response<dynamic>(
      requestOptions: RequestOptions(path: path),
      statusCode: status,
      data: body,
    );

void main() {
  setUp(() {
    // The auth notifier tears down / reinitialises the global socket on login;
    // an empty store makes that init bail before it can open a connection.
    FlutterSecureStorage.setMockInitialValues({});
  });

  test('an existing account returns a session and persists the tokens', () async {
    final dio = MockDio();
    when(() => dio.post(any(), data: any(named: 'data'))).thenAnswer(
      (_) async => _response('/auth/google', 200, {
        'registered': true,
        'accessToken': 'access.token',
        'refreshToken': 'refresh.token',
      }),
    );
    final storage = MockStorage();
    final notifier = AuthNotifier(dio, storage);
    await Future<void>.delayed(Duration.zero);

    final result = await notifier.loginWithGoogle('id-token');

    expect(result.status, GoogleAuthStatus.authenticated);
    expect(await storage.accessToken, 'access.token');
    expect(await storage.refreshToken, 'refresh.token');
    expect(notifier.state.isAuthenticated, isTrue);
    notifier.dispose();
  });

  test('an unknown email returns the verified profile for sign-up', () async {
    final dio = MockDio();
    when(() => dio.post(any(), data: any(named: 'data'))).thenAnswer(
      (_) async => _response('/auth/google', 200, {
        'registered': false,
        'profile': {
          'email': 'new@example.com',
          'fullName': 'New Player',
          'picture': 'https://example.com/p.png',
        },
      }),
    );
    final notifier = AuthNotifier(dio, MockStorage());
    await Future<void>.delayed(Duration.zero);

    final result = await notifier.loginWithGoogle('id-token');

    expect(result.status, GoogleAuthStatus.requiresRegistration);
    expect(result.profile?.email, 'new@example.com');
    expect(result.profile?.fullName, 'New Player');
    expect(notifier.state.isAuthenticated, isFalse);
    notifier.dispose();
  });

  test('a rejected token surfaces the backend error', () async {
    final dio = MockDio();
    when(() => dio.post(any(), data: any(named: 'data'))).thenThrow(
      DioException(
        requestOptions: RequestOptions(path: '/auth/google'),
        type: DioExceptionType.badResponse,
        response: _response('/auth/google', 401, {'error': 'Invalid Google token'}),
      ),
    );
    final notifier = AuthNotifier(dio, MockStorage());
    await Future<void>.delayed(Duration.zero);

    final result = await notifier.loginWithGoogle('bad-token');

    expect(result.status, GoogleAuthStatus.failure);
    expect(result.error, 'Invalid Google token');
    expect(notifier.state.error, 'Invalid Google token');
    notifier.dispose();
  });

  test('register forwards the id token and omits the password', () async {
    final dio = MockDio();
    Map<String, dynamic>? sent;
    when(() => dio.post(any(), data: any(named: 'data'))).thenAnswer((
      invocation,
    ) async {
      sent = Map<String, dynamic>.from(
        invocation.namedArguments[#data] as Map,
      );
      return _response('/auth/register', 201, {
        'accessToken': 'access.token',
        'refreshToken': 'refresh.token',
      });
    });
    final notifier = AuthNotifier(dio, MockStorage());
    await Future<void>.delayed(Duration.zero);

    final ok = await notifier.register(
      email: 'new@example.com',
      dateOfBirth: DateTime(2000, 1, 1),
      countryCode: 'NG',
      geoBinding: 'geo-abcdefgh',
      googleIdToken: 'google-id-token',
    );

    expect(ok, isTrue);
    expect(sent?['googleIdToken'], 'google-id-token');
    expect(sent?.containsKey('password'), isFalse);
    notifier.dispose();
  });
}
