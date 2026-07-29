// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint
// ignore_for_file: unused_element, deprecated_member_use, deprecated_member_use_from_same_package, use_function_type_syntax_for_parameters, unnecessary_const, avoid_init_to_null, invalid_override_different_default_values_named, prefer_expression_function_bodies, annotate_overrides, invalid_annotation_target, unnecessary_question_mark

part of 'game_state.dart';

// **************************************************************************
// FreezedGenerator
// **************************************************************************

T _$identity<T>(T value) => value;

final _privateConstructorUsedError = UnsupportedError(
    'It seems like you constructed your class using `MyClass._()`. This constructor is only meant to be used by freezed and you are not supposed to need it nor use it.\nPlease check the documentation here for more information: https://github.com/rrousselGit/freezed#adding-getters-and-methods-to-our-models');

GameState _$GameStateFromJson(Map<String, dynamic> json) {
  return _GameState.fromJson(json);
}

/// @nodoc
mixin _$GameState {
  List<int> get board => throw _privateConstructorUsedError;
  String get currentTurn => throw _privateConstructorUsedError;
  String get player1 => throw _privateConstructorUsedError;
  String get player2 => throw _privateConstructorUsedError;
  String get status => throw _privateConstructorUsedError;
  int get moveCount => throw _privateConstructorUsedError;
  int get consecutiveKingMoves => throw _privateConstructorUsedError;
  List<LegalMove> get legalMoves => throw _privateConstructorUsedError;
  String? get winnerId => throw _privateConstructorUsedError;

  /// Serializes this GameState to a JSON map.
  Map<String, dynamic> toJson() => throw _privateConstructorUsedError;

  /// Create a copy of GameState
  /// with the given fields replaced by the non-null parameter values.
  @JsonKey(includeFromJson: false, includeToJson: false)
  $GameStateCopyWith<GameState> get copyWith =>
      throw _privateConstructorUsedError;
}

/// @nodoc
abstract class $GameStateCopyWith<$Res> {
  factory $GameStateCopyWith(GameState value, $Res Function(GameState) then) =
      _$GameStateCopyWithImpl<$Res, GameState>;
  @useResult
  $Res call(
      {List<int> board,
      String currentTurn,
      String player1,
      String player2,
      String status,
      int moveCount,
      int consecutiveKingMoves,
      List<LegalMove> legalMoves,
      String? winnerId});
}

/// @nodoc
class _$GameStateCopyWithImpl<$Res, $Val extends GameState>
    implements $GameStateCopyWith<$Res> {
  _$GameStateCopyWithImpl(this._value, this._then);

  // ignore: unused_field
  final $Val _value;
  // ignore: unused_field
  final $Res Function($Val) _then;

  /// Create a copy of GameState
  /// with the given fields replaced by the non-null parameter values.
  @pragma('vm:prefer-inline')
  @override
  $Res call({
    Object? board = null,
    Object? currentTurn = null,
    Object? player1 = null,
    Object? player2 = null,
    Object? status = null,
    Object? moveCount = null,
    Object? consecutiveKingMoves = null,
    Object? legalMoves = null,
    Object? winnerId = freezed,
  }) {
    return _then(_value.copyWith(
      board: null == board
          ? _value.board
          : board // ignore: cast_nullable_to_non_nullable
              as List<int>,
      currentTurn: null == currentTurn
          ? _value.currentTurn
          : currentTurn // ignore: cast_nullable_to_non_nullable
              as String,
      player1: null == player1
          ? _value.player1
          : player1 // ignore: cast_nullable_to_non_nullable
              as String,
      player2: null == player2
          ? _value.player2
          : player2 // ignore: cast_nullable_to_non_nullable
              as String,
      status: null == status
          ? _value.status
          : status // ignore: cast_nullable_to_non_nullable
              as String,
      moveCount: null == moveCount
          ? _value.moveCount
          : moveCount // ignore: cast_nullable_to_non_nullable
              as int,
      consecutiveKingMoves: null == consecutiveKingMoves
          ? _value.consecutiveKingMoves
          : consecutiveKingMoves // ignore: cast_nullable_to_non_nullable
              as int,
      legalMoves: null == legalMoves
          ? _value.legalMoves
          : legalMoves // ignore: cast_nullable_to_non_nullable
              as List<LegalMove>,
      winnerId: freezed == winnerId
          ? _value.winnerId
          : winnerId // ignore: cast_nullable_to_non_nullable
              as String?,
    ) as $Val);
  }
}

