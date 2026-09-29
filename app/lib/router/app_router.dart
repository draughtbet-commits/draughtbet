import 'package:flutter/foundation.dart';
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
import '../screens/withdrawal_flow_screens.dart';
import '../screens/settings_screen.dart';
import '../screens/results_screen.dart';
import '../screens/game_move_history_screen.dart';
import '../screens/eligibility_screens.dart';
import '../screens/safer_play_screens.dart';
import '../screens/verification_screens.dart';
import '../models/eligibility.dart';
import '../screens/dispute_screens.dart';
import '../models/dispute.dart';
import '../models/app_notification.dart';
import '../screens/notification_screens.dart';
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
            builder: (context, state) =>
                DisputeStatusScreen(disputeId: state.uri.queryParameters['id']),
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
        ],
      ),
      GoRoute(
        path: '/eligibility/age-legal',
        builder: (context, state) => const AgeLegalEligibilityScreen(),
      ),
      GoRoute(
        path: '/eligibility/blocked',
        builder: (context, state) => EligibilityBlockedScreen(
          decision: state.extra is EligibilityDecision
              ? state.extra! as EligibilityDecision
              : null,
        ),
      ),
      GoRoute(
        path: '/profile/settings/account-restricted',
        builder: (context, state) => const AccountRestrictedScreen(),
      ),
      GoRoute(
        path: '/profile/verification',
        builder: (context, state) => const VerificationIntroScreen(),
      ),
      GoRoute(
        path: '/profile/verification/personal-details',
        builder: (context, state) => const VerificationPersonalDetailsScreen(),
      ),
      GoRoute(
        path: '/profile/verification/select-id',
        builder: (context, state) => const VerificationIdTypeScreen(),
      ),
      GoRoute(
        path: '/profile/verification/upload-id',
        builder: (context, state) => VerificationUploadIdScreen(
          type: _verificationType(state.uri.queryParameters['type']),
        ),
      ),
      GoRoute(
        path: '/profile/verification/selfie',
        builder: (context, state) => VerificationSelfieScreen(
          type: _verificationType(state.uri.queryParameters['type']),
        ),
      ),
      GoRoute(
        path: '/profile/verification/processing',
        builder: (context, state) =>
            const VerificationStatusScreen(status: VerificationStatus.pending),
      ),
      GoRoute(
        path: '/profile/verification/successful',
        builder: (context, state) =>
            const VerificationStatusScreen(status: VerificationStatus.verified),
      ),
      GoRoute(
        path: '/profile/verification/rejected',
        builder: (context, state) =>
            const VerificationStatusScreen(status: VerificationStatus.rejected),
      ),
      GoRoute(
        path: '/profile/verification/expired',
        builder: (context, state) =>
            const VerificationStatusScreen(status: VerificationStatus.expired),
      ),
      GoRoute(
        path: '/profile/settings/deposit-limits',
        builder: (context, state) => const LimitEditorScreen(deposit: true),
      ),
      GoRoute(
        path: '/profile/settings/stake-limits',
        builder: (context, state) => const LimitEditorScreen(deposit: false),
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
            return ReadyCheckScreen(
              snapshot: snapshot,
              onReady: () async {
                final updated = await ref
                    .read(matchFlowProvider.notifier)
                    .markReady();
                if (!context.mounted || updated == null) return;
                context.go('/play/waiting-ready', extra: updated);
              },
            );
          },
        ),
      ),
      GoRoute(
        path: '/play/waiting-ready',
        redirect: (context, state) =>
            state.extra is MatchLifecycleSnapshot ? null : '/play/unavailable',
        builder: (context, state) => WaitingOpponentReadyScreen(
          snapshot: state.extra! as MatchLifecycleSnapshot,
        ),
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
        builder: (context, state) => ChallengeStatusScreen(
          snapshot: state.extra! as MatchLifecycleSnapshot,
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
        path: '/wallet/withdraw/withdrawal-reversed',
        builder: (context, state) => const WithdrawalStatusScreen(
          requestedPhase: WithdrawalFlowPhase.reversed,
        ),
      ),
    ],
  );
});

VerificationCheckType _verificationType(String? raw) =>
    VerificationCheckType.values.firstWhere(
      (type) => type.wireValue == raw,
      orElse: () => VerificationCheckType.idDocument,
    );
