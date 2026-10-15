import 'package:draughts_arena/config/google_auth.dart';
import 'package:draughts_arena/services/google_auth_service.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:google_sign_in/google_sign_in.dart';
import 'package:mocktail/mocktail.dart';

class MockGoogleSignIn extends Mock implements GoogleSignIn {}

class MockGoogleAccount extends Mock implements GoogleSignInAccount {}

const _configured = GoogleAuthConfig(
  serverClientId: 'web-client-id.apps.googleusercontent.com',
  clientId: '',
);
const _unconfigured = GoogleAuthConfig(serverClientId: '', clientId: '');

void main() {
  late MockGoogleSignIn signIn;
  late MockGoogleAccount account;

  setUp(() {
    signIn = MockGoogleSignIn();
    account = MockGoogleAccount();
    when(
      () => signIn.initialize(
        serverClientId: any(named: 'serverClientId'),
        clientId: any(named: 'clientId'),
        nonce: any(named: 'nonce'),
        hostedDomain: any(named: 'hostedDomain'),
      ),
    ).thenAnswer((_) async {});
  });

  test('returns the OpenID Connect id token from the native flow', () async {
    when(() => account.authentication).thenReturn(
      const GoogleSignInAuthentication(idToken: 'the-id-token'),
    );
    when(
      () => signIn.authenticate(scopeHint: any(named: 'scopeHint')),
    ).thenAnswer((_) async => account);

    final service = GoogleAuthService(signIn: signIn, config: _configured);

    expect(await service.signIn(), 'the-id-token');
  });

  test('initializes the SDK exactly once across calls', () async {
    when(() => account.authentication).thenReturn(
      const GoogleSignInAuthentication(idToken: 'tok'),
    );
    when(
      () => signIn.authenticate(scopeHint: any(named: 'scopeHint')),
    ).thenAnswer((_) async => account);

    final service = GoogleAuthService(signIn: signIn, config: _configured);
    await service.signIn();
    await service.signIn();

    verify(
      () => signIn.initialize(
        serverClientId: any(named: 'serverClientId'),
        clientId: any(named: 'clientId'),
        nonce: any(named: 'nonce'),
        hostedDomain: any(named: 'hostedDomain'),
      ),
    ).called(1);
  });

  test('treats a user cancellation as a null result', () async {
    when(
      () => signIn.authenticate(scopeHint: any(named: 'scopeHint')),
    ).thenThrow(
      const GoogleSignInException(code: GoogleSignInExceptionCode.canceled),
    );

    final service = GoogleAuthService(signIn: signIn, config: _configured);

    expect(await service.signIn(), isNull);
  });

  test('refuses to start when the build has no OAuth client id', () async {
    final service = GoogleAuthService(
      signIn: MockGoogleSignIn(),
      config: _unconfigured,
    );

    expect(service.isConfigured, isFalse);
    await expectLater(
      service.signIn(),
      throwsA(isA<GoogleSignInUnavailableException>()),
    );
  });

  test('throws when Google returns no identity token', () async {
    when(() => account.authentication).thenReturn(
      const GoogleSignInAuthentication(idToken: null),
    );
    when(
      () => signIn.authenticate(scopeHint: any(named: 'scopeHint')),
    ).thenAnswer((_) async => account);

    final service = GoogleAuthService(signIn: signIn, config: _configured);

    await expectLater(
      service.signIn(),
      throwsA(isA<GoogleSignInUnavailableException>()),
    );
  });
}
