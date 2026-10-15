import 'package:flutter_dotenv/flutter_dotenv.dart';

/// Compile-time override for release/CI builds, e.g.
///
///   flutter build apk --release \
///     --dart-define=BACKEND_URL=https://api.draughtbet.com/api/v1
///
/// Empty when the define is absent, so `flutter run` keeps using the bundled
/// `.env` for local and emulator work.
const String _backendUrlDefine = String.fromEnvironment('BACKEND_URL');

/// The single source of truth for the backend base URL.
///
/// Resolution order:
///   1. `--dart-define=BACKEND_URL=…` (release/CI builds)
///   2. the bundled `.env` `BACKEND_URL` (local dev, emulators)
///   3. `http://localhost:3000`
///
/// The returned value always carries the `/api/v1` prefix. Socket.IO strips it
/// (see `SocketService`), so REST and realtime follow the same setting.
String resolveBackendUrl() {
  final fromDefine = _backendUrlDefine.trim();
  if (fromDefine.isNotEmpty) return fromDefine;

  final fromDotenv = dotenv.isInitialized
      ? dotenv.env['BACKEND_URL']?.trim() ?? ''
      : '';
  return fromDotenv.isNotEmpty ? fromDotenv : 'http://localhost:3000';
}
