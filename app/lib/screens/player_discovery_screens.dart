import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import '../models/match_flow.dart';
import '../providers/match_flow_provider.dart';
import '../providers/player_discovery_provider.dart';
import '../providers/profile_provider.dart';
import '../theme/colors.dart';
import '../theme/typography.dart';
import '../widgets/flow_widgets.dart';

class PlayerSearchScreen extends ConsumerStatefulWidget {
  const PlayerSearchScreen({super.key, this.players = const []});

  final List<MatchPlayer> players;

  @override
  ConsumerState<PlayerSearchScreen> createState() => _PlayerSearchScreenState();
}

class _PlayerSearchScreenState extends ConsumerState<PlayerSearchScreen> {
  final TextEditingController _controller = TextEditingController();

  @override
  void initState() {
    super.initState();
    if (widget.players.isNotEmpty) {
      Future.microtask(() => ref
          .read(playerSearchProvider.notifier)
          .setResults(widget.players));
    }
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(playerSearchProvider);
    final Widget content = switch (state.phase) {
      PlayerSearchPhase.idle => SizedBox(
        height: 420,
        child: RecoverableState(
          title: 'Search the arena',
          message: 'Look up any player by username and view their public '
              'profile. Contact and balance details are never shown.',
          actionLabel: 'Browse Arena',
          onAction: _browseArena,
          icon: LucideIcons.userSearch,
        ),
      ),
      PlayerSearchPhase.searching => const SizedBox(
        height: 220,
        child: Center(child: CircularProgressIndicator(strokeWidth: 3)),
      ),
      PlayerSearchPhase.error => RecoverableState(
        title: 'Search failed',
        message:
            state.message ?? 'Could not reach the server. Please try again.',
        actionLabel: 'Try again',
        onAction: () => ref
            .read(playerSearchProvider.notifier)
            .updateQuery(state.query),
        icon: LucideIcons.searchX,
      ),
      PlayerSearchPhase.empty => RecoverableState(
        title: 'No players found',
        message: 'Try another username.',
        actionLabel: 'Clear search',
        onAction: _clearSearch,
        icon: LucideIcons.searchX,
      ),
      PlayerSearchPhase.results => SizedBox(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            for (final player in state.players)
              Padding(
                padding: const EdgeInsets.only(bottom: 9),
                child: FlowCard(
                  padding: const EdgeInsets.all(10),
                  child: Material(
                    color: AppColors.transparent,
                    child: ListTile(
                      contentPadding: EdgeInsets.zero,
                      leading: GameAvatar(
                        avatarId: player.avatarId,
                        size: 46,
                        label: player.name,
                      ),
                      title: Text(player.name, style: AppTypography.labelBold),
                      subtitle: Text(
                        '${player.rank ?? 'PLAYER'}${player.rating == null ? '' : '  ★ ${player.rating}'}',
                        style: AppTypography.bodySmall,
                      ),
                      trailing: const Icon(LucideIcons.chevronRight),
                      onTap: () =>
                          context.push('/arena/player', extra: player),
                    ),
                  ),
                ),
              ),
          ],
        ),
      ),
    };
    return Scaffold(
      backgroundColor: AppColors.background,
      appBar: AppBar(title: const Text('PLAYER SEARCH'), centerTitle: true),
      body: SafeArea(
        top: false,
        child: FlowPage(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              TextField(
                controller: _controller,
                onChanged: (value) =>
                    ref.read(playerSearchProvider.notifier).updateQuery(value),
                textInputAction: TextInputAction.search,
                decoration: InputDecoration(
                  hintText: 'Search players by username…',
                  prefixIcon: const Icon(LucideIcons.search),
                  suffixIcon: state.query.isEmpty
                      ? null
                      : IconButton(
                          tooltip: 'Clear search',
                          icon: const Icon(LucideIcons.x, size: 18),
                          onPressed: _clearSearch,
                        ),
                ),
              ),
              const SizedBox(height: 16),
              content,
            ],
          ),
        ),
      ),
    );
  }

  void _browseArena() => context.go('/arena');

  void _clearSearch() {
    _controller.clear();
    ref.read(playerSearchProvider.notifier).clear();
  }
}

class PublicPlayerProfileScreen extends ConsumerStatefulWidget {
  const PublicPlayerProfileScreen({super.key, required this.player});

  final MatchPlayer player;

  @override
  ConsumerState<PublicPlayerProfileScreen> createState() =>
      _PublicPlayerProfileScreenState();
}

