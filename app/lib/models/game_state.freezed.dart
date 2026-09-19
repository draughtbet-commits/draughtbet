// GENERATED CODE - DO NOT MODIFY BY HAND
// coverage:ignore-file
// ignore_for_file: type=lint, type=warning, deprecated_member_use, deprecated_member_use_from_same_package
// ignore_for_file: unused_element, deprecated_member_use, deprecated_member_use_from_same_package, use_function_type_syntax_for_parameters, unnecessary_const, avoid_init_to_null, invalid_override_different_default_values_named, prefer_expression_function_bodies, annotate_overrides, invalid_annotation_target, unnecessary_question_mark

part of 'game_state.dart';

// **************************************************************************
// FreezedGenerator
// **************************************************************************

// GENERATED CODE - DO NOT MODIFY BY HAND
// dart format off
T _$identity<T>(T value) => value;

/// @nodoc
mixin _$GameState {

 List<int> get board; String get currentTurn; String get player1; String get player2; String get status; int get moveCount; int get consecutiveKingMoves; int get protocolVersion; int get stateVersion; List<LegalMove> get legalMoves; List<AcceptedGameMove> get moveHistory; String? get winnerId;
/// Create a copy of GameState
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$GameStateCopyWith<GameState> get copyWith => _$GameStateCopyWithImpl<GameState>(this as GameState, _$identity);

  /// Serializes this GameState to a JSON map.
  Map<String, dynamic> toJson();


@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is GameState&&const DeepCollectionEquality().equals(other.board, board)&&(identical(other.currentTurn, currentTurn) || other.currentTurn == currentTurn)&&(identical(other.player1, player1) || other.player1 == player1)&&(identical(other.player2, player2) || other.player2 == player2)&&(identical(other.status, status) || other.status == status)&&(identical(other.moveCount, moveCount) || other.moveCount == moveCount)&&(identical(other.consecutiveKingMoves, consecutiveKingMoves) || other.consecutiveKingMoves == consecutiveKingMoves)&&(identical(other.protocolVersion, protocolVersion) || other.protocolVersion == protocolVersion)&&(identical(other.stateVersion, stateVersion) || other.stateVersion == stateVersion)&&const DeepCollectionEquality().equals(other.legalMoves, legalMoves)&&const DeepCollectionEquality().equals(other.moveHistory, moveHistory)&&(identical(other.winnerId, winnerId) || other.winnerId == winnerId));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,const DeepCollectionEquality().hash(board),currentTurn,player1,player2,status,moveCount,consecutiveKingMoves,protocolVersion,stateVersion,const DeepCollectionEquality().hash(legalMoves),const DeepCollectionEquality().hash(moveHistory),winnerId);

@override
String toString() {
  return 'GameState(board: $board, currentTurn: $currentTurn, player1: $player1, player2: $player2, status: $status, moveCount: $moveCount, consecutiveKingMoves: $consecutiveKingMoves, protocolVersion: $protocolVersion, stateVersion: $stateVersion, legalMoves: $legalMoves, moveHistory: $moveHistory, winnerId: $winnerId)';
}


}

/// @nodoc
abstract mixin class $GameStateCopyWith<$Res>  {
  factory $GameStateCopyWith(GameState value, $Res Function(GameState) _then) = _$GameStateCopyWithImpl;
@useResult
$Res call({
 List<int> board, String currentTurn, String player1, String player2, String status, int moveCount, int consecutiveKingMoves, int protocolVersion, int stateVersion, List<LegalMove> legalMoves, List<AcceptedGameMove> moveHistory, String? winnerId
});




}
/// @nodoc
class _$GameStateCopyWithImpl<$Res>
    implements $GameStateCopyWith<$Res> {
  _$GameStateCopyWithImpl(this._self, this._then);

  final GameState _self;
  final $Res Function(GameState) _then;

/// Create a copy of GameState
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') @override $Res call({Object? board = null,Object? currentTurn = null,Object? player1 = null,Object? player2 = null,Object? status = null,Object? moveCount = null,Object? consecutiveKingMoves = null,Object? protocolVersion = null,Object? stateVersion = null,Object? legalMoves = null,Object? moveHistory = null,Object? winnerId = freezed,}) {
  return _then(GameState(
board: null == board ? _self.board : board // ignore: cast_nullable_to_non_nullable
as List<int>,currentTurn: null == currentTurn ? _self.currentTurn : currentTurn // ignore: cast_nullable_to_non_nullable
as String,player1: null == player1 ? _self.player1 : player1 // ignore: cast_nullable_to_non_nullable
as String,player2: null == player2 ? _self.player2 : player2 // ignore: cast_nullable_to_non_nullable
as String,status: null == status ? _self.status : status // ignore: cast_nullable_to_non_nullable
as String,moveCount: null == moveCount ? _self.moveCount : moveCount // ignore: cast_nullable_to_non_nullable
as int,consecutiveKingMoves: null == consecutiveKingMoves ? _self.consecutiveKingMoves : consecutiveKingMoves // ignore: cast_nullable_to_non_nullable
as int,protocolVersion: null == protocolVersion ? _self.protocolVersion : protocolVersion // ignore: cast_nullable_to_non_nullable
as int,stateVersion: null == stateVersion ? _self.stateVersion : stateVersion // ignore: cast_nullable_to_non_nullable
as int,legalMoves: null == legalMoves ? _self.legalMoves : legalMoves // ignore: cast_nullable_to_non_nullable
as List<LegalMove>,moveHistory: null == moveHistory ? _self.moveHistory : moveHistory // ignore: cast_nullable_to_non_nullable
as List<AcceptedGameMove>,winnerId: freezed == winnerId ? _self.winnerId : winnerId // ignore: cast_nullable_to_non_nullable
as String?,
  ));
}

}


