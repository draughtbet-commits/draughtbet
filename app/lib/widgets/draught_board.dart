import 'dart:math' as math;
import 'package:flutter/material.dart';
import '../models/game_state.dart';
import '../theme/colors.dart';

class DraughtBoard extends StatelessWidget {
  const DraughtBoard({
    super.key,
    required this.board,
    required this.legalMoves,
    required this.selectedSquare,
    required this.onSquareTapped,
    this.inputEnabled = true,
    this.capturePath = const [],
  });

  final List<int> board;
  final List<LegalMove> legalMoves;
  final int? selectedSquare;
  final ValueChanged<int> onSquareTapped;
  final bool inputEnabled;
  final List<int> capturePath;

  @override
  Widget build(BuildContext context) {
    final legalDestinations = selectedSquare == null
        ? const <int>[]
        : legalMoves
              .where((move) => move.from == selectedSquare)
              .map((move) => move.to)
              .toList(growable: false);
    return Semantics(
      label:
          'International draughts board. ${board.where((piece) => piece != 0).length} pieces remain.',
      enabled: inputEnabled,
      child: AspectRatio(
        aspectRatio: 1,
        child: LayoutBuilder(
          builder: (context, constraints) {
            return GestureDetector(
              behavior: HitTestBehavior.opaque,
              onTapUp: inputEnabled
                  ? (details) {
                      final squareSize = constraints.maxWidth / 10;
                      final col = (details.localPosition.dx / squareSize)
                          .floor();
                      final row = (details.localPosition.dy / squareSize)
                          .floor();
                      if (row < 0 || row > 9 || col < 0 || col > 9) return;
                      if ((row + col).isOdd) {
                        onSquareTapped((row * 5) + (col ~/ 2) + 1);
                      }
                    }
                  : null,
              child: CustomPaint(
                painter: BoardPainter(
                  board: board,
                  selectedSquare: selectedSquare,
                  legalMoves: legalMoves,
                  capturePath: capturePath,
                ),
                child: Stack(
                  children: [
                    for (final square in legalDestinations)
                      _LegalMoveSemantics(
                        square: square,
                        boardSize: constraints.maxWidth,
                        onTap: inputEnabled
                            ? () => onSquareTapped(square)
                            : null,
                      ),
                  ],
                ),
              ),
            );
          },
        ),
      ),
    );
  }
}

class _LegalMoveSemantics extends StatelessWidget {
  const _LegalMoveSemantics({
    required this.square,
    required this.boardSize,
    required this.onTap,
  });

  final int square;
  final double boardSize;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final zero = square - 1;
    final row = zero ~/ 5;
    final indexInRow = zero % 5;
    final col = row.isEven ? indexInRow * 2 + 1 : indexInRow * 2;
    final squareSize = boardSize / 10;
    return Positioned(
      left: col * squareSize,
      top: row * squareSize,
      width: squareSize,
      height: squareSize,
      child: Semantics(
        button: true,
        label: 'Move to square $square, row ${row + 1}, column ${col + 1}',
        onTap: onTap,
        child: const SizedBox.expand(),
      ),
    );
  }
}

class BoardPainter extends CustomPainter {
  const BoardPainter({
    required this.board,
    required this.selectedSquare,
    required this.legalMoves,
    this.capturePath = const [],
  });

  final List<int> board;
  final int? selectedSquare;
  final List<LegalMove> legalMoves;
  final List<int> capturePath;

  Offset _centerForSquare(int square, double size) {
    final zero = square - 1;
    final row = zero ~/ 5;
    final index = zero % 5;
    final col = row.isEven ? index * 2 + 1 : index * 2;
    return Offset((col + .5) * size, (row + .5) * size);
  }

  @override
  void paint(Canvas canvas, Size size) {
    final square = size.width / 10;
    final boardBounds = Offset.zero & size;
    canvas.drawRRect(
      RRect.fromRectAndRadius(boardBounds, const Radius.circular(7)),
      Paint()..color = AppColors.valueAccent,
    );
    canvas.save();
    canvas.clipRRect(
      RRect.fromRectAndRadius(boardBounds.deflate(2), const Radius.circular(6)),
    );

    for (var row = 0; row < 10; row++) {
      for (var col = 0; col < 10; col++) {
        final rect = Rect.fromLTWH(
          col * square,
          row * square,
          square + .5,
          square + .5,
        );
        canvas.drawRect(
          rect,
          Paint()
            ..color = (row + col).isOdd
                ? AppColors.boardDark
                : AppColors.boardLight,
        );
      }
    }

    if (capturePath.length > 1) {
      final path = Path()
        ..moveTo(
          _centerForSquare(capturePath.first, square).dx,
          _centerForSquare(capturePath.first, square).dy,
        );
      for (final point in capturePath.skip(1)) {
        final center = _centerForSquare(point, square);
        path.lineTo(center.dx, center.dy);
      }
      canvas.drawPath(
        path,
        Paint()
          ..color = AppColors.valueAccent.withValues(alpha: .86)
          ..style = PaintingStyle.stroke
          ..strokeWidth = math.max(2, square * .09)
          ..strokeCap = StrokeCap.round,
      );
    }

    for (var index = 1; index <= math.min(50, board.length); index++) {
      final piece = board[index - 1];
      final center = _centerForSquare(index, square);
      final selected = selectedSquare == index;
      final legalDestination =
          selectedSquare != null &&
          legalMoves.any(
            (move) => move.from == selectedSquare && move.to == index,
          );

      if (legalDestination) {
        canvas.drawCircle(
          center,
          square * .22,
          Paint()
            ..color = AppColors.primaryBright.withValues(alpha: .28)
            ..style = PaintingStyle.fill,
        );
        canvas.drawCircle(
          center,
          square * .13,
          Paint()
            ..color = AppColors.textPrimary
            ..style = PaintingStyle.stroke
            ..strokeWidth = 1.5,
        );
      }
      if (piece == 0) continue;

      final isLight = piece > 0;
      final pieceColor = isLight ? AppColors.pieceLight : AppColors.pieceDark;
      canvas.drawCircle(
        center.translate(0, square * .05),
        square * .38,
        Paint()..color = Colors.black.withValues(alpha: .35),
      );
      canvas.drawCircle(center, square * .38, Paint()..color = pieceColor);
      canvas.drawCircle(
        center,
        square * .29,
        Paint()
          ..color = isLight
              ? AppColors.primaryBright.withValues(alpha: .35)
              : AppColors.textSecondary.withValues(alpha: .16)
          ..style = PaintingStyle.stroke
          ..strokeWidth = math.max(1, square * .055),
      );

      if (piece.abs() == 2) {
        canvas.drawCircle(
          center,
          square * .17,
          Paint()
            ..color = AppColors.valueAccent
            ..style = PaintingStyle.stroke
            ..strokeWidth = math.max(2, square * .07),
        );
      }
      if (selected) {
        canvas.drawCircle(
          center,
          square * .46,
          Paint()
            ..color = AppColors.primaryBright
            ..style = PaintingStyle.stroke
            ..strokeWidth = math.max(2, square * .08),
        );
      }
    }
    canvas.restore();
  }

  @override
  bool shouldRepaint(covariant BoardPainter oldDelegate) {
    return oldDelegate.board != board ||
        oldDelegate.selectedSquare != selectedSquare ||
        oldDelegate.legalMoves != legalMoves ||
        oldDelegate.capturePath != capturePath;
  }
}
