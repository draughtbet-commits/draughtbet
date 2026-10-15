import 'dart:async';
import 'dart:ui';

import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_dotenv/flutter_dotenv.dart';
import 'package:go_router/go_router.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'providers/auth_provider.dart';
import 'providers/eligibility_provider.dart';
import 'providers/match_flow_provider.dart';
import 'router/app_router.dart';
import 'services/api_client.dart';
import 'services/fcm_service.dart';
import 'services/push_registration.dart';
import 'services/socket_service.dart';
import 'theme/app_theme.dart';
import 'theme/colors.dart';
import 'theme/typography.dart';

/// Retained so the forced semantics tree outlives the first frame.
SemanticsHandle? semanticsHandle;

/// Keeps framework internals off the screen. Full details still go to logcat
/// for engineers, but the user only ever sees a plain retry panel instead of
/// Flutter's error box, which renders the exception text and stack.
void installErrorBoundary() {
  final previousOnError = FlutterError.onError;
  FlutterError.onError = (details) {
    previousOnError?.call(details);
    debugPrint(
      'UNCAUGHT ${details.exceptionAsString()}\n'
      '${details.library ?? 'flutter'}\n${details.stack}',
    );
  };

  PlatformDispatcher.instance.onError = (error, stack) {
    debugPrint('UNCAUGHT ASYNC $error\n$stack');
    return true;
  };

  ErrorWidget.builder = (details) => _UnexpectedErrorPanel(
        onRetry: () => FlutterError.resetErrorCount(),
      );
}

class _UnexpectedErrorPanel extends StatelessWidget {
  const _UnexpectedErrorPanel({required this.onRetry});

  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    return ColoredBox(
      color: AppColors.background,
      child: Center(
        child: Padding(
          padding: const EdgeInsets.all(32),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Icon(
                LucideIcons.triangleAlert,
                size: 44,
                color: AppColors.danger,
              ),
              const SizedBox(height: 20),
              Text(
                'Something went wrong',
                textAlign: TextAlign.center,
                style: AppTypography.heading3,
              ),
              const SizedBox(height: 10),
              Text(
                'We could not load this page. Your balance and account are '
                'unaffected. Please try again.',
                textAlign: TextAlign.center,
                style: AppTypography.bodyMedium
                    .copyWith(color: AppColors.textSecondary),
              ),
              const SizedBox(height: 28),
              FilledButton(
                onPressed: onRetry,
                child: const Text('Try again'),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

void main() async {
  WidgetsFlutterBinding.ensureInitialized();
  installErrorBoundary();
  // Forces the semantics tree on so `uiautomator dump` can see Flutter widgets,
  // which is what lets an external driver (and the screen recorders) tap real
  // controls. It costs real frame time, so release builds skip it. The handle
  // must be retained: if it is garbage collected, Flutter disposes of the
  // semantics tree and every widget disappears from the dump again.
  if (kDebugMode || kProfileMode) {
    semanticsHandle = SemanticsBinding.instance.ensureSemantics();
  }

  // Load environment variables (will fail if .env is missing, which is expected before setup)
  try {
    await dotenv.load(fileName: ".env");
  } catch (e) {
    debugPrint("No .env file found. Proceeding with default config.");
  }

  // Firebase powers offline push. Without google-services.json the init throws;
  // that is expected on a dev build and simply leaves push unavailable — the
  // socket path keeps working.
  try {
    await Firebase.initializeApp();
    FirebaseMessaging.onBackgroundMessage(firebaseMessagingBackgroundHandler);
  } catch (e) {
    debugPrint("Firebase not configured. Push disabled: $e");
  }

  runApp(const ProviderScope(child: DraughtsArenaApp()));
}

class DraughtsArenaApp extends ConsumerWidget {
  const DraughtsArenaApp({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final router = ref.watch(appRouterProvider);

    return MaterialApp.router(
      title: 'Draught Bet',
      themeMode: ThemeMode.dark, // Enforce Dark Mode First
      darkTheme: AppTheme.dark,
      routerConfig: router,
      builder: (context, child) => PushRegistrationBridge(
        child: ChallengeInboxBridge(child: child ?? const SizedBox.shrink()),
      ),
    );
  }
}

/// Registers the device's push token with the backend once a session is live,
/// and re-registers when FCM rotates it. Kept off the auth notifier so unit
/// tests never touch the Firebase/notification platform channels; nothing runs
/// until the player is authenticated.
class PushRegistrationBridge extends ConsumerStatefulWidget {
  const PushRegistrationBridge({super.key, required this.child});

  final Widget child;

  @override
  ConsumerState<PushRegistrationBridge> createState() =>
      _PushRegistrationBridgeState();
}

class _PushRegistrationBridgeState
    extends ConsumerState<PushRegistrationBridge> {
  bool _registered = false;

  Future<void> _register() async {
    if (_registered) return;
    _registered = true;
    // Wire the refresh callback once, so a rotated token replaces the stored one.
    fcmService.onTokenRefresh = (_) {
      _registered = false;
      unawaited(_register());
    };
    await registerDevicePushToken(ref.read(apiClientProvider));
  }

  @override
  Widget build(BuildContext context) {
    ref.listen<AuthState>(authProvider, (previous, next) {
      if (!next.isAuthenticated) {
        // Reset so the next sign-in re-registers (possibly a new account).
        _registered = false;
        return;
      }
      if (!(previous?.isAuthenticated ?? false)) {
        unawaited(_register());
      }
    });
    return widget.child;
  }
}

/// Routes an incoming challenge notification to the challenge screen. The
/// invitee holds no match seat yet, so the screen state is built from the
/// players challenge listing rather than the match snapshot.
class ChallengeInboxBridge extends ConsumerStatefulWidget {
  const ChallengeInboxBridge({super.key, required this.child});

  final Widget child;

  @override
  ConsumerState<ChallengeInboxBridge> createState() =>
      _ChallengeInboxBridgeState();
}

class _ChallengeInboxBridgeState extends ConsumerState<ChallengeInboxBridge>
    with WidgetsBindingObserver {
  StreamSubscription<Map<String, dynamic>>? _subscription;
  final Set<String> _handled = <String>{};

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _subscription = socketService.onNotification.listen((data) {
      if (data['type'] != 'MATCH_CHALLENGE') return;
      final matchId = data['matchId']?.toString();
      if (matchId == null || matchId.isEmpty || _handled.contains(matchId)) {
        return;
      }
      _handled.add(matchId);
      _openIncoming(matchId);
    });
  }

  Future<void> _openIncoming(String matchId) async {
    final notifier = ref.read(matchFlowProvider.notifier);
    if (ref.read(matchFlowProvider).currentMatchId == matchId) return;
    final snapshot = await notifier.handleIncomingChallenge(matchId);
    if (!mounted || snapshot == null) return;
    context.go('/play/challenge', extra: snapshot);
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    // Re-read the server-owned restriction when the app comes back to the
    // foreground. A reinstatement that happened while the app was backgrounded
    // would otherwise leave the banner up until the next cold start.
    if (state == AppLifecycleState.resumed) {
      ref.read(eligibilityProvider.notifier).refreshCanonical();
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _subscription?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => widget.child;
}