/// Adds pattern-matching-related methods to [GameState].
extension GameStatePatterns on GameState {
/// A variant of `map` that fallback to returning `orElse`.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case _:
///     return orElse();
/// }
/// ```

@optionalTypeArgs TResult maybeMap<TResult extends Object?>(TResult Function( _GameState value)?  $default,{required TResult orElse(),}){
final _that = this;
switch (_that) {
case _GameState() when $default != null:
return $default(_that);case _:
  return orElse();

}
}
/// A `switch`-like method, using callbacks.
///
/// Callbacks receives the raw object, upcasted.
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case final Subclass2 value:
///     return ...;
/// }
/// ```

@optionalTypeArgs TResult map<TResult extends Object?>(TResult Function( _GameState value)  $default,){
final _that = this;
switch (_that) {
case _GameState():
return $default(_that);case _:
  throw StateError('Unexpected subclass');

}
}
/// A variant of `map` that fallback to returning `null`.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case _:
///     return null;
/// }
/// ```

@optionalTypeArgs TResult? mapOrNull<TResult extends Object?>(TResult? Function( _GameState value)?  $default,){
final _that = this;
switch (_that) {
case _GameState() when $default != null:
return $default(_that);case _:
  return null;

}
}
/// A variant of `when` that fallback to an `orElse` callback.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case _:
///     return orElse();
/// }
/// ```

@optionalTypeArgs TResult maybeWhen<TResult extends Object?>(TResult Function( List<int> board,  String currentTurn,  String player1,  String player2,  String status,  int moveCount,  int consecutiveKingMoves,  int protocolVersion,  int stateVersion,  List<LegalMove> legalMoves,  List<AcceptedGameMove> moveHistory,  String? winnerId)?  $default,{required TResult orElse(),}) {final _that = this;
switch (_that) {
case _GameState() when $default != null:
return $default(_that.board,_that.currentTurn,_that.player1,_that.player2,_that.status,_that.moveCount,_that.consecutiveKingMoves,_that.protocolVersion,_that.stateVersion,_that.legalMoves,_that.moveHistory,_that.winnerId);case _:
  return orElse();

}
}
/// A `switch`-like method, using callbacks.
///
/// As opposed to `map`, this offers destructuring.
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case Subclass2(:final field2):
///     return ...;
/// }
/// ```

@optionalTypeArgs TResult when<TResult extends Object?>(TResult Function( List<int> board,  String currentTurn,  String player1,  String player2,  String status,  int moveCount,  int consecutiveKingMoves,  int protocolVersion,  int stateVersion,  List<LegalMove> legalMoves,  List<AcceptedGameMove> moveHistory,  String? winnerId)  $default,) {final _that = this;
switch (_that) {
case _GameState():
return $default(_that.board,_that.currentTurn,_that.player1,_that.player2,_that.status,_that.moveCount,_that.consecutiveKingMoves,_that.protocolVersion,_that.stateVersion,_that.legalMoves,_that.moveHistory,_that.winnerId);case _:
  throw StateError('Unexpected subclass');

}
}
/// A variant of `when` that fallback to returning `null`
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case _:
///     return null;
/// }
/// ```

@optionalTypeArgs TResult? whenOrNull<TResult extends Object?>(TResult? Function( List<int> board,  String currentTurn,  String player1,  String player2,  String status,  int moveCount,  int consecutiveKingMoves,  int protocolVersion,  int stateVersion,  List<LegalMove> legalMoves,  List<AcceptedGameMove> moveHistory,  String? winnerId)?  $default,) {final _that = this;
switch (_that) {
case _GameState() when $default != null:
return $default(_that.board,_that.currentTurn,_that.player1,_that.player2,_that.status,_that.moveCount,_that.consecutiveKingMoves,_that.protocolVersion,_that.stateVersion,_that.legalMoves,_that.moveHistory,_that.winnerId);case _:
  return null;

}
}

}

/// @nodoc
@JsonSerializable()

class _GameState implements GameState {
  const _GameState({required  List<int> board, required this.currentTurn, required this.player1, required this.player2, required this.status, required this.moveCount, required this.consecutiveKingMoves, this.protocolVersion = 1, this.stateVersion = 0,  List<LegalMove> legalMoves = const [],  List<AcceptedGameMove> moveHistory = const [], this.winnerId}): _board = board,_legalMoves = legalMoves,_moveHistory = moveHistory;
  factory _GameState.fromJson(Map<String, dynamic> json) => _$GameStateFromJson(json);

 final  List<int> _board;
@override List<int> get board {
  if (_board is EqualUnmodifiableListView) return _board;
  // ignore: implicit_dynamic_type
  return EqualUnmodifiableListView(_board);
}

@override final  String currentTurn;
@override final  String player1;
@override final  String player2;
@override final  String status;
@override final  int moveCount;
@override final  int consecutiveKingMoves;
@override@JsonKey() final  int protocolVersion;
@override@JsonKey() final  int stateVersion;
 final  List<LegalMove> _legalMoves;
@override@JsonKey() List<LegalMove> get legalMoves {
  if (_legalMoves is EqualUnmodifiableListView) return _legalMoves;
  // ignore: implicit_dynamic_type
  return EqualUnmodifiableListView(_legalMoves);
}

 final  List<AcceptedGameMove> _moveHistory;
@override@JsonKey() List<AcceptedGameMove> get moveHistory {
  if (_moveHistory is EqualUnmodifiableListView) return _moveHistory;
  // ignore: implicit_dynamic_type
  return EqualUnmodifiableListView(_moveHistory);
}

@override final  String? winnerId;

/// Create a copy of GameState
/// with the given fields replaced by the non-null parameter values.
@override @JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
_$GameStateCopyWith<_GameState> get copyWith => __$GameStateCopyWithImpl<_GameState>(this, _$identity);

@override
Map<String, dynamic> toJson() {
  return _$GameStateToJson(this, );
}

@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is _GameState&&const DeepCollectionEquality().equals(other._board, _board)&&(identical(other.currentTurn, currentTurn) || other.currentTurn == currentTurn)&&(identical(other.player1, player1) || other.player1 == player1)&&(identical(other.player2, player2) || other.player2 == player2)&&(identical(other.status, status) || other.status == status)&&(identical(other.moveCount, moveCount) || other.moveCount == moveCount)&&(identical(other.consecutiveKingMoves, consecutiveKingMoves) || other.consecutiveKingMoves == consecutiveKingMoves)&&(identical(other.protocolVersion, protocolVersion) || other.protocolVersion == protocolVersion)&&(identical(other.stateVersion, stateVersion) || other.stateVersion == stateVersion)&&const DeepCollectionEquality().equals(other._legalMoves, _legalMoves)&&const DeepCollectionEquality().equals(other._moveHistory, _moveHistory)&&(identical(other.winnerId, winnerId) || other.winnerId == winnerId));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,const DeepCollectionEquality().hash(_board),currentTurn,player1,player2,status,moveCount,consecutiveKingMoves,protocolVersion,stateVersion,const DeepCollectionEquality().hash(_legalMoves),const DeepCollectionEquality().hash(_moveHistory),winnerId);

