import 'package:flutter_dotenv/flutter_dotenv.dart';

/// Compile-time overrides for release/CI builds, e.g.
///
///   flutter build apk --release \
///     --dart-define=GOOGLE_SERVER_CLIENT_ID=…apps.googleusercontent.com
///
/// Empty when the define is absent, so `flutter run` keeps using the bundled
/// `.env` for local and emulator work.
const String _serverClientIdDefine = String.fromEnvironment(
  'GOOGLE_SERVER_CLIENT_ID',
);
const String _clientIdDefine = String.fromEnvironment('GOOGLE_CLIENT_ID');

/// The Google OAuth client identifiers used to bootstrap the native sign-in SDK.
///
/// [serverClientId] is the **Web** client id. It is the one that makes Android
/// return an OpenID Connect id token (`nones`), so it is effectively required
/// on Android; the Android OAuth client is matched server-side by the app's
/// package name and signing SHA-1.
///
/// [clientId] is the iOS client id; unused on Android.
class GoogleAuthConfig {
  const GoogleAuthConfig({
    required this.serverClientId,
    required this.clientId,
  });

  final String serverClientId;
  final String clientId;

  bool get isConfigured => serverClientId.isNotEmpty || clientId.isNotEmpty;

  static GoogleAuthConfig fromSources({
    String? serverClientIdDefine,
    String? clientIdDefine,
  }) {
    return GoogleAuthConfig(
      serverClientId: _resolve(
        serverClientIdDefine ?? _serverClientIdDefine,
        'GOOGLE_SERVER_CLIENT_ID',
      ),
      clientId: _resolve(clientIdDefine ?? _clientIdDefine, 'GOOGLE_CLIENT_ID'),
    );
  }

  static String _resolve(String fromDefine, String key) {
    final trimmed = fromDefine.trim();
    if (trimmed.isNotEmpty) return trimmed;
    final fromDotenv = dotenv.isInitialized
        ? dotenv.env[key]?.trim() ?? ''
        : '';
    return fromDotenv;
  }
}

GoogleAuthConfig resolveGoogleAuthConfig() => GoogleAuthConfig.fromSources();
