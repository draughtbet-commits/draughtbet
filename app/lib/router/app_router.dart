import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../providers/auth_provider.dart';
import '../screens/login_screen.dart';
import '../screens/register_screen.dart';
import '../screens/landing_page.dart';
import '../screens/home_lobby_screen.dart';
import '../screens/match_screen.dart';
import '../screens/arena_screen.dart';
import '../screens/create_match_screen.dart';
import '../screens/match_confirmation_screen.dart';
import '../screens/matchmaking_screen.dart';
import '../screens/match_room_screen.dart';
import '../screens/match_result_screen.dart';
import '../screens/settlement_result_screens.dart';
import '../screens/match_lifecycle_screens.dart';
import '../screens/player_discovery_screens.dart';
import '../screens/tier_select_screen.dart';
import '../models/match_flow.dart';
import '../screens/crown_screen.dart';
import '../screens/wallet_read_screens.dart';
import '../models/wallet_read.dart';
import '../screens/deposit_flow_screens.dart';
import '../providers/deposit_provider.dart';
import '../providers/withdrawal_provider.dart';
import '../providers/match_flow_provider.dart';
import '../providers/match_provider.dart';
import '../screens/withdrawal_flow_screens.dart';
import '../screens/settings_screen.dart';
import '../screens/results_screen.dart';
import '../screens/game_move_history_screen.dart';
import '../services/socket_service.dart';
import 'lifecycle_routes.dart';
import '../widgets/main_layout.dart';