@override
String toString() {
  return 'GameState(board: $board, currentTurn: $currentTurn, player1: $player1, player2: $player2, status: $status, moveCount: $moveCount, consecutiveKingMoves: $consecutiveKingMoves, protocolVersion: $protocolVersion, stateVersion: $stateVersion, legalMoves: $legalMoves, moveHistory: $moveHistory, winnerId: $winnerId)';
}


}

/// @nodoc
abstract mixin class _$GameStateCopyWith<$Res> implements $GameStateCopyWith<$Res> {
  factory _$GameStateCopyWith(_GameState value, $Res Function(_GameState) _then) = __$GameStateCopyWithImpl;
@override @useResult
$Res call({
 List<int> board, String currentTurn, String player1, String player2, String status, int moveCount, int consecutiveKingMoves, int protocolVersion, int stateVersion, List<LegalMove> legalMoves, List<AcceptedGameMove> moveHistory, String? winnerId
});




}
/// @nodoc
class __$GameStateCopyWithImpl<$Res>
    implements _$GameStateCopyWith<$Res> {
  __$GameStateCopyWithImpl(this._self, this._then);

  final _GameState _self;
  final $Res Function(_GameState) _then;

/// Create a copy of GameState
/// with the given fields replaced by the non-null parameter values.
@override @pragma('vm:prefer-inline') $Res call({Object? board = null,Object? currentTurn = null,Object? player1 = null,Object? player2 = null,Object? status = null,Object? moveCount = null,Object? consecutiveKingMoves = null,Object? protocolVersion = null,Object? stateVersion = null,Object? legalMoves = null,Object? moveHistory = null,Object? winnerId = freezed,}) {
  return _then(_GameState(
board: null == board ? _self._board : board // ignore: cast_nullable_to_non_nullable
as List<int>,currentTurn: null == currentTurn ? _self.currentTurn : currentTurn // ignore: cast_nullable_to_non_nullable
as String,player1: null == player1 ? _self.player1 : player1 // ignore: cast_nullable_to_non_nullable
as String,player2: null == player2 ? _self.player2 : player2 // ignore: cast_nullable_to_non_nullable
as String,status: null == status ? _self.status : status // ignore: cast_nullable_to_non_nullable
as String,moveCount: null == moveCount ? _self.moveCount : moveCount // ignore: cast_nullable_to_non_nullable
as int,consecutiveKingMoves: null == consecutiveKingMoves ? _self.consecutiveKingMoves : consecutiveKingMoves // ignore: cast_nullable_to_non_nullable
as int,protocolVersion: null == protocolVersion ? _self.protocolVersion : protocolVersion // ignore: cast_nullable_to_non_nullable
as int,stateVersion: null == stateVersion ? _self.stateVersion : stateVersion // ignore: cast_nullable_to_non_nullable
as int,legalMoves: null == legalMoves ? _self._legalMoves : legalMoves // ignore: cast_nullable_to_non_nullable
as List<LegalMove>,moveHistory: null == moveHistory ? _self._moveHistory : moveHistory // ignore: cast_nullable_to_non_nullable
as List<AcceptedGameMove>,winnerId: freezed == winnerId ? _self.winnerId : winnerId // ignore: cast_nullable_to_non_nullable
as String?,
  ));
}


}


/// @nodoc
mixin _$LegalMove {

 int get from; int get to; List<int> get path; List<int> get capturedSquares; bool get promoted;
/// Create a copy of LegalMove
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$LegalMoveCopyWith<LegalMove> get copyWith => _$LegalMoveCopyWithImpl<LegalMove>(this as LegalMove, _$identity);

  /// Serializes this LegalMove to a JSON map.
  Map<String, dynamic> toJson();


@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is LegalMove&&(identical(other.from, from) || other.from == from)&&(identical(other.to, to) || other.to == to)&&const DeepCollectionEquality().equals(other.path, path)&&const DeepCollectionEquality().equals(other.capturedSquares, capturedSquares)&&(identical(other.promoted, promoted) || other.promoted == promoted));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,from,to,const DeepCollectionEquality().hash(path),const DeepCollectionEquality().hash(capturedSquares),promoted);

@override
String toString() {
  return 'LegalMove(from: $from, to: $to, path: $path, capturedSquares: $capturedSquares, promoted: $promoted)';
}


}

/// @nodoc
abstract mixin class $LegalMoveCopyWith<$Res>  {
  factory $LegalMoveCopyWith(LegalMove value, $Res Function(LegalMove) _then) = _$LegalMoveCopyWithImpl;
@useResult
$Res call({
 int from, int to, List<int> path, List<int> capturedSquares, bool promoted
});




}
/// @nodoc
class _$LegalMoveCopyWithImpl<$Res>
    implements $LegalMoveCopyWith<$Res> {
  _$LegalMoveCopyWithImpl(this._self, this._then);

  final LegalMove _self;
  final $Res Function(LegalMove) _then;

/// Create a copy of LegalMove
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') @override $Res call({Object? from = null,Object? to = null,Object? path = null,Object? capturedSquares = null,Object? promoted = null,}) {
  return _then(LegalMove(
from: null == from ? _self.from : from // ignore: cast_nullable_to_non_nullable
as int,to: null == to ? _self.to : to // ignore: cast_nullable_to_non_nullable
as int,path: null == path ? _self.path : path // ignore: cast_nullable_to_non_nullable
as List<int>,capturedSquares: null == capturedSquares ? _self.capturedSquares : capturedSquares // ignore: cast_nullable_to_non_nullable
as List<int>,promoted: null == promoted ? _self.promoted : promoted // ignore: cast_nullable_to_non_nullable
as bool,
  ));
}

}


