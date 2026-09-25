import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_svg/flutter_svg.dart';
import 'package:go_router/go_router.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import '../models/match_flow.dart';
import '../providers/match_flow_provider.dart';
import '../providers/match_provider.dart';
import '../providers/profile_provider.dart';
import '../theme/colors.dart';
import '../widgets/balance_card.dart';
import '../widgets/flow_widgets.dart';
import '../widgets/lobby_header.dart';
import '../widgets/notification_bell.dart';

class HomeLobbyScreen extends ConsumerStatefulWidget {
  const HomeLobbyScreen({super.key});

  @override
  ConsumerState<HomeLobbyScreen> createState() => _HomeLobbyScreenState();
}

class _HomeLobbyScreenState extends ConsumerState<HomeLobbyScreen>
    with WidgetsBindingObserver {
  static const _stakes = [50000, 100000, 200000, 500000];
  int _selectedStake = 200000;
  bool _returningToActiveMatch = false;
  bool _reconcilingActiveMatch = false;
  bool _activeMatchRecoveryFailed = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    Future.microtask(_loadHome);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  Future<void> _loadHome() async {
    unawaited(ref.read(profileProvider.notifier).load());
    unawaited(ref.read(matchFlowProvider.notifier).loadArena());
    await ref.read(matchProvider.notifier).restoreActiveMatch();
    if (mounted) await _reconcileActiveMatch();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state != AppLifecycleState.resumed) return;
    final matchId = ref.read(matchProvider).currentMatchId;
    if (matchId != null) {
      ref.read(matchProvider.notifier).handleAppResumed(matchId);
    }
    unawaited(_reconcileActiveMatch());
  }

  Future<void> _reconcileActiveMatch() async {
    final flow = ref.read(matchFlowProvider);
    if (flow.currentMatchId == null || flow.currentIntent == null) return;
    if (_reconcilingActiveMatch) return;
    setState(() {
      _reconcilingActiveMatch = true;
      _activeMatchRecoveryFailed = false;
    });
    try {
      await ref.read(matchFlowProvider.notifier).refreshLifecycle();
    } catch (_) {
      if (mounted) setState(() => _activeMatchRecoveryFailed = true);
    } finally {
      if (mounted) setState(() => _reconcilingActiveMatch = false);
    }
  }

  Future<void> _startQuickMatch() async {
    final intent = MatchFlowIntent(
      kind: MatchEntryKind.quick,
      terms: MatchTerms(stakeMinorUnits: _selectedStake),
    );
    ref.read(matchFlowProvider.notifier).review(intent);
    await ref.read(matchFlowProvider.notifier).confirm();
    if (mounted &&
        ref.read(matchFlowProvider).actionPhase == MatchActionPhase.succeeded) {
      context.go('/play/search');
    }
  }

  Future<void> _returnToActiveMatch(
    _ActiveMatchPresentation activeMatch,
  ) async {
    if (_returningToActiveMatch) return;
    setState(() => _returningToActiveMatch = true);
    try {
      await context.push(
        activeMatch.route,
        extra: activeMatch.lifecycleSnapshot,
      );
    } finally {
      if (mounted) setState(() => _returningToActiveMatch = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final matchState = ref.watch(matchProvider);
    final flow = ref.watch(matchFlowProvider);
    final actionPending = flow.actionPhase == MatchActionPhase.submitting;
    final activeMatch = _activeMatchPresentation(
      flow,
      matchState,
      reconciling: _reconcilingActiveMatch,
      recoveryFailed: _activeMatchRecoveryFailed,
    );

    ref.listen<String?>(matchProvider.select((state) => state.currentMatchId), (
      previous,
      next,
    ) {
      if (next == null || next == previous) return;
      ref.read(matchFlowProvider.notifier).matchFound(next);
    });

    return Scaffold(
      backgroundColor: AppColors.background,
      appBar: AppBar(
        toolbarHeight: 64,
        titleSpacing: 16,
        title: const LobbyHeader(),
        actions: const [NotificationBell(), SizedBox(width: 8)],
      ),
      body: FlowPage(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const BalanceCard(),
            if (flow.arenaPhase == LoadPhase.offline) ...[
              const SizedBox(height: 10),
              FlowCard(
                padding: const EdgeInsets.symmetric(
                  horizontal: 12,
                  vertical: 10,
                ),
                borderColor: AppColors.valueAccent.withValues(alpha: .45),
                child: Row(
                  children: [
                    const Icon(
                      LucideIcons.wifiOff,
                      color: AppColors.valueAccent,
                      size: 17,
                    ),
                    const SizedBox(width: 9),
                    Expanded(
                      child: Text(
                        'Offline mode · live matches are unavailable',
                        style: TextStyle(
                          fontFamily: 'Inter',
                          color: AppColors.textSecondary,
                          fontSize: 10,
                        ),
                      ),
                    ),
                    TextButton(
                      onPressed: () =>
                          ref.read(matchFlowProvider.notifier).loadArena(),
                      child: const Text('Retry'),
                    ),
                  ],
                ),
              ),
            ],
            const SizedBox(height: 12),
            Semantics(
              button: true,
              label: 'Find a match in the open Arena',
              child: InkWell(
                borderRadius: BorderRadius.circular(12),
                onTap: () => context.go('/arena'),
                child: Container(
                  constraints: const BoxConstraints(minHeight: 64),
                  padding: const EdgeInsets.symmetric(
                    horizontal: 14,
                    vertical: 10,
                  ),
                  decoration: BoxDecoration(
                    color: AppColors.primaryAction,
                    borderRadius: BorderRadius.circular(12),
                    boxShadow: [
                      BoxShadow(
                        color: AppColors.primaryBright.withValues(alpha: 0.16),
                        blurRadius: 16,
                      ),
                    ],
                  ),
                  child: Row(
                    children: [
                      SvgPicture.asset(
                        'assets/icons/find_match.svg',
                        width: 27,
                        height: 27,
                      ),
                      const SizedBox(width: 12),
                      Expanded(
                        child: Column(
                          mainAxisAlignment: MainAxisAlignment.center,
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              'FIND A MATCH',
                              style: TextStyle(
                                fontFamily: 'Sora',
                                fontSize: 16,
                                fontWeight: FontWeight.w700,
                                letterSpacing: .4,
                              ),
                            ),
                            Text(
                              'Match with an available player',
                              style: TextStyle(
                                fontFamily: 'Inter',
                                fontSize: 10,
                                color: AppColors.textPrimary.withValues(
                                  alpha: .82,
                                ),
                              ),
                            ),
                          ],
                        ),
                      ),
                      const Icon(LucideIcons.scanSearch, size: 22),
                    ],
                  ),
                ),
              ),
            ),
            const SizedBox(height: 16),
            Text(
              'Quick Match',
              style: TextStyle(
                fontFamily: 'Sora',
                fontSize: 16,
                fontWeight: FontWeight.w700,
              ),
            ),
            const SizedBox(height: 2),
            Text(
              'Choose your stake',
              style: TextStyle(
                fontFamily: 'Inter',
                fontSize: 11,
                color: AppColors.textSecondary,
              ),
            ),
            const SizedBox(height: 10),
            Row(
              children: _stakes.map((stake) {
                final selected = stake == _selectedStake;
                return Expanded(
                  child: Padding(
                    padding: EdgeInsets.only(
                      right: stake == _stakes.last ? 0 : 7,
                    ),
                    child: Semantics(
                      button: true,
                      selected: selected,
                      label: '${Money(stake).format()} stake',
                      child: InkWell(
                        onTap: () => setState(() => _selectedStake = stake),
                        borderRadius: BorderRadius.circular(9),
                        child: AnimatedContainer(
                          duration: const Duration(milliseconds: 140),
                          height: 42,
                          alignment: Alignment.center,
                          decoration: BoxDecoration(
                            color: selected
                                ? AppColors.primaryAction.withValues(alpha: .22)
                                : AppColors.surface,
                            borderRadius: BorderRadius.circular(9),
                            border: Border.all(
                              color: selected
                                  ? AppColors.primaryBright
                                  : AppColors.border,
                              width: selected ? 1.5 : 1,
                            ),
                          ),
                          child: Text(
                            stake >= 100000
                                ? '₦${stake ~/ 100000}K'
                                : '₦${stake ~/ 100}',
                            style: TextStyle(
                              fontFamily: 'Inter',
                              fontSize: 13,
                              fontWeight: FontWeight.w700,
                              color: selected
                                  ? AppColors.primaryBright
                                  : AppColors.textPrimary,
                            ),
                          ),
                        ),
                      ),
                    ),
                  ),
                );
              }).toList(),
            ),
            const SizedBox(height: 10),
            Row(
              children: [
                Expanded(
                  child: Container(
                    height: 44,
                    alignment: Alignment.center,
                    decoration: BoxDecoration(
                      color: AppColors.primaryAction.withValues(alpha: .12),
                      borderRadius: BorderRadius.circular(9),
                      border: Border.all(
                        color: AppColors.primaryBright.withValues(alpha: .45),
                      ),
                    ),
                    child: Text(
                      '10 min · Classic',
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        fontFamily: 'Inter',
                        color: AppColors.primaryBright,
                        fontSize: 10,
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                  ),
                ),
                const SizedBox(width: 8),
                SizedBox(
                  width: 140,
                  height: 44,
                  child: FilledButton(
                    onPressed: actionPending ? null : _startQuickMatch,
                    style: FilledButton.styleFrom(
                      backgroundColor: AppColors.primaryAction,
                      shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(10),
                      ),
                    ),
                    child: actionPending
                        ? const SizedBox.square(
                            dimension: 18,
                            child: CircularProgressIndicator(
                              strokeWidth: 2,
                              color: AppColors.textPrimary,
                            ),
                          )
                        : const Text('Find Opponent'),
                  ),
                ),
              ],
            ),
            if (flow.message != null) ...[
              const SizedBox(height: 8),
              Text(
                flow.message!,
                style: TextStyle(
                  fontFamily: 'Inter',
                  color: AppColors.danger,
                  fontSize: 12,
                ),
              ),
            ],
            if (activeMatch != null) ...[
              const SizedBox(height: 18),
              Text(
                activeMatch.sectionTitle,
                style: TextStyle(
                  fontFamily: 'Inter',
                  color: AppColors.valueAccent,
                  fontSize: 11,
                  fontWeight: FontWeight.w700,
                  letterSpacing: .7,
                ),
              ),
              const SizedBox(height: 8),
              _ActiveMatchCard(
                presentation: activeMatch,
                returning: _returningToActiveMatch,
                onReturn: () => _returnToActiveMatch(activeMatch),
              ),
            ],
            if (activeMatch == null &&
                matchState.currentMatchId != null &&
                matchState.gameState != null) ...[
              const SizedBox(height: 18),
              Text(
                'MATCH IN PROGRESS',
                style: TextStyle(
                  fontFamily: 'Inter',
                  color: AppColors.valueAccent,
                  fontSize: 11,
                  fontWeight: FontWeight.w700,
                  letterSpacing: .7,
                ),
              ),
              const SizedBox(height: 8),
              FlowCard(
                borderColor: AppColors.primaryAction.withValues(alpha: .6),
                child: Row(
                  children: [
                    const GameAvatar(size: 40, label: 'Opponent'),
                    const SizedBox(width: 10),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            'Active match',
                            style: TextStyle(
                              fontFamily: 'Sora',
                              fontSize: 13,
                              fontWeight: FontWeight.w700,
                            ),
                          ),
                          Text(
                            matchState.syncState == MatchSyncState.offline
                                ? 'Offline · reconnect to continue'
                                : 'Your turn · state verified',
                            style: TextStyle(
                              fontFamily: 'Inter',
                              color: AppColors.textSecondary,
                              fontSize: 10,
                            ),
                          ),
                        ],
                      ),
                    ),
                    OutlinedButton(
                      onPressed: () =>
                          context.go('/match/${matchState.currentMatchId}'),
                      style: OutlinedButton.styleFrom(
                        minimumSize: const Size(0, 42),
                        side: const BorderSide(color: AppColors.primaryBright),
                      ),
                      child: const Text(
                        'Return to Match',
                        style: TextStyle(fontSize: 11),
                      ),
                    ),
                  ],
                ),
              ),
            ],
            const SizedBox(height: 12),
          ],
        ),
      ),
    );
  }
}

