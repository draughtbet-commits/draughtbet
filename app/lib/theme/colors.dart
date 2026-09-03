import 'package:flutter/material.dart';

class AppColors {
  // Base surfaces
  static const Color voidBg = Color(0xFF0B0D10);
  static const Color surface1 = Color(0xFF15181D);
  static const Color surface2 = Color(0xFF1E2229);
  static const Color surface3 = Color(0xFF272C34);
  static const Color hairline = Color(0xFF2E333B);

  // Board & pieces
  static const Color boardDark = Color(0xFF1E2229);
  static const Color boardLight = Color(0xFFE8E2D5);
  static const Color pieceLight = Color(0xFFF2EEE6);
  static const Color pieceDark = Color(0xFF2A2118);
  static const Color legalMoveHighlight = Color(0x402FAE72); // 25% opacity

  // Text
  static const Color textPrimary = Color(0xFFF4F2ED);
  static const Color textSecondary = Color(0xFF9CA3AF);
  static const Color textMuted = Color(0xFF6B7280);

  // Accent gold
  static const Color gold500 = Color(0xFFE7B24A);
  static const Color gold700 = Color(0xFFB8862E);
  static const Color gold100 = Color(0xFF3A2E17);

  // Semantic states
  static const Color success = Color(0xFF2FAE72);
  static const Color danger = Color(0xFFE5484D);
  static const Color warning = Color(0xFFE7B24A); // reused gold500
  static const Color info = Color(0xFF4C8DFF);    // reused tierMaster

  // Tiers
  static const Color tierAmateur = Color(0xFF8B93A1);
  static const Color tierMaster = Color(0xFF4C8DFF);
  static const Color tierPro = Color(0xFFE7B24A); // reused gold500

  // Aliases (used by callout_card and tier_select_screen)
  static const Color textMain = textPrimary;
  static const Color proGold = gold500;
  static const Color borderDim = hairline;
}