/// Adds pattern-matching-related methods to [LegalMove].
extension LegalMovePatterns on LegalMove {
/// A variant of `map` that fallback to returning `orElse`.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case _:
///     return orElse();
/// }
/// ```

@optionalTypeArgs TResult maybeMap<TResult extends Object?>(TResult Function( _LegalMove value)?  $default,{required TResult orElse(),}){
final _that = this;
switch (_that) {
case _LegalMove() when $default != null:
return $default(_that);case _:
  return orElse();

}
}
/// A `switch`-like method, using callbacks.
///
/// Callbacks receives the raw object, upcasted.
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case final Subclass2 value:
///     return ...;
/// }
/// ```

@optionalTypeArgs TResult map<TResult extends Object?>(TResult Function( _LegalMove value)  $default,){
final _that = this;
switch (_that) {
case _LegalMove():
return $default(_that);case _:
  throw StateError('Unexpected subclass');

}
}
/// A variant of `map` that fallback to returning `null`.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case _:
///     return null;
/// }
/// ```

@optionalTypeArgs TResult? mapOrNull<TResult extends Object?>(TResult? Function( _LegalMove value)?  $default,){
final _that = this;
switch (_that) {
case _LegalMove() when $default != null:
return $default(_that);case _:
  return null;

}
}
/// A variant of `when` that fallback to an `orElse` callback.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case _:
///     return orElse();
/// }
/// ```

@optionalTypeArgs TResult maybeWhen<TResult extends Object?>(TResult Function( int from,  int to,  List<int> path,  List<int> capturedSquares,  bool promoted)?  $default,{required TResult orElse(),}) {final _that = this;
switch (_that) {
case _LegalMove() when $default != null:
return $default(_that.from,_that.to,_that.path,_that.capturedSquares,_that.promoted);case _:
  return orElse();

}
}
/// A `switch`-like method, using callbacks.
///
/// As opposed to `map`, this offers destructuring.
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case Subclass2(:final field2):
///     return ...;
/// }
/// ```

@optionalTypeArgs TResult when<TResult extends Object?>(TResult Function( int from,  int to,  List<int> path,  List<int> capturedSquares,  bool promoted)  $default,) {final _that = this;
switch (_that) {
case _LegalMove():
return $default(_that.from,_that.to,_that.path,_that.capturedSquares,_that.promoted);case _:
  throw StateError('Unexpected subclass');

}
}
/// A variant of `when` that fallback to returning `null`
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case _:
///     return null;
/// }
/// ```

@optionalTypeArgs TResult? whenOrNull<TResult extends Object?>(TResult? Function( int from,  int to,  List<int> path,  List<int> capturedSquares,  bool promoted)?  $default,) {final _that = this;
switch (_that) {
case _LegalMove() when $default != null:
return $default(_that.from,_that.to,_that.path,_that.capturedSquares,_that.promoted);case _:
  return null;

}
}

}

/// @nodoc
@JsonSerializable()

class _LegalMove implements LegalMove {
  const _LegalMove({required this.from, required this.to,  List<int> path = const [],  List<int> capturedSquares = const [], this.promoted = false}): _path = path,_capturedSquares = capturedSquares;
  factory _LegalMove.fromJson(Map<String, dynamic> json) => _$LegalMoveFromJson(json);

@override final  int from;
@override final  int to;
 final  List<int> _path;
@override@JsonKey() List<int> get path {
  if (_path is EqualUnmodifiableListView) return _path;
  // ignore: implicit_dynamic_type
  return EqualUnmodifiableListView(_path);
}

 final  List<int> _capturedSquares;
@override@JsonKey() List<int> get capturedSquares {
  if (_capturedSquares is EqualUnmodifiableListView) return _capturedSquares;
  // ignore: implicit_dynamic_type
  return EqualUnmodifiableListView(_capturedSquares);
}

@override@JsonKey() final  bool promoted;

/// Create a copy of LegalMove
/// with the given fields replaced by the non-null parameter values.
@override @JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
_$LegalMoveCopyWith<_LegalMove> get copyWith => __$LegalMoveCopyWithImpl<_LegalMove>(this, _$identity);

@override
Map<String, dynamic> toJson() {
  return _$LegalMoveToJson(this, );
}

@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is _LegalMove&&(identical(other.from, from) || other.from == from)&&(identical(other.to, to) || other.to == to)&&const DeepCollectionEquality().equals(other._path, _path)&&const DeepCollectionEquality().equals(other._capturedSquares, _capturedSquares)&&(identical(other.promoted, promoted) || other.promoted == promoted));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,from,to,const DeepCollectionEquality().hash(_path),const DeepCollectionEquality().hash(_capturedSquares),promoted);

@override
String toString() {
  return 'LegalMove(from: $from, to: $to, path: $path, capturedSquares: $capturedSquares, promoted: $promoted)';
}


}

/// @nodoc
abstract mixin class _$LegalMoveCopyWith<$Res> implements $LegalMoveCopyWith<$Res> {
  factory _$LegalMoveCopyWith(_LegalMove value, $Res Function(_LegalMove) _then) = __$LegalMoveCopyWithImpl;
@override @useResult
$Res call({
 int from, int to, List<int> path, List<int> capturedSquares, bool promoted
});




}
/// @nodoc
class __$LegalMoveCopyWithImpl<$Res>
    implements _$LegalMoveCopyWith<$Res> {
  __$LegalMoveCopyWithImpl(this._self, this._then);

  final _LegalMove _self;
  final $Res Function(_LegalMove) _then;

/// Create a copy of LegalMove
/// with the given fields replaced by the non-null parameter values.
@override @pragma('vm:prefer-inline') $Res call({Object? from = null,Object? to = null,Object? path = null,Object? capturedSquares = null,Object? promoted = null,}) {
  return _then(_LegalMove(
from: null == from ? _self.from : from // ignore: cast_nullable_to_non_nullable
as int,to: null == to ? _self.to : to // ignore: cast_nullable_to_non_nullable
as int,path: null == path ? _self._path : path // ignore: cast_nullable_to_non_nullable
as List<int>,capturedSquares: null == capturedSquares ? _self._capturedSquares : capturedSquares // ignore: cast_nullable_to_non_nullable
as List<int>,promoted: null == promoted ? _self.promoted : promoted // ignore: cast_nullable_to_non_nullable
as bool,
  ));
}


}


/// @nodoc
mixin _$AcceptedGameMove {

 int get sequence; String get clientMoveId; int get from; List<int> get path; List<int> get capturedSquares; bool get promoted; int get stateVersion; String? get side;
/// Create a copy of AcceptedGameMove
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$AcceptedGameMoveCopyWith<AcceptedGameMove> get copyWith => _$AcceptedGameMoveCopyWithImpl<AcceptedGameMove>(this as AcceptedGameMove, _$identity);

  /// Serializes this AcceptedGameMove to a JSON map.
  Map<String, dynamic> toJson();


@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is AcceptedGameMove&&(identical(other.sequence, sequence) || other.sequence == sequence)&&(identical(other.clientMoveId, clientMoveId) || other.clientMoveId == clientMoveId)&&(identical(other.from, from) || other.from == from)&&const DeepCollectionEquality().equals(other.path, path)&&const DeepCollectionEquality().equals(other.capturedSquares, capturedSquares)&&(identical(other.promoted, promoted) || other.promoted == promoted)&&(identical(other.stateVersion, stateVersion) || other.stateVersion == stateVersion)&&(identical(other.side, side) || other.side == side));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,sequence,clientMoveId,from,const DeepCollectionEquality().hash(path),const DeepCollectionEquality().hash(capturedSquares),promoted,stateVersion,side);

