import 'package:flutter/material.dart';

class AppColors {
  // Client-approved semantic palette.
  static const Color background = Color(0xFF07111F);
  static const Color surface = Color(0xFF0C1B2A);
  static const Color surfaceRaised = Color(0xFF132638);
  static const Color surfaceQuiet = Color(0xFF102131);
  static const Color border = Color(0xFF274056);
  static const Color primaryAction = Color(0xFF18C986);
  static const Color primaryBright = Color(0xFF26E6A4);
  static const Color valueAccent = Color(0xFFF5C451);
  static const Color textPrimary = Color(0xFFF5F7FA);
  static const Color textSecondary = Color(0xFF8FA3B7);
  static const Color danger = Color(0xFFF55A67);
  static const Color success = Color(0xFF18C986);
  static const Color warning = Color(0xFFF5C451);
  static const Color disabled = Color(0xFF53677A);

  // Backwards-compatible names used outside the Home-to-result slice.
  static const Color voidBg = background;
  static const Color surface1 = surface;
  static const Color surface2 = surfaceRaised;
  static const Color surface3 = surfaceQuiet;
  static const Color hairline = border;

  // Board & pieces
  static const Color boardDark = Color(0xFF202A2F);
  static const Color boardLight = Color(0xFFB6A88F);
  static const Color pieceLight = Color(0xFF18C986);
  static const Color pieceDark = Color(0xFF22262A);
  static const Color legalMoveHighlight = Color(0x6626E6A4);

  // Text
  static const Color textMuted = textSecondary;

  // Accent gold
  static const Color gold500 = valueAccent;
  static const Color gold700 = Color(0xFFB8862E);
  static const Color gold100 = Color(0xFF3A2E17);

  // Brand primary (new design) — DRAUGHT BET accent
  static const Color brand = primaryBright;
  // Deep green used for filled cards so white text keeps contrast.
  static const Color brandDeep = primaryAction;
  static const Color info = Color(0xFF4C8DFF); // reused tierMaster

  // Tiers
  static const Color tierAmateur = Color(0xFF8B93A1);
  static const Color tierMaster = Color(0xFF4C8DFF);
  static const Color tierPro = Color(0xFFE7B24A); // reused gold500

  // Aliases (used by callout_card and tier_select_screen)
  static const Color textMain = textPrimary;
  static const Color proGold = gold500;
  static const Color borderDim = hairline;
}