/// @nodoc
abstract class _$$GameStateImplCopyWith<$Res>
    implements $GameStateCopyWith<$Res> {
  factory _$$GameStateImplCopyWith(
          _$GameStateImpl value, $Res Function(_$GameStateImpl) then) =
      __$$GameStateImplCopyWithImpl<$Res>;
  @override
  @useResult
  $Res call(
      {List<int> board,
      String currentTurn,
      String player1,
      String player2,
      String status,
      int moveCount,
      int consecutiveKingMoves,
      List<LegalMove> legalMoves,
      String? winnerId});
}

/// @nodoc
class __$$GameStateImplCopyWithImpl<$Res>
    extends _$GameStateCopyWithImpl<$Res, _$GameStateImpl>
    implements _$$GameStateImplCopyWith<$Res> {
  __$$GameStateImplCopyWithImpl(
      _$GameStateImpl _value, $Res Function(_$GameStateImpl) _then)
      : super(_value, _then);

  /// Create a copy of GameState
  /// with the given fields replaced by the non-null parameter values.
  @pragma('vm:prefer-inline')
  @override
  $Res call({
    Object? board = null,
    Object? currentTurn = null,
    Object? player1 = null,
    Object? player2 = null,
    Object? status = null,
    Object? moveCount = null,
    Object? consecutiveKingMoves = null,
    Object? legalMoves = null,
    Object? winnerId = freezed,
  }) {
    return _then(_$GameStateImpl(
      board: null == board
          ? _value._board
          : board // ignore: cast_nullable_to_non_nullable
              as List<int>,
      currentTurn: null == currentTurn
          ? _value.currentTurn
          : currentTurn // ignore: cast_nullable_to_non_nullable
              as String,
      player1: null == player1
          ? _value.player1
          : player1 // ignore: cast_nullable_to_non_nullable
              as String,
      player2: null == player2
          ? _value.player2
          : player2 // ignore: cast_nullable_to_non_nullable
              as String,
      status: null == status
          ? _value.status
          : status // ignore: cast_nullable_to_non_nullable
              as String,
      moveCount: null == moveCount
          ? _value.moveCount
          : moveCount // ignore: cast_nullable_to_non_nullable
              as int,
      consecutiveKingMoves: null == consecutiveKingMoves
          ? _value.consecutiveKingMoves
          : consecutiveKingMoves // ignore: cast_nullable_to_non_nullable
              as int,
      legalMoves: null == legalMoves
          ? _value._legalMoves
          : legalMoves // ignore: cast_nullable_to_non_nullable
              as List<LegalMove>,
      winnerId: freezed == winnerId
          ? _value.winnerId
          : winnerId // ignore: cast_nullable_to_non_nullable
              as String?,
    ));
  }
}

/// @nodoc
@JsonSerializable()
class _$GameStateImpl implements _GameState {
  const _$GameStateImpl(
      {required final List<int> board,
      required this.currentTurn,
      required this.player1,
      required this.player2,
      required this.status,
      required this.moveCount,
      required this.consecutiveKingMoves,
      final List<LegalMove> legalMoves = const [],
      this.winnerId})
      : _board = board,
        _legalMoves = legalMoves;

  factory _$GameStateImpl.fromJson(Map<String, dynamic> json) =>
      _$$GameStateImplFromJson(json);

  final List<int> _board;
  @override
  List<int> get board {
    if (_board is EqualUnmodifiableListView) return _board;
    // ignore: implicit_dynamic_type
    return EqualUnmodifiableListView(_board);
  }

  @override
  final String currentTurn;
  @override
  final String player1;
  @override
  final String player2;
  @override
  final String status;
  @override
  final int moveCount;
  @override
  final int consecutiveKingMoves;
  final List<LegalMove> _legalMoves;
  @override
  @JsonKey()
  List<LegalMove> get legalMoves {
    if (_legalMoves is EqualUnmodifiableListView) return _legalMoves;
    // ignore: implicit_dynamic_type
    return EqualUnmodifiableListView(_legalMoves);
  }

  @override
  final String? winnerId;