final appRouterProvider = Provider<GoRouter>((ref) {
  final refresh = ValueNotifier<bool>(false);
  ref.listen<AuthState>(
    authProvider,
    (previous, next) => refresh.value = !refresh.value,
  );
  ref.onDispose(refresh.dispose);

  return GoRouter(
    initialLocation: LandingPage.route,
    refreshListenable: refresh,
    redirect: (context, state) {
      final isLoggedIn = ref.read(authProvider).isAuthenticated;
      final location = state.matchedLocation;
      final isAuthRoute = location == '/login' || location == '/register';
      final isPublicRoute = location == LandingPage.route;

      // Authenticated users never see onboarding or the auth forms.
      if (isLoggedIn) return (isAuthRoute || isPublicRoute) ? '/home' : null;
      if (isPublicRoute) return null; // logged-out users start on the landing
      if (!isAuthRoute) return '/login';
      return null;
    },
    routes: [
      GoRoute(
        path: LandingPage.route,
        builder: (context, state) => const LandingPage(),
      ),
      GoRoute(path: '/login', builder: (context, state) => const LoginScreen()),
      GoRoute(
        path: '/register',
        builder: (context, state) => const RegisterScreen(),
      ),
      ShellRoute(
        builder: (context, state, child) {
          return MainLayout(child: child);
        },
        routes: [
          GoRoute(
            path: '/home',
            builder: (context, state) => const HomeLobbyScreen(),
          ),
          GoRoute(
            path: '/crown',
            builder: (context, state) => const CrownScreen(),
          ),
          GoRoute(
            path: '/wallet',
            builder: (context, state) => const WalletDashboardScreen(),
          ),
          GoRoute(
            path: '/wallet/transactions',
            builder: (context, state) => const TransactionHistoryScreen(),
          ),
          GoRoute(
            path: '/wallet/transaction',
            redirect: (context, state) =>
                state.extra is WalletEntry ? null : '/wallet/transactions',
            builder: (context, state) => WalletTransactionDetailScreen(
              entry: state.extra! as WalletEntry,
            ),
          ),
          GoRoute(
            path: '/wallet/locked',
            builder: (context, state) => const LockedFundsScreen(),
          ),
          GoRoute(
            path: '/wallet/unavailable',
            builder: (context, state) => const WalletUnavailableScreen(),
          ),
          GoRoute(
            path: '/arena',
            builder: (context, state) => const ArenaScreen(),
          ),
          GoRoute(
            path: '/arena/players',
            builder: (context, state) => const PlayerSearchScreen(),
          ),
          GoRoute(
            path: '/arena/player',
            redirect: (context, state) =>
                state.extra is MatchPlayer ? null : '/arena/players',
            builder: (context, state) =>
                PublicPlayerProfileScreen(player: state.extra! as MatchPlayer),
          ),
          GoRoute(
            path: '/results',
            builder: (context, state) => const ResultsScreen(),
          ),
          GoRoute(
            path: '/profile',
            builder: (context, state) => const SettingsScreen(),
          ),
          GoRoute(
            path: '/profile/saved-bank-accounts',
            builder: (context, state) => const SavedBankAccountsScreen(),
          ),
        ],
      ),
      GoRoute(
        path: '/play/create',
        builder: (context, state) => const CreateMatchScreen(),
      ),
      GoRoute(
        path: '/play/tier',
        builder: (context, state) => const TierSelectScreen(),
      ),
      GoRoute(
        path: '/play/quick',
        builder: (context, state) => const CreateMatchScreen(),
      ),
      GoRoute(
        path: '/play/open-details',
        redirect: (context, state) =>
            state.extra is OpenMatch ? null : '/play/unavailable',
        builder: (context, state) =>
            OpenMatchDetailsScreen(match: state.extra! as OpenMatch),
      ),
      GoRoute(
        path: '/play/unavailable',
        builder: (context, state) => MatchUnavailableScreen(
          alreadyFilled: state.uri.queryParameters['reason'] == 'filled',
        ),
      ),
      GoRoute(
        path: '/play/insufficient-balance',
        redirect: (context, state) =>
            state.extra is MatchLifecycleSnapshot ? null : '/play/unavailable',
        builder: (context, state) => InsufficientBalanceScreen(
          snapshot: state.extra! as MatchLifecycleSnapshot,
        ),
      ),
      GoRoute(
        path: '/play/stake-limit',
        redirect: (context, state) =>
            state.extra is MatchLifecycleSnapshot ? null : '/play/unavailable',
        builder: (context, state) => StakeEligibilityBlockedScreen(
          snapshot: state.extra! as MatchLifecycleSnapshot,
        ),
      ),
      GoRoute(
        path: '/play/locking-stake',
        redirect: (context, state) =>
            state.extra is MatchLifecycleSnapshot ? null : '/play/unavailable',
        builder: (context, state) => LockingStakeScreen(
          snapshot: state.extra! as MatchLifecycleSnapshot,
        ),
      ),
      GoRoute(
        path: '/play/waiting-stake',
        redirect: (context, state) =>
            state.extra is MatchLifecycleSnapshot ? null : '/play/unavailable',
        builder: (context, state) => WaitingOpponentStakeScreen(
          snapshot: state.extra! as MatchLifecycleSnapshot,
        ),
      ),
      GoRoute(
        path: '/play/ready',
        redirect: (context, state) =>
            state.extra is MatchLifecycleSnapshot ? null : '/play/unavailable',
        builder: (context, state) => Consumer(
          builder: (context, ref, _) {
            final snapshot = state.extra! as MatchLifecycleSnapshot;
            return _PrePlayLifecycleWatcher(
              snapshot: snapshot,
              child: ReadyCheckScreen(
                snapshot: snapshot,
                onReady: () async {
                  final updated = await ref
                      .read(matchFlowProvider.notifier)
                      .markReady();
                  if (!context.mounted || updated == null) return;
                  context.go('/play/waiting-ready', extra: updated);
                },
              ),
            );
          },
        ),
      ),
      GoRoute(
        path: '/play/waiting-ready',
        redirect: (context, state) =>
            state.extra is MatchLifecycleSnapshot ? null : '/play/unavailable',
        builder: (context, state) {
          final snapshot = state.extra! as MatchLifecycleSnapshot;
          return _PrePlayLifecycleWatcher(
            snapshot: snapshot,
            child: WaitingOpponentReadyScreen(snapshot: snapshot),
          );
        },
      ),
      GoRoute(
        path: '/play/ready-timeout',
        redirect: (context, state) =>
            state.extra is MatchLifecycleSnapshot ? null : '/play/unavailable',
        builder: (context, state) => ReadyTimeoutScreen(
          snapshot: state.extra! as MatchLifecycleSnapshot,
        ),
      ),
      GoRoute(
        path: '/play/disconnected-before-start',
        redirect: (context, state) =>
            state.extra is MatchLifecycleSnapshot ? null : '/play/unavailable',
        builder: (context, state) => OpponentDisconnectedBeforeStartScreen(
          snapshot: state.extra! as MatchLifecycleSnapshot,
        ),
      ),
      GoRoute(
        path: '/play/private-room',
        redirect: (context, state) =>
            state.extra is MatchLifecycleSnapshot ? null : '/play/unavailable',
        builder: (context, state) => PrivateRoomCodeScreen(
          snapshot: state.extra! as MatchLifecycleSnapshot,
        ),
      ),
      GoRoute(
        path: '/play/challenge',
        redirect: (context, state) =>
            state.extra is MatchLifecycleSnapshot ? null : '/play/unavailable',
        builder: (context, state) => Consumer(
          builder: (context, ref, _) {
            final snapshot = state.extra! as MatchLifecycleSnapshot;
            final notifier = ref.read(matchFlowProvider.notifier);
            final sent = snapshot.phase == MatchLifecyclePhase.challengeSent;
            final screen = ChallengeStatusScreen(
              snapshot: snapshot,
              onAccept: snapshot.phase == MatchLifecyclePhase.incomingChallenge
                  ? () async {
                      final updated = await notifier.acceptChallenge();
                      if (!context.mounted || updated == null) return;
                      context.go('/play/ready', extra: updated);
                    }
                  : null,
              onDecline: () async {
                final incoming =
                    snapshot.phase == MatchLifecyclePhase.incomingChallenge;
                if (incoming) {
                  await notifier.declineChallenge();
                } else {
                  await notifier.cancelSentChallenge();
                }
                if (!context.mounted) return;
                context.go('/arena');
              },
            );
            // The inviter waits idle on the sent screen; advance once the
            // invitee joins through the normal fund path.
            return sent ? _SentChallengeWatcher(child: screen) : screen;
          },
        ),
      ),
      GoRoute(
        path: '/play/confirm',
        builder: (context, state) => const MatchConfirmationScreen(),
      ),
      GoRoute(
        path: '/play/search',
        builder: (context, state) => const MatchmakingScreen(),
      ),
      GoRoute(
        path: '/play/room/:id',
        builder: (context, state) =>
            MatchRoomScreen(matchId: state.pathParameters['id']!),
      ),
      GoRoute(
        path: '/play/result',
        redirect: (context, state) =>
            state.extra is MatchResultViewData ? null : '/home',
        builder: (context, state) =>
            MatchResultScreen(result: state.extra! as MatchResultViewData),
      ),
      GoRoute(
        path: '/matches/:id/settlement-processing',
        redirect: (context, state) =>
            state.extra is MatchResultViewData ? null : '/home',
        builder: (context, state) => SettlementStatusScreen(
          result: state.extra! as MatchResultViewData,
          phase: SettlementPhase.pending,
        ),
      ),
      GoRoute(
        path: '/matches/:id/settlement-complete',
        redirect: (context, state) =>
            state.extra is MatchResultViewData ? null : '/home',
        builder: (context, state) => SettlementStatusScreen(
          result: state.extra! as MatchResultViewData,
          phase: SettlementPhase.confirmed,
        ),
      ),
      GoRoute(
        path: '/matches/:id/settlement-delayed',
        redirect: (context, state) =>
            state.extra is MatchResultViewData ? null : '/home',
        builder: (context, state) => SettlementStatusScreen(
          result: state.extra! as MatchResultViewData,
          phase: SettlementPhase.delayed,
        ),
      ),
      GoRoute(
        path: '/matches/:id/receipt',
        builder: (context, state) =>
            MatchReceiptScreen(matchId: state.pathParameters['id']!),
      ),
      GoRoute(
        path: '/match/:id',
        builder: (context, state) {
          final matchId = state.pathParameters['id']!;
          return MatchScreen(matchId: matchId);
        },
      ),
      GoRoute(
        path: '/matches/:id/moves',
        builder: (context, state) =>
            GameMoveHistoryScreen(matchId: state.pathParameters['id']!),
      ),
      GoRoute(
        path: '/wallet/add-money',
        builder: (context, state) => const AddMoneyScreen(),
      ),
      GoRoute(
        path: '/wallet/payment-method',
        builder: (context, state) => const PaymentMethodScreen(),
      ),
      GoRoute(
        path: '/wallet/hosted-checkout',
        builder: (context, state) => const HostedCheckoutScreen(),
      ),
      GoRoute(
        path: '/wallet/deposit-processing',
        builder: (context, state) => const DepositStatusScreen(
          requestedPhase: DepositFlowPhase.processing,
        ),
      ),
      GoRoute(
        path: '/wallet/deposit-successful',
        builder: (context, state) => const DepositStatusScreen(
          requestedPhase: DepositFlowPhase.successful,
        ),
      ),
      GoRoute(
        path: '/wallet/deposit-failed',
        builder: (context, state) =>
            const DepositStatusScreen(requestedPhase: DepositFlowPhase.failed),
      ),
      GoRoute(
        path: '/wallet/deposit-pending',
        builder: (context, state) =>
            const DepositStatusScreen(requestedPhase: DepositFlowPhase.pending),
      ),
      GoRoute(
        path: '/wallet/withdraw/withdraw-money',
        builder: (context, state) => const WithdrawMoneyScreen(),
      ),
      GoRoute(
        path: '/wallet/withdraw/select-bank-account',
        builder: (context, state) => const SelectBankAccountScreen(),
      ),
      GoRoute(
        path: '/wallet/withdraw/add-bank-account',
        builder: (context, state) => const AddBankAccountScreen(),
      ),
      GoRoute(
        path: '/wallet/withdraw/verifying-bank-account',
        builder: (context, state) => const VerifyingBankAccountScreen(),
      ),
      GoRoute(
        path: '/wallet/withdraw/withdrawal-review',
        builder: (context, state) => const WithdrawalReviewScreen(),
      ),
      GoRoute(
        path: '/wallet/withdraw/verification-required',
        builder: (context, state) => const WithdrawalGateScreen(
          phase: WithdrawalFlowPhase.verificationRequired,
        ),
      ),
      GoRoute(
        path: '/wallet/withdraw/withdrawal-limit-reached',
        builder: (context, state) =>
            const WithdrawalGateScreen(phase: WithdrawalFlowPhase.limitReached),
      ),
      GoRoute(
        path: '/wallet/withdraw/withdrawal-pending-review',
        builder: (context, state) => const WithdrawalStatusScreen(
          requestedPhase: WithdrawalFlowPhase.pendingReview,
        ),
      ),
      GoRoute(
        path: '/wallet/withdraw/withdrawal-processing',
        builder: (context, state) => const WithdrawalStatusScreen(
          requestedPhase: WithdrawalFlowPhase.processing,
        ),
      ),
      GoRoute(
        path: '/wallet/withdraw/withdrawal-successful',
        builder: (context, state) => const WithdrawalStatusScreen(
          requestedPhase: WithdrawalFlowPhase.successful,
        ),
      ),
      GoRoute(
        path: '/wallet/withdraw/withdrawal-payout-failed',
        builder: (context, state) => const WithdrawalStatusScreen(
          requestedPhase: WithdrawalFlowPhase.payoutFailed,
        ),
      ),
      GoRoute(
        path: '/wallet/withdraw/withdrawal-reversed',
        builder: (context, state) => const WithdrawalStatusScreen(
          requestedPhase: WithdrawalFlowPhase.reversed,
        ),
      ),
    ],
  );
});

