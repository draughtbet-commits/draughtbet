import 'package:flutter_dotenv/flutter_dotenv.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:draughts_arena/config/backend_url.dart';

// The --dart-define branch cannot be exercised here: String.fromEnvironment is
// fixed at compile time, so these tests cover the .env fallback and the
// hardcoded default, which is what `flutter run` and the test suite use.
void main() {
  test('uses BACKEND_URL from the bundled .env when present', () {
    dotenv.testLoad(fileInput: 'BACKEND_URL=https://api.example.test/api/v1');
    expect(resolveBackendUrl(), 'https://api.example.test/api/v1');
  });

  test('trims whitespace around the configured URL', () {
    dotenv.testLoad(fileInput: 'BACKEND_URL=  https://api.example.test/api/v1  ');
    expect(resolveBackendUrl(), 'https://api.example.test/api/v1');
  });

  test('falls back to localhost when BACKEND_URL is absent', () {
    dotenv.testLoad(fileInput: 'BACKEND_CONTRACT=legacy');
    expect(resolveBackendUrl(), 'http://localhost:3000');
  });

  test('falls back to localhost when BACKEND_URL is blank', () {
    dotenv.testLoad(fileInput: 'BACKEND_URL=');
    expect(resolveBackendUrl(), 'http://localhost:3000');
  });
}