  @override
  String toString() {
    return 'GameState(board: $board, currentTurn: $currentTurn, player1: $player1, player2: $player2, status: $status, moveCount: $moveCount, consecutiveKingMoves: $consecutiveKingMoves, legalMoves: $legalMoves, winnerId: $winnerId)';
  }

  @override
  bool operator ==(Object other) {
    return identical(this, other) ||
        (other.runtimeType == runtimeType &&
            other is _$GameStateImpl &&
            const DeepCollectionEquality().equals(other._board, _board) &&
            (identical(other.currentTurn, currentTurn) ||
                other.currentTurn == currentTurn) &&
            (identical(other.player1, player1) || other.player1 == player1) &&
            (identical(other.player2, player2) || other.player2 == player2) &&
            (identical(other.status, status) || other.status == status) &&
            (identical(other.moveCount, moveCount) ||
                other.moveCount == moveCount) &&
            (identical(other.consecutiveKingMoves, consecutiveKingMoves) ||
                other.consecutiveKingMoves == consecutiveKingMoves) &&
            const DeepCollectionEquality()
                .equals(other._legalMoves, _legalMoves) &&
            (identical(other.winnerId, winnerId) ||
                other.winnerId == winnerId));
  }

  @JsonKey(includeFromJson: false, includeToJson: false)
  @override
  int get hashCode => Object.hash(
      runtimeType,
      const DeepCollectionEquality().hash(_board),
      currentTurn,
      player1,
      player2,
      status,
      moveCount,
      consecutiveKingMoves,
      const DeepCollectionEquality().hash(_legalMoves),
      winnerId);

  /// Create a copy of GameState
  /// with the given fields replaced by the non-null parameter values.
  @JsonKey(includeFromJson: false, includeToJson: false)
  @override
  @pragma('vm:prefer-inline')
  _$$GameStateImplCopyWith<_$GameStateImpl> get copyWith =>
      __$$GameStateImplCopyWithImpl<_$GameStateImpl>(this, _$identity);

  @override
  Map<String, dynamic> toJson() {
    return _$$GameStateImplToJson(
      this,
    );
  }
}

abstract class _GameState implements GameState {
  const factory _GameState(
      {required final List<int> board,
      required final String currentTurn,
      required final String player1,
      required final String player2,
      required final String status,
      required final int moveCount,
      required final int consecutiveKingMoves,
      final List<LegalMove> legalMoves,
      final String? winnerId}) = _$GameStateImpl;

  factory _GameState.fromJson(Map<String, dynamic> json) =
      _$GameStateImpl.fromJson;

  @override
  List<int> get board;
  @override
  String get currentTurn;
  @override
  String get player1;
  @override
  String get player2;
  @override
  String get status;
  @override
  int get moveCount;
  @override
  int get consecutiveKingMoves;
  @override
  List<LegalMove> get legalMoves;
  @override
  String? get winnerId;

  /// Create a copy of GameState
  /// with the given fields replaced by the non-null parameter values.
  @override
  @JsonKey(includeFromJson: false, includeToJson: false)
  _$$GameStateImplCopyWith<_$GameStateImpl> get copyWith =>
      throw _privateConstructorUsedError;
}

LegalMove _$LegalMoveFromJson(Map<String, dynamic> json) {
  return _LegalMove.fromJson(json);
}

/// @nodoc
mixin _$LegalMove {
  int get from => throw _privateConstructorUsedError;
  int get to => throw _privateConstructorUsedError;
  List<int> get capturedSquares => throw _privateConstructorUsedError;
  bool get promoted => throw _privateConstructorUsedError;

  /// Serializes this LegalMove to a JSON map.
  Map<String, dynamic> toJson() => throw _privateConstructorUsedError;

  /// Create a copy of LegalMove
  /// with the given fields replaced by the non-null parameter values.
  @JsonKey(includeFromJson: false, includeToJson: false)
  $LegalMoveCopyWith<LegalMove> get copyWith =>
      throw _privateConstructorUsedError;
}

/// @nodoc
abstract class $LegalMoveCopyWith<$Res> {
  factory $LegalMoveCopyWith(LegalMove value, $Res Function(LegalMove) then) =
      _$LegalMoveCopyWithImpl<$Res, LegalMove>;
  @useResult
  $Res call({int from, int to, List<int> capturedSquares, bool promoted});
}

