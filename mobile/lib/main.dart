import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:media_kit/media_kit.dart';

import 'app_state.dart';
import 'l10n.dart';
import 'screens/library.dart';
import 'store.dart';
import 'theme.dart';
import 'ui/toast.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  MediaKit.ensureInitialized();
  await Store.init();
  _arabic = await L10n.loadArabic();
  await AppState.instance.start();
  _applyLanguage();
  runApp(MagneticApp(key: MagneticApp._key));
}

Map<String, String> _arabic = const {};

void _applyLanguage() {
  final pref = AppState.instance.prefs['language'] as String? ?? 'system';
  L10n.use(resolveLanguage(pref, ui.PlatformDispatcher.instance.locale.toLanguageTag()), _arabic);
}

class MagneticApp extends StatefulWidget {
  const MagneticApp({super.key});

  static final _key = GlobalKey<_MagneticAppState>();

  /// Re-applies theme and language (the desktop reloaded its window for a language change).
  static Future<void> reload() async {
    _applyLanguage();
    _key.currentState?._rebuild();
  }

  @override
  State<MagneticApp> createState() => _MagneticAppState();
}

class _MagneticAppState extends State<MagneticApp> {
  void _rebuild() => setState(() {});

  @override
  Widget build(BuildContext context) {
    final theme = AppState.instance.prefs['theme'] as String? ?? 'system';
    return MaterialApp(
      title: 'Magnetic',
      debugShowCheckedModeBanner: false,
      theme: buildTheme(Brightness.light),
      darkTheme: buildTheme(Brightness.dark),
      themeMode: switch (theme) { 'dark' => ThemeMode.dark, 'light' => ThemeMode.light, _ => ThemeMode.system },
      builder: (context, child) => Directionality(
        textDirection: isRtl ? TextDirection.rtl : TextDirection.ltr,
        child: DefaultTextStyle.merge(
          style: TextStyle(height: isRtl ? 1.6 : 1.45, fontFeatures: const [ui.FontFeature.tabularFigures()]),
          child: Stack(children: [child!, const ToastHost()]),
        ),
      ),
      // A new key per language rebuilds every screen with the new strings and direction.
      home: LibraryScreen(key: ValueKey(L10n.language)),
    );
  }
}
