// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'wallet_transaction.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

_WalletTransaction _$WalletTransactionFromJson(Map<String, dynamic> json) =>
    _WalletTransaction(
      id: json['id'] as String,
      type: json['type'] as String,
      amountMinorUnits: json['amountMinorUnits'] as String,
      status: json['status'] as String,
      createdAt: DateTime.parse(json['createdAt'] as String),
      relatedMatchId: json['relatedMatchId'] as String?,
    );

Map<String, dynamic> _$WalletTransactionToJson(_WalletTransaction instance) =>
    <String, dynamic>{
      'id': instance.id,
      'type': instance.type,
      'amountMinorUnits': instance.amountMinorUnits,
      'status': instance.status,
      'createdAt': instance.createdAt.toIso8601String(),
      'relatedMatchId': instance.relatedMatchId,
    };