/// Polls a pending sent challenge and advances the inviter once the invitee
/// funds the match (the server emits no dedicated socket event for the inviter
/// of a directed challenge, so a light snapshot poll bridges the gap).
class _SentChallengeWatcher extends ConsumerStatefulWidget {
  const _SentChallengeWatcher({required this.child});

  final Widget child;

  @override
  ConsumerState<_SentChallengeWatcher> createState() =>
      _SentChallengeWatcherState();
}

class _SentChallengeWatcherState extends ConsumerState<_SentChallengeWatcher> {
  Timer? _timer;

  @override
  void initState() {
    super.initState();
    _timer = Timer.periodic(const Duration(seconds: 2), (_) => _tick());
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  Future<void> _tick() async {
    MatchLifecycleSnapshot? next;
    try {
      next = await ref.read(matchFlowProvider.notifier).refreshLifecycle();
    } catch (_) {
      return; // transient network hiccup; keep waiting
    }
    if (!mounted || next == null) return;
    final phase = next.phase;
    if (phase == MatchLifecyclePhase.challengeSent ||
        phase == MatchLifecyclePhase.waitingOpponentStake ||
        phase == MatchLifecyclePhase.incomingChallenge) {
      return; // the invitee has not responded yet
    }
    _timer?.cancel();
    if (!context.mounted) return;
    if (phase == MatchLifecyclePhase.unavailable) {
      context.go('/arena');
    } else if (phase == MatchLifecyclePhase.challengeExpired) {
      // The server sweep expired the pending challenge; re-render the same
      // screen with the expired status so the inviter sees it as over.
      context.go('/play/challenge', extra: next);
    } else {
      context.go('/play/ready', extra: next);
    }
  }

  @override
  Widget build(BuildContext context) => widget.child;
}

/// Polls a pre-play snapshot (ready check / waiting for opponent) and advances
/// when the server releases the match (ready-gate sweep) or records the
/// opponent dropping their socket before the opening. Mirrors the sent
/// challenge watcher: no dedicated socket event reaches the parked player.
class _PrePlayLifecycleWatcher extends ConsumerStatefulWidget {
  const _PrePlayLifecycleWatcher({required this.child, required this.snapshot});

