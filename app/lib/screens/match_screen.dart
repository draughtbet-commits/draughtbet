export '../widgets/draught_board.dart' show BoardPainter;

import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import '../models/game_state.dart';
import '../models/match_flow.dart';
import '../providers/match_flow_provider.dart';
import '../providers/match_provider.dart';
import '../services/secure_storage.dart';
import '../services/socket_service.dart';
import '../theme/colors.dart';
import '../widgets/draught_board.dart';
import '../widgets/flow_widgets.dart';

class MatchScreen extends ConsumerStatefulWidget {
  const MatchScreen({super.key, required this.matchId});

  final String matchId;

  @override
  ConsumerState<MatchScreen> createState() => _MatchScreenState();
}

class _MatchScreenState extends ConsumerState<MatchScreen> {
  int? _selectedSquare;
  String? _userId;
  StreamSubscription<Map<String, dynamic>>? _errorSubscription;
  Timer? _promotionTimer;
  Timer? _disconnectTicker;
  bool _resultOpened = false;

  @override
  void initState() {
    super.initState();
    SecureStorageService().userId.then((value) {
      if (mounted) setState(() => _userId = value);
    });
    WidgetsBinding.instance.addPostFrameCallback((_) {
      ref.read(matchProvider.notifier).joinMatch(widget.matchId);
      ref.read(matchProvider.notifier).fetchGameState(widget.matchId);
      if (ref.read(matchProvider).promotionVisible) _schedulePromotionDismiss();
    });
    _errorSubscription = socketService.onError.listen((data) {
      if (!mounted) return;
      final message =
          data['message']?.toString() ?? 'The match server reported an error.';
      if (message.toLowerCase().contains('ended') ||
          message.toLowerCase().contains('not found')) {
        ref.read(matchProvider.notifier).fetchGameState(widget.matchId);
        return;
      }
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(message.replaceAll('!', '')),
          backgroundColor: AppColors.surfaceRaised,
          behavior: SnackBarBehavior.floating,
        ),
      );
    });
  }

  @override
  void dispose() {
    _errorSubscription?.cancel();
    _promotionTimer?.cancel();
    _disconnectTicker?.cancel();
    super.dispose();
  }

  bool _isMyTurn(GameState game) {
    if (_userId == null) return false;
    if (game.currentTurn.toUpperCase() == 'WHITE') {
      return game.player1 == _userId;
    }
    return game.player2 == _userId;
  }

  void _onSquareTapped(int square) {
    final state = ref.read(matchProvider);
    final game = state.gameState;
    if (game == null || !_isMyTurn(game) || state.isMovePending) return;

    if (_selectedSquare != null) {
      final move = game.legalMoves.where(
        (candidate) =>
            candidate.from == _selectedSquare && candidate.to == square,
      );
      if (move.isNotEmpty) {
        ref.read(matchProvider.notifier).attemptMove(_selectedSquare!, square);
        setState(() => _selectedSquare = null);
        return;
      }
    }

    final canMove = game.legalMoves.any((move) => move.from == square);
    setState(() => _selectedSquare = canMove ? square : null);
  }

  Future<void> _confirmResign() async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => _GameDecisionDialog(
        icon: LucideIcons.flag,
        accent: AppColors.danger,
        title: 'RESIGN MATCH?',
        message:
            'If you resign, the match will end and your opponent will be declared the winner.',
        confirmLabel: 'Confirm resignation',
        cancelLabel: 'Cancel',
        destructive: true,
      ),
    );
    if (confirmed == true) ref.read(matchProvider.notifier).resign();
  }

  Future<void> _confirmDrawOffer() async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => const _GameDecisionDialog(
        icon: LucideIcons.handshake,
        accent: AppColors.valueAccent,
        title: 'OFFER A DRAW',
        message:
            'Offer a draw to your opponent? The match ends in a draw only if they accept.',
        confirmLabel: 'Offer draw',
        cancelLabel: 'Cancel',
      ),
    );
    if (confirmed != true || !mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(
        content: Text(
          'Draw offers are not supported by the current server contract.',
        ),
      ),
    );
  }

  void _chatUnavailable() {
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(
        content: Text('Chat is not supported by the current server contract.'),
      ),
    );
  }

  void _showMatchMenu() {
    showModalBottomSheet<void>(
      context: context,
      backgroundColor: AppColors.surface,
      showDragHandle: true,
      builder: (context) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(16, 4, 16, 24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text(
                'Match options',
                style: TextStyle(
                  fontFamily: 'Sora',
                  fontSize: 18,
                  fontWeight: FontWeight.w700,
                ),
              ),
              const SizedBox(height: 12),
              ListTile(
                leading: const Icon(LucideIcons.handshake),
                title: const Text('Offer Draw'),
                onTap: () {
                  Navigator.pop(context);
                  _confirmDrawOffer();
                },
              ),
              ListTile(
                leading: const Icon(LucideIcons.flag, color: AppColors.danger),
                title: const Text('Resign Match'),
                onTap: () {
                  Navigator.pop(context);
                  _confirmResign();
                },
              ),
            ],
          ),
        ),
      ),
    );
  }

  void _schedulePromotionDismiss() {
    _promotionTimer?.cancel();
    _promotionTimer = Timer(const Duration(milliseconds: 950), () {
      if (mounted && ref.read(matchProvider).promotionVisible) {
        ref.read(matchProvider.notifier).dismissPromotion();
      }
    });
  }

  void _startDisconnectTicker() {
    _disconnectTicker?.cancel();
    _disconnectTicker = Timer.periodic(const Duration(seconds: 1), (_) {
      if (!mounted || ref.read(matchProvider).opponentConnected) {
        _disconnectTicker?.cancel();
        return;
      }
      setState(() {});
    });
  }

  int _remainingReconnectSeconds(MatchState state) {
    final grace = state.opponentGracePeriodMs ?? 60000;
    final disconnectedAt = state.opponentDisconnectedAt;
    if (disconnectedAt == null) return (grace / 1000).ceil();
    final remaining =
        grace - DateTime.now().difference(disconnectedAt).inMilliseconds;
    return remaining <= 0 ? 0 : (remaining / 1000).ceil();
  }

  void _openResult(GameState game, MatchState matchState) {
    if (_resultOpened) return;
    _resultOpened = true;
    final intent = ref.read(matchFlowProvider).currentIntent;
    final opponentId = game.player1 == _userId ? game.player2 : game.player1;
    final won = game.winnerId != null && game.winnerId == _userId;
    final draw = game.winnerId == null || game.winnerId!.isEmpty;
    final result = MatchResultViewData(
      kind: draw
          ? ResultKind.draw
          : won
          ? ResultKind.victory
          : ResultKind.defeat,
      opponent:
          intent?.opponent ??
          MatchPlayer(id: opponentId, name: 'Opponent', avatarId: 'avatar_04'),
      terms: intent?.terms ?? const MatchTerms(stakeMinorUnits: 0),
      matchId: widget.matchId,
      reason:
          matchState.endReason ??
          (draw
              ? 'Match drawn'
              : won
              ? 'You won the match'
              : 'Match completed'),
      settlement: matchState.settlementPhase,
    );
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) context.go('/play/result', extra: result);
    });
  }

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(matchProvider);
    final game = state.gameState;
    ref.listen(matchProvider, (previous, next) {
      if (previous?.promotionVisible != true && next.promotionVisible) {
        _schedulePromotionDismiss();
      } else if (previous?.promotionVisible == true && !next.promotionVisible) {
        _promotionTimer?.cancel();
      }
      if (previous?.opponentConnected != false && !next.opponentConnected) {
        _startDisconnectTicker();
      } else if (next.opponentConnected) {
        _disconnectTicker?.cancel();
      }
    });
    if (game != null &&
        (game.status == 'completed' || game.status == 'draw') &&
        _userId != null) {
      _openResult(game, state);
    }

    final myTurn = game != null && _isMyTurn(game);
    final stable = state.syncState == MatchSyncState.synced;
    final inputEnabled =
        game != null &&
        game.status == 'in_progress' &&
        myTurn &&
        stable &&
        !state.isMovePending &&
        state.opponentConnected;
    final selectedMove = game?.legalMoves.where(
      (move) => move.from == _selectedSquare,
    );
    final capturePath = selectedMove == null || selectedMove.isEmpty
        ? const <int>[]
        : <int>[
            _selectedSquare!,
            ...selectedMove.first.capturedSquares,
            selectedMove.first.to,
          ];

    return PopScope(
      canPop: game == null || game.status != 'in_progress',
      onPopInvokedWithResult: (didPop, result) {
        if (!didPop && game?.status == 'in_progress') {
          ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(
              content: Text('Use Resign to leave an active match safely.'),
            ),
          );
        }
      },
      child: Scaffold(
        backgroundColor: AppColors.background,
        appBar: AppBar(
          titleSpacing: 8,
          title: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                'MATCH #${widget.matchId.length > 6 ? widget.matchId.substring(0, 6) : widget.matchId}',
                style: TextStyle(
                  fontFamily: 'Inter',
                  fontSize: 10,
                  fontWeight: FontWeight.w700,
                ),
              ),
              Text(
                stable ? 'Secure game state' : 'Connection needs attention',
                style: TextStyle(
                  fontFamily: 'Inter',
                  color: stable
                      ? AppColors.primaryBright
                      : AppColors.valueAccent,
                  fontSize: 9,
                ),
              ),
            ],
          ),
          actions: [
            _ClockChip(label: '--:--', active: !myTurn),
            IconButton(
              tooltip: 'Match menu',
              onPressed: _showMatchMenu,
              icon: const Icon(LucideIcons.ellipsis, size: 20),
            ),
          ],
        ),
        body: SafeArea(
          child: Stack(
            fit: StackFit.expand,
            children: [
              game == null
                  ? RecoverableState(
                      title: stable ? 'Loading match' : 'Reconnecting',
                      message:
                          'Requesting the canonical board from the server.',
                      actionLabel: 'Retry',
                      onAction: () => ref
                          .read(matchProvider.notifier)
                          .fetchGameState(widget.matchId),
                    )
                  : LayoutBuilder(
                      builder: (context, constraints) {
                        final compact = constraints.maxHeight < 680;
                        return Column(
                          children: [
                            _ConnectionBanner(state: state),
                            _PlayerStrip(
                              title: 'KingMoves',
                              subtitle: myTurn ? 'Waiting' : 'Thinking…',
                              clock: '--:--',
                              accent: AppColors.valueAccent,
                              active: !myTurn,
                            ),
                            Expanded(
                              child: Align(
                                alignment: const Alignment(0, -0.45),
                                child: Padding(
                                  padding: EdgeInsets.symmetric(
                                    horizontal: compact ? 8 : 12,
                                    vertical: 6,
                                  ),
                                  child: ConstrainedBox(
                                    constraints: const BoxConstraints(
                                      maxWidth: 560,
                                    ),
                                    child: Stack(
                                      alignment: Alignment.center,
                                      children: [
                                        DraughtBoard(
                                          board: game.board,
                                          legalMoves: game.legalMoves,
                                          selectedSquare: _selectedSquare,
                                          onSquareTapped: _onSquareTapped,
                                          inputEnabled: inputEnabled,
                                          capturePath: capturePath,
                                        ),
                                        if (!myTurn && stable)
                                          Positioned.fill(
                                            child: IgnorePointer(
                                              child: ColoredBox(
                                                color: AppColors.background
                                                    .withValues(alpha: .32),
                                                child: Center(
                                                  child: Container(
                                                    padding:
                                                        const EdgeInsets.symmetric(
                                                          horizontal: 14,
                                                          vertical: 8,
                                                        ),
                                                    decoration: BoxDecoration(
                                                      color: AppColors
                                                          .background
                                                          .withValues(
                                                            alpha: .86,
                                                          ),
                                                      borderRadius:
                                                          BorderRadius.circular(
                                                            20,
                                                          ),
                                                      border: Border.all(
                                                        color: AppColors.border,
                                                      ),
                                                    ),
                                                    child: Text(
                                                      'Opponent is thinking…',
                                                      style: TextStyle(
                                                        fontFamily: 'Inter',
                                                        color: AppColors
                                                            .textSecondary,
                                                        fontSize: 11,
                                                      ),
                                                    ),
                                                  ),
                                                ),
                                              ),
                                            ),
                                          ),
                                        if (!state.opponentConnected)
                                          Positioned.fill(
                                            child: _OpponentDisconnectedOverlay(
                                              remainingSeconds:
                                                  _remainingReconnectSeconds(
                                                    state,
                                                  ),
                                            ),
                                          ),
                                        if (game.status == 'settling')
                                          const Positioned.fill(
                                            child: _SettlementPendingOverlay(),
                                          ),
                                      ],
                                    ),
                                  ),
                                ),
                              ),
                            ),
                            _PlayerStrip(
                              title: 'You',
                              subtitle: myTurn
                                  ? 'Your turn'
                                  : 'Opponent’s turn',
                              clock: '--:--',
                              accent: AppColors.primaryBright,
                              active: myTurn,
                            ),
                            SizedBox(
                              height: compact ? 62 : 70,
                              child: Row(
                                mainAxisAlignment:
                                    MainAxisAlignment.spaceEvenly,
                                children: [
                                  _GameAction(
                                    icon: LucideIcons.flag,
                                    label: 'Resign',
                                    color: AppColors.danger,
                                    onTap: _confirmResign,
                                  ),
                                  _GameAction(
                                    icon: LucideIcons.handshake,
                                    label: 'Offer Draw',
                                    onTap: _confirmDrawOffer,
                                  ),
                                  _GameAction(
                                    icon: LucideIcons.messageCircle,
                                    label: 'Chat',
                                    onTap: _chatUnavailable,
                                  ),
                                  _GameAction(
                                    icon: LucideIcons.menu,
                                    label: 'Menu',
                                    onTap: _showMatchMenu,
                                  ),
                                ],
                              ),
                            ),
                            if (_selectedSquare != null)
                              Padding(
                                padding: const EdgeInsets.only(bottom: 4),
                                child: Text(
                                  capturePath.length > 2
                                      ? 'Capture path selected'
                                      : 'Choose a highlighted destination',
                                  style: TextStyle(
                                    fontFamily: 'Inter',
                                    color: capturePath.length > 2
                                        ? AppColors.valueAccent
                                        : AppColors.textSecondary,
                                    fontSize: 10,
                                  ),
                                ),
                              ),
                          ],
                        );
                      },
                    ),
              if (state.promotionVisible) const _PromotionOverlay(),
            ],
          ),
        ),
        floatingActionButton: state.rejectionReason == null
            ? null
            : FloatingActionButton.extended(
                onPressed: ref.read(matchProvider.notifier).clearRejection,
                backgroundColor: AppColors.danger,
                icon: const Icon(LucideIcons.circleAlert, size: 18),
                label: Text(
                  state.rejectionReason == 'illegal_move'
                      ? 'Move rejected'
                      : 'State refreshed',
                ),
              ),
      ),
    );
  }
}

