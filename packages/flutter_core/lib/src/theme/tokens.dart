import 'package:flutter/material.dart';

/// Design tokens. Values mirror packages/design-tokens/tokens.json.
abstract final class AppColors {
  static const ink = Color(0xFF0F0F12);
  static const ivory = Color(0xFFFAF8F5);
  static const sand = Color(0xFFEFEAE2);
  static const border = Color(0xFFE3DDD2);
  static const gold = Color(0xFFB08D57);
  static const goldHover = Color(0xFF9A7A49);
  static const emerald = Color(0xFF1F6F5C);
  static const danger = Color(0xFFB3261E);
  static const warning = Color(0xFFB26A00);
  static const info = Color(0xFF2F5D8A);
  static const darkSurface = Color(0xFF16161A);
  static const mutedText = Color(0xFF5F5B54);
}

/// 4pt spacing grid.
abstract final class AppSpacing {
  static const double xs = 4;
  static const double sm = 8;
  static const double md = 12;
  static const double lg = 16;
  static const double xl = 24;
  static const double xxl = 32;
  static const double xxxl = 48;
}

abstract final class AppRadius {
  static const double input = 8;
  static const double card = 12;
  static const double sheet = 20;
  static const double full = 999;
}

abstract final class AppMotion {
  static const fast = Duration(milliseconds: 150);
  static const base = Duration(milliseconds: 200);
  static const slow = Duration(milliseconds: 250);
  static const curve = Curves.easeOut;
}

/// Minimum touch target (accessibility).
const double kMinTouchTarget = 44;