@override
String toString() {
  return 'AcceptedGameMove(sequence: $sequence, clientMoveId: $clientMoveId, from: $from, path: $path, capturedSquares: $capturedSquares, promoted: $promoted, stateVersion: $stateVersion, side: $side)';
}


}

/// @nodoc
abstract mixin class $AcceptedGameMoveCopyWith<$Res>  {
  factory $AcceptedGameMoveCopyWith(AcceptedGameMove value, $Res Function(AcceptedGameMove) _then) = _$AcceptedGameMoveCopyWithImpl;
@useResult
$Res call({
 int sequence, String clientMoveId, int from, List<int> path, List<int> capturedSquares, bool promoted, int stateVersion, String? side
});




}
/// @nodoc
class _$AcceptedGameMoveCopyWithImpl<$Res>
    implements $AcceptedGameMoveCopyWith<$Res> {
  _$AcceptedGameMoveCopyWithImpl(this._self, this._then);

  final AcceptedGameMove _self;
  final $Res Function(AcceptedGameMove) _then;

/// Create a copy of AcceptedGameMove
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') @override $Res call({Object? sequence = null,Object? clientMoveId = null,Object? from = null,Object? path = null,Object? capturedSquares = null,Object? promoted = null,Object? stateVersion = null,Object? side = freezed,}) {
  return _then(AcceptedGameMove(
sequence: null == sequence ? _self.sequence : sequence // ignore: cast_nullable_to_non_nullable
as int,clientMoveId: null == clientMoveId ? _self.clientMoveId : clientMoveId // ignore: cast_nullable_to_non_nullable
as String,from: null == from ? _self.from : from // ignore: cast_nullable_to_non_nullable
as int,path: null == path ? _self.path : path // ignore: cast_nullable_to_non_nullable
as List<int>,capturedSquares: null == capturedSquares ? _self.capturedSquares : capturedSquares // ignore: cast_nullable_to_non_nullable
as List<int>,promoted: null == promoted ? _self.promoted : promoted // ignore: cast_nullable_to_non_nullable
as bool,stateVersion: null == stateVersion ? _self.stateVersion : stateVersion // ignore: cast_nullable_to_non_nullable
as int,side: freezed == side ? _self.side : side // ignore: cast_nullable_to_non_nullable
as String?,
  ));
}

}


/// Adds pattern-matching-related methods to [AcceptedGameMove].
extension AcceptedGameMovePatterns on AcceptedGameMove {
/// A variant of `map` that fallback to returning `orElse`.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case _:
///     return orElse();
/// }
/// ```

@optionalTypeArgs TResult maybeMap<TResult extends Object?>(TResult Function( _AcceptedGameMove value)?  $default,{required TResult orElse(),}){
final _that = this;
switch (_that) {
case _AcceptedGameMove() when $default != null:
return $default(_that);case _:
  return orElse();

}
}
/// A `switch`-like method, using callbacks.
///
/// Callbacks receives the raw object, upcasted.
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case final Subclass2 value:
///     return ...;
/// }
/// ```

@optionalTypeArgs TResult map<TResult extends Object?>(TResult Function( _AcceptedGameMove value)  $default,){
final _that = this;
switch (_that) {
case _AcceptedGameMove():
return $default(_that);case _:
  throw StateError('Unexpected subclass');

}
}
/// A variant of `map` that fallback to returning `null`.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case _:
///     return null;
/// }
/// ```

@optionalTypeArgs TResult? mapOrNull<TResult extends Object?>(TResult? Function( _AcceptedGameMove value)?  $default,){
final _that = this;
switch (_that) {
case _AcceptedGameMove() when $default != null:
return $default(_that);case _:
  return null;

}
}
/// A variant of `when` that fallback to an `orElse` callback.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case _:
///     return orElse();
/// }
/// ```

@optionalTypeArgs TResult maybeWhen<TResult extends Object?>(TResult Function( int sequence,  String clientMoveId,  int from,  List<int> path,  List<int> capturedSquares,  bool promoted,  int stateVersion,  String? side)?  $default,{required TResult orElse(),}) {final _that = this;
switch (_that) {
case _AcceptedGameMove() when $default != null:
return $default(_that.sequence,_that.clientMoveId,_that.from,_that.path,_that.capturedSquares,_that.promoted,_that.stateVersion,_that.side);case _:
  return orElse();

}
}
/// A `switch`-like method, using callbacks.
///
/// As opposed to `map`, this offers destructuring.
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case Subclass2(:final field2):
///     return ...;
/// }
/// ```

@optionalTypeArgs TResult when<TResult extends Object?>(TResult Function( int sequence,  String clientMoveId,  int from,  List<int> path,  List<int> capturedSquares,  bool promoted,  int stateVersion,  String? side)  $default,) {final _that = this;
switch (_that) {
case _AcceptedGameMove():
return $default(_that.sequence,_that.clientMoveId,_that.from,_that.path,_that.capturedSquares,_that.promoted,_that.stateVersion,_that.side);case _:
  throw StateError('Unexpected subclass');

}
}
/// A variant of `when` that fallback to returning `null`
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case _:
///     return null;
/// }
/// ```

@optionalTypeArgs TResult? whenOrNull<TResult extends Object?>(TResult? Function( int sequence,  String clientMoveId,  int from,  List<int> path,  List<int> capturedSquares,  bool promoted,  int stateVersion,  String? side)?  $default,) {final _that = this;
switch (_that) {
case _AcceptedGameMove() when $default != null:
return $default(_that.sequence,_that.clientMoveId,_that.from,_that.path,_that.capturedSquares,_that.promoted,_that.stateVersion,_that.side);case _:
  return null;

}
}

}

/// @nodoc
@JsonSerializable()

class _AcceptedGameMove implements AcceptedGameMove {
  const _AcceptedGameMove({this.sequence = 0, this.clientMoveId = '', required this.from,  List<int> path = const [],  List<int> capturedSquares = const [], this.promoted = false, this.stateVersion = 0, this.side}): _path = path,_capturedSquares = capturedSquares;
  factory _AcceptedGameMove.fromJson(Map<String, dynamic> json) => _$AcceptedGameMoveFromJson(json);

@override@JsonKey() final  int sequence;
@override@JsonKey() final  String clientMoveId;
@override final  int from;
 final  List<int> _path;
@override@JsonKey() List<int> get path {
  if (_path is EqualUnmodifiableListView) return _path;
  // ignore: implicit_dynamic_type
  return EqualUnmodifiableListView(_path);
}