class _PromotionOverlay extends StatelessWidget {
  const _PromotionOverlay();

  @override
  Widget build(BuildContext context) {
    final reduceMotion = MediaQuery.disableAnimationsOf(context);
    return Semantics(
      liveRegion: true,
      label: 'King promotion. Your piece is now a king.',
      child: ColoredBox(
        color: AppColors.background.withValues(alpha: .94),
        child: Center(
          child: TweenAnimationBuilder<double>(
            duration: Duration(milliseconds: reduceMotion ? 1 : 240),
            curve: Curves.easeOut,
            tween: Tween(begin: reduceMotion ? 1 : .92, end: 1),
            builder: (context, value, child) => Transform.scale(
              scale: value,
              child: Opacity(opacity: value, child: child),
            ),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Container(
                  width: 180,
                  height: 180,
                  decoration: BoxDecoration(
                    shape: BoxShape.circle,
                    boxShadow: [
                      BoxShadow(
                        color: AppColors.valueAccent.withValues(alpha: .28),
                        blurRadius: 42,
                      ),
                    ],
                  ),
                  child: Image.asset(
                    'assets/images/king_promotion.png',
                    fit: BoxFit.contain,
                    semanticLabel: 'Emerald draught king with gold crown',
                  ),
                ),
                const SizedBox(height: 24),
                Text(
                  'KING PROMOTION!',
                  style: TextStyle(
                    fontFamily: 'Sora',
                    color: AppColors.valueAccent,
                    fontSize: 25,
                    fontWeight: FontWeight.w700,
                  ),
                ),
                const SizedBox(height: 7),
                Text(
                  'Your piece is now a King',
                  style: TextStyle(
                    fontFamily: 'Inter',
                    color: AppColors.textSecondary,
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _ConnectionBanner extends StatelessWidget {
  const _ConnectionBanner({required this.state});

  final MatchState state;

  @override
  Widget build(BuildContext context) {
    String? label;
    IconData icon = LucideIcons.wifiOff;
    if (!state.opponentConnected) {
      label = 'Opponent disconnected · waiting for reconnect';
      icon = LucideIcons.userRoundX;
    } else if (state.syncState == MatchSyncState.syncing) {
      label = 'Resynchronizing canonical match state';
      icon = LucideIcons.refreshCw;
    } else if (state.syncState == MatchSyncState.offline) {
      label = 'Connection lost · moves are paused';
    } else if (state.isMovePending) {
      label = 'Move submitted · waiting for server';
      icon = LucideIcons.clock3;
    }
    if (label == null) return const SizedBox.shrink();
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 7),
      color: AppColors.valueAccent.withValues(alpha: .12),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Icon(icon, color: AppColors.valueAccent, size: 14),
          const SizedBox(width: 7),
          Flexible(
            child: Text(
              label,
              textAlign: TextAlign.center,
              style: TextStyle(
                fontFamily: 'Inter',
                color: AppColors.valueAccent,
                fontSize: 10,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _GameDecisionDialog extends StatelessWidget {
  const _GameDecisionDialog({
    required this.icon,
    required this.accent,
    required this.title,
    required this.message,
    required this.confirmLabel,
    required this.cancelLabel,
    this.destructive = false,
  });

  final IconData icon;
  final Color accent;
  final String title;
  final String message;
  final String confirmLabel;
  final String cancelLabel;
  final bool destructive;

  @override
  Widget build(BuildContext context) {
    return Dialog(
      insetPadding: const EdgeInsets.symmetric(horizontal: 28),
      child: Padding(
        padding: const EdgeInsets.all(20),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icon, size: 44, color: accent),
            const SizedBox(height: 14),
            Text(
              title,
              textAlign: TextAlign.center,
              style: const TextStyle(
                fontFamily: 'Sora',
                fontSize: 20,
                fontWeight: FontWeight.w700,
              ),
            ),
            const SizedBox(height: 8),
            Text(
              message,
              textAlign: TextAlign.center,
              style: const TextStyle(
                fontFamily: 'Inter',
                color: AppColors.textSecondary,
                fontSize: 12,
                height: 1.4,
              ),
            ),
            const SizedBox(height: 20),
            PrimaryActionButton(
              label: confirmLabel,
              destructive: destructive,
              onPressed: () => Navigator.pop(context, true),
            ),
            const SizedBox(height: 8),
            SecondaryActionButton(
              label: cancelLabel,
              onPressed: () => Navigator.pop(context, false),
            ),
          ],
        ),
      ),
    );
  }
}

class _OpponentDisconnectedOverlay extends StatelessWidget {
  const _OpponentDisconnectedOverlay({required this.remainingSeconds});

  final int remainingSeconds;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      liveRegion: true,
      label:
          'Opponent disconnected. $remainingSeconds seconds remain for reconnection.',
      child: ColoredBox(
        color: AppColors.background.withValues(alpha: .72),
        child: Center(
          child: Padding(
            padding: const EdgeInsets.all(12),
            child: FlowCard(
              padding: const EdgeInsets.all(12),
              borderColor: AppColors.primaryBright.withValues(alpha: .42),
              color: AppColors.surface.withValues(alpha: .96),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  const Icon(
                    LucideIcons.wifiOff,
                    size: 28,
                    color: AppColors.textSecondary,
                  ),
                  const SizedBox(height: 8),
                  const Text(
                    'OPPONENT DISCONNECTED',
                    textAlign: TextAlign.center,
                    style: TextStyle(
                      fontFamily: 'Sora',
                      fontSize: 14,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                  const SizedBox(height: 4),
                  const Text(
                    'Waiting for reconnection',
                    style: TextStyle(
                      fontFamily: 'Inter',
                      color: AppColors.textSecondary,
                      fontSize: 11,
                    ),
                  ),
                  const SizedBox(height: 8),
                  Container(
                    width: 54,
                    height: 54,
                    alignment: Alignment.center,
                    decoration: BoxDecoration(
                      shape: BoxShape.circle,
                      border: Border.all(
                        color: AppColors.primaryBright,
                        width: 4,
                      ),
                    ),
                    child: Text(
                      '$remainingSeconds',
                      style: const TextStyle(
                        fontFamily: 'Sora',
                        fontSize: 22,
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                  ),
                  const SizedBox(height: 8),
                  const Text(
                    'The server keeps this match open during the reconnect grace period.',
                    textAlign: TextAlign.center,
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
          ),
        ),
      ),
    );
  }
}

class _SettlementPendingOverlay extends StatelessWidget {
  const _SettlementPendingOverlay();

  @override
  Widget build(BuildContext context) {
    return Semantics(
      liveRegion: true,
      label: 'Settlement processing. Waiting for confirmed result.',
      child: ColoredBox(
        color: AppColors.background.withValues(alpha: .82),
        child: Center(
          child: Padding(
            padding: const EdgeInsets.all(24),
            child: FlowCard(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  const SizedBox.square(
                    dimension: 38,
                    child: CircularProgressIndicator(
                      strokeWidth: 3,
                      color: AppColors.valueAccent,
                    ),
                  ),
                  const SizedBox(height: 16),
                  const Text(
                    'SETTLEMENT PROCESSING',
                    style: TextStyle(
                      fontFamily: 'Sora',
                      fontSize: 16,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                  const SizedBox(height: 7),
                  const Text(
                    'Finalising the match result. Your wallet updates only after server confirmation.',
                    textAlign: TextAlign.center,
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
          ),
        ),
      ),
    );
  }
}

class _ClockChip extends StatelessWidget {
  const _ClockChip({required this.label, required this.active});

  final String label;
  final bool active;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 6),
      decoration: BoxDecoration(
        color: AppColors.surface,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(
          color: active ? AppColors.primaryBright : AppColors.border,
        ),
      ),
      child: Text(
        label,
        style: TextStyle(
          fontFamily: 'Inter',
          fontSize: 11,
          fontWeight: FontWeight.w700,
        ),
      ),
    );
  }
}

class _PlayerStrip extends StatelessWidget {
  const _PlayerStrip({
    required this.title,
    required this.subtitle,
    required this.clock,
    required this.accent,
    required this.active,
  });

  final String title;
  final String subtitle;
  final String clock;
  final Color accent;
  final bool active;

  @override
  Widget build(BuildContext context) {
    return Container(
      height: 52,
      margin: const EdgeInsets.symmetric(horizontal: 10),
      padding: const EdgeInsets.symmetric(horizontal: 10),
      decoration: BoxDecoration(
        color: active ? accent.withValues(alpha: .08) : Colors.transparent,
        borderRadius: BorderRadius.circular(10),
      ),
      child: Row(
        children: [
          GameAvatar(size: 34, accent: accent, label: title),
          const SizedBox(width: 8),
          Expanded(
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  title,
                  style: TextStyle(
                    fontFamily: 'Sora',
                    fontSize: 11,
                    fontWeight: FontWeight.w700,
                  ),
                ),
                Text(
                  subtitle,
                  style: TextStyle(
                    fontFamily: 'Inter',
                    color: accent,
                    fontSize: 9,
                  ),
                ),
              ],
            ),
          ),
          _ClockChip(label: clock, active: active),
        ],
      ),
    );
  }
}

class _GameAction extends StatelessWidget {
  const _GameAction({
    required this.icon,
    required this.label,
    required this.onTap,
    this.color = AppColors.primaryBright,
  });

  final IconData icon;
  final String label;
  final VoidCallback onTap;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      button: true,
      label: label,
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(10),
        child: SizedBox(
          width: 72,
          height: 58,
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Icon(icon, color: color, size: 18),
              const SizedBox(height: 4),
              Text(
                label,
                style: TextStyle(
                  fontFamily: 'Inter',
                  color: AppColors.textSecondary,
                  fontSize: 9,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
