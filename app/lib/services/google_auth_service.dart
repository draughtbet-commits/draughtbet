import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:google_sign_in/google_sign_in.dart';

import '../config/google_auth.dart';

/// Raised when the native Google flow cannot run: the build was compiled
/// without the OAuth client ids, or Google returned no identity token.
class GoogleSignInUnavailableException implements Exception {
  GoogleSignInUnavailableException([
    this.message = 'Google sign-in is not available on this build.',
  ]);

  final String message;

  @override
  String toString() => message;
}

/// The verified identity Google hands back for a brand-new account, used to
/// prefill the registration form the user still has to complete.
class GoogleProfile {
  const GoogleProfile({this.email, this.fullName, this.picture});

  final String? email;
  final String? fullName;
  final String? picture;
}

/// Carries the Google identity across the login -> register navigation. The
/// id token is deliberately in-memory only (never persisted) so it cannot be
/// replayed by a later launch.
class GoogleSignupArgs {
  const GoogleSignupArgs({
    required this.idToken,
    this.email,
    this.fullName,
    this.picture,
  });

  final String idToken;
  final String? email;
  final String? fullName;
  final String? picture;
}

enum GoogleAuthStatus { authenticated, requiresRegistration, failure }

class GoogleAuthResult {
  const GoogleAuthResult({required this.status, this.profile, this.error});

  final GoogleAuthStatus status;
  final GoogleProfile? profile;
  final String? error;
}

/// Thin wrapper over the platform `GoogleSignIn` SDK.
///
/// A single [GoogleSignIn.instance] serves the whole app and its
/// `initialize` must run exactly once before any other call, so this service
/// memoises that bootstrap. Tests inject a mock instance via the constructor.
class GoogleAuthService {
  GoogleAuthService({GoogleSignIn? signIn, GoogleAuthConfig? config})
    : _signIn = signIn ?? GoogleSignIn.instance,
      _config = config ?? resolveGoogleAuthConfig();

  final GoogleSignIn _signIn;
  final GoogleAuthConfig _config;
  bool _initialized = false;

  bool get isConfigured => _config.isConfigured;

  Future<void> _ensureInitialized() async {
    if (_initialized) return;
    await _signIn.initialize(
      serverClientId: _config.serverClientId.isEmpty
          ? null
          : _config.serverClientId,
      clientId: _config.clientId.isEmpty ? null : _config.clientId,
    );
    _initialized = true;
  }

  /// Runs the interactive Google flow and resolves with the OpenID Connect id
  /// token the backend verifies. Returns null when the user dismissed the
  /// sheet. Throws [GoogleSignInUnavailableException] when the build is not
  /// configured or Google returned no token.
  Future<String?> signIn() async {
    if (!_config.isConfigured) {
      throw GoogleSignInUnavailableException();
    }
    await _ensureInitialized();
    try {
      final account = await _signIn.authenticate();
      final idToken = account.authentication.idToken;
      if (idToken == null || idToken.isEmpty) {
        throw GoogleSignInUnavailableException(
          'Google did not return an identity token.',
        );
      }
      return idToken;
    } on GoogleSignInException catch (e) {
      // A dismissed sheet is a normal outcome, not an error.
      if (e.code == GoogleSignInExceptionCode.canceled ||
          e.code == GoogleSignInExceptionCode.interrupted) {
        return null;
      }
      rethrow;
    }
  }

  /// Best-effort native sign-out so the next attempt shows the account picker
  /// instead of silently reusing the previous Google account.
  Future<void> signOut() async {
    try {
      await _signIn.signOut();
    } catch (_) {
      // Nothing actionable: local session cleanup must proceed regardless.
    }
  }
}

final googleAuthServiceProvider = Provider<GoogleAuthService>(
  (ref) => GoogleAuthService(),
);