 final  List<int> _capturedSquares;
@override@JsonKey() List<int> get capturedSquares {
  if (_capturedSquares is EqualUnmodifiableListView) return _capturedSquares;
  // ignore: implicit_dynamic_type
  return EqualUnmodifiableListView(_capturedSquares);
}

@override@JsonKey() final  bool promoted;
@override@JsonKey() final  int stateVersion;
@override final  String? side;

/// Create a copy of AcceptedGameMove
/// with the given fields replaced by the non-null parameter values.
@override @JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
_$AcceptedGameMoveCopyWith<_AcceptedGameMove> get copyWith => __$AcceptedGameMoveCopyWithImpl<_AcceptedGameMove>(this, _$identity);

@override
Map<String, dynamic> toJson() {
  return _$AcceptedGameMoveToJson(this, );
}

@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is _AcceptedGameMove&&(identical(other.sequence, sequence) || other.sequence == sequence)&&(identical(other.clientMoveId, clientMoveId) || other.clientMoveId == clientMoveId)&&(identical(other.from, from) || other.from == from)&&const DeepCollectionEquality().equals(other._path, _path)&&const DeepCollectionEquality().equals(other._capturedSquares, _capturedSquares)&&(identical(other.promoted, promoted) || other.promoted == promoted)&&(identical(other.stateVersion, stateVersion) || other.stateVersion == stateVersion)&&(identical(other.side, side) || other.side == side));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,sequence,clientMoveId,from,const DeepCollectionEquality().hash(_path),const DeepCollectionEquality().hash(_capturedSquares),promoted,stateVersion,side);

@override
String toString() {
  return 'AcceptedGameMove(sequence: $sequence, clientMoveId: $clientMoveId, from: $from, path: $path, capturedSquares: $capturedSquares, promoted: $promoted, stateVersion: $stateVersion, side: $side)';
}


}

/// @nodoc
abstract mixin class _$AcceptedGameMoveCopyWith<$Res> implements $AcceptedGameMoveCopyWith<$Res> {
  factory _$AcceptedGameMoveCopyWith(_AcceptedGameMove value, $Res Function(_AcceptedGameMove) _then) = __$AcceptedGameMoveCopyWithImpl;
@override @useResult
$Res call({
 int sequence, String clientMoveId, int from, List<int> path, List<int> capturedSquares, bool promoted, int stateVersion, String? side
});




}
/// @nodoc
class __$AcceptedGameMoveCopyWithImpl<$Res>
    implements _$AcceptedGameMoveCopyWith<$Res> {
  __$AcceptedGameMoveCopyWithImpl(this._self, this._then);

  final _AcceptedGameMove _self;
  final $Res Function(_AcceptedGameMove) _then;

/// Create a copy of AcceptedGameMove
/// with the given fields replaced by the non-null parameter values.
@override @pragma('vm:prefer-inline') $Res call({Object? sequence = null,Object? clientMoveId = null,Object? from = null,Object? path = null,Object? capturedSquares = null,Object? promoted = null,Object? stateVersion = null,Object? side = freezed,}) {
  return _then(_AcceptedGameMove(
sequence: null == sequence ? _self.sequence : sequence // ignore: cast_nullable_to_non_nullable
as int,clientMoveId: null == clientMoveId ? _self.clientMoveId : clientMoveId // ignore: cast_nullable_to_non_nullable
as String,from: null == from ? _self.from : from // ignore: cast_nullable_to_non_nullable
as int,path: null == path ? _self._path : path // ignore: cast_nullable_to_non_nullable
as List<int>,capturedSquares: null == capturedSquares ? _self._capturedSquares : capturedSquares // ignore: cast_nullable_to_non_nullable
as List<int>,promoted: null == promoted ? _self.promoted : promoted // ignore: cast_nullable_to_non_nullable
as bool,stateVersion: null == stateVersion ? _self.stateVersion : stateVersion // ignore: cast_nullable_to_non_nullable
as int,side: freezed == side ? _self.side : side // ignore: cast_nullable_to_non_nullable
as String?,
  ));
}


}


/// @nodoc
mixin _$MoveAppliedEvent {

 int get from; int get to; List<int> get path; List<int> get board; List<int> get captured; bool get promoted; String get nextTurn; bool get gameEnded; String? get clientMoveId; int? get stateVersion; String? get reason; List<LegalMove> get legalMoves;
/// Create a copy of MoveAppliedEvent
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$MoveAppliedEventCopyWith<MoveAppliedEvent> get copyWith => _$MoveAppliedEventCopyWithImpl<MoveAppliedEvent>(this as MoveAppliedEvent, _$identity);

  /// Serializes this MoveAppliedEvent to a JSON map.
  Map<String, dynamic> toJson();


@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is MoveAppliedEvent&&(identical(other.from, from) || other.from == from)&&(identical(other.to, to) || other.to == to)&&const DeepCollectionEquality().equals(other.path, path)&&const DeepCollectionEquality().equals(other.board, board)&&const DeepCollectionEquality().equals(other.captured, captured)&&(identical(other.promoted, promoted) || other.promoted == promoted)&&(identical(other.nextTurn, nextTurn) || other.nextTurn == nextTurn)&&(identical(other.gameEnded, gameEnded) || other.gameEnded == gameEnded)&&(identical(other.clientMoveId, clientMoveId) || other.clientMoveId == clientMoveId)&&(identical(other.stateVersion, stateVersion) || other.stateVersion == stateVersion)&&(identical(other.reason, reason) || other.reason == reason)&&const DeepCollectionEquality().equals(other.legalMoves, legalMoves));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,from,to,const DeepCollectionEquality().hash(path),const DeepCollectionEquality().hash(board),const DeepCollectionEquality().hash(captured),promoted,nextTurn,gameEnded,clientMoveId,stateVersion,reason,const DeepCollectionEquality().hash(legalMoves));

@override
String toString() {
  return 'MoveAppliedEvent(from: $from, to: $to, path: $path, board: $board, captured: $captured, promoted: $promoted, nextTurn: $nextTurn, gameEnded: $gameEnded, clientMoveId: $clientMoveId, stateVersion: $stateVersion, reason: $reason, legalMoves: $legalMoves)';
}


}

