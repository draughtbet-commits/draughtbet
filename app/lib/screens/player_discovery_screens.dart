import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import '../models/match_flow.dart';
import '../theme/colors.dart';
import '../theme/typography.dart';
import '../widgets/flow_widgets.dart';

class PlayerSearchScreen extends StatefulWidget {
  const PlayerSearchScreen({super.key, this.players = const []});

  final List<MatchPlayer> players;

  @override
  State<PlayerSearchScreen> createState() => _PlayerSearchScreenState();
}

class _PlayerSearchScreenState extends State<PlayerSearchScreen> {
  String _query = '';

  @override
  Widget build(BuildContext context) {
    final players = widget.players
        .where(
          (player) => player.name.toLowerCase().contains(_query.toLowerCase()),
        )
        .toList(growable: false);
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
                onChanged: (value) => setState(() => _query = value),
                textInputAction: TextInputAction.search,
                decoration: const InputDecoration(
                  hintText: 'Search players by username…',
                  prefixIcon: Icon(LucideIcons.search),
                ),
              ),
              const SizedBox(height: 16),
              if (widget.players.isEmpty)
                SizedBox(
                  height: 560,
                  child: RecoverableState(
                    title: 'Player search unavailable',
                    message:
                        'The current server does not expose an authoritative player-search contract.',
                    actionLabel: 'Browse Arena',
                    onAction: _browseArena,
                    icon: LucideIcons.userSearch,
                  ),
                )
              else if (players.isEmpty)
                SizedBox(
                  height: 420,
                  child: RecoverableState(
                    title: 'No players found',
                    message: 'Try another username.',
                    actionLabel: 'Clear search',
                    onAction: _clearSearch,
                    icon: LucideIcons.searchX,
                  ),
                )
              else
                ...players.map(
                  (player) => Padding(
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
                          title: Text(
                            player.name,
                            style: AppTypography.labelBold,
                          ),
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
                ),
            ],
          ),
        ),
      ),
    );
  }

  void _browseArena() => context.go('/arena');

  void _clearSearch() => setState(() => _query = '');
}

class PublicPlayerProfileScreen extends StatelessWidget {
  const PublicPlayerProfileScreen({required this.player, super.key});

  final MatchPlayer player;

  @override
  Widget build(BuildContext context) => Scaffold(
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
            PrimaryActionButton(label: 'Challenge Player', onPressed: null),
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
