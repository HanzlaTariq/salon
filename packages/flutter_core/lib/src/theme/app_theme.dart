import 'package:flutter/material.dart';
import 'package:google_fonts/google_fonts.dart';

import 'tokens.dart';

/// Builds the light and dark Material 3 themes for both Flutter apps.
///
/// Accessibility note: gold on ivory is used for accents / large text only, never for
/// small body text (contrast). Primary buttons use ink-on-gold-free dark fills instead.
abstract final class AppTheme {
  static ThemeData light() => _build(Brightness.light);
  static ThemeData dark() => _build(Brightness.dark);

  static ThemeData _build(Brightness brightness) {
    final isDark = brightness == Brightness.dark;
    final background = isDark ? AppColors.darkSurface : AppColors.ivory;
    final onBackground = isDark ? AppColors.ivory : AppColors.ink;
    final surface = isDark ? const Color(0xFF1E1E23) : Colors.white;

    final scheme = ColorScheme(
      brightness: brightness,
      primary: isDark ? AppColors.gold : AppColors.ink,
      onPrimary: isDark ? AppColors.ink : AppColors.ivory,
      secondary: AppColors.gold,
      onSecondary: AppColors.ink,
      tertiary: AppColors.emerald,
      onTertiary: Colors.white,
      error: AppColors.danger,
      onError: Colors.white,
      surface: surface,
      onSurface: onBackground,
      surfaceContainerHighest: isDark ? const Color(0xFF26262C) : AppColors.sand,
      outline: isDark ? const Color(0xFF3A3A42) : AppColors.border,
    );

    final base = ThemeData(brightness: brightness, useMaterial3: true, colorScheme: scheme);

    final body = GoogleFonts.interTextTheme(base.textTheme).apply(
      bodyColor: onBackground,
      displayColor: onBackground,
    );
    // Elegant serif for headings, Inter for UI text.
    TextStyle? serif(TextStyle? s) =>
        s == null ? null : GoogleFonts.cormorantGaramond(textStyle: s, fontWeight: FontWeight.w600);

    final textTheme = body.copyWith(
      displayLarge: serif(body.displayLarge),
      displayMedium: serif(body.displayMedium),
      displaySmall: serif(body.displaySmall),
      headlineLarge: serif(body.headlineLarge),
      headlineMedium: serif(body.headlineMedium),
      headlineSmall: serif(body.headlineSmall),
    );

    final inputBorder = OutlineInputBorder(
      borderRadius: BorderRadius.circular(AppRadius.input),
      borderSide: BorderSide(color: scheme.outline),
    );

    return base.copyWith(
      scaffoldBackgroundColor: background,
      textTheme: textTheme,
      appBarTheme: AppBarTheme(
        backgroundColor: background,
        foregroundColor: onBackground,
        elevation: 0,
        scrolledUnderElevation: 0,
        centerTitle: false,
        titleTextStyle: textTheme.headlineSmall,
      ),
      cardTheme: CardThemeData(
        color: surface,
        elevation: 0,
        margin: EdgeInsets.zero,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(AppRadius.card),
          side: BorderSide(color: scheme.outline),
        ),
      ),
      dividerTheme: DividerThemeData(color: scheme.outline, space: 1, thickness: 1),
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: surface,
        contentPadding: const EdgeInsets.symmetric(horizontal: AppSpacing.lg, vertical: AppSpacing.md),
        border: inputBorder,
        enabledBorder: inputBorder,
        focusedBorder: inputBorder.copyWith(borderSide: const BorderSide(color: AppColors.gold, width: 1.5)),
        errorBorder: inputBorder.copyWith(borderSide: const BorderSide(color: AppColors.danger)),
        focusedErrorBorder:
            inputBorder.copyWith(borderSide: const BorderSide(color: AppColors.danger, width: 1.5)),
      ),
      filledButtonTheme: FilledButtonThemeData(
        style: FilledButton.styleFrom(
          minimumSize: const Size(kMinTouchTarget, 48),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(AppRadius.input)),
          textStyle: textTheme.labelLarge?.copyWith(fontWeight: FontWeight.w600),
        ),
      ),
      outlinedButtonTheme: OutlinedButtonThemeData(
        style: OutlinedButton.styleFrom(
          minimumSize: const Size(kMinTouchTarget, 48),
          side: BorderSide(color: scheme.outline),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(AppRadius.input)),
        ),
      ),
      textButtonTheme: TextButtonThemeData(
        style: TextButton.styleFrom(minimumSize: const Size(kMinTouchTarget, kMinTouchTarget)),
      ),
      chipTheme: base.chipTheme.copyWith(
        shape: const StadiumBorder(),
        side: BorderSide(color: scheme.outline),
      ),
      bottomSheetTheme: BottomSheetThemeData(
        backgroundColor: surface,
        shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(top: Radius.circular(AppRadius.sheet)),
        ),
      ),
      snackBarTheme: SnackBarThemeData(
        behavior: SnackBarBehavior.floating,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(AppRadius.input)),
      ),
    );
  }
}
