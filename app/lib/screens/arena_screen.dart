import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import '../models/match_flow.dart';
import '../providers/match_flow_provider.dart';
import '../theme/colors.dart';
import '../widgets/flow_widgets.dart';

class ArenaScreen extends ConsumerStatefulWidget {
  const ArenaScreen({super.key});

  @override
  ConsumerState<ArenaScreen> createState() => _ArenaScreenState();
}

class _ArenaScreenState extends ConsumerState<ArenaScreen> {
  int? _maxStake;

  @override
  void initState() {
    super.initState();
    Future.microtask(() => ref.read(matchFlowProvider.notifier).loadArena());
  }

  void _showFilters() {
    showModalBottomSheet<void>(
      context: context,
      backgroundColor: AppColors.surface,
      showDragHandle: true,
      builder: (sheetContext) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(16, 4, 16, 24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                'Filter matches',
                style: TextStyle(
                  fontFamily: 'Sora',
                  fontSize: 18,
                  fontWeight: FontWeight.w700,
                ),
              ),
              const SizedBox(height: 16),
              Wrap(
                spacing: 8,
                children: [null, 100000, 200000, 500000].map((value) {
                  return ChoiceChip(
                    label: Text(
                      value == null ? 'All stakes' : Money(value).format(),
                    ),
                    selected: _maxStake == value,
                    onSelected: (_) {
                      setState(() => _maxStake = value);
                      Navigator.pop(sheetContext);
                    },
                  );
                }).toList(),
              ),
            ],
          ),
        ),
      ),
    );
  }

  void _review(OpenMatch match) {
    if (match.isStale) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('This match is no longer available.')),
      );
      ref.read(matchFlowProvider.notifier).loadArena();
      return;
    }
    final intent = MatchFlowIntent(
      kind: MatchEntryKind.openMatch,
      terms: match.terms,
      openMatchId: match.id,
      opponent: match.host,
    );
    ref.read(matchFlowProvider.notifier).review(intent);
    context.go('/play/confirm');
  }

  @override
  Widget build(BuildContext context) {
    final flow = ref.watch(matchFlowProvider);
    final matches = flow.openMatches
        .where(
          (match) =>
              _maxStake == null || match.terms.stakeMinorUnits <= _maxStake!,
        )
        .toList(growable: false);

    return Scaffold(
      backgroundColor: AppColors.background,
      body: SafeArea(
        child: FlowPage(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              ScreenHeading(
                title: 'Open Arena',
                subtitle: _maxStake == null
                    ? 'Challenge any eligible player'
                    : 'Stake filter applied',
                trailing: IconButton.outlined(
                  tooltip: 'Filter open matches',
                  onPressed: _showFilters,
                  icon: const Icon(LucideIcons.listFilter, size: 19),
                ),
              ),
              const SizedBox(height: 16),
              if (flow.arenaPhase == LoadPhase.initial ||
                  flow.arenaPhase == LoadPhase.loading)
                ...List.generate(
                  4,
                  (index) => const Padding(
                    padding: EdgeInsets.only(bottom: 12),
                    child: _ArenaSkeleton(),
                  ),
                )
              else if (flow.arenaPhase == LoadPhase.error ||
                  flow.arenaPhase == LoadPhase.offline)
                SizedBox(
                  height: 480,
                  child: RecoverableState(
                    title: flow.arenaPhase == LoadPhase.offline
                        ? 'You are offline'
                        : 'Arena unavailable',
                    message: flow.message ?? 'We could not refresh the Arena.',
                    actionLabel: 'Try again',
                    onAction: () =>
                        ref.read(matchFlowProvider.notifier).loadArena(),
                    icon: flow.arenaPhase == LoadPhase.offline
                        ? LucideIcons.wifiOff
                        : LucideIcons.refreshCw,
                  ),
                )
              else if (matches.isEmpty)
                SizedBox(
                  height: 480,
                  child: RecoverableState(
                    title: 'Arena is quiet right now',
                    message:
                        'Create a match and let an eligible player join you.',
                    actionLabel: 'Create Match',
                    onAction: () => context.go('/play/create'),
                    icon: LucideIcons.swords,
                  ),
                )
              else
                ...matches.map(
                  (match) => Padding(
                    padding: const EdgeInsets.only(bottom: 10),
                    child: _OpenMatchCard(
                      match: match,
                      onJoin: () => _review(match),
                    ),
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}

class _OpenMatchCard extends StatelessWidget {
  const _OpenMatchCard({required this.match, required this.onJoin});

  final OpenMatch match;
  final VoidCallback onJoin;

  @override
  Widget build(BuildContext context) {
    final player = match.host;
    return FlowCard(
      padding: const EdgeInsets.all(12),
      child: Row(
        children: [
          GameAvatar(
            avatarId: player.avatarId,
            size: 46,
            accent: player.rank == 'MASTER'
                ? AppColors.valueAccent
                : AppColors.primaryBright,
            label: player.name,
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Flexible(
                      child: Text(
                        player.name,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                          fontFamily: 'Sora',
                          fontSize: 13,
                          fontWeight: FontWeight.w700,
                        ),
                      ),
                    ),
                    const SizedBox(width: 6),
                    if (player.rank != null) RankPill(label: player.rank!),
                  ],
                ),
                const SizedBox(height: 3),
                Text(
                  [
                    if (player.winRate != null) '${player.winRate}% win rate',
                    if (player.rating != null) '★ ${player.rating} rating',
                    if (player.winRate == null && player.rating == null)
                      'Verified open match',
                  ].join('   '),
                  style: TextStyle(
                    fontFamily: 'Inter',
                    color: AppColors.textSecondary,
                    fontSize: 10,
                  ),
                ),
                const SizedBox(height: 6),
                Text(
                  'Stake  ${Money(match.terms.stakeMinorUnits).format()}    ${match.terms.timeControl}',
                  style: TextStyle(
                    fontFamily: 'Inter',
                    fontSize: 10,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(width: 8),
          OutlinedButton(
            onPressed: match.isStale ? null : onJoin,
            style: OutlinedButton.styleFrom(
              minimumSize: const Size(62, 44),
              padding: const EdgeInsets.symmetric(horizontal: 13),
              side: const BorderSide(color: AppColors.primaryBright),
              foregroundColor: AppColors.textPrimary,
            ),
            child: Text(match.isStale ? 'STALE' : 'JOIN'),
          ),
        ],
      ),
    );
  }
}

class _ArenaSkeleton extends StatelessWidget {
  const _ArenaSkeleton();

  @override
  Widget build(BuildContext context) {
    return const FlowCard(
      child: SizedBox(
        height: 58,
        child: Row(
          children: [
            CircleAvatar(radius: 23, backgroundColor: AppColors.surfaceRaised),
            SizedBox(width: 12),
            Expanded(child: LinearProgressIndicator(minHeight: 8)),
          ],
        ),
      ),
    );
  }
}