/// @nodoc
abstract mixin class $MoveAppliedEventCopyWith<$Res>  {
  factory $MoveAppliedEventCopyWith(MoveAppliedEvent value, $Res Function(MoveAppliedEvent) _then) = _$MoveAppliedEventCopyWithImpl;
@useResult
$Res call({
 int from, int to, List<int> path, List<int> board, List<int> captured, bool promoted, String nextTurn, bool gameEnded, String? clientMoveId, int? stateVersion, String? reason, List<LegalMove> legalMoves
});




}
/// @nodoc
class _$MoveAppliedEventCopyWithImpl<$Res>
    implements $MoveAppliedEventCopyWith<$Res> {
  _$MoveAppliedEventCopyWithImpl(this._self, this._then);

  final MoveAppliedEvent _self;
  final $Res Function(MoveAppliedEvent) _then;

/// Create a copy of MoveAppliedEvent
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') @override $Res call({Object? from = null,Object? to = null,Object? path = null,Object? board = null,Object? captured = null,Object? promoted = null,Object? nextTurn = null,Object? gameEnded = null,Object? clientMoveId = freezed,Object? stateVersion = freezed,Object? reason = freezed,Object? legalMoves = null,}) {
  return _then(MoveAppliedEvent(
from: null == from ? _self.from : from // ignore: cast_nullable_to_non_nullable
as int,to: null == to ? _self.to : to // ignore: cast_nullable_to_non_nullable
as int,path: null == path ? _self.path : path // ignore: cast_nullable_to_non_nullable
as List<int>,board: null == board ? _self.board : board // ignore: cast_nullable_to_non_nullable
as List<int>,captured: null == captured ? _self.captured : captured // ignore: cast_nullable_to_non_nullable
as List<int>,promoted: null == promoted ? _self.promoted : promoted // ignore: cast_nullable_to_non_nullable
as bool,nextTurn: null == nextTurn ? _self.nextTurn : nextTurn // ignore: cast_nullable_to_non_nullable
as String,gameEnded: null == gameEnded ? _self.gameEnded : gameEnded // ignore: cast_nullable_to_non_nullable
as bool,clientMoveId: freezed == clientMoveId ? _self.clientMoveId : clientMoveId // ignore: cast_nullable_to_non_nullable
as String?,stateVersion: freezed == stateVersion ? _self.stateVersion : stateVersion // ignore: cast_nullable_to_non_nullable
as int?,reason: freezed == reason ? _self.reason : reason // ignore: cast_nullable_to_non_nullable
as String?,legalMoves: null == legalMoves ? _self.legalMoves : legalMoves // ignore: cast_nullable_to_non_nullable
as List<LegalMove>,
  ));
}

}


/// Adds pattern-matching-related methods to [MoveAppliedEvent].
extension MoveAppliedEventPatterns on MoveAppliedEvent {
/// A variant of `map` that fallback to returning `orElse`.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case _:
///     return orElse();
/// }
/// ```

@optionalTypeArgs TResult maybeMap<TResult extends Object?>(TResult Function( _MoveAppliedEvent value)?  $default,{required TResult orElse(),}){
final _that = this;
switch (_that) {
case _MoveAppliedEvent() when $default != null:
return $default(_that);case _:
  return orElse();

}
}
/// A `switch`-like method, using callbacks.
///
/// Callbacks receives the raw object, upcasted.
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case final Subclass2 value:
///     return ...;
/// }
/// ```

@optionalTypeArgs TResult map<TResult extends Object?>(TResult Function( _MoveAppliedEvent value)  $default,){
final _that = this;
switch (_that) {
case _MoveAppliedEvent():
return $default(_that);case _:
  throw StateError('Unexpected subclass');

}
}
/// A variant of `map` that fallback to returning `null`.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case _:
///     return null;
/// }
/// ```

@optionalTypeArgs TResult? mapOrNull<TResult extends Object?>(TResult? Function( _MoveAppliedEvent value)?  $default,){
final _that = this;
switch (_that) {
case _MoveAppliedEvent() when $default != null:
return $default(_that);case _:
  return null;

}
}
/// A variant of `when` that fallback to an `orElse` callback.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case _:
///     return orElse();
/// }
/// ```

@optionalTypeArgs TResult maybeWhen<TResult extends Object?>(TResult Function( int from,  int to,  List<int> path,  List<int> board,  List<int> captured,  bool promoted,  String nextTurn,  bool gameEnded,  String? clientMoveId,  int? stateVersion,  String? reason,  List<LegalMove> legalMoves)?  $default,{required TResult orElse(),}) {final _that = this;
switch (_that) {
case _MoveAppliedEvent() when $default != null:
return $default(_that.from,_that.to,_that.path,_that.board,_that.captured,_that.promoted,_that.nextTurn,_that.gameEnded,_that.clientMoveId,_that.stateVersion,_that.reason,_that.legalMoves);case _:
  return orElse();

}
}
/// A `switch`-like method, using callbacks.
///
/// As opposed to `map`, this offers destructuring.
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case Subclass2(:final field2):
///     return ...;
/// }
/// ```

@optionalTypeArgs TResult when<TResult extends Object?>(TResult Function( int from,  int to,  List<int> path,  List<int> board,  List<int> captured,  bool promoted,  String nextTurn,  bool gameEnded,  String? clientMoveId,  int? stateVersion,  String? reason,  List<LegalMove> legalMoves)  $default,) {final _that = this;
switch (_that) {
case _MoveAppliedEvent():
return $default(_that.from,_that.to,_that.path,_that.board,_that.captured,_that.promoted,_that.nextTurn,_that.gameEnded,_that.clientMoveId,_that.stateVersion,_that.reason,_that.legalMoves);case _:
  throw StateError('Unexpected subclass');

}
}
/// A variant of `when` that fallback to returning `null`
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case _:
///     return null;
/// }
/// ```

@optionalTypeArgs TResult? whenOrNull<TResult extends Object?>(TResult? Function( int from,  int to,  List<int> path,  List<int> board,  List<int> captured,  bool promoted,  String nextTurn,  bool gameEnded,  String? clientMoveId,  int? stateVersion,  String? reason,  List<LegalMove> legalMoves)?  $default,) {final _that = this;
switch (_that) {
case _MoveAppliedEvent() when $default != null:
return $default(_that.from,_that.to,_that.path,_that.board,_that.captured,_that.promoted,_that.nextTurn,_that.gameEnded,_that.clientMoveId,_that.stateVersion,_that.reason,_that.legalMoves);case _:
  return null;

}
}

}

/// @nodoc
@JsonSerializable()

