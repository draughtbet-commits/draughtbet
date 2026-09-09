import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// Whether the user has passed the onboarding carousel at least once. Once
/// true, /landing shows the welcome view (sign in / create account) directly,
/// both for the rest of the session and on future app launches.
final landingWelcomeShownProvider =
    StateNotifierProvider<LandingWelcomeShown, bool>(
      (ref) => LandingWelcomeShown(),
    );

class LandingWelcomeShown extends StateNotifier<bool> {
  static const String _key = 'onboarding_completed';

  LandingWelcomeShown() : super(false);

  bool _loaded = false;

  /// Restores the persisted flag from disk (no-op if already loaded).
  Future<void> ensureLoaded() async {
    if (_loaded) return;
    final prefs = await SharedPreferences.getInstance();
    state = prefs.getBool(_key) ?? false;
    _loaded = true;
  }

  /// Marks onboarding as done and persists it for future launches.
  Future<void> complete() async {
    state = true;
    final prefs = await SharedPreferences.getInstance();
    await prefs.setBool(_key, true);
  }
}