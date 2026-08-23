import 'package:freezed_annotation/freezed_annotation.dart';

part 'wallet.freezed.dart';
part 'wallet.g.dart';

@freezed
class Wallet with _$Wallet {
  const factory Wallet({
    required String balance,
  }) = _Wallet;

  factory Wallet.fromJson(Map<String, dynamic> json) => _$WalletFromJson(json);
}

@freezed
class TierLimits with _$TierLimits {
  const factory TierLimits({
    required String tier,
    required String stakeMin,
    required String stakeMax,
    required String calloutMax,
  }) = _TierLimits;

  factory TierLimits.fromJson(Map<String, dynamic> json) => _$TierLimitsFromJson(json);
}
