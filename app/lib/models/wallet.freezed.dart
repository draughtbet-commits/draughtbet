// GENERATED CODE - DO NOT MODIFY BY HAND
// coverage:ignore-file
// ignore_for_file: type=lint, type=warning, deprecated_member_use, deprecated_member_use_from_same_package
// ignore_for_file: unused_element, deprecated_member_use, deprecated_member_use_from_same_package, use_function_type_syntax_for_parameters, unnecessary_const, avoid_init_to_null, invalid_override_different_default_values_named, prefer_expression_function_bodies, annotate_overrides, invalid_annotation_target, unnecessary_question_mark

part of 'wallet.dart';

// **************************************************************************
// FreezedGenerator
// **************************************************************************

// GENERATED CODE - DO NOT MODIFY BY HAND
// dart format off
T _$identity<T>(T value) => value;

/// @nodoc
mixin _$Wallet {

 String get balance;
/// Create a copy of Wallet
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$WalletCopyWith<Wallet> get copyWith => _$WalletCopyWithImpl<Wallet>(this as Wallet, _$identity);

  /// Serializes this Wallet to a JSON map.
  Map<String, dynamic> toJson();


@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is Wallet&&(identical(other.balance, balance) || other.balance == balance));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,balance);

@override
String toString() {
  return 'Wallet(balance: $balance)';
}


}

/// @nodoc
abstract mixin class $WalletCopyWith<$Res>  {
  factory $WalletCopyWith(Wallet value, $Res Function(Wallet) _then) = _$WalletCopyWithImpl;
@useResult
$Res call({
 String balance
});




}
/// @nodoc
class _$WalletCopyWithImpl<$Res>
    implements $WalletCopyWith<$Res> {
  _$WalletCopyWithImpl(this._self, this._then);

  final Wallet _self;
  final $Res Function(Wallet) _then;

/// Create a copy of Wallet
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') @override $Res call({Object? balance = null,}) {
  return _then(Wallet(
balance: null == balance ? _self.balance : balance // ignore: cast_nullable_to_non_nullable
as String,
  ));
}

}


