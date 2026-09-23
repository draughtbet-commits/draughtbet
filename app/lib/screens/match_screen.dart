export '../widgets/draught_board.dart' show BoardPainter;

import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import '../models/game_state.dart';
import '../models/game_protocol.dart';
import '../models/match_flow.dart';
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

class _MatchScreenState extends ConsumerState<MatchScreen>
    with WidgetsBindingObserver {
  int? _selectedSquare;
  String? _userId;
  StreamSubscription<Map<String, dynamic>>? _errorSubscription;
  Timer? _promotionTimer;
  Timer? _uiTicker;
  final Stopwatch _clockStopwatch = Stopwatch();
  final Stopwatch _disconnectStopwatch = Stopwatch();
  int _clockRevisionSeen = -1;
  int _disconnectSequenceSeen = -1;
  bool _resultOpened = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _uiTicker = Timer.periodic(const Duration(seconds: 1), (_) {
      if (mounted) setState(() {});
    });
    SecureStorageService().userId.then((value) {
      if (mounted) {
        ref.read(matchProvider.notifier).setCurrentUserId(value);
        setState(() => _userId = value);
      }
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
    WidgetsBinding.instance.removeObserver(this);
    _errorSubscription?.cancel();
    _promotionTimer?.cancel();
    _uiTicker?.cancel();
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState lifecycleState) {
    if (lifecycleState == AppLifecycleState.resumed) {
      ref.read(matchProvider.notifier).handleAppResumed(widget.matchId);
    }
  }

  bool _isMyTurn(GameState game, MatchState state) {
    final userId = _userId ?? state.currentUserId;
    if (userId == null) return false;
    final serverTurnUserId = state.serverClock?.currentTurnUserId;
    if (serverTurnUserId != null && serverTurnUserId.isNotEmpty) {
      return serverTurnUserId == userId;
    }
    if (game.currentTurn.toUpperCase() == 'WHITE') {
      return game.player1 == userId;
    }
    return game.player2 == userId;
  }

  void _onSquareTapped(int square) {
    final state = ref.read(matchProvider);
    final game = state.gameState;
    if (game == null || !_isMyTurn(game, state) || state.isMovePending) return;

    if (_selectedSquare != null) {
      final move = game.legalMoves.where(
        (candidate) =>
            candidate.from == _selectedSquare && candidate.to == square,
      );
      if (move.isNotEmpty) {
        final acceptedMove = move.first;
        ref
            .read(matchProvider.notifier)
            .attemptMove(_selectedSquare!, square, path: acceptedMove.path);
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
    final submitted = ref.read(matchProvider.notifier).offerDraw();
    if (!submitted && mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text(
            'Draw offers are unavailable until the match server enables Game Protocol V2.',
          ),
        ),
      );
    }
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
                leading: const Icon(LucideIcons.history),
                title: const Text('Move History'),
                subtitle: const Text('Server-confirmed moves'),
                onTap: () {
                  Navigator.pop(context);
                  GoRouter.maybeOf(
                    context,
                  )?.push('/matches/${widget.matchId}/moves');
                },
              ),
              ListTile(
                leading: const Icon(LucideIcons.bookOpen),
                title: const Text('Game Rules'),
                onTap: () {
                  Navigator.pop(context);
                  ScaffoldMessenger.of(this.context).showSnackBar(
                    const SnackBar(
                      content: Text('Game rules are not available offline.'),
                    ),
                  );
                },
              ),
              ListTile(
                leading: const Icon(LucideIcons.wifi),
                title: const Text('Connection Status'),
                subtitle: Text(
                  ref.read(matchProvider).syncState == MatchSyncState.synced
                      ? 'Match state synced'
                      : 'Match state needs attention',
                ),
              ),
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

  int _remainingReconnectSeconds(MatchState state) {
    final grace = state.opponentGracePeriodMs ?? 60000;
    final remaining = grace - _disconnectStopwatch.elapsedMilliseconds;
    return remaining <= 0 ? 0 : (remaining / 1000).ceil();
  }

  int? _displayRemainingMs(MatchState state) {
    final snapshot = state.serverClock;
    if (snapshot == null || state.syncState != MatchSyncState.synced) {
      return null;
    }
    final remaining =
        snapshot.remainingMs - _clockStopwatch.elapsedMilliseconds;
    return remaining < 0 ? 0 : remaining;
  }

  void _openResult(MatchResultViewData result) {
    if (_resultOpened) return;
    _resultOpened = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      GoRouter.maybeOf(context)?.go('/play/result', extra: result);
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
      if (previous?.opponentDisconnectSequence !=
          next.opponentDisconnectSequence) {
        _disconnectSequenceSeen = next.opponentDisconnectSequence;
        _disconnectStopwatch
          ..reset()
          ..start();
      } else if (next.opponentConnected) {
        _disconnectStopwatch.stop();
      }
      if (previous?.clockRevision != next.clockRevision) {
        _clockRevisionSeen = next.clockRevision;
        _clockStopwatch
          ..reset()
          ..start();
      }
    });
    if (_clockRevisionSeen != state.clockRevision) {
      _clockRevisionSeen = state.clockRevision;
      _clockStopwatch
        ..reset()
        ..start();
    }
    if (!state.opponentConnected &&
        _disconnectSequenceSeen != state.opponentDisconnectSequence) {
      _disconnectSequenceSeen = state.opponentDisconnectSequence;
      _disconnectStopwatch
        ..reset()
        ..start();
    }
    if (state.authoritativeResult != null) {
      _openResult(state.authoritativeResult!);
    }

    final myTurn = game != null && _isMyTurn(game, state);
    final stable = state.syncState == MatchSyncState.synced;
    final displayRemainingMs = _displayRemainingMs(state);
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
            ...(selectedMove.first.path.isNotEmpty
                ? selectedMove.first.path
                : <int>[
                    ...selectedMove.first.capturedSquares,
                    selectedMove.first.to,
                  ]),
          ];
    final mandatoryCapture =
        game?.legalMoves.any((move) => move.capturedSquares.isNotEmpty) ??
        false;

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
            _ClockChip(
              label: myTurn ? '--:--' : _serverClockLabel(displayRemainingMs),
              active: !myTurn,
              urgency: !myTurn ? _clockUrgency(displayRemainingMs) : null,
            ),
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
                              clock: _serverClockLabel(
                                myTurn ? null : displayRemainingMs,
                              ),
                              accent: AppColors.valueAccent,
                              active: !myTurn,
                              urgency: !myTurn
                                  ? _clockUrgency(displayRemainingMs)
                                  : null,
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
                                        if (mandatoryCapture &&
                                            _selectedSquare == null &&
                                            myTurn &&
                                            stable)
                                          const Positioned(
                                            top: 10,
                                            left: 12,
                                            right: 12,
                                            child: _BoardStatusPill(
                                              icon: LucideIcons.crosshair,
                                              label:
                                                  'Capture required · choose a highlighted piece',
                                            ),
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
                                        if (!state.opponentConnected &&
                                            state.recoveryPhase ==
                                                MatchRecoveryPhase.none)
                                          Positioned.fill(
                                            child: _OpponentDisconnectedOverlay(
                                              remainingSeconds:
                                                  _remainingReconnectSeconds(
                                                    state,
                                                  ),
                                            ),
                                          ),
                                        if (stable &&
                                            state.opponentConnected &&
                                            myTurn &&
                                            displayRemainingMs != null &&
                                            displayRemainingMs <= 30000)
                                          Positioned(
                                            left: 12,
                                            right: 12,
                                            bottom: 10,
                                            child: _TimeWarningPill(
                                              remainingMs: displayRemainingMs,
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
                              clock: _serverClockLabel(
                                myTurn ? displayRemainingMs : null,
                              ),
                              accent: AppColors.primaryBright,
                              active: myTurn,
                              urgency: myTurn
                                  ? _clockUrgency(displayRemainingMs)
                                  : null,
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
              if (state.recoveryPhase != MatchRecoveryPhase.none)
                _RecoveryOverlay(
                  phase: state.recoveryPhase,
                  onRetry: ref.read(matchProvider.notifier).retryConnection,
                ),
              if (state.incomingDrawOffer != null)
                _ProtocolDecisionOverlay(
                  icon: LucideIcons.handshake,
                  accent: AppColors.valueAccent,
                  title: 'DRAW OFFER RECEIVED',
                  message:
                      '${state.incomingDrawOffer?.opponentName ?? 'Your opponent'} offered a draw. Accepting ends the match as a draw.',
                  primaryLabel: 'Accept draw',
                  secondaryLabel: 'Decline',
                  onPrimary: () =>
                      ref.read(matchProvider.notifier).respondToDraw(true),
                  onSecondary: () =>
                      ref.read(matchProvider.notifier).respondToDraw(false),
                ),
              if (state.drawOfferRejected)
                _ProtocolDecisionOverlay(
                  icon: LucideIcons.circleX,
                  accent: AppColors.danger,
                  title: 'DRAW OFFER REJECTED',
                  message:
                      'Your opponent declined the draw offer. The match continues.',
                  primaryLabel: 'Keep playing',
                  onPrimary: ref.read(matchProvider.notifier).clearDrawRejected,
                ),
              if (state.moveRejection != null || state.rejectionReason != null)
                _MoveRejectedOverlay(
                  rejection:
                      state.moveRejection ??
                      MoveRejection.fromServer({'code': state.rejectionReason}),
                  onDismiss: ref.read(matchProvider.notifier).clearRejection,
                ),
            ],
          ),
        ),
      ),
    );
  }
}