  final Widget child;
  final MatchLifecycleSnapshot snapshot;

  @override
  ConsumerState<_PrePlayLifecycleWatcher> createState() =>
      _PrePlayLifecycleWatcherState();
}

class _PrePlayLifecycleWatcherState
    extends ConsumerState<_PrePlayLifecycleWatcher> {
  Timer? _timer;
  StreamSubscription<Map<String, dynamic>>? _disconnectSub;
  StreamSubscription<Map<String, dynamic>>? _startedSub;

  @override
  void initState() {
    super.initState();
    // Re-enter the match context before anything can poll or act on it. After a
    // cold start the provider holds no match id or terms, so the readiness
    // action would silently no-op.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      ref.read(matchFlowProvider.notifier).adoptLifecycle(widget.snapshot);
    });
    _timer = Timer.periodic(const Duration(seconds: 2), (_) => _tick());
    // The server pings the parked opponent's user room the moment the
    // pre-start socket drops; refresh immediately instead of waiting on the
    // next poll, then the phase change navigates.
    _disconnectSub = socketService.onOpponentDisconnected.listen(
      (_) => _tick(),
    );
    // `game.started` is the server's authoritative start signal. A player
    // parked on a readiness screen has no other way to learn the match is live.
    _startedSub = socketService.onGameStarted.listen((_) => _tick());
  }

  @override
  void dispose() {
    _timer?.cancel();
    _disconnectSub?.cancel();
    _startedSub?.cancel();
    super.dispose();
  }

  Future<void> _tick() async {
    MatchLifecycleSnapshot? next;
    try {
      next = await ref.read(matchFlowProvider.notifier).refreshLifecycle();
    } catch (_) {
      return; // transient network hiccup; keep waiting
    }
    if (!mounted || next == null) return;
    final phase = next.phase;
    if (phase == MatchLifecyclePhase.readyCheck ||
        phase == MatchLifecyclePhase.waitingOpponentReady ||
        phase == MatchLifecyclePhase.challengeSent ||
        phase == MatchLifecyclePhase.waitingOpponentStake) {
      return; // nothing changed from the player's perspective
    }
    _timer?.cancel();
    if (!context.mounted) return;
    final route = lifecyclePhaseRoute(next);
    if (isBoardRoute(route)) {
      // Seat the player on the board the way the room screen's Enter Match does.
      ref.read(matchProvider.notifier).joinMatch(next.matchId!);
      context.go(route);
      return;
    }
    // Pre-play screens carry the snapshot through `extra`; the router rejects
    // them without it.
    context.go(route, extra: next);
  }

  @override
  Widget build(BuildContext context) => widget.child;
}
