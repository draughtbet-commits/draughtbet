// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'wallet.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

_Wallet _$WalletFromJson(Map<String, dynamic> json) =>
    _Wallet(balance: json['balance'] as String);

Map<String, dynamic> _$WalletToJson(_Wallet instance) => <String, dynamic>{
  'balance': instance.balance,
};

_TierLimits _$TierLimitsFromJson(Map<String, dynamic> json) => _TierLimits(
  tier: json['tier'] as String,
  stakeMin: json['stakeMin'] as String,
  stakeMax: json['stakeMax'] as String,
  calloutMax: json['calloutMax'] as String,
);

Map<String, dynamic> _$TierLimitsToJson(_TierLimits instance) =>
    <String, dynamic>{
      'tier': instance.tier,
      'stakeMin': instance.stakeMin,
      'stakeMax': instance.stakeMax,
      'calloutMax': instance.calloutMax,
    };