class _BoardStatusPill extends StatelessWidget {
  const _BoardStatusPill({required this.icon, required this.label});

  final IconData icon;
  final String label;

  @override
  Widget build(BuildContext context) {
    return DecoratedBox(
      decoration: BoxDecoration(
        color: AppColors.surface.withValues(alpha: .94),
        borderRadius: BorderRadius.circular(22),
        border: Border.all(color: AppColors.valueAccent),
      ),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
        child: Row(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(icon, size: 14, color: AppColors.valueAccent),
            const SizedBox(width: 7),
            Flexible(
              child: Text(
                label,
                textAlign: TextAlign.center,
                style: const TextStyle(
                  fontFamily: 'Inter',
                  fontSize: 10,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _MoveRejectedOverlay extends StatelessWidget {
  const _MoveRejectedOverlay({
    required this.rejection,
    required this.onDismiss,
  });

  final MoveRejection rejection;
  final VoidCallback onDismiss;

  @override
  Widget build(BuildContext context) {
    return _ProtocolDecisionOverlay(
      icon: rejection.code == GameRejectionCode.stateVersionConflict
          ? LucideIcons.refreshCw
          : LucideIcons.circleX,
      accent: rejection.code == GameRejectionCode.stateVersionConflict
          ? AppColors.valueAccent
          : AppColors.danger,
      title: rejection.title,
      message: rejection.message,
      primaryLabel: rejection.requiresResync
          ? 'Continue'
          : 'Choose another move',
      onPrimary: onDismiss,
    );
  }
}

class _ProtocolDecisionOverlay extends StatelessWidget {
  const _ProtocolDecisionOverlay({
    required this.icon,
    required this.accent,
    required this.title,
    required this.message,
    required this.primaryLabel,
    required this.onPrimary,
    this.secondaryLabel,
    this.onSecondary,
  });

  final IconData icon;
  final Color accent;
  final String title;
  final String message;
  final String primaryLabel;
  final VoidCallback onPrimary;
  final String? secondaryLabel;
  final VoidCallback? onSecondary;

  @override
  Widget build(BuildContext context) {
    return ColoredBox(
      color: AppColors.background.withValues(alpha: .74),
      child: Center(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(28),
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 360),
            child: FlowCard(
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
                      fontSize: 18,
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
                  const SizedBox(height: 18),
                  PrimaryActionButton(
                    label: primaryLabel,
                    onPressed: onPrimary,
                  ),
                  if (secondaryLabel != null && onSecondary != null) ...[
                    const SizedBox(height: 8),
                    SecondaryActionButton(
                      label: secondaryLabel!,
                      onPressed: onSecondary!,
                    ),
                  ],
                ],
              ),
            ),
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
      label: remainingSeconds > 0
          ? 'Opponent disconnected. $remainingSeconds seconds remain for reconnection.'
          : 'Opponent disconnected. Awaiting the server decision.',
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
                      remainingSeconds > 0 ? '$remainingSeconds' : '…',
                      style: const TextStyle(
                        fontFamily: 'Sora',
                        fontSize: 22,
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                  ),
                  const SizedBox(height: 8),
                  Text(
                    remainingSeconds > 0
                        ? 'Your opponent disconnected. The server keeps this match open during the reconnect grace period.'
                        : 'Grace period elapsed. Waiting for the server to confirm the match outcome.',
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

class _RecoveryOverlay extends StatelessWidget {
  const _RecoveryOverlay({required this.phase, required this.onRetry});

  final MatchRecoveryPhase phase;
  final Future<void> Function() onRetry;

  @override
  Widget build(BuildContext context) {
    final (icon, title, message, spinning) = switch (phase) {
      MatchRecoveryPhase.connectionLost => (
        LucideIcons.wifiOff,
        'CONNECTION LOST',
        'Moves are paused. Reconnect before continuing this match.',
        false,
      ),
      MatchRecoveryPhase.reconnecting => (
        LucideIcons.refreshCw,
        'RECONNECTING',
        'Restoring the secure game connection.',
        true,
      ),
      MatchRecoveryPhase.appResumed => (
        LucideIcons.smartphone,
        'APP RESUMED',
        'Checking the authoritative match state before play continues.',
        true,
      ),
      MatchRecoveryPhase.resyncing => (
        LucideIcons.shieldCheck,
        'CHECKING MATCH STATE',
        'Waiting for the latest board and server clock.',
        true,
      ),
      MatchRecoveryPhase.none => (LucideIcons.wifi, '', '', false),
    };
    if (phase == MatchRecoveryPhase.none) return const SizedBox.shrink();
    return Semantics(
      liveRegion: true,
      label: '$title. $message',
      child: ColoredBox(
        color: AppColors.background.withValues(alpha: .82),
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(28),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 340),
              child: FlowCard(
                borderColor: AppColors.primaryBright.withValues(alpha: .42),
                color: AppColors.surface.withValues(alpha: .98),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    if (spinning)
                      const SizedBox.square(
                        dimension: 42,
                        child: CircularProgressIndicator(
                          strokeWidth: 3,
                          color: AppColors.primaryBright,
                        ),
                      )
                    else
                      Icon(icon, size: 42, color: AppColors.textSecondary),
                    const SizedBox(height: 16),
                    Text(
                      title,
                      textAlign: TextAlign.center,
                      style: const TextStyle(
                        fontFamily: 'Sora',
                        fontSize: 18,
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
                        fontSize: 11,
                        height: 1.4,
                      ),
                    ),
                    if (phase == MatchRecoveryPhase.connectionLost) ...[
                      const SizedBox(height: 18),
                      PrimaryActionButton(
                        label: 'Retry connection',
                        icon: LucideIcons.refreshCw,
                        onPressed: onRetry,
                      ),
                    ],
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

enum _ClockUrgency { low, imminent, awaitingServer }

_ClockUrgency? _clockUrgency(int? remainingMs) {
  if (remainingMs == null || remainingMs > 30000) return null;
  if (remainingMs == 0) return _ClockUrgency.awaitingServer;
  if (remainingMs <= 10000) return _ClockUrgency.imminent;
  return _ClockUrgency.low;
}

class _TimeWarningPill extends StatelessWidget {
  const _TimeWarningPill({required this.remainingMs});

  final int remainingMs;

  @override
  Widget build(BuildContext context) {
    final urgency = _clockUrgency(remainingMs)!;
    final critical = urgency != _ClockUrgency.low;
    final label = switch (urgency) {
      _ClockUrgency.low => 'LOW TIME · ${_serverClockLabel(remainingMs)}',
      _ClockUrgency.imminent =>
        'TIMEOUT IMMINENT · ${_serverClockLabel(remainingMs)}',
      _ClockUrgency.awaitingServer => 'AWAITING SERVER RESULT',
    };
    return Semantics(
      liveRegion: true,
      label: label,
      child: DecoratedBox(
        decoration: BoxDecoration(
          color: AppColors.surface.withValues(alpha: .96),
          borderRadius: BorderRadius.circular(22),
          border: Border.all(
            color: critical ? AppColors.danger : AppColors.valueAccent,
          ),
        ),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
          child: Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Icon(
                LucideIcons.clockAlert,
                size: 15,
                color: critical ? AppColors.danger : AppColors.valueAccent,
              ),
              const SizedBox(width: 7),
              Flexible(
                child: Text(
                  label,
                  textAlign: TextAlign.center,
                  style: TextStyle(
                    fontFamily: 'Inter',
                    color: critical ? AppColors.danger : AppColors.valueAccent,
                    fontSize: 10,
                    fontWeight: FontWeight.w700,
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
  const _ClockChip({required this.label, required this.active, this.urgency});

  final String label;
  final bool active;
  final _ClockUrgency? urgency;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 6),
      decoration: BoxDecoration(
        color: AppColors.surface,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(
          color: switch (urgency) {
            _ClockUrgency.imminent ||
            _ClockUrgency.awaitingServer => AppColors.danger,
            _ClockUrgency.low => AppColors.valueAccent,
            null => active ? AppColors.primaryBright : AppColors.border,
          },
        ),
      ),
      child: Text(
        label,
        style: TextStyle(
          fontFamily: 'Inter',
          fontSize: 11,
          fontWeight: FontWeight.w700,
          color: switch (urgency) {
            _ClockUrgency.imminent ||
            _ClockUrgency.awaitingServer => AppColors.danger,
            _ClockUrgency.low => AppColors.valueAccent,
            null => AppColors.textPrimary,
          },
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
    this.urgency,
  });

  final String title;
  final String subtitle;
  final String clock;
  final Color accent;
  final bool active;
  final _ClockUrgency? urgency;

  @override
  Widget build(BuildContext context) {
    return Container(
      height: 52,
      margin: const EdgeInsets.symmetric(horizontal: 10),
      padding: const EdgeInsets.symmetric(horizontal: 10),
      decoration: BoxDecoration(
        color: active ? accent.withValues(alpha: .08) : AppColors.transparent,
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
          _ClockChip(label: clock, active: active, urgency: urgency),
        ],
      ),
    );
  }
}

String _serverClockLabel(int? milliseconds) {
  if (milliseconds == null || milliseconds < 0) return '--:--';
  final totalSeconds = milliseconds ~/ 1000;
  final minutes = totalSeconds ~/ 60;
  final seconds = totalSeconds % 60;
  return '${minutes.toString().padLeft(2, '0')}:${seconds.toString().padLeft(2, '0')}';
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
