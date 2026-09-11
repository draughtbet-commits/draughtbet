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

class _HomeLobbyScreenState extends ConsumerState<HomeLobbyScreen> {
  static const _stakes = [50000, 100000, 200000, 500000];
  int _selectedStake = 200000;

  @override
  void initState() {
    super.initState();
    Future.microtask(() {
      ref.read(profileProvider.notifier).load();
      ref.read(matchFlowProvider.notifier).loadArena();
      ref.read(matchProvider.notifier).restoreActiveMatch();
    });
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

  @override
  Widget build(BuildContext context) {
    final matchState = ref.watch(matchProvider);
    final flow = ref.watch(matchFlowProvider);
    final actionPending = flow.actionPhase == MatchActionPhase.submitting;

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
            if (matchState.currentMatchId != null) ...[
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
