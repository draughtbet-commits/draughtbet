// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'game_state.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

_GameState _$GameStateFromJson(Map<String, dynamic> json) => _GameState(
  board: (json['board'] as List<dynamic>)
      .map((e) => (e as num).toInt())
      .toList(),
  currentTurn: json['currentTurn'] as String,
  player1: json['player1'] as String,
  player2: json['player2'] as String,
  status: json['status'] as String,
  moveCount: (json['moveCount'] as num).toInt(),
  consecutiveKingMoves: (json['consecutiveKingMoves'] as num).toInt(),
  legalMoves:
      (json['legalMoves'] as List<dynamic>?)
          ?.map((e) => LegalMove.fromJson(e as Map<String, dynamic>))
          .toList() ??
      const [],
  winnerId: json['winnerId'] as String?,
);

Map<String, dynamic> _$GameStateToJson(_GameState instance) =>
    <String, dynamic>{
      'board': instance.board,
      'currentTurn': instance.currentTurn,
      'player1': instance.player1,
      'player2': instance.player2,
      'status': instance.status,
      'moveCount': instance.moveCount,
      'consecutiveKingMoves': instance.consecutiveKingMoves,
      'legalMoves': instance.legalMoves,
      'winnerId': instance.winnerId,
    };

_LegalMove _$LegalMoveFromJson(Map<String, dynamic> json) => _LegalMove(
  from: (json['from'] as num).toInt(),
  to: (json['to'] as num).toInt(),
  capturedSquares:
      (json['capturedSquares'] as List<dynamic>?)
          ?.map((e) => (e as num).toInt())
          .toList() ??
      const [],
  promoted: json['promoted'] as bool? ?? false,
);

Map<String, dynamic> _$LegalMoveToJson(_LegalMove instance) =>
    <String, dynamic>{
      'from': instance.from,
      'to': instance.to,
      'capturedSquares': instance.capturedSquares,
      'promoted': instance.promoted,
    };

_MoveAppliedEvent _$MoveAppliedEventFromJson(Map<String, dynamic> json) =>
    _MoveAppliedEvent(
      from: (json['from'] as num).toInt(),
      to: (json['to'] as num).toInt(),
      board: (json['board'] as List<dynamic>)
          .map((e) => (e as num).toInt())
          .toList(),
      captured:
          (json['captured'] as List<dynamic>?)
              ?.map((e) => (e as num).toInt())
              .toList() ??
          const [],
      promoted: json['promoted'] as bool? ?? false,
      nextTurn: json['nextTurn'] as String,
      gameEnded: json['gameEnded'] as bool,
      reason: json['reason'] as String?,
      legalMoves:
          (json['legalMoves'] as List<dynamic>?)
              ?.map((e) => LegalMove.fromJson(e as Map<String, dynamic>))
              .toList() ??
          const [],
    );

Map<String, dynamic> _$MoveAppliedEventToJson(_MoveAppliedEvent instance) =>
    <String, dynamic>{
      'from': instance.from,
      'to': instance.to,
      'board': instance.board,
      'captured': instance.captured,
      'promoted': instance.promoted,
      'nextTurn': instance.nextTurn,
      'gameEnded': instance.gameEnded,
      'reason': instance.reason,
      'legalMoves': instance.legalMoves,
    };
