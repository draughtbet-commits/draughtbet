import 'package:draughts_arena/models/piece.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('piece encoding', () {
    // The server sends unsigned codes: 1/2 white, 3/4 black. Reading the sign as
    // the colour painted all 40 pieces green and dropped the black king crown,
    // which is what both players were seeing.
    test('black pieces are not mistaken for white', () {
      expect(Piece.isLight(Piece.blackMan), isFalse);
      expect(Piece.isLight(Piece.blackKing), isFalse);
      expect(Piece.isDark(Piece.blackMan), isTrue);
      expect(Piece.isDark(Piece.blackKing), isTrue);
    });

    test('white pieces are not mistaken for black', () {
      expect(Piece.isLight(Piece.whiteMan), isTrue);
      expect(Piece.isLight(Piece.whiteKing), isTrue);
      expect(Piece.isDark(Piece.whiteMan), isFalse);
      expect(Piece.isDark(Piece.whiteKing), isFalse);
    });

    test('both kings are recognised as kings', () {
      expect(Piece.isKing(Piece.whiteKing), isTrue);
      expect(Piece.isKing(Piece.blackKing), isTrue);
      expect(Piece.isKing(Piece.whiteMan), isFalse);
      expect(Piece.isKing(Piece.blackMan), isFalse);
    });

    test('empty squares are empty and unranked', () {
      expect(Piece.isEmpty(Piece.empty), isTrue);
      expect(Piece.isLight(Piece.empty), isFalse);
      expect(Piece.isDark(Piece.empty), isFalse);
      expect(Piece.isKing(Piece.empty), isFalse);
    });

    test('every code the engine can emit is classified', () {
      for (var code = 0; code <= 4; code++) {
        expect(
          Piece.isValid(code),
          isTrue,
          reason: 'code $code should be a valid piece',
        );
      }
    });

    test('a starting board classifies exactly 20 light and 20 dark pieces', () {
      final board = List<int>.filled(50, 0);
      for (var square = 1; square <= 20; square++) {
        board[square - 1] = Piece.blackMan;
      }
      for (var square = 31; square <= 50; square++) {
        board[square - 1] = Piece.whiteMan;
      }
      expect(board.where(Piece.isLight).length, 20);
      expect(board.where(Piece.isDark).length, 20);
      expect(board.where(Piece.isEmpty).length, 10);
    });
  });
}