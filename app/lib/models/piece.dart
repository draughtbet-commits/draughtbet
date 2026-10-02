/// Square encoding shared with the server engine.
///
/// The wire format is unsigned, NOT signed: `0` empty, `1` white man, `2` white
/// king, `3` black man, `4` black king. Treating the value's sign as the colour
/// renders every piece as white and never draws a black king's crown, so all
/// colour and rank questions must go through these helpers.
abstract final class Piece {
  static const int empty = 0;
  static const int whiteMan = 1;
  static const int whiteKing = 2;
  static const int blackMan = 3;
  static const int blackKing = 4;

  static bool isEmpty(int piece) => piece == empty;

  /// True for white pieces (1 and 2). Black is 3 and 4, not a negative number.
  static bool isLight(int piece) => piece == whiteMan || piece == whiteKing;

  static bool isDark(int piece) => piece == blackMan || piece == blackKing;

  /// True for either king. Covers both 2 and 4.
  static bool isKing(int piece) => piece == whiteKing || piece == blackKing;

  static bool isValid(int piece) => piece >= empty && piece <= blackKing;
}