/// Adds pattern-matching-related methods to [Wallet].
extension WalletPatterns on Wallet {
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

@optionalTypeArgs TResult maybeMap<TResult extends Object?>(TResult Function( _Wallet value)?  $default,{required TResult orElse(),}){
final _that = this;
switch (_that) {
case _Wallet() when $default != null:
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

@optionalTypeArgs TResult map<TResult extends Object?>(TResult Function( _Wallet value)  $default,){
final _that = this;
switch (_that) {
case _Wallet():
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

@optionalTypeArgs TResult? mapOrNull<TResult extends Object?>(TResult? Function( _Wallet value)?  $default,){
final _that = this;
switch (_that) {
case _Wallet() when $default != null:
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

@optionalTypeArgs TResult maybeWhen<TResult extends Object?>(TResult Function( String balance)?  $default,{required TResult orElse(),}) {final _that = this;
switch (_that) {
case _Wallet() when $default != null:
return $default(_that.balance);case _:
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

@optionalTypeArgs TResult when<TResult extends Object?>(TResult Function( String balance)  $default,) {final _that = this;
switch (_that) {
case _Wallet():
return $default(_that.balance);case _:
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

@optionalTypeArgs TResult? whenOrNull<TResult extends Object?>(TResult? Function( String balance)?  $default,) {final _that = this;
switch (_that) {
case _Wallet() when $default != null:
return $default(_that.balance);case _:
  return null;

}
}

}

/// @nodoc
@JsonSerializable()

class _Wallet implements Wallet {
  const _Wallet({required this.balance});
  factory _Wallet.fromJson(Map<String, dynamic> json) => _$WalletFromJson(json);

@override final  String balance;

/// Create a copy of Wallet
/// with the given fields replaced by the non-null parameter values.
@override @JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
_$WalletCopyWith<_Wallet> get copyWith => __$WalletCopyWithImpl<_Wallet>(this, _$identity);

@override
Map<String, dynamic> toJson() {
  return _$WalletToJson(this, );
}

@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is _Wallet&&(identical(other.balance, balance) || other.balance == balance));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,balance);

@override
String toString() {
  return 'Wallet(balance: $balance)';
}


}

/// @nodoc
abstract mixin class _$WalletCopyWith<$Res> implements $WalletCopyWith<$Res> {
  factory _$WalletCopyWith(_Wallet value, $Res Function(_Wallet) _then) = __$WalletCopyWithImpl;
@override @useResult
$Res call({
 String balance
});




}
/// @nodoc
class __$WalletCopyWithImpl<$Res>
    implements _$WalletCopyWith<$Res> {
  __$WalletCopyWithImpl(this._self, this._then);

  final _Wallet _self;
  final $Res Function(_Wallet) _then;

/// Create a copy of Wallet
/// with the given fields replaced by the non-null parameter values.
@override @pragma('vm:prefer-inline') $Res call({Object? balance = null,}) {
  return _then(_Wallet(
balance: null == balance ? _self.balance : balance // ignore: cast_nullable_to_non_nullable
as String,
  ));
}


}


/// @nodoc
mixin _$TierLimits {

 String get tier; String get stakeMin; String get stakeMax; String get calloutMax;
/// Create a copy of TierLimits
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$TierLimitsCopyWith<TierLimits> get copyWith => _$TierLimitsCopyWithImpl<TierLimits>(this as TierLimits, _$identity);

  /// Serializes this TierLimits to a JSON map.
  Map<String, dynamic> toJson();


@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is TierLimits&&(identical(other.tier, tier) || other.tier == tier)&&(identical(other.stakeMin, stakeMin) || other.stakeMin == stakeMin)&&(identical(other.stakeMax, stakeMax) || other.stakeMax == stakeMax)&&(identical(other.calloutMax, calloutMax) || other.calloutMax == calloutMax));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,tier,stakeMin,stakeMax,calloutMax);

@override
String toString() {
  return 'TierLimits(tier: $tier, stakeMin: $stakeMin, stakeMax: $stakeMax, calloutMax: $calloutMax)';
}


}

/// @nodoc
abstract mixin class $TierLimitsCopyWith<$Res>  {
  factory $TierLimitsCopyWith(TierLimits value, $Res Function(TierLimits) _then) = _$TierLimitsCopyWithImpl;
@useResult
$Res call({
 String tier, String stakeMin, String stakeMax, String calloutMax
});




}
/// @nodoc
class _$TierLimitsCopyWithImpl<$Res>
    implements $TierLimitsCopyWith<$Res> {
  _$TierLimitsCopyWithImpl(this._self, this._then);

  final TierLimits _self;
  final $Res Function(TierLimits) _then;

/// Create a copy of TierLimits
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') @override $Res call({Object? tier = null,Object? stakeMin = null,Object? stakeMax = null,Object? calloutMax = null,}) {
  return _then(TierLimits(
tier: null == tier ? _self.tier : tier // ignore: cast_nullable_to_non_nullable
as String,stakeMin: null == stakeMin ? _self.stakeMin : stakeMin // ignore: cast_nullable_to_non_nullable
as String,stakeMax: null == stakeMax ? _self.stakeMax : stakeMax // ignore: cast_nullable_to_non_nullable
as String,calloutMax: null == calloutMax ? _self.calloutMax : calloutMax // ignore: cast_nullable_to_non_nullable
as String,
  ));
}

}


/// Adds pattern-matching-related methods to [TierLimits].
extension TierLimitsPatterns on TierLimits {
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

@optionalTypeArgs TResult maybeMap<TResult extends Object?>(TResult Function( _TierLimits value)?  $default,{required TResult orElse(),}){
final _that = this;
switch (_that) {
case _TierLimits() when $default != null:
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

@optionalTypeArgs TResult map<TResult extends Object?>(TResult Function( _TierLimits value)  $default,){
final _that = this;
switch (_that) {
case _TierLimits():
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

@optionalTypeArgs TResult? mapOrNull<TResult extends Object?>(TResult? Function( _TierLimits value)?  $default,){
final _that = this;
switch (_that) {
case _TierLimits() when $default != null:
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

@optionalTypeArgs TResult maybeWhen<TResult extends Object?>(TResult Function( String tier,  String stakeMin,  String stakeMax,  String calloutMax)?  $default,{required TResult orElse(),}) {final _that = this;
switch (_that) {
case _TierLimits() when $default != null:
return $default(_that.tier,_that.stakeMin,_that.stakeMax,_that.calloutMax);case _:
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

@optionalTypeArgs TResult when<TResult extends Object?>(TResult Function( String tier,  String stakeMin,  String stakeMax,  String calloutMax)  $default,) {final _that = this;
switch (_that) {
case _TierLimits():
return $default(_that.tier,_that.stakeMin,_that.stakeMax,_that.calloutMax);case _:
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

@optionalTypeArgs TResult? whenOrNull<TResult extends Object?>(TResult? Function( String tier,  String stakeMin,  String stakeMax,  String calloutMax)?  $default,) {final _that = this;
switch (_that) {
case _TierLimits() when $default != null:
return $default(_that.tier,_that.stakeMin,_that.stakeMax,_that.calloutMax);case _:
  return null;

}
}

}

/// @nodoc
@JsonSerializable()

class _TierLimits implements TierLimits {
  const _TierLimits({required this.tier, required this.stakeMin, required this.stakeMax, required this.calloutMax});
  factory _TierLimits.fromJson(Map<String, dynamic> json) => _$TierLimitsFromJson(json);

@override final  String tier;
@override final  String stakeMin;
@override final  String stakeMax;
@override final  String calloutMax;

/// Create a copy of TierLimits
/// with the given fields replaced by the non-null parameter values.
@override @JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
_$TierLimitsCopyWith<_TierLimits> get copyWith => __$TierLimitsCopyWithImpl<_TierLimits>(this, _$identity);

@override
Map<String, dynamic> toJson() {
  return _$TierLimitsToJson(this, );
}

@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is _TierLimits&&(identical(other.tier, tier) || other.tier == tier)&&(identical(other.stakeMin, stakeMin) || other.stakeMin == stakeMin)&&(identical(other.stakeMax, stakeMax) || other.stakeMax == stakeMax)&&(identical(other.calloutMax, calloutMax) || other.calloutMax == calloutMax));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,tier,stakeMin,stakeMax,calloutMax);

@override
String toString() {
  return 'TierLimits(tier: $tier, stakeMin: $stakeMin, stakeMax: $stakeMax, calloutMax: $calloutMax)';
}


}

/// @nodoc
abstract mixin class _$TierLimitsCopyWith<$Res> implements $TierLimitsCopyWith<$Res> {
  factory _$TierLimitsCopyWith(_TierLimits value, $Res Function(_TierLimits) _then) = __$TierLimitsCopyWithImpl;
@override @useResult
$Res call({
 String tier, String stakeMin, String stakeMax, String calloutMax
});




}
/// @nodoc
class __$TierLimitsCopyWithImpl<$Res>
    implements _$TierLimitsCopyWith<$Res> {
  __$TierLimitsCopyWithImpl(this._self, this._then);

  final _TierLimits _self;
  final $Res Function(_TierLimits) _then;

/// Create a copy of TierLimits
/// with the given fields replaced by the non-null parameter values.
@override @pragma('vm:prefer-inline') $Res call({Object? tier = null,Object? stakeMin = null,Object? stakeMax = null,Object? calloutMax = null,}) {
  return _then(_TierLimits(
tier: null == tier ? _self.tier : tier // ignore: cast_nullable_to_non_nullable
as String,stakeMin: null == stakeMin ? _self.stakeMin : stakeMin // ignore: cast_nullable_to_non_nullable
as String,stakeMax: null == stakeMax ? _self.stakeMax : stakeMax // ignore: cast_nullable_to_non_nullable
as String,calloutMax: null == calloutMax ? _self.calloutMax : calloutMax // ignore: cast_nullable_to_non_nullable
as String,
  ));
}


}

// dart format on
