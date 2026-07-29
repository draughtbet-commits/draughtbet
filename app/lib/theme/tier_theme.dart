import 'package:flutter/material.dart';
import 'colors.dart';

class TierThemeData {
  final Color primaryColor;
  final String displayName;

  const TierThemeData({required this.primaryColor, required this.displayName});
}

class TierTheme {
  static const _themes = {
    'AMATEUR': TierThemeData(primaryColor: AppColors.tierAmateur, displayName: 'Amateur'),
    'MASTER': TierThemeData(primaryColor: AppColors.tierMaster, displayName: 'Master'),
    'PRO': TierThemeData(primaryColor: AppColors.tierPro, displayName: 'Pro'),
  };

  /// Accepts the raw tier string from server JSON ('AMATEUR', 'MASTER', 'PRO').
  /// Returns a [TierThemeData] with the tier's primary color and display name.
  static TierThemeData forTier(String tier) {
    return _themes[tier.toUpperCase()] ??
        const TierThemeData(primaryColor: AppColors.tierAmateur, displayName: 'Amateur');
  }

  static TextStyle badgeStyleForTier(String tier) {
    return TextStyle(
      fontFamily: 'Manrope',
      fontWeight: FontWeight.w700,
      fontSize: 13, // Caption
      color: forTier(tier).primaryColor,
    );
  }
}