/// @nodoc
class _$LegalMoveCopyWithImpl<$Res, $Val extends LegalMove>
    implements $LegalMoveCopyWith<$Res> {
  _$LegalMoveCopyWithImpl(this._value, this._then);

  // ignore: unused_field
  final $Val _value;
  // ignore: unused_field
  final $Res Function($Val) _then;

  /// Create a copy of LegalMove
  /// with the given fields replaced by the non-null parameter values.
  @pragma('vm:prefer-inline')
  @override
  $Res call({
    Object? from = null,
    Object? to = null,
    Object? capturedSquares = null,
    Object? promoted = null,
  }) {
    return _then(_value.copyWith(
      from: null == from
          ? _value.from
          : from // ignore: cast_nullable_to_non_nullable
              as int,
      to: null == to
          ? _value.to
          : to // ignore: cast_nullable_to_non_nullable
              as int,
      capturedSquares: null == capturedSquares
          ? _value.capturedSquares
          : capturedSquares // ignore: cast_nullable_to_non_nullable
              as List<int>,
      promoted: null == promoted
          ? _value.promoted
          : promoted // ignore: cast_nullable_to_non_nullable
              as bool,
    ) as $Val);
  }
}

/// @nodoc
abstract class _$$LegalMoveImplCopyWith<$Res>
    implements $LegalMoveCopyWith<$Res> {
  factory _$$LegalMoveImplCopyWith(
          _$LegalMoveImpl value, $Res Function(_$LegalMoveImpl) then) =
      __$$LegalMoveImplCopyWithImpl<$Res>;
  @override
  @useResult
  $Res call({int from, int to, List<int> capturedSquares, bool promoted});
}

/// @nodoc
class __$$LegalMoveImplCopyWithImpl<$Res>
    extends _$LegalMoveCopyWithImpl<$Res, _$LegalMoveImpl>
    implements _$$LegalMoveImplCopyWith<$Res> {
  __$$LegalMoveImplCopyWithImpl(
      _$LegalMoveImpl _value, $Res Function(_$LegalMoveImpl) _then)
      : super(_value, _then);

  /// Create a copy of LegalMove
  /// with the given fields replaced by the non-null parameter values.
  @pragma('vm:prefer-inline')
  @override
  $Res call({
    Object? from = null,
    Object? to = null,
    Object? capturedSquares = null,
    Object? promoted = null,
  }) {
    return _then(_$LegalMoveImpl(
      from: null == from
          ? _value.from
          : from // ignore: cast_nullable_to_non_nullable
              as int,
      to: null == to
          ? _value.to
          : to // ignore: cast_nullable_to_non_nullable
              as int,
      capturedSquares: null == capturedSquares
          ? _value._capturedSquares
          : capturedSquares // ignore: cast_nullable_to_non_nullable
              as List<int>,
      promoted: null == promoted
          ? _value.promoted
          : promoted // ignore: cast_nullable_to_non_nullable
              as bool,
    ));
  }
}

/// @nodoc
@JsonSerializable()
class _$LegalMoveImpl implements _LegalMove {
  const _$LegalMoveImpl(
      {required this.from,
      required this.to,
      final List<int> capturedSquares = const [],
      this.promoted = false})
      : _capturedSquares = capturedSquares;

  factory _$LegalMoveImpl.fromJson(Map<String, dynamic> json) =>
      _$$LegalMoveImplFromJson(json);

  @override
  final int from;
  @override
  final int to;
  final List<int> _capturedSquares;
  @override
  @JsonKey()
  List<int> get capturedSquares {
    if (_capturedSquares is EqualUnmodifiableListView) return _capturedSquares;
    // ignore: implicit_dynamic_type
    return EqualUnmodifiableListView(_capturedSquares);
  }

  @override
  @JsonKey()
  final bool promoted;

  @override
  String toString() {
    return 'LegalMove(from: $from, to: $to, capturedSquares: $capturedSquares, promoted: $promoted)';
  }

  @override
  bool operator ==(Object other) {
    return identical(this, other) ||
        (other.runtimeType == runtimeType &&
            other is _$LegalMoveImpl &&
            (identical(other.from, from) || other.from == from) &&
            (identical(other.to, to) || other.to == to) &&
            const DeepCollectionEquality()
                .equals(other._capturedSquares, _capturedSquares) &&
            (identical(other.promoted, promoted) ||
                other.promoted == promoted));
  }