class _ActiveMatchPresentation {
  const _ActiveMatchPresentation({
    required this.sectionTitle,
    required this.status,
    required this.route,
    required this.matchId,
    required this.terms,
    this.lifecycleSnapshot,
    this.detail,
    this.deadline,
    this.offline = false,
  });

  final String sectionTitle;
  final String status;
  final String route;
  final String matchId;
  final MatchTerms? terms;
  final MatchLifecycleSnapshot? lifecycleSnapshot;
  final String? detail;
  final DateTime? deadline;
  final bool offline;
}

_ActiveMatchPresentation? _activeMatchPresentation(
  MatchFlowState flow,
  MatchState matchState, {
  required bool reconciling,
  required bool recoveryFailed,
}) {
  final lifecycle = flow.lifecycle;
  final terminalLifecycle =
      lifecycle?.phase == MatchLifecyclePhase.unavailable ||
      lifecycle?.phase == MatchLifecyclePhase.challengeExpired ||
      lifecycle?.phase == MatchLifecyclePhase.readyTimeout;
  if (flow.searchPhase == SearchPhase.cancelled || terminalLifecycle) {
    return null;
  }

  final matchId = flow.currentMatchId ?? matchState.currentMatchId;
  if (matchId == null || matchId.trim().isEmpty) return null;
  if (matchState.gameState != null) return null;

  final restoredActiveMatch =
      flow.currentMatchId == null && matchState.currentMatchId != null;
  final found = flow.searchPhase == SearchPhase.found || restoredActiveMatch;
  final offline =
      flow.searchPhase == SearchPhase.degraded ||
      matchState.syncState == MatchSyncState.offline;
  final terms = lifecycle?.terms ?? flow.currentIntent?.terms;
  final phase = lifecycle?.phase;

  late final String status;
  late final String route;
  String? detail;
  MatchLifecycleSnapshot? routeSnapshot;

  if (found) {
    status = 'Match found';
    route = '/play/room/$matchId';
    detail = 'Your opponent has joined. Continue when you are ready.';
  } else {
    switch (phase) {
      case MatchLifecyclePhase.lockingStake:
        status = 'Confirming stake';
        route = '/play/locking-stake';
        routeSnapshot = lifecycle;
      case MatchLifecyclePhase.readyCheck:
        status = 'Ready check';
        route = '/play/ready';
        routeSnapshot = lifecycle;
      case MatchLifecyclePhase.waitingOpponentReady:
        status = 'Waiting for opponent to ready up';
        route = '/play/waiting-ready';
        routeSnapshot = lifecycle;
      case MatchLifecyclePhase.opponentDisconnected:
        status = 'Opponent reconnecting';
        route = '/play/disconnected-before-start';
        routeSnapshot = lifecycle;
      default:
        status = 'Waiting for opponent';
        route = lifecycle == null ? '/play/search' : '/play/waiting-stake';
        routeSnapshot = lifecycle;
    }
  }

  if (offline) {
    detail = 'Offline · reconnecting with your match preserved';
  } else if (recoveryFailed) {
    detail = 'Status refresh unavailable · last known match preserved';
  } else if (reconciling) {
    detail = 'Checking the latest server status…';
  }

  return _ActiveMatchPresentation(
    sectionTitle: found ? 'MATCH IN PROGRESS' : 'ACTIVE MATCH',
    status: status,
    route: route,
    matchId: matchId,
    terms: terms,
    lifecycleSnapshot: routeSnapshot,
    detail: detail,
    deadline: lifecycle?.deadline,
    offline: offline,
  );
}

