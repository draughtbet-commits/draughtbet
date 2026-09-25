import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_dotenv/flutter_dotenv.dart';
import 'package:go_router/go_router.dart';
import 'providers/match_flow_provider.dart';
import 'router/app_router.dart';
import 'services/socket_service.dart';
import 'theme/app_theme.dart';

void main() async {
  WidgetsFlutterBinding.ensureInitialized();

  // Load environment variables (will fail if .env is missing, which is expected before setup)
  try {
    await dotenv.load(fileName: ".env");
  } catch (e) {
    debugPrint("No .env file found. Proceeding with default config.");
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
      builder: (context, child) =>
          ChallengeInboxBridge(child: child ?? const SizedBox.shrink()),
    );
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

class _ChallengeInboxBridgeState extends ConsumerState<ChallengeInboxBridge> {
  StreamSubscription<Map<String, dynamic>>? _subscription;
  final Set<String> _handled = <String>{};

  @override
  void initState() {
    super.initState();
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
  void dispose() {
    _subscription?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => widget.child;
}