  @JsonKey(includeFromJson: false, includeToJson: false)
  @override
  int get hashCode => Object.hash(runtimeType, from, to,
      const DeepCollectionEquality().hash(_capturedSquares), promoted);

  /// Create a copy of LegalMove
  /// with the given fields replaced by the non-null parameter values.
  @JsonKey(includeFromJson: false, includeToJson: false)
  @override
  @pragma('vm:prefer-inline')
  _$$LegalMoveImplCopyWith<_$LegalMoveImpl> get copyWith =>
      __$$LegalMoveImplCopyWithImpl<_$LegalMoveImpl>(this, _$identity);

  @override
  Map<String, dynamic> toJson() {
    return _$$LegalMoveImplToJson(
      this,
    );
  }
}

abstract class _LegalMove implements LegalMove {
  const factory _LegalMove(
      {required final int from,
      required final int to,
      final List<int> capturedSquares,
      final bool promoted}) = _$LegalMoveImpl;

  factory _LegalMove.fromJson(Map<String, dynamic> json) =
      _$LegalMoveImpl.fromJson;

  @override
  int get from;
  @override
  int get to;
  @override
  List<int> get capturedSquares;
  @override
  bool get promoted;

  /// Create a copy of LegalMove
  /// with the given fields replaced by the non-null parameter values.
  @override
  @JsonKey(includeFromJson: false, includeToJson: false)
  _$$LegalMoveImplCopyWith<_$LegalMoveImpl> get copyWith =>
      throw _privateConstructorUsedError;
}

MoveAppliedEvent _$MoveAppliedEventFromJson(Map<String, dynamic> json) {
  return _MoveAppliedEvent.fromJson(json);
}

/// @nodoc
mixin _$MoveAppliedEvent {
  int get from => throw _privateConstructorUsedError;
  int get to => throw _privateConstructorUsedError;
  List<int> get board => throw _privateConstructorUsedError;
  List<int> get captured => throw _privateConstructorUsedError;
  bool get promoted => throw _privateConstructorUsedError;
  String get nextTurn => throw _privateConstructorUsedError;
  bool get gameEnded => throw _privateConstructorUsedError;
  String? get reason => throw _privateConstructorUsedError;
  List<LegalMove> get legalMoves => throw _privateConstructorUsedError;

  /// Serializes this MoveAppliedEvent to a JSON map.
  Map<String, dynamic> toJson() => throw _privateConstructorUsedError;

  /// Create a copy of MoveAppliedEvent
  /// with the given fields replaced by the non-null parameter values.
  @JsonKey(includeFromJson: false, includeToJson: false)
  $MoveAppliedEventCopyWith<MoveAppliedEvent> get copyWith =>
      throw _privateConstructorUsedError;
}

/// @nodoc
abstract class $MoveAppliedEventCopyWith<$Res> {
  factory $MoveAppliedEventCopyWith(
          MoveAppliedEvent value, $Res Function(MoveAppliedEvent) then) =
      _$MoveAppliedEventCopyWithImpl<$Res, MoveAppliedEvent>;
  @useResult
  $Res call(
      {int from,
      int to,
      List<int> board,
      List<int> captured,
      bool promoted,
      String nextTurn,
      bool gameEnded,
      String? reason,
      List<LegalMove> legalMoves});
}

/// @nodoc
class _$MoveAppliedEventCopyWithImpl<$Res, $Val extends MoveAppliedEvent>
    implements $MoveAppliedEventCopyWith<$Res> {
  _$MoveAppliedEventCopyWithImpl(this._value, this._then);

  // ignore: unused_field
  final $Val _value;
  // ignore: unused_field
  final $Res Function($Val) _then;

  /// Create a copy of MoveAppliedEvent
  /// with the given fields replaced by the non-null parameter values.
  @pragma('vm:prefer-inline')
  @override
  $Res call({
    Object? from = null,
    Object? to = null,
    Object? board = null,
    Object? captured = null,
    Object? promoted = null,
    Object? nextTurn = null,
    Object? gameEnded = null,
    Object? reason = freezed,
    Object? legalMoves = null,
  }) {
    return _then(_value.copyWith(
      from: null == from
          ? _value.from
          : from // ignore: cast_nullable_to_non_nullable
              as int,
      to: null == to
          ? _value.to
          : to // ignore: cast_nullable_to_non_nullable
              as int,
      board: null == board
          ? _value.board
          : board // ignore: cast_nullable_to_non_nullable
              as List<int>,
      captured: null == captured
          ? _value.captured
          : captured // ignore: cast_nullable_to_non_nullable
              as List<int>,
      promoted: null == promoted
          ? _value.promoted
          : promoted // ignore: cast_nullable_to_non_nullable
              as bool,
      nextTurn: null == nextTurn
          ? _value.nextTurn
          : nextTurn // ignore: cast_nullable_to_non_nullable
              as String,
      gameEnded: null == gameEnded
          ? _value.gameEnded
          : gameEnded // ignore: cast_nullable_to_non_nullable
              as bool,
      reason: freezed == reason
          ? _value.reason
          : reason // ignore: cast_nullable_to_non_nullable
              as String?,
      legalMoves: null == legalMoves
          ? _value.legalMoves
          : legalMoves // ignore: cast_nullable_to_non_nullable
              as List<LegalMove>,
    ) as $Val);
  }
}

