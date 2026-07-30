import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'dart:async';
import '../providers/match_provider.dart';
import '../models/game_state.dart';
import '../services/socket_service.dart';
import '../theme/colors.dart';

class MatchScreen extends ConsumerStatefulWidget {
  final String matchId;
  const MatchScreen({Key? key, required this.matchId}) : super(key: key);

  @override
  ConsumerState<MatchScreen> createState() => _MatchScreenState();
}

class _MatchScreenState extends ConsumerState<MatchScreen> {
  int? selectedSquare; // 1-indexed to match backend
  StreamSubscription? _errorSub;

  @override
  void initState() {
    super.initState();
    // Fetch initial state if not already loaded (e.g., from deep link)
    WidgetsBinding.instance.addPostFrameCallback((_) {
      ref.read(matchProvider.notifier).fetchGameState(widget.matchId);
    });

    // Global error listener for dead-end socket errors
    _errorSub = socketService.onError.listen((data) {
      if (!mounted) return;
      final message = (data['message'] as String?) ?? 'An error occurred';
      
      // If the error means our local state is stale (e.g. game ended while we were disconnected)
      if (message.toLowerCase().contains('already ended') || message.toLowerCase().contains('not found')) {
        ref.read(matchProvider.notifier).fetchGameState(widget.matchId);
        return;
      }
      
      // Apply voice rules: no exclamation marks, add actionable "Try again" if it's a failure
      String displayMsg = message.replaceAll('!', '');
      if (displayMsg.toLowerCase().contains('failed') || displayMsg.toLowerCase().contains('busy')) {
        if (!displayMsg.endsWith('.')) displayMsg += '.';
        displayMsg += ' Try again.';
      }

      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(displayMsg, style: const TextStyle(color: AppColors.textPrimary, fontFamily: 'Manrope')),
          backgroundColor: AppColors.surface2,
          behavior: SnackBarBehavior.floating,
          duration: const Duration(seconds: 4),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
        ),
      );
    });
  }

  @override
  void dispose() {
    _errorSub?.cancel();
    super.dispose();
  }

  void _onSquareTapped(int index) {
    final matchState = ref.read(matchProvider);
    if (matchState.gameState == null || matchState.gameState!.status != 'in_progress') return;

    final board = matchState.gameState!.board;
    final piece = board[index - 1];
    final legalMoves = matchState.gameState!.legalMoves;

    // TODO: Determine if it is our turn (need to know local user's color)
    // For now, allow selection if it has legal moves.
    
    if (selectedSquare != null) {
      // If we tapped a valid destination for the selected piece
      final validMove = legalMoves.where((m) => m.from == selectedSquare && m.to == index).isNotEmpty;
      if (validMove) {
        ref.read(matchProvider.notifier).attemptMove(selectedSquare!, index);
        setState(() {
          selectedSquare = null;
        });
        return;
      }
    }

    // Otherwise, select the piece if it belongs to us and has legal moves (or just select it)
    if (piece != 0) {
      setState(() {
        selectedSquare = index;
      });
    } else {
      setState(() {
        selectedSquare = null;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final matchState = ref.watch(matchProvider);
    final gameState = matchState.gameState;

    return Scaffold(
      backgroundColor: AppColors.voidBg, // Void background
      appBar: AppBar(
        title: const Text('Match'),
        backgroundColor: AppColors.voidBg,
        actions: [
          IconButton(
            icon: const Icon(LucideIcons.flag),
            onPressed: () {
              ref.read(matchProvider.notifier).resign();
            },
          )
        ],
      ),
      body: Stack(
        children: [
          if (gameState == null)
            const Center(child: CircularProgressIndicator())
          else
            Column(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                // Opponent tray
                const Padding(
                  padding: EdgeInsets.all(16.0),
                  child: Text('Opponent', style: TextStyle(color: AppColors.textMain, fontSize: 18)),
                ),
                
                // Board
                Expanded(
                  child: Center(
                    child: AspectRatio(
                      aspectRatio: 1,
                      child: GestureDetector(
                        onTapUp: (details) {
                          RenderBox box = context.findRenderObject() as RenderBox;
                          // The gesture detector gives us local position, we need to map to 10x10 grid.
                          // However, the gesture detector is wrapping the AspectRatio. 
                          // It's better to wrap a LayoutBuilder inside to get accurate sizes.
                        },
                        child: LayoutBuilder(
                          builder: (context, constraints) {
                            return GestureDetector(
                              onTapUp: (details) {
                                double squareSize = constraints.maxWidth / 10;
                                int col = (details.localPosition.dx / squareSize).floor();
                                int row = (details.localPosition.dy / squareSize).floor();
                                // International draughts boards are usually 10x10.
                                // Playable squares are dark squares.
                                if ((row + col) % 2 != 0) {
                                  // Map (row, col) to 1-50 index.
                                  int index = (row * 5) + (col ~/ 2) + 1;
                                  _onSquareTapped(index);
                                }
                              },
                              child: CustomPaint(
                                size: Size(constraints.maxWidth, constraints.maxWidth),
                                painter: BoardPainter(
                                  board: gameState.board,
                                  selectedSquare: selectedSquare,
                                  legalMoves: gameState.legalMoves,
                                ),
                              ),
                            );
                          }
                        ),
                      ),
                    ),
                  ),
                ),
                
                // Player tray
                const Padding(
                  padding: EdgeInsets.all(16.0),
                  child: Text('You', style: TextStyle(color: AppColors.textMain, fontSize: 18)),
                ),
              ],
            ),

          // Syncing Overlay
          if (matchState.syncState == MatchSyncState.syncing)
            Container(
              color: AppColors.voidBg.withOpacity(0.54),
              child: const Center(
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    CircularProgressIndicator(color: AppColors.info), // Neutral info blue instead of gold
                    SizedBox(height: 16),
                    Text('Syncing...', style: TextStyle(color: AppColors.textPrimary, fontFamily: 'Manrope')),
                  ],
                ),
              ),
            ),
            
          // Win/Loss Overlay
          if (gameState != null && gameState.status == 'completed')
            Container(
              color: AppColors.voidBg.withOpacity(0.87),
              child: Center(
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    // Win vs Loss formatting
                    // For MVP we don't have the winnerId vs userId yet here easily, but we'll use text-primary 
                    // and only apply gold if we know they won. Assuming generic for now unless extended.
                    const Text('Match Ended', style: TextStyle(color: AppColors.textPrimary, fontFamily: 'Fraunces', fontSize: 32, fontWeight: FontWeight.bold)),
                    const SizedBox(height: 20),
                    ElevatedButton(
                      style: ElevatedButton.styleFrom(backgroundColor: AppColors.surface1), // Use ghost/neutral instead of gold
                      onPressed: () {
                        context.go('/home');
                      },
                      child: const Text('Return to Home', style: TextStyle(color: AppColors.textPrimary, fontFamily: 'Manrope')),
                    )
                  ],
                ),
              ),
            ),
        ],
      ),
    );
  }
}

