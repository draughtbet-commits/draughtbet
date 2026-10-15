import 'package:flutter_dotenv/flutter_dotenv.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:draughts_arena/config/google_auth.dart';

// The --dart-define branch cannot be exercised here (String.fromEnvironment is
// fixed at compile time), so these tests drive the override parameters directly
// plus the bundled .env fallback, which is what `flutter run` uses.
void main() {
  test('prefers the dart-define overrides', () {
    dotenv.testLoad(fileInput: 'GOOGLE_SERVER_CLIENT_ID=env-web');
    final config = GoogleAuthConfig.fromSources(
      serverClientIdDefine: 'define-web',
      clientIdDefine: 'define-ios',
    );
    expect(config.serverClientId, 'define-web');
    expect(config.clientId, 'define-ios');
    expect(config.isConfigured, isTrue);
  });

  test('falls back to the bundled .env when no define is present', () {
    dotenv.testLoad(
      fileInput: 'GOOGLE_SERVER_CLIENT_ID=env-web\nGOOGLE_CLIENT_ID=env-ios',
    );
    final config = GoogleAuthConfig.fromSources(
      serverClientIdDefine: '',
      clientIdDefine: '',
    );
    expect(config.serverClientId, 'env-web');
    expect(config.clientId, 'env-ios');
  });

  test('reports unconfigured when nothing is set', () {
    dotenv.testLoad(fileInput: 'BACKEND_CONTRACT=v2');
    final config = GoogleAuthConfig.fromSources(
      serverClientIdDefine: '',
      clientIdDefine: '',
    );
    expect(config.isConfigured, isFalse);
  });

  test('trims whitespace around configured ids', () {
    final config = GoogleAuthConfig.fromSources(
      serverClientIdDefine: '  web-id  ',
      clientIdDefine: '',
    );
    expect(config.serverClientId, 'web-id');
    expect(config.isConfigured, isTrue);
  });
}
