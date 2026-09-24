import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../models/game_state.dart';
import '../services/api_client.dart';
import '../theme/colors.dart';
import '../widgets/flow_widgets.dart';

class GameMoveHistoryScreen extends ConsumerStatefulWidget {
  const GameMoveHistoryScreen({
    super.key,
    required this.matchId,
    this.initialMoves = const [],
    this.autoLoad = true,
  });

  final String matchId;
  final List<AcceptedGameMove> initialMoves;
  final bool autoLoad;

  @override
  ConsumerState<GameMoveHistoryScreen> createState() =>
      _GameMoveHistoryScreenState();
}

class _GameMoveHistoryScreenState extends ConsumerState<GameMoveHistoryScreen> {
  late List<AcceptedGameMove> _moves = widget.initialMoves;
  bool _loading = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    if (widget.autoLoad && _moves.isEmpty) {
      WidgetsBinding.instance.addPostFrameCallback((_) => _load());
    }
  }

  Future<void> _load() async {
    if (_loading) return;
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final response = await ref
          .read(apiClientProvider)
          .get('/matches/${widget.matchId}/state');
      if (!mounted) return;
      final data = response.data;
      if (data is! Map) throw const FormatException('Invalid match state');
      final json = Map<String, dynamic>.from(data);
      if (!json.containsKey('moveHistory') &&
          !json.containsKey('acceptedMoves') &&
          !json.containsKey('moves')) {
        throw const FormatException('Accepted move log unavailable');
      }
      final game = GameState.fromJson(json);
      setState(() => _moves = game.moveHistory);
    } catch (_) {
      if (mounted) {
        setState(
          () => _error =
              'Move history is unavailable until the server provides the accepted move log.',
        );
      }
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColors.background,
      appBar: AppBar(title: const Text('MOVE HISTORY')),
      body: SafeArea(
        child: _loading
            ? const Center(
                child: CircularProgressIndicator(
                  color: AppColors.primaryBright,
                ),
              )
            : _error != null
            ? RecoverableState(
                icon: LucideIcons.history,
                title: 'Move history unavailable',
                message: _error!,
                actionLabel: 'Try again',
                onAction: _load,
              )
            : _moves.isEmpty
            ? const RecoverableState(
                icon: LucideIcons.history,
                title: 'No accepted moves yet',
                message:
                    'Server-confirmed moves will appear here after play begins.',
                actionLabel: 'Refresh',
                onAction: _noop,
              )
            : ListView.separated(
                padding: const EdgeInsets.fromLTRB(16, 12, 16, 24),
                itemCount: (_moves.length + 1) ~/ 2,
                separatorBuilder: (_, _) => const SizedBox(height: 6),
                itemBuilder: (context, index) {
                  final light = _moves[index * 2];
                  final darkIndex = index * 2 + 1;
                  final dark = darkIndex < _moves.length
                      ? _moves[darkIndex]
                      : null;
                  return _MoveHistoryRow(
                    round: index + 1,
                    light: light,
                    dark: dark,
                  );
                },
              ),
      ),
    );
  }

  static void _noop() {}
}

class _MoveHistoryRow extends StatelessWidget {
  const _MoveHistoryRow({
    required this.round,
    required this.light,
    required this.dark,
  });

  final int round;
  final AcceptedGameMove light;
  final AcceptedGameMove? dark;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      label:
          'Move $round, ${_label(light)}${dark == null ? '' : ', ${_label(dark!)}'}',
      child: FlowCard(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 11),
        child: Row(
          children: [
            SizedBox(
              width: 28,
              child: Text(
                '$round',
                style: const TextStyle(
                  fontFamily: 'Inter',
                  color: AppColors.textSecondary,
                  fontSize: 11,
                ),
              ),
            ),
            Expanded(child: _MoveCell(move: light, light: true)),
            const SizedBox(width: 8),
            Expanded(
              child: dark == null
                  ? const SizedBox.shrink()
                  : _MoveCell(move: dark!, light: false),
            ),
            const SizedBox(width: 4),
            const Icon(
              LucideIcons.chevronRight,
              color: AppColors.textSecondary,
              size: 15,
            ),
          ],
        ),
      ),
    );
  }

  static String _label(AcceptedGameMove move) {
    final destination = move.path.isEmpty ? '—' : '${move.path.last + 1}';
    return '${move.from + 1}–$destination';
  }
}

class _MoveCell extends StatelessWidget {
  const _MoveCell({required this.move, required this.light});

  final AcceptedGameMove move;
  final bool light;

  @override
  Widget build(BuildContext context) {
    final destination = move.path.isEmpty ? '—' : '${move.path.last + 1}';
    return Row(
      children: [
        Container(
          width: 15,
          height: 15,
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            color: light ? AppColors.pieceLight : AppColors.pieceDark,
            border: Border.all(
              color: light ? AppColors.primaryBright : AppColors.textSecondary,
            ),
            boxShadow: [BoxShadow(color: AppColors.pieceShadow, blurRadius: 4)],
          ),
        ),
        const SizedBox(width: 8),
        Flexible(
          child: Text(
            '${move.from + 1}–$destination',
            overflow: TextOverflow.ellipsis,
            style: const TextStyle(
              fontFamily: 'Sora',
              fontWeight: FontWeight.w600,
              fontSize: 11,
            ),
          ),
        ),
        if (move.promoted) ...[
          const SizedBox(width: 4),
          const Icon(LucideIcons.crown, color: AppColors.valueAccent, size: 13),
        ],
      ],
    );
  }
}
