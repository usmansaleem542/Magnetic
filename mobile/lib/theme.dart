// Design tokens ported from web-app/renderer/styles.css (":root" and the light overrides):
// cinema dark grey, with marquee gold for what you already have.

import 'package:flutter/material.dart';

@immutable
class Palette extends ThemeExtension<Palette> {
  const Palette({
    required this.bg,
    required this.surface,
    required this.surface2,
    required this.line,
    required this.text,
    required this.muted,
    required this.faint,
    required this.gold,
    required this.accent,
    required this.accentHover,
    required this.accentInk,
    required this.sea,
    required this.goldText,
    required this.seaText,
    required this.danger,
    required this.hover,
    required this.backdrop,
    required this.fallbackEnd,
    required this.fallbackEdge,
    required this.shadow,
  });

  final Color bg, surface, surface2, line, text, muted, faint;
  final Color gold; // pieces on disk
  final Color accent, accentHover, accentInk; // primary buttons
  final Color sea, goldText, seaText, danger, hover, backdrop, fallbackEnd, fallbackEdge;
  final BoxShadow shadow;

  static const dark = Palette(
    bg: Color(0xFF141414),
    surface: Color(0xFF181818),
    surface2: Color(0xFF2A2A2A),
    line: Color(0xFF333333),
    text: Color(0xFFE5E5E5),
    muted: Color(0xFFA3A3A3),
    faint: Color(0xFF6D6D6D),
    gold: Color(0xFFF0BE4B),
    accent: Color(0xFFF0BE4B),
    accentHover: Color(0xFFF6CC67),
    accentInk: Color(0xFF2A1F05),
    sea: Color(0xFF62C4B5),
    goldText: Color(0xFFF0BE4B),
    seaText: Color(0xFF62C4B5),
    danger: Color(0xFFF08070),
    hover: Color(0x0FFFFFFF), // rgba(255,255,255,.06)
    backdrop: Color(0xB3000000), // rgba(0,0,0,.7)
    fallbackEnd: Color(0xFF141414),
    fallbackEdge: Color(0x0AFFFFFF), // rgba(255,255,255,.04)
    shadow: BoxShadow(color: Color(0x99000000), offset: Offset(0, 18), blurRadius: 40, spreadRadius: -12),
  );

  /// Daylight: neutral whites; status text gets deeper gold and green so it passes contrast on white.
  static const light = Palette(
    bg: Color(0xFFFAFAFA),
    surface: Color(0xFFFFFFFF),
    surface2: Color(0xFFF0F0F0),
    line: Color(0xFFE3E3E3),
    text: Color(0xFF141414),
    muted: Color(0xFF5C5C5C),
    faint: Color(0xFF9A9A9A),
    gold: Color(0xFFD9980F),
    accent: Color(0xFFF0BE4B),
    accentHover: Color(0xFFF6CC67),
    accentInk: Color(0xFF2A1F05),
    sea: Color(0xFF2B8F80),
    goldText: Color(0xFF8F6200),
    seaText: Color(0xFF1D7266),
    danger: Color(0xFFC8452F),
    hover: Color(0x0B000000), // rgba(0,0,0,.045)
    backdrop: Color(0x52000000), // rgba(0,0,0,.32)
    fallbackEnd: Color(0xFFE6E6E6),
    fallbackEdge: Color(0x0F000000), // rgba(0,0,0,.06)
    shadow: BoxShadow(color: Color(0x2E000000), offset: Offset(0, 18), blurRadius: 40, spreadRadius: -16),
  );

  @override
  Palette copyWith() => this;

  @override
  Palette lerp(Palette? other, double t) => t < .5 ? this : (other ?? this);
}

/// Sizes, radii and motion from styles.css.
abstract final class Tokens {
  static const fsXs = 12.0, fsSm = 13.0, fsMd = 14.5, fsLg = 17.0, fsXl = 26.0;
  static const rSm = 6.0, rMd = 10.0;
  static const easeOut = Cubic(0.23, 1, 0.32, 1);
  static const easeInOut = Cubic(0.77, 0, 0.175, 1);
  static const font = 'Bricolage';
}

extension PaletteOf on BuildContext {
  Palette get palette => Theme.of(this).extension<Palette>()!;
}

ThemeData buildTheme(Brightness brightness) {
  final p = brightness == Brightness.dark ? Palette.dark : Palette.light;
  final scheme = ColorScheme(
    brightness: brightness,
    primary: p.accent,
    onPrimary: p.accentInk,
    secondary: p.sea,
    onSecondary: p.bg,
    error: p.danger,
    onError: p.bg,
    surface: p.surface,
    onSurface: p.text,
    surfaceContainerHighest: p.surface2,
    outline: p.line,
  );
  final base = ThemeData(
    useMaterial3: true,
    brightness: brightness,
    colorScheme: scheme,
    fontFamily: Tokens.font,
    // Arabic falls back to the system Arabic font, as on desktop.
    fontFamilyFallback: const ['Noto Sans Arabic', 'sans-serif'],
    scaffoldBackgroundColor: p.bg,
    canvasColor: p.bg,
    dividerColor: p.line,
    splashFactory: NoSplash.splashFactory,
    highlightColor: p.hover,
    hoverColor: p.hover,
    extensions: [p],
  );
  return base.copyWith(
    textTheme: base.textTheme.apply(bodyColor: p.text, displayColor: p.text).copyWith(
          bodyMedium: TextStyle(fontSize: Tokens.fsMd, color: p.text),
          bodySmall: TextStyle(fontSize: Tokens.fsSm, color: p.muted),
          titleMedium: TextStyle(fontSize: Tokens.fsLg, fontWeight: FontWeight.w600, color: p.text),
          headlineSmall: TextStyle(fontSize: Tokens.fsXl, fontWeight: FontWeight.w700, color: p.text),
        ).apply(fontFamily: Tokens.font, fontFamilyFallback: const ['Noto Sans Arabic', 'sans-serif']),
    textSelectionTheme: TextSelectionThemeData(cursorColor: p.accent, selectionColor: p.accent.withValues(alpha: .35)),
    snackBarTheme: SnackBarThemeData(backgroundColor: p.surface2, contentTextStyle: TextStyle(color: p.text, fontSize: Tokens.fsSm)),
  );
}
