import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_svg/flutter_svg.dart';
import 'package:go_router/go_router.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import '../models/match_flow.dart';
import '../providers/match_flow_provider.dart';
import '../providers/match_provider.dart';
import '../providers/profile_provider.dart';
import '../providers/wallet_provider.dart';
import '../router/lifecycle_routes.dart';
import '../theme/colors.dart';
import '../widgets/balance_card.dart';
import '../widgets/flow_widgets.dart';
import '../widgets/lobby_header.dart';
import '../widgets/notification_bell.dart';
import '../widgets/results_shortcut.dart';

class HomeLobbyScreen extends ConsumerStatefulWidget {
  const HomeLobbyScreen({super.key});

  @override
  ConsumerState<HomeLobbyScreen> createState() => _HomeLobbyScreenState();
}

class _HomeLobbyScreenState extends ConsumerState<HomeLobbyScreen> {
  int? _selectedStake;

  @override
  void initState() {
    super.initState();
    // A match is played on a route pushed over the shell, so this home screen
    // stays alive the whole time. When the match reaches a terminal state, the
    // OPEN/FUNDED/READY entry it once held in activeMatches is stale — refresh
    // the authoritative list so the ended match never lingers on Home.
    ref.listenManual(matchProvider, (previous, next) {
      if (previous?.currentMatchId != null &&
          next.gameState?.status == 'completed') {
        ref.read(matchFlowProvider.notifier).loadActiveMatches();
      }
    });
    Future.microtask(() {
      ref.read(profileProvider.notifier).load();
      ref.read(matchFlowProvider.notifier).loadArena();
      ref.read(matchFlowProvider.notifier).loadActiveMatches();
      ref.read(matchProvider.notifier).restoreActiveMatch();
      ref.read(walletProvider.notifier).fetchBalance(silent: true);
      ref.read(walletProvider.notifier).fetchTierLimits();
    });
  }

  int get _stakeMin {
    final tier = ref.read(profileProvider).profile?.tier;
    final limits = ref.watch(walletProvider).tierLimits;
    if (limits != null && limits.tier.toUpperCase() == (tier ?? '').toUpperCase()) {
      return int.tryParse(limits.stakeMin) ?? 50000;
    }
    final presets = stakePresetsForTier(tier);
    return presets.isNotEmpty ? presets.first : 50000;
  }

  int get _stakeMax {
    final tier = ref.read(profileProvider).profile?.tier;
    final limits = ref.watch(walletProvider).tierLimits;
    if (limits != null && limits.tier.toUpperCase() == (tier ?? '').toUpperCase()) {
      return int.tryParse(limits.stakeMax) ?? 5000000;
    }
    final presets = stakePresetsForTier(tier);
    return presets.isNotEmpty ? presets.last : 5000000;
  }

  int get _effectiveStake => _selectedStake ?? _stakeMin;

  Future<void> _startQuickMatch() async {
    final intent = MatchFlowIntent(
      kind: MatchEntryKind.quick,
      terms: MatchTerms(stakeMinorUnits: _effectiveStake),
    );
    ref.read(matchFlowProvider.notifier).review(intent);
    await ref.read(matchFlowProvider.notifier).confirm();
    if (mounted &&
        ref.read(matchFlowProvider).actionPhase == MatchActionPhase.succeeded) {
      context.go('/play/search');
    }
  }

