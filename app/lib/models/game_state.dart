import 'package:freezed_annotation/freezed_annotation.dart';

part 'game_state.freezed.dart';
part 'game_state.g.dart';

@freezed
class GameState with _$GameState {
  const factory GameState({
    required List<int> board,
    required String currentTurn,
    required String player1,
    required String player2,
    required String status,
    required int moveCount,
    required int consecutiveKingMoves,
    @Default([]) List<LegalMove> legalMoves,
    String? winnerId,
  }) = _GameState;

  factory GameState.fromJson(Map<String, dynamic> json) => _$GameStateFromJson(json);
}

@freezed
class LegalMove with _$LegalMove {
  const factory LegalMove({
    required int from,
    required int to,
    @Default([]) List<int> capturedSquares,
    @Default(false) bool promoted,
  }) = _LegalMove;

  factory LegalMove.fromJson(Map<String, dynamic> json) => _$LegalMoveFromJson(json);
}

@freezed
class MoveAppliedEvent with _$MoveAppliedEvent {
  const factory MoveAppliedEvent({
    required int from,
    required int to,
    required List<int> board,
    @Default([]) List<int> captured,
    @Default(false) bool promoted,
    required String nextTurn,
    required bool gameEnded,
    String? reason,
    @Default([]) List<LegalMove> legalMoves,
  }) = _MoveAppliedEvent;

  factory MoveAppliedEvent.fromJson(Map<String, dynamic> json) => _$MoveAppliedEventFromJson(json);
}
