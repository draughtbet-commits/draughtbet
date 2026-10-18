import 'dart:ui';

import 'package:draughts_arena/models/game_state.dart';
import 'package:draughts_arena/models/piece.dart';
import 'package:draughts_arena/theme/colors.dart';
import 'package:draughts_arena/widgets/draught_board.dart';
import 'package:flutter_test/flutter_test.dart';

class _DrawnCircle {
  const _DrawnCircle(this.center, this.radius, this.color);

  final Offset center;
  final double radius;
  final Color color;
}

class _RecordingCanvas implements Canvas {
  final circles = <_DrawnCircle>[];

  @override
  void drawCircle(Offset c, double radius, Paint paint) {
    circles.add(_DrawnCircle(c, radius, paint.color));
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => null;
}

Offset _centerForSquare(int square, double size) {
  final zero = square - 1;
  final row = zero ~/ 5;
  final index = zero % 5;
  final col = row.isEven ? index * 2 + 1 : index * 2;
  return Offset((col + .5) * size, (row + .5) * size);
}

void main() {
  const boardSize = Size(400, 400);
  const square = 40.0;

  BoardPainter painter({
    required bool interactive,
    required List<LegalMove> moves,
    required List<int> board,
    int? selectedSquare,
  }) {
    return BoardPainter(
      board: board,
      selectedSquare: selectedSquare,
      legalMoves: moves,
      interactive: interactive,
    );
  }

  group('BoardPainter movable-piece highlighting', () {
    test('rings capturable pieces with the capture accent when interactive', () {
      final canvas = _RecordingCanvas();
      painter(
        interactive: true,
        moves: const [LegalMove(from: 33, to: 22, capturedSquares: [28])],
        board: List<int>.generate(50, (i) => i == 32 ? Piece.whiteMan : 0),
      ).paint(canvas, boardSize);

      final ring = canvas.circles.where(
        (circle) => (circle.radius - square * .44).abs() < .001,
      );
      expect(ring, hasLength(1));
      expect(ring.single.center, _centerForSquare(33, square));
      expect(ring.single.color.toARGB32(), AppColors.valueAccent.toARGB32());
    });

    test('highlights free-moving pieces in the primary accent', () {
      final board = List<int>.filled(50, 0);
      board[32] = Piece.whiteMan;
      final canvas = _RecordingCanvas();
      painter(
        interactive: true,
        moves: const [LegalMove(from: 33, to: 28)],
        board: board,
      ).paint(canvas, boardSize);

      final ring = canvas.circles.where(
        (c) => (c.radius - square * .44).abs() < .001,
      );
      expect(ring, hasLength(1));
      expect(ring.single.color.toARGB32(), AppColors.primaryBright.toARGB32());
    });

    test('draws no moveable highlight while it is not the clients turn', () {
      final board = List<int>.filled(50, 0);
      board[32] = Piece.whiteMan;
      final canvas = _RecordingCanvas();
      painter(
        interactive: false,
        moves: const [LegalMove(from: 33, to: 22, capturedSquares: [28])],
        board: board,
      ).paint(canvas, boardSize);

      expect(
        canvas.circles.where((c) => (c.radius - square * .44).abs() < .001),
        isEmpty,
      );
    });

    test('repaints when interactivity flips', () {
      final board = List<int>.filled(50, 0);
      final moves = const [LegalMove(from: 33, to: 28)];
      final above = BoardPainter(
        board: board,
        selectedSquare: null,
        legalMoves: moves,
        interactive: true,
      );
      final below = BoardPainter(
        board: board,
        selectedSquare: null,
        legalMoves: moves,
        interactive: false,
      );
      expect(above.shouldRepaint(below), isTrue);
      expect(below.shouldRepaint(above), isTrue);
    });
  });
}