class _MoveAppliedEvent implements MoveAppliedEvent {
  const _MoveAppliedEvent({required this.from, required this.to,  List<int> path = const [],  List<int> board = const [],  List<int> captured = const [], this.promoted = false, this.nextTurn = '', this.gameEnded = false, this.clientMoveId, this.stateVersion, this.reason,  List<LegalMove> legalMoves = const []}): _path = path,_board = board,_captured = captured,_legalMoves = legalMoves;
  factory _MoveAppliedEvent.fromJson(Map<String, dynamic> json) => _$MoveAppliedEventFromJson(json);

@override final  int from;
@override final  int to;
 final  List<int> _path;
@override@JsonKey() List<int> get path {
  if (_path is EqualUnmodifiableListView) return _path;
  // ignore: implicit_dynamic_type
  return EqualUnmodifiableListView(_path);
}

 final  List<int> _board;
@override@JsonKey() List<int> get board {
  if (_board is EqualUnmodifiableListView) return _board;
  // ignore: implicit_dynamic_type
  return EqualUnmodifiableListView(_board);
}

 final  List<int> _captured;
@override@JsonKey() List<int> get captured {
  if (_captured is EqualUnmodifiableListView) return _captured;
  // ignore: implicit_dynamic_type
  return EqualUnmodifiableListView(_captured);
}

@override@JsonKey() final  bool promoted;
@override@JsonKey() final  String nextTurn;
@override@JsonKey() final  bool gameEnded;
@override final  String? clientMoveId;
@override final  int? stateVersion;
@override final  String? reason;
 final  List<LegalMove> _legalMoves;
@override@JsonKey() List<LegalMove> get legalMoves {
  if (_legalMoves is EqualUnmodifiableListView) return _legalMoves;
  // ignore: implicit_dynamic_type
  return EqualUnmodifiableListView(_legalMoves);
}


/// Create a copy of MoveAppliedEvent
/// with the given fields replaced by the non-null parameter values.
@override @JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
_$MoveAppliedEventCopyWith<_MoveAppliedEvent> get copyWith => __$MoveAppliedEventCopyWithImpl<_MoveAppliedEvent>(this, _$identity);

@override
Map<String, dynamic> toJson() {
  return _$MoveAppliedEventToJson(this, );
}

@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is _MoveAppliedEvent&&(identical(other.from, from) || other.from == from)&&(identical(other.to, to) || other.to == to)&&const DeepCollectionEquality().equals(other._path, _path)&&const DeepCollectionEquality().equals(other._board, _board)&&const DeepCollectionEquality().equals(other._captured, _captured)&&(identical(other.promoted, promoted) || other.promoted == promoted)&&(identical(other.nextTurn, nextTurn) || other.nextTurn == nextTurn)&&(identical(other.gameEnded, gameEnded) || other.gameEnded == gameEnded)&&(identical(other.clientMoveId, clientMoveId) || other.clientMoveId == clientMoveId)&&(identical(other.stateVersion, stateVersion) || other.stateVersion == stateVersion)&&(identical(other.reason, reason) || other.reason == reason)&&const DeepCollectionEquality().equals(other._legalMoves, _legalMoves));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,from,to,const DeepCollectionEquality().hash(_path),const DeepCollectionEquality().hash(_board),const DeepCollectionEquality().hash(_captured),promoted,nextTurn,gameEnded,clientMoveId,stateVersion,reason,const DeepCollectionEquality().hash(_legalMoves));

@override
String toString() {
  return 'MoveAppliedEvent(from: $from, to: $to, path: $path, board: $board, captured: $captured, promoted: $promoted, nextTurn: $nextTurn, gameEnded: $gameEnded, clientMoveId: $clientMoveId, stateVersion: $stateVersion, reason: $reason, legalMoves: $legalMoves)';
}


}

/// @nodoc
abstract mixin class _$MoveAppliedEventCopyWith<$Res> implements $MoveAppliedEventCopyWith<$Res> {
  factory _$MoveAppliedEventCopyWith(_MoveAppliedEvent value, $Res Function(_MoveAppliedEvent) _then) = __$MoveAppliedEventCopyWithImpl;
@override @useResult
$Res call({
 int from, int to, List<int> path, List<int> board, List<int> captured, bool promoted, String nextTurn, bool gameEnded, String? clientMoveId, int? stateVersion, String? reason, List<LegalMove> legalMoves
});




}
/// @nodoc
class __$MoveAppliedEventCopyWithImpl<$Res>
    implements _$MoveAppliedEventCopyWith<$Res> {
  __$MoveAppliedEventCopyWithImpl(this._self, this._then);

  final _MoveAppliedEvent _self;
  final $Res Function(_MoveAppliedEvent) _then;

/// Create a copy of MoveAppliedEvent
/// with the given fields replaced by the non-null parameter values.
@override @pragma('vm:prefer-inline') $Res call({Object? from = null,Object? to = null,Object? path = null,Object? board = null,Object? captured = null,Object? promoted = null,Object? nextTurn = null,Object? gameEnded = null,Object? clientMoveId = freezed,Object? stateVersion = freezed,Object? reason = freezed,Object? legalMoves = null,}) {
  return _then(_MoveAppliedEvent(
from: null == from ? _self.from : from // ignore: cast_nullable_to_non_nullable
as int,to: null == to ? _self.to : to // ignore: cast_nullable_to_non_nullable
as int,path: null == path ? _self._path : path // ignore: cast_nullable_to_non_nullable
as List<int>,board: null == board ? _self._board : board // ignore: cast_nullable_to_non_nullable
as List<int>,captured: null == captured ? _self._captured : captured // ignore: cast_nullable_to_non_nullable
as List<int>,promoted: null == promoted ? _self.promoted : promoted // ignore: cast_nullable_to_non_nullable
as bool,nextTurn: null == nextTurn ? _self.nextTurn : nextTurn // ignore: cast_nullable_to_non_nullable
as String,gameEnded: null == gameEnded ? _self.gameEnded : gameEnded // ignore: cast_nullable_to_non_nullable
as bool,clientMoveId: freezed == clientMoveId ? _self.clientMoveId : clientMoveId // ignore: cast_nullable_to_non_nullable
as String?,stateVersion: freezed == stateVersion ? _self.stateVersion : stateVersion // ignore: cast_nullable_to_non_nullable
as int?,reason: freezed == reason ? _self.reason : reason // ignore: cast_nullable_to_non_nullable
as String?,legalMoves: null == legalMoves ? _self._legalMoves : legalMoves // ignore: cast_nullable_to_non_nullable
as List<LegalMove>,
  ));
}


}

// dart format on