  Future<void> _joinWithCode() async {
    final controller = TextEditingController();
    final code = await showDialog<String>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        backgroundColor: AppColors.surface,
        title: const Text('Join a private room'),
        content: TextField(
          controller: controller,
          autofocus: true,
          textCapitalization: TextCapitalization.characters,
          textInputAction: TextInputAction.done,
          decoration: const InputDecoration(hintText: 'Room code'),
          onSubmitted: (value) => Navigator.of(dialogContext).pop(value),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(dialogContext).pop(controller.text),
            child: const Text('Join'),
          ),
        ],
      ),
    );
    controller.dispose();
    if (!mounted || code == null || code.trim().isEmpty) return;
    final notifier = ref.read(matchFlowProvider.notifier);
    final snapshot = await notifier.joinPrivateRoom(code.trim());
    if (!mounted) return;
    if (snapshot == null) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            ref.read(matchFlowProvider).message ??
                'That room code could not be found.',
          ),
        ),
      );
      return;
    }
    final route = lifecyclePhaseRoute(snapshot);
    if (isBoardRoute(route)) {
      ref.read(matchProvider.notifier).joinMatch(snapshot.matchId!);
      context.go(route);
      return;
    }
    context.go(route, extra: snapshot);
  }

  @override
  Widget build(BuildContext context) {
    final matchState = ref.watch(matchProvider);
    final flow = ref.watch(matchFlowProvider);
    final actionPending = flow.actionPhase == MatchActionPhase.submitting;
    final hasActiveMatches = flow.activeMatches.isNotEmpty;
    final hasStartedMatch =
        matchState.currentMatchId != null && !matchState.isMatchOver;

    return Scaffold(
      backgroundColor: AppColors.background,
      appBar: AppBar(
        toolbarHeight: 64,
        titleSpacing: 16,
        title: const LobbyHeader(),
        actions: const [
          ResultsShortcut(),
          NotificationBell(),
          SizedBox(width: 8),
        ],
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
                  height: 64,
                  padding: const EdgeInsets.symmetric(horizontal: 14),
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
            const SizedBox(height: 10),
            Semantics(
              button: true,
              label: 'Join a private room with a code',
              child: SizedBox(
                width: double.infinity,
                height: 48,
                child: OutlinedButton.icon(
                  onPressed: _joinWithCode,
                  style: OutlinedButton.styleFrom(
                    foregroundColor: AppColors.textPrimary,
                    side: const BorderSide(color: AppColors.valueAccent),
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(11),
                    ),
                  ),
                  icon: const Icon(LucideIcons.keyRound, size: 18),
                  label: const Text('JOIN WITH CODE'),
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
            StatefulBuilder(
              builder: (context, setState) {
                return Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      'Stake: ${Money(_selectedStake ?? _stakeMin).format()}',
                      style: TextStyle(
                        fontFamily: 'Inter',
                        fontSize: 13,
                        fontWeight: FontWeight.w600,
                        color: AppColors.textPrimary,
                      ),
                    ),
                    Slider(
                      value: ((_selectedStake ?? _stakeMin).toDouble()).clamp(
                        _stakeMin <= _stakeMax ? _stakeMin.toDouble() : _stakeMax.toDouble(),
                        _stakeMax >= _stakeMin ? _stakeMax.toDouble() : _stakeMin.toDouble(),
                      ),
                      min: _stakeMin <= _stakeMax ? _stakeMin.toDouble() : _stakeMax.toDouble(),
                      max: _stakeMax >= _stakeMin ? _stakeMax.toDouble() : _stakeMin.toDouble(),
                      divisions: _stakeMax > _stakeMin ? (((_stakeMax - _stakeMin) ~/ 50000).clamp(1, 50)) : 1,
                      onChanged: (val) {
                        setState(() {
                          _selectedStake = val.toInt();
                        });
                      },
                    ),
                    Row(
                      mainAxisAlignment: MainAxisAlignment.spaceBetween,
                      children: [
                        Text(
                          Money(_stakeMin).format(),
                          style: TextStyle(fontSize: 10, color: AppColors.textSecondary),
                        ),
                        Text(
                          Money(_stakeMax).format(),
                          style: TextStyle(fontSize: 10, color: AppColors.textSecondary),
                        ),
                      ],
                    ),
                  ],
                );
              },
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
            if (hasActiveMatches || hasStartedMatch) ...[
              const SizedBox(height: 18),
              Text(
                'ACTIVE MATCHES',
                style: TextStyle(
                  fontFamily: 'Inter',
                  color: AppColors.valueAccent,
                  fontSize: 11,
                  fontWeight: FontWeight.w700,
                  letterSpacing: .7,
                ),
              ),
              const SizedBox(height: 8),
              ...flow.activeMatches.map(
                (active) => Padding(
                  padding: const EdgeInsets.only(bottom: 8),
                  child: _ActiveMatchCard(snapshot: active),
                ),
              ),
              if (hasStartedMatch) ...[
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
                              'In play',
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
                          side: const BorderSide(
                            color: AppColors.primaryBright,
                          ),
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
            ],
            const SizedBox(height: 12),
          ],
        ),
      ),
    );
  }
}

/// One pre-start match the caller holds (OPEN / FUNDED / READY), surfaced so a
/// still-locked match is never invisible. Return routes to the correct
/// lifecycle screen carrying the real snapshot.
class _ActiveMatchCard extends StatelessWidget {
  const _ActiveMatchCard({required this.snapshot});

  final MatchLifecycleSnapshot snapshot;

  String get _route => lifecyclePhaseRoute(snapshot);

  String get _status => switch (snapshot.phase) {
    MatchLifecyclePhase.challengeSent => 'Challenge sent · awaiting response',
    MatchLifecyclePhase.incomingChallenge =>
      'Incoming challenge · tap to respond',
    MatchLifecyclePhase.challengeExpired => 'Challenge expired',
    MatchLifecyclePhase.privateRoom => 'Private room · share the code',
    MatchLifecyclePhase.readyCheck => 'Both stakes confirmed · ready to start',
    MatchLifecyclePhase.waitingOpponentReady =>
      'Waiting for opponent to confirm',
    _ => 'Waiting for an opponent stake',
  };

  String get _actionLabel => switch (snapshot.phase) {
    MatchLifecyclePhase.incomingChallenge => 'Respond',
    MatchLifecyclePhase.challengeSent ||
    MatchLifecyclePhase.challengeExpired =>
      'View Challenge',
    MatchLifecyclePhase.privateRoom => 'View Code',
    _ => 'Return to Room',
  };

  String get _opponentLabel {
    final name = snapshot.opponent?.name ?? '';
    return name.isEmpty ? '?' : name.substring(0, 1);
  }

  @override
  Widget build(BuildContext context) {
    final opponentName = snapshot.opponent?.name ?? 'No opponent yet';
    return FlowCard(
      borderColor: AppColors.primaryAction.withValues(alpha: .6),
      child: Row(
        children: [
          GameAvatar(size: 40, label: _opponentLabel),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  opponentName,
                  style: const TextStyle(
                    fontFamily: 'Sora',
                    fontSize: 13,
                    fontWeight: FontWeight.w700,
                  ),
                ),
                Text(
                  Money(snapshot.terms.stakeMinorUnits).format(),
                  style: TextStyle(
                    fontFamily: 'Inter',
                    color: AppColors.valueAccent,
                    fontSize: 11,
                    fontWeight: FontWeight.w700,
                  ),
                ),
                Text(
                  _status,
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
            onPressed: () => context.go(_route, extra: snapshot),
            style: OutlinedButton.styleFrom(
              minimumSize: const Size(0, 42),
              side: const BorderSide(color: AppColors.primaryBright),
            ),
            child: Text(_actionLabel, style: const TextStyle(fontSize: 11)),
          ),
        ],
      ),
    );
  }
}
