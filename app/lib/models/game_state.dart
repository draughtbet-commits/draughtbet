import 'package:freezed_annotation/freezed_annotation.dart';

part 'game_state.freezed.dart';
part 'game_state.g.dart';

@freezed
abstract class GameState with _$GameState {
  const factory GameState({
    required List<int> board,
    required String currentTurn,
    required String player1,
    required String player2,
    required String status,
    required int moveCount,
    required int consecutiveKingMoves,
    @Default(1) int protocolVersion,
    @Default(0) int stateVersion,
    @Default([]) List<LegalMove> legalMoves,
    @Default([]) List<AcceptedGameMove> moveHistory,
    String? winnerId,
  }) = _GameState;

  factory GameState.fromJson(Map<String, dynamic> json) =>
      _$GameStateFromJson(_normalizeGameState(json));
}

@freezed
abstract class LegalMove with _$LegalMove {
  const factory LegalMove({
    required int from,
    required int to,
    @Default([]) List<int> path,
    @Default([]) List<int> capturedSquares,
    @Default(false) bool promoted,
  }) = _LegalMove;

  factory LegalMove.fromJson(Map<String, dynamic> json) =>
      _$LegalMoveFromJson(_normalizeLegalMove(json));
}

@freezed
abstract class AcceptedGameMove with _$AcceptedGameMove {
  const factory AcceptedGameMove({
    @Default(0) int sequence,
    @Default('') String clientMoveId,
    required int from,
    @Default([]) List<int> path,
    @Default([]) List<int> capturedSquares,
    @Default(false) bool promoted,
    @Default(0) int stateVersion,
    String? side,
  }) = _AcceptedGameMove;

  factory AcceptedGameMove.fromJson(Map<String, dynamic> json) =>
      _$AcceptedGameMoveFromJson(_normalizeAcceptedMove(json));
}

@freezed
abstract class MoveAppliedEvent with _$MoveAppliedEvent {
  const factory MoveAppliedEvent({
    required int from,
    required int to,
    @Default([]) List<int> path,
    @Default([]) List<int> board,
    @Default([]) List<int> captured,
    @Default(false) bool promoted,
    @Default('') String nextTurn,
    @Default(false) bool gameEnded,
    String? clientMoveId,
    int? stateVersion,
    String? reason,
    @Default([]) List<LegalMove> legalMoves,
  }) = _MoveAppliedEvent;

  factory MoveAppliedEvent.fromJson(Map<String, dynamic> json) =>
      _$MoveAppliedEventFromJson(_normalizeMoveApplied(json));
}

Map<String, dynamic> _normalizeGameState(Map<String, dynamic> json) {
  final normalized = Map<String, dynamic>.from(json);
  final players = json['players'];
  if (players is Map) {
    normalized['player1'] ??= players['light'];
    normalized['player2'] ??= players['dark'];
  }
  normalized['moveCount'] ??= 0;
  normalized['consecutiveKingMoves'] ??= 0;
  normalized['legalMoves'] ??= const <dynamic>[];
  normalized['moveHistory'] ??=
      json['acceptedMoves'] ?? json['moves'] ?? const <dynamic>[];
  normalized['protocolVersion'] ??=
      json['gameProtocolVersion'] ??
      json['_protocolVersion'] ??
      (json.containsKey('stateVersion') ? 2 : 1);
  normalized['stateVersion'] ??= json['version'] ?? 0;
  normalized['currentTurn'] ??= json['sideToMove'] ?? '';
  normalized['player1'] ??= '';
  normalized['player2'] ??= '';
  return normalized;
}

Map<String, dynamic> _normalizeLegalMove(Map<String, dynamic> json) {
  final normalized = Map<String, dynamic>.from(json);
  normalized['capturedSquares'] ??= json['captures'] ?? const <dynamic>[];
  normalized['path'] ??= <dynamic>[json['to']];
  return normalized;
}

Map<String, dynamic> _normalizeAcceptedMove(Map<String, dynamic> json) {
  final normalized = Map<String, dynamic>.from(json);
  final move = json['move'];
  if (move is Map) {
    normalized['from'] ??= move['from'];
    normalized['path'] ??= move['path'];
  }
  normalized['capturedSquares'] ??= json['captures'] ?? const <dynamic>[];
  normalized['path'] ??= const <dynamic>[];
  return normalized;
}

Map<String, dynamic> _normalizeMoveApplied(Map<String, dynamic> json) {
  final normalized = Map<String, dynamic>.from(json);
  final move = json['move'];
  if (move is Map) {
    normalized['from'] ??= move['from'];
    normalized['path'] ??= move['path'];
    final path = normalized['path'];
    if (path is List && path.isNotEmpty) normalized['to'] ??= path.last;
  }
  normalized['path'] ??= <dynamic>[json['to']];
  normalized['captured'] ??= json['captures'] ?? const <dynamic>[];
  normalized['board'] ??= const <dynamic>[];
  normalized['nextTurn'] ??= json['sideToMove'] ?? '';
  normalized['gameEnded'] ??= false;
  return normalized;
}