class _PublicPlayerProfileScreenState
    extends ConsumerState<PublicPlayerProfileScreen> {
  MatchPlayer? _fetched;
  bool _challenging = false;

  @override
  void initState() {
    super.initState();
    _refresh();
  }

  Future<void> _refresh() async {
    try {
      final profile = await ref
          .read(playerGatewayProvider)
          .fetchProfile(widget.player.id);
      if (mounted && profile != null) {
        setState(() => _fetched = profile);
      }
    } catch (_) {
      // Best-effort enrichment: the passed-in review data already renders.
    }
  }

  static const Map<String, List<int>> _stakePresets = {
    'PRO': [6000000, 5000000, 3000000],
    'MASTER': [3000000, 1500000, 1000000],
    'AMATEUR': [500000, 200000, 100000, 50000],
  };

  Future<void> _sendChallenge(MatchPlayer target) async {
    ref.read(profileProvider.notifier).load();
    final tier = ref.read(profileProvider).profile?.tier ?? 'AMATEUR';
    final presets = _stakePresets[tier] ?? _stakePresets['AMATEUR']!;
    final stake = await showModalBottomSheet<int>(
      context: context,
      isScrollControlled: true,
      backgroundColor: AppColors.surface,
      builder: (sheetContext) => _ChallengeStakeSheet(presets: presets),
    );
    if (stake == null || !mounted) return;

    setState(() => _challenging = true);
    final notifier = ref.read(matchFlowProvider.notifier);
    final snapshot = await notifier.createChallenge(
      target,
      MatchTerms(
        stakeMinorUnits: stake,
        timeControl: '10 minutes',
        gameType: 'Classic',
        visibility: 'Anyone',
      ),
    );
    if (!mounted) return;
    setState(() => _challenging = false);
    if (snapshot != null) {
      context.go('/play/challenge', extra: snapshot);
      return;
    }
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(
          ref.read(matchFlowProvider).message ??
              'The challenge could not be sent.',
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final player = _fetched ?? widget.player;
    return Scaffold(
      backgroundColor: AppColors.background,
      appBar: AppBar(),
      body: SafeArea(
        top: false,
        child: FlowPage(
          scrollable: false,
          child: Column(
            children: [
              const Spacer(),
              GameAvatar(
                avatarId: player.avatarId,
                size: 104,
                label: player.name,
              ),
              const SizedBox(height: 14),
              Text(player.name, style: AppTypography.heading2),
              Text(
                player.rank ?? 'Verified player',
                style: AppTypography.bodyLarge.copyWith(
                  color: AppColors.primaryBright,
                ),
              ),
              if (player.rating != null)
                Text('★ ${player.rating}', style: AppTypography.bodyLarge),
              const SizedBox(height: 20),
              FlowCard(
                child: Row(
                  mainAxisAlignment: MainAxisAlignment.spaceAround,
                  children: [
                    _Metric(value: '${player.level ?? '—'}', label: 'Level'),
                    _Metric(
                      value: '${player.winRate ?? '—'}%',
                      label: 'Win rate',
                    ),
                    _Metric(value: '${player.rating ?? '—'}', label: 'Rating'),
                  ],
                ),
              ),
              const Spacer(),
              PrimaryActionButton(
                label: 'Challenge Player',
                loading: _challenging,
                onPressed:
                    _challenging ? null : () => _sendChallenge(player),
              ),
              const SizedBox(height: 8),
              SecondaryActionButton(
                label: 'Browse Arena',
                onPressed: () => context.go('/arena'),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _ChallengeStakeSheet extends StatelessWidget {
  const _ChallengeStakeSheet({required this.presets});

  final List<int> presets;

  @override
  Widget build(BuildContext context) {
    return SingleChildScrollView(
      child: SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(20, 24, 20, 12),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text(
                'Challenge stake',
                textAlign: TextAlign.center,
                style: AppTypography.heading2,
              ),
              const SizedBox(height: 8),
              Text(
                'Pick a preset. The opponent stakes the same amount.',
                textAlign: TextAlign.center,
                style: AppTypography.bodySmall,
              ),
              const SizedBox(height: 16),
              for (final stake in presets)
                Padding(
                  padding: const EdgeInsets.only(bottom: 10),
                  child: FlowCard(
                    padding: const EdgeInsets.all(2),
                    child: Material(
                      color: AppColors.transparent,
                      child: ListTile(
                        contentPadding: const EdgeInsets.symmetric(
                          horizontal: 14,
                          vertical: 2,
                        ),
                        leading: const Icon(LucideIcons.trophy, size: 20),
                        title: Text(
                          Money(stake).format(),
                          style: AppTypography.labelBold,
                        ),
                        subtitle: Text(
                          'You and the opponent each stake this',
                          style: AppTypography.bodySmall,
                        ),
                        trailing: const Icon(LucideIcons.chevronRight),
                        onTap: () => Navigator.pop(context, stake),
                      ),
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

class _Metric extends StatelessWidget {
  const _Metric({required this.value, required this.label});

  final String value;
  final String label;

  @override
  Widget build(BuildContext context) => Column(
    children: [
      Text(value, style: AppTypography.heading3),
      Text(label, style: AppTypography.bodySmall),
    ],
  );
}