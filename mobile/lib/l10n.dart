// Interface translations, gettext style, ported from web-app/renderer/i18n.js: the English text
// is the key, so untranslated text simply shows in English. The Arabic table is generated from
// the desktop one (assets/i18n/ar.json), so both apps share the same wording.

import 'dart:convert';

import 'package:flutter/services.dart';

class L10n {
  static String _lang = 'en';
  static Map<String, String> _ar = const {};

  static String get language => _lang;

  /// Switches language. [table] is the Arabic table (loaded once with [loadArabic]).
  static void use(String lang, Map<String, String> table) {
    _lang = lang == 'ar' ? 'ar' : 'en';
    _ar = table;
  }

  /// Desktop table plus the phone-only strings (ar_mobile.json).
  static Future<Map<String, String>> loadArabic() async => {
        for (final f in const ['assets/i18n/ar.json', 'assets/i18n/ar_mobile.json'])
          ...(jsonDecode(await rootBundle.loadString(f)) as Map).cast<String, String>(),
      };
}

bool get isRtl => L10n._lang == 'ar';

final _placeholder = RegExp(r'\{(\w+)\}');

/// Translates [english] and fills `{name}` placeholders from [vars].
String t(String english, [Map<String, Object?>? vars]) {
  final s = L10n._lang == 'ar' ? (L10n._ar[english] ?? english) : english;
  if (vars == null) return s;
  return s.replaceAllMapped(_placeholder, (m) => vars.containsKey(m[1]) ? '${vars[m[1]]}' : m[0]!);
}

/// Keeps a value such as "8.7 MB" or "+0.5 s" in left-to-right order inside Arabic text.
String ltr(Object? s) => isRtl ? '\u2066$s\u2069' : '$s';

/// [pref] is 'system' | 'en' | 'ar'; 'system' follows the device locale.
String resolveLanguage(String pref, String systemLocale) {
  if (pref == 'en' || pref == 'ar') return pref;
  return RegExp(r'^ar(?:[-_]|$)', caseSensitive: false).hasMatch(systemLocale.trim()) ? 'ar' : 'en';
}