/// @nodoc
abstract class _$$MoveAppliedEventImplCopyWith<$Res>
    implements $MoveAppliedEventCopyWith<$Res> {
  factory _$$MoveAppliedEventImplCopyWith(_$MoveAppliedEventImpl value,
          $Res Function(_$MoveAppliedEventImpl) then) =
      __$$MoveAppliedEventImplCopyWithImpl<$Res>;
  @override
  @useResult
  $Res call(
      {int from,
      int to,
      List<int> board,
      List<int> captured,
      bool promoted,
      String nextTurn,
      bool gameEnded,
      String? reason,
      List<LegalMove> legalMoves});
}

/// @nodoc
class __$$MoveAppliedEventImplCopyWithImpl<$Res>
    extends _$MoveAppliedEventCopyWithImpl<$Res, _$MoveAppliedEventImpl>
    implements _$$MoveAppliedEventImplCopyWith<$Res> {
  __$$MoveAppliedEventImplCopyWithImpl(_$MoveAppliedEventImpl _value,
      $Res Function(_$MoveAppliedEventImpl) _then)
      : super(_value, _then);

  /// Create a copy of MoveAppliedEvent
  /// with the given fields replaced by the non-null parameter values.
  @pragma('vm:prefer-inline')
  @override
  $Res call({
    Object? from = null,
    Object? to = null,
    Object? board = null,
    Object? captured = null,
    Object? promoted = null,
    Object? nextTurn = null,
    Object? gameEnded = null,
    Object? reason = freezed,
    Object? legalMoves = null,
  }) {
    return _then(_$MoveAppliedEventImpl(
      from: null == from
          ? _value.from
          : from // ignore: cast_nullable_to_non_nullable
              as int,
      to: null == to
          ? _value.to
          : to // ignore: cast_nullable_to_non_nullable
              as int,
      board: null == board
          ? _value._board
          : board // ignore: cast_nullable_to_non_nullable
              as List<int>,
      captured: null == captured
          ? _value._captured
          : captured // ignore: cast_nullable_to_non_nullable
              as List<int>,
      promoted: null == promoted
          ? _value.promoted
          : promoted // ignore: cast_nullable_to_non_nullable
              as bool,
      nextTurn: null == nextTurn
          ? _value.nextTurn
          : nextTurn // ignore: cast_nullable_to_non_nullable
              as String,
      gameEnded: null == gameEnded
          ? _value.gameEnded
          : gameEnded // ignore: cast_nullable_to_non_nullable
              as bool,
      reason: freezed == reason
          ? _value.reason
          : reason // ignore: cast_nullable_to_non_nullable
              as String?,
      legalMoves: null == legalMoves
          ? _value._legalMoves
          : legalMoves // ignore: cast_nullable_to_non_nullable
              as List<LegalMove>,
    ));
  }
}

/// @nodoc
@JsonSerializable()
class _$MoveAppliedEventImpl implements _MoveAppliedEvent {
  const _$MoveAppliedEventImpl(
      {required this.from,
      required this.to,
      required final List<int> board,
      final List<int> captured = const [],
      this.promoted = false,
      required this.nextTurn,
      required this.gameEnded,
      this.reason,
      final List<LegalMove> legalMoves = const []})
      : _board = board,
        _captured = captured,
        _legalMoves = legalMoves;

  factory _$MoveAppliedEventImpl.fromJson(Map<String, dynamic> json) =>
      _$$MoveAppliedEventImplFromJson(json);