class _ActiveMatchCard extends StatelessWidget {
  const _ActiveMatchCard({
    required this.presentation,
    required this.returning,
    required this.onReturn,
  });

  final _ActiveMatchPresentation presentation;
  final bool returning;
  final VoidCallback onReturn;

  String get _safeReference {
    final value = presentation.matchId.trim();
    final suffix = value.length <= 4
        ? value
        : value.substring(value.length - 4);
    return '#••••${suffix.toUpperCase()}';
  }

  String _deadlineLabel(DateTime deadline) {
    final local = deadline.toLocal();
    final hour = local.hour % 12 == 0 ? 12 : local.hour % 12;
    final minute = local.minute.toString().padLeft(2, '0');
    final period = local.hour < 12 ? 'AM' : 'PM';
    return 'Expires $hour:$minute $period';
  }

  @override
  Widget build(BuildContext context) {
    final terms = presentation.terms;
    return Semantics(
      container: true,
      label: '${presentation.status}. Active match $_safeReference',
      child: FlowCard(
        borderColor:
            (presentation.offline
                    ? AppColors.valueAccent
                    : AppColors.primaryBright)
                .withValues(alpha: .58),
        color: AppColors.surfaceQuiet,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Container(
                  width: 42,
                  height: 42,
                  decoration: BoxDecoration(
                    shape: BoxShape.circle,
                    color: AppColors.primaryAction.withValues(alpha: .14),
                    border: Border.all(
                      color: presentation.offline
                          ? AppColors.valueAccent
                          : AppColors.primaryBright,
                    ),
                  ),
                  child: Icon(
                    presentation.offline
                        ? LucideIcons.wifiOff
                        : LucideIcons.usersRound,
                    size: 20,
                    color: presentation.offline
                        ? AppColors.valueAccent
                        : AppColors.primaryBright,
                  ),
                ),
                const SizedBox(width: 11),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        presentation.status,
                        style: TextStyle(
                          fontFamily: 'Sora',
                          fontSize: 14,
                          fontWeight: FontWeight.w700,
                        ),
                      ),
                      const SizedBox(height: 2),
                      Text(
                        presentation.detail ??
                            'Your match remains open while you use the app.',
                        style: TextStyle(
                          fontFamily: 'Inter',
                          color: AppColors.textSecondary,
                          fontSize: 10,
                          height: 1.35,
                        ),
                      ),
                    ],
                  ),
                ),
                const SizedBox(width: 8),
                Text(
                  _safeReference,
                  style: TextStyle(
                    fontFamily: 'Inter',
                    color: AppColors.textSecondary,
                    fontSize: 9,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ],
            ),
            if (terms != null) ...[
              const SizedBox(height: 12),
              Wrap(
                spacing: 7,
                runSpacing: 7,
                children: [
                  _MatchFact(
                    label: 'Stake',
                    value: Money(terms.stakeMinorUnits).format(),
                    accent: AppColors.valueAccent,
                  ),
                  _MatchFact(label: 'Type', value: terms.gameType),
                  _MatchFact(label: 'Time', value: terms.timeControl),
                  if (presentation.deadline != null)
                    _MatchFact(
                      label: 'Status',
                      value: _deadlineLabel(presentation.deadline!),
                    ),
                ],
              ),
            ],
            const SizedBox(height: 12),
            Semantics(
              button: true,
              enabled: !returning,
              label: 'Return to active match $_safeReference',
              excludeSemantics: true,
              child: SizedBox(
                width: double.infinity,
                height: 48,
                child: OutlinedButton.icon(
                  onPressed: returning ? null : onReturn,
                  style: OutlinedButton.styleFrom(
                    foregroundColor: AppColors.textPrimary,
                    side: const BorderSide(color: AppColors.primaryBright),
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(10),
                    ),
                  ),
                  icon: returning
                      ? const SizedBox.square(
                          dimension: 16,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      : const Icon(LucideIcons.logIn, size: 17),
                  label: Text(
                    returning ? 'Opening Match' : 'Return to Match',
                    style: TextStyle(
                      fontFamily: 'Inter',
                      fontSize: 12,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _MatchFact extends StatelessWidget {
  const _MatchFact({required this.label, required this.value, this.accent});

  final String label;
  final String value;
  final Color? accent;

  @override
  Widget build(BuildContext context) => Container(
    constraints: const BoxConstraints(minHeight: 32),
    padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 7),
    decoration: BoxDecoration(
      color: AppColors.surface,
      borderRadius: BorderRadius.circular(8),
      border: Border.all(color: AppColors.border),
    ),
    child: Text.rich(
      TextSpan(
        children: [
          TextSpan(
            text: '$label  ',
            style: TextStyle(
              fontFamily: 'Inter',
              color: AppColors.textSecondary,
              fontSize: 9,
            ),
          ),
          TextSpan(
            text: value,
            style: TextStyle(
              fontFamily: 'Inter',
              color: accent ?? AppColors.textPrimary,
              fontSize: 10,
              fontWeight: FontWeight.w700,
            ),
          ),
        ],
      ),
      maxLines: 1,
      overflow: TextOverflow.ellipsis,
    ),
  );
}