class BoardPainter extends CustomPainter {
  final List<int> board;
  final int? selectedSquare;
  final List<LegalMove> legalMoves;

  BoardPainter({
    required this.board,
    required this.selectedSquare,
    required this.legalMoves,
  });

  @override
  void paint(Canvas canvas, Size size) {
    final double squareSize = size.width / 10;
    
    final Paint lightSquarePaint = Paint()..color = AppColors.boardLight;
    final Paint darkSquarePaint = Paint()..color = AppColors.boardDark;
    final Paint highlightPaint = Paint()..color = AppColors.legalMoveHighlight;
    final Paint whitePiecePaint = Paint()..color = AppColors.pieceLight;
    final Paint blackPiecePaint = Paint()..color = AppColors.pieceDark;

    // Draw Board
    for (int row = 0; row < 10; row++) {
      for (int col = 0; col < 10; col++) {
        bool isDark = (row + col) % 2 != 0;
        final rect = Rect.fromLTWH(col * squareSize, row * squareSize, squareSize, squareSize);
        canvas.drawRect(rect, isDark ? darkSquarePaint : lightSquarePaint);
        
        if (isDark) {
          int index = (row * 5) + (col ~/ 2) + 1;
          
          // Draw Highlight for legal moves
          if (selectedSquare != null) {
            bool isLegalDest = legalMoves.any((m) => m.from == selectedSquare && m.to == index);
            if (isLegalDest) {
              canvas.drawRect(rect, highlightPaint);
            }
          }

          // Draw Piece
          int piece = board[index - 1];
          if (piece != 0) {
            canvas.drawCircle(
              Offset(col * squareSize + squareSize / 2, row * squareSize + squareSize / 2),
              squareSize * 0.4,
              piece > 0 ? whitePiecePaint : blackPiecePaint,
            );
            
            // Draw King Crown
            if (piece.abs() == 2) {
              final Paint crownPaint = Paint()..color = AppColors.gold500; // Gold crown allowed
              canvas.drawCircle(
                Offset(col * squareSize + squareSize / 2, row * squareSize + squareSize / 2),
                squareSize * 0.15,
                crownPaint,
              );
            }
            
            // Draw selection ring
            if (selectedSquare == index) {
              final Paint selectionPaint = Paint()
                ..color = AppColors.textPrimary
                ..style = PaintingStyle.stroke
                ..strokeWidth = 3;
              canvas.drawCircle(
                Offset(col * squareSize + squareSize / 2, row * squareSize + squareSize / 2),
                squareSize * 0.45,
                selectionPaint,
              );
            }
          }
        }
      }
    }
  }

  @override
  bool shouldRepaint(covariant BoardPainter oldDelegate) {
    return oldDelegate.board != board || 
           oldDelegate.selectedSquare != selectedSquare ||
           oldDelegate.legalMoves != legalMoves;
  }
}
