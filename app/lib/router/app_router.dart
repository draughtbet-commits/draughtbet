import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../providers/auth_provider.dart';
import '../screens/login_screen.dart';
import '../screens/register_screen.dart';
import '../screens/password_recovery_screen.dart';
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
import '../services/google_auth_service.dart';
import '../services/socket_service.dart';
import 'lifecycle_routes.dart';
import '../screens/eligibility_screens.dart';
import '../screens/safer_play_screens.dart';
import '../screens/support_screen.dart';
import '../screens/verification_screens.dart';
import '../models/eligibility.dart';
import '../models/support_case.dart';
import '../models/dispute.dart';
import '../screens/dispute_screens.dart';
import '../models/app_notification.dart';
import '../screens/notification_screens.dart';
import '../widgets/main_layout.dart';

/// Root navigator, used to host full-screen interstitials outside MainLayout's
/// shell. Pushing `/eligibility/blocked` as a shell child while another shell
/// route was already on the stack produced two pages with the same key in one
/// Navigator, which trips go_router's duplicate-page-key assertion in debug and
/// silently renders an empty page in release.
final rootNavigatorKey = GlobalKey<NavigatorState>(debugLabel: 'root');

final appRouterProvider = Provider<GoRouter>((ref) {
  final refresh = ValueNotifier<bool>(false);
  ref.listen<AuthState>(
    authProvider,
    (previous, next) => refresh.value = !refresh.value,
  );
  ref.onDispose(refresh.dispose);

  return GoRouter(
    initialLocation: LandingPage.route,
    navigatorKey: rootNavigatorKey,
    refreshListenable: refresh,
    redirect: (context, state) {
      final isLoggedIn = ref.read(authProvider).isAuthenticated;
      final location = state.matchedLocation;
      final isAuthRoute =
          location == '/login' ||
          location == '/register' ||
          location == PasswordRecoveryScreen.route;
      final isPublicRoute = location == LandingPage.route;

      // Authenticated users never see onboarding or the auth forms.
      final result = _resolve(
        isLoggedIn: isLoggedIn,
        location: location,
        isAuthRoute: isAuthRoute,
        isPublicRoute: isPublicRoute,
      );
      return result;
    },
    routes: [
      GoRoute(
        path: LandingPage.route,
        builder: (context, state) => const LandingPage(),
      ),
      GoRoute(path: '/login', builder: (context, state) => const LoginScreen()),
      GoRoute(
        path: PasswordRecoveryScreen.route,
        builder: (context, state) => const PasswordRecoveryScreen(),
      ),
      GoRoute(
        path: '/register',
        builder: (context, state) => RegisterScreen(
          google: state.extra is GoogleSignupArgs
              ? state.extra! as GoogleSignupArgs
              : null,
        ),
      ),
      // Deliberately a top-level route, not a ShellRoute child. It is a
      // full-screen interstitial that must sit above MainLayout, and giving a
      // nested shell child a parentNavigatorKey breaks go_router's shell
      // matching (ShellRouteMatch expects its own children under the null
      // navigator bucket). Hosting it at the top level keeps the pushed page
      // off the shell navigator entirely.
      GoRoute(
        path: '/eligibility/blocked',
        parentNavigatorKey: rootNavigatorKey,
        builder: (context, state) => EligibilityBlockedScreen(
          decision: state.extra is EligibilityDecision
              ? state.extra! as EligibilityDecision
              : null,
        ),
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
            path: '/profile/report-match',
            builder: (context, state) => ReportMatchScreen(
              match: state.extra is DisputeMatchSummary
                  ? state.extra! as DisputeMatchSummary
                  : null,
            ),
          ),
          GoRoute(
            path: '/profile/dispute-reason',
            builder: (context, state) => const DisputeReasonScreen(),
          ),
          GoRoute(
            path: '/profile/add-evidence',
            builder: (context, state) => const AddEvidenceScreen(),
          ),
          GoRoute(
            path: '/profile/dispute-submitted',
            builder: (context, state) => const DisputeSubmittedScreen(),
          ),
          GoRoute(
            path: '/profile/dispute-status',
            builder: (context, state) => DisputeStatusScreen(
              disputeId: state.uri.queryParameters['id'],
              matchId: state.uri.queryParameters['match'],
            ),
          ),
          GoRoute(
            path: '/profile/notifications',
            builder: (context, state) => const NotificationsScreen(),
          ),
          GoRoute(
            path: '/profile/notification-details',
            redirect: (context, state) => state.extra is AppNotification
                ? null
                : '/profile/notifications',
            builder: (context, state) => NotificationDetailsScreen(
              notification: state.extra! as AppNotification,
            ),
          ),
          GoRoute(
            path: '/profile/notification-preferences',
            builder: (context, state) => const NotificationPreferencesScreen(),
          ),
          GoRoute(
            path: '/profile',
            builder: (context, state) => const SettingsScreen(),
          ),
          GoRoute(
            path: '/profile/saved-bank-accounts',
            builder: (context, state) => const SavedBankAccountsScreen(),
          ),
          GoRoute(
            path: '/profile/settings/safer-play',
            builder: (context, state) => const SaferPlayDashboardScreen(),
          ),
          GoRoute(
            path: '/eligibility/age-legal',
            builder: (context, state) => const AgeLegalEligibilityScreen(),
          ),
          GoRoute(
            path: '/profile/settings/account-restricted',
            builder: (context, state) => const AccountRestrictedScreen(),
          ),
          // Reachable by everyone, including a restricted account: restricting
          // a player without an appeal route is a dead end.
          GoRoute(
            path: '/support',
            builder: (context, state) => SupportScreen(
              initialType: switch (state.uri.queryParameters['type']) {
                'account' => SupportCaseType.account,
                'payment' => SupportCaseType.payment,
                'withdrawal' => SupportCaseType.withdrawal,
                'kyc' => SupportCaseType.kyc,
                'match' => SupportCaseType.match,
                'safer-play' => SupportCaseType.saferPlay,
                _ => null,
              },
            ),
          ),
          GoRoute(
            path: '/profile/verification',
            builder: (context, state) => const VerificationIntroScreen(),
          ),
          GoRoute(
            path: '/profile/verification/select-id',
            builder: (context, state) => const VerificationIdTypeScreen(),
          ),
          GoRoute(
            path: '/profile/verification/selfie',
            builder: (context, state) => VerificationSelfieScreen(
              type: _verificationType(state.uri.queryParameters['type']),
            ),
          ),
          GoRoute(
            path: '/profile/verification/processing',
            builder: (context, state) => const VerificationStatusScreen(
              status: VerificationStatus.pending,
            ),
          ),
          GoRoute(
            path: '/profile/verification/successful',
            builder: (context, state) => const VerificationStatusScreen(
              status: VerificationStatus.verified,
            ),
          ),
          GoRoute(
            path: '/profile/verification/rejected',
            builder: (context, state) => const VerificationStatusScreen(
              status: VerificationStatus.rejected,
            ),
          ),
          GoRoute(
            path: '/profile/verification/expired',
            builder: (context, state) => const VerificationStatusScreen(
              status: VerificationStatus.expired,
            ),
          ),
          GoRoute(
            path: '/profile/settings/deposit-limits',
            builder: (context, state) => const LimitEditorScreen(deposit: true),
          ),
          GoRoute(
            path: '/profile/settings/stake-limits',
            builder: (context, state) =>
                const LimitEditorScreen(deposit: false),
          ),
          GoRoute(
            path: '/profile/settings/take-a-break',
            builder: (context, state) => const TakeBreakScreen(),
          ),
          GoRoute(
            path: '/profile/settings/self-exclusion',
            builder: (context, state) => const SelfExclusionScreen(),
          ),
          GoRoute(
            path: '/profile/settings/session-reminder',
            builder: (context, state) => const SessionReminderScreen(),
          ),
          GoRoute(
            path: '/profile/settings/restriction',
            builder: (context, state) => const ActiveRestrictionScreen(),
          ),
          GoRoute(
            path: '/profile/settings/limit-confirmed',
            builder: (context, state) => LimitConfirmedScreen(
              deposit: switch (state.uri.queryParameters['control']) {
                'deposit' => true,
                'stake' => false,
                _ => null,
              },
            ),
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
            final incoming =
                snapshot.phase == MatchLifecyclePhase.incomingChallenge;
            final screen = ChallengeStatusScreen(
              snapshot: snapshot,
              onAccept: snapshot.phase == MatchLifecyclePhase.incomingChallenge
                  ? () async {
                      final updated = await notifier.acceptChallenge(
                        matchId: snapshot.matchId,
                        terms: snapshot.terms,
                      );
                      if (!context.mounted || updated == null) return;
                      context.go('/play/ready', extra: updated);
                    }
                  : null,
              onDecline: () async {
                if (incoming) {
                  await notifier.declineChallenge(
                    matchId: snapshot.matchId,
                    terms: snapshot.terms,
                  );
                } else {
                  await notifier.cancelSentChallenge(
                    matchId: snapshot.matchId,
                    terms: snapshot.terms,
                  );
                }
                if (!context.mounted) return;
                context.go('/arena');
              },
            );
            // Both the inviter (waiting for a response) and the invitee
            // (deciding) poll the same snapshot: the server advances either the
            // moment the challenge is accepted, declined, cancelled or expires.
            return _SentChallengeWatcher(snapshot: snapshot, child: screen);
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

/// Polls a pending directed challenge (either side) and advances the parked
/// player once it resolves. The server emits no dedicated socket event for the
/// inviter of a directed challenge, and the invitee's cold-start snapshot has
/// no adopted match context, so the watcher re-seeds it on entry and then polls.
class _SentChallengeWatcher extends ConsumerStatefulWidget {
  const _SentChallengeWatcher({required this.child, required this.snapshot});

  final Widget child;
  final MatchLifecycleSnapshot snapshot;

  @override
  ConsumerState<_SentChallengeWatcher> createState() =>
      _SentChallengeWatcherState();
}

class _SentChallengeWatcherState extends ConsumerState<_SentChallengeWatcher> {
  Timer? _timer;

  @override
  void initState() {
    super.initState();
    // A challenge opened from the home active-match list (or via the
    // notification) arrives without an adopted match context; without this the
    // poll and the accept/decline actions silently no-op.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      ref.read(matchFlowProvider.notifier).adoptLifecycle(widget.snapshot);
    });
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

VerificationCheckType _verificationType(String? raw) =>
    VerificationCheckType.values.firstWhere(
      (type) => type.wireValue == raw,
      orElse: () => VerificationCheckType.idDocument,
    );

/// Pure form of the auth gate so the redirect above can log both the requested
/// location and where it resolved to.
String? _resolve({
  required bool isLoggedIn,
  required String location,
  required bool isAuthRoute,
  required bool isPublicRoute,
}) {
  if (isLoggedIn) return (isAuthRoute || isPublicRoute) ? '/home' : null;
  if (isPublicRoute) return null;
  if (!isAuthRoute) return '/login';
  return null;
}
