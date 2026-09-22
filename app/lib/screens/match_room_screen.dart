import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import '../models/match_flow.dart';
import '../providers/match_flow_provider.dart';
import '../providers/match_provider.dart';
import '../providers/profile_provider.dart';
import '../theme/colors.dart';
import '../widgets/flow_widgets.dart';

class MatchRoomScreen extends ConsumerStatefulWidget {
  const MatchRoomScreen({super.key, required this.matchId});

  final String matchId;

  @override
  ConsumerState<MatchRoomScreen> createState() => _MatchRoomScreenState();
}

class _MatchRoomScreenState extends ConsumerState<MatchRoomScreen> {
  bool _joining = false;

  Future<void> _copyRoomId() async {
    await Clipboard.setData(ClipboardData(text: widget.matchId));
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(content: Text('Room ID copied for sharing.')),
    );
  }

  void _chatUnavailable() {
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(
        content: Text('Room chat is not available on the current server.'),
      ),
    );
  }

  @override
  void initState() {
    super.initState();
    Future.microtask(
      () => ref.read(matchProvider.notifier).fetchGameState(widget.matchId),
    );
  }

  Future<void> _enterMatch() async {
    if (_joining) return;
    setState(() => _joining = true);
    ref.read(matchProvider.notifier).joinMatch(widget.matchId);
    if (mounted) context.go('/match/${widget.matchId}');
  }

  @override
  Widget build(BuildContext context) {
    final profile = ref.watch(profileProvider).profile;
    final game = ref.watch(matchProvider);
    final intent = ref.watch(matchFlowProvider).currentIntent;
    final terms = intent?.terms ?? const MatchTerms(stakeMinorUnits: 0);
    final synced =
        game.gameState != null && game.syncState == MatchSyncState.synced;
    final offline = game.syncState == MatchSyncState.offline;
    final opponentDisconnected = !game.opponentConnected;
    final ended =
        game.gameState?.status == 'completed' ||
        game.gameState?.status == 'draw';
    final opponent = intent?.opponent;

    return PopScope(
      canPop: game.gameState == null,
      child: Scaffold(
        backgroundColor: AppColors.background,
        appBar: AppBar(
          leading: IconButton(
            tooltip: 'Back',
            onPressed: game.gameState == null
                ? () => context.go('/home')
                : null,
            icon: const Icon(Icons.arrow_back_ios_new_rounded, size: 19),
          ),
          title: Text(
            'Room #${widget.matchId.length > 7 ? widget.matchId.substring(0, 7) : widget.matchId}',
          ),
          actions: [
            IconButton(
              tooltip: 'Copy room ID',
              onPressed: _copyRoomId,
              icon: const Icon(LucideIcons.copy, size: 19),
            ),
            IconButton(
              tooltip: 'Share room',
              onPressed: _copyRoomId,
              icon: const Icon(LucideIcons.share2, size: 19),
            ),
          ],
        ),
        body: SafeArea(
          child: FlowPage(
            child: Column(
              children: [
                const SizedBox(height: 14),
                Row(
                  mainAxisAlignment: MainAxisAlignment.spaceAround,
                  children: [
                    _RoomPlayer(
                      name: profile?.displayName ?? 'You',
                      avatarId: profile?.avatar ?? 'avatar_01',
                      rank: profile?.tier ?? 'PLAYER',
                      accent: AppColors.primaryBright,
                    ),
                    Text(
                      'VS',
                      style: TextStyle(
                        fontFamily: 'Sora',
                        fontSize: 23,
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                    _RoomPlayer(
                      name: opponent?.name ?? 'Opponent',
                      avatarId: opponent?.avatarId ?? 'avatar_04',
                      rank: opponent?.rank ?? 'PLAYER',
                      accent: AppColors.valueAccent,
                    ),
                  ],
                ),
                const SizedBox(height: 24),
                MatchTermsCard(terms: terms),
                if (opponentDisconnected) ...[
                  const SizedBox(height: 12),
                  FlowCard(
                    borderColor: AppColors.danger.withValues(alpha: .5),
                    child: const Row(
                      children: [
                        Icon(LucideIcons.userRoundX, color: AppColors.danger),
                        SizedBox(width: 10),
                        Expanded(
                          child: Text(
                            'Opponent disconnected. Waiting for the server reconnect window.',
                            style: TextStyle(
                              fontFamily: 'Inter',
                              color: AppColors.textSecondary,
                              fontSize: 11,
                            ),
                          ),
                        ),
                      ],
                    ),
                  ),
                ],
                const SizedBox(height: 18),
                Row(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    Icon(
                      synced
                          ? LucideIcons.shieldCheck
                          : LucideIcons.loaderCircle,
                      color: synced
                          ? AppColors.primaryBright
                          : AppColors.textSecondary,
                      size: 17,
                    ),
                    const SizedBox(width: 7),
                    Flexible(
                      child: Text(
                        ended
                            ? 'This match has ended'
                            : opponentDisconnected
                            ? 'Waiting for opponent to reconnect'
                            : synced
                            ? 'Canonical match state received'
                            : offline
                            ? 'Connection lost before match start'
                            : 'Waiting for authoritative match state',
                        textAlign: TextAlign.center,
                        style: TextStyle(
                          fontFamily: 'Inter',
                          color: synced
                              ? AppColors.primaryBright
                              : AppColors.textSecondary,
                          fontSize: 11,
                        ),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 24),
                Text(
                  ended
                      ? 'MATCH COMPLETE'
                      : opponentDisconnected
                      ? 'WAITING FOR OPPONENT'
                      : synced
                      ? 'READY TO PLAY'
                      : offline
                      ? 'RECONNECT TO CONTINUE'
                      : 'MATCH STARTS WHEN SERVER IS READY',
                  textAlign: TextAlign.center,
                  style: TextStyle(
                    fontFamily: 'Inter',
                    color: AppColors.valueAccent,
                    fontSize: 12,
                    fontWeight: FontWeight.w700,
                    letterSpacing: .8,
                  ),
                ),
                const SizedBox(height: 8),
                Text(
                  ended
                      ? 'ENDED'
                      : opponentDisconnected
                      ? 'WAITING'
                      : synced
                      ? 'READY'
                      : '--:--',
                  style: TextStyle(
                    fontFamily: 'Sora',
                    color: AppColors.valueAccent,
                    fontSize: 34,
                    fontWeight: FontWeight.w700,
                  ),
                ),
                const SizedBox(height: 8),
                Text(
                  ended
                      ? 'The server has closed this room.'
                      : opponentDisconnected
                      ? 'The match will continue only if the server confirms reconnection.'
                      : synced
                      ? 'Canonical game state is ready; clocks start from server events.'
                      : offline
                      ? 'Retry to request the canonical match state.'
                      : 'No local countdown is shown before the server confirms start.',
                  textAlign: TextAlign.center,
                  style: TextStyle(
                    fontFamily: 'Inter',
                    color: AppColors.textSecondary,
                    fontSize: 11,
                  ),
                ),
                const SizedBox(height: 18),
                if (offline)
                  SecondaryActionButton(
                    label: 'Retry connection',
                    icon: LucideIcons.refreshCw,
                    onPressed: () => ref
                        .read(matchProvider.notifier)
                        .fetchGameState(widget.matchId),
                  )
                else if (ended)
                  PrimaryActionButton(
                    label: 'Back to Home',
                    onPressed: () => context.go('/home'),
                  )
                else
                  PrimaryActionButton(
                    label: _joining ? 'Joining Match' : 'Enter Match',
                    loading: _joining,
                    onPressed: synced && !opponentDisconnected
                        ? _enterMatch
                        : null,
                  ),
              ],
            ),
          ),
        ),
        floatingActionButton: FloatingActionButton.small(
          tooltip: 'Match chat',
          onPressed: _chatUnavailable,
          backgroundColor: AppColors.surfaceRaised,
          child: const Icon(LucideIcons.messageCircle, size: 19),
        ),
      ),
    );
  }
}

class _RoomPlayer extends StatelessWidget {
  const _RoomPlayer({
    required this.name,
    required this.avatarId,
    required this.rank,
    required this.accent,
  });

  final String name;
  final String avatarId;
  final String rank;
  final Color accent;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: 112,
      child: Column(
        children: [
          GameAvatar(avatarId: avatarId, size: 72, accent: accent, label: name),
          const SizedBox(height: 7),
          Text(
            name,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(
              fontFamily: 'Sora',
              fontSize: 12,
              fontWeight: FontWeight.w700,
            ),
          ),
          Text(
            rank,
            style: TextStyle(fontFamily: 'Inter', color: accent, fontSize: 10),
          ),
        ],
      ),
    );
  }
}