  @override
  final int from;
  @override
  final int to;
  final List<int> _board;
  @override
  List<int> get board {
    if (_board is EqualUnmodifiableListView) return _board;
    // ignore: implicit_dynamic_type
    return EqualUnmodifiableListView(_board);
  }

  final List<int> _captured;
  @override
  @JsonKey()
  List<int> get captured {
    if (_captured is EqualUnmodifiableListView) return _captured;
    // ignore: implicit_dynamic_type
    return EqualUnmodifiableListView(_captured);
  }

  @override
  @JsonKey()
  final bool promoted;
  @override
  final String nextTurn;
  @override
  final bool gameEnded;
  @override
  final String? reason;
  final List<LegalMove> _legalMoves;
  @override
  @JsonKey()
  List<LegalMove> get legalMoves {
    if (_legalMoves is EqualUnmodifiableListView) return _legalMoves;
    // ignore: implicit_dynamic_type
    return EqualUnmodifiableListView(_legalMoves);
  }

  @override
  String toString() {
    return 'MoveAppliedEvent(from: $from, to: $to, board: $board, captured: $captured, promoted: $promoted, nextTurn: $nextTurn, gameEnded: $gameEnded, reason: $reason, legalMoves: $legalMoves)';
  }

  @override
  bool operator ==(Object other) {
    return identical(this, other) ||
        (other.runtimeType == runtimeType &&
            other is _$MoveAppliedEventImpl &&
            (identical(other.from, from) || other.from == from) &&
            (identical(other.to, to) || other.to == to) &&
            const DeepCollectionEquality().equals(other._board, _board) &&
            const DeepCollectionEquality().equals(other._captured, _captured) &&
            (identical(other.promoted, promoted) ||
                other.promoted == promoted) &&
            (identical(other.nextTurn, nextTurn) ||
                other.nextTurn == nextTurn) &&
            (identical(other.gameEnded, gameEnded) ||
                other.gameEnded == gameEnded) &&
            (identical(other.reason, reason) || other.reason == reason) &&
            const DeepCollectionEquality()
                .equals(other._legalMoves, _legalMoves));
  }

  @JsonKey(includeFromJson: false, includeToJson: false)
  @override
  int get hashCode => Object.hash(
      runtimeType,
      from,
      to,
      const DeepCollectionEquality().hash(_board),
      const DeepCollectionEquality().hash(_captured),
      promoted,
      nextTurn,
      gameEnded,
      reason,
      const DeepCollectionEquality().hash(_legalMoves));

  /// Create a copy of MoveAppliedEvent
  /// with the given fields replaced by the non-null parameter values.
  @JsonKey(includeFromJson: false, includeToJson: false)
  @override
  @pragma('vm:prefer-inline')
  _$$MoveAppliedEventImplCopyWith<_$MoveAppliedEventImpl> get copyWith =>
      __$$MoveAppliedEventImplCopyWithImpl<_$MoveAppliedEventImpl>(
          this, _$identity);

  @override
  Map<String, dynamic> toJson() {
    return _$$MoveAppliedEventImplToJson(
      this,
    );
  }
}

abstract class _MoveAppliedEvent implements MoveAppliedEvent {
  const factory _MoveAppliedEvent(
      {required final int from,
      required final int to,
      required final List<int> board,
      final List<int> captured,
      final bool promoted,
      required final String nextTurn,
      required final bool gameEnded,
      final String? reason,
      final List<LegalMove> legalMoves}) = _$MoveAppliedEventImpl;

  factory _MoveAppliedEvent.fromJson(Map<String, dynamic> json) =
      _$MoveAppliedEventImpl.fromJson;

  @override
  int get from;
  @override
  int get to;
  @override
  List<int> get board;
  @override
  List<int> get captured;
  @override
  bool get promoted;
  @override
  String get nextTurn;
  @override
  bool get gameEnded;
  @override
  String? get reason;
  @override
  List<LegalMove> get legalMoves;

  /// Create a copy of MoveAppliedEvent
  /// with the given fields replaced by the non-null parameter values.
  @override
  @JsonKey(includeFromJson: false, includeToJson: false)
  _$$MoveAppliedEventImplCopyWith<_$MoveAppliedEventImpl> get copyWith =>
      throw _privateConstructorUsedError;
}
