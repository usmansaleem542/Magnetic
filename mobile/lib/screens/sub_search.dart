// "Find subtitles online" (app.js:1695-1761 + main.js subs:search / subs:download), OpenSubtitles.com.

import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:path_provider/path_provider.dart';

import '../app_state.dart';
import '../bridge.dart';
import '../format.dart';
import '../l10n.dart';
import '../services/opensubtitles.dart';
import '../services/subtitles.dart';
import '../store.dart';
import '../theme.dart';
import '../ui/kit.dart';
import '../ui/toast.dart';
import 'player.dart';
import 'prefs.dart';

const secureStorage = FlutterSecureStorage();

/// One client per credentials (main.js openSubtitles()).
Future<OpenSubtitles> openSubtitlesClient() async {
  final prefs = AppState.instance.prefs;
  final client = OpenSubtitles(
    apiKey: (prefs['osApiKey'] as String? ?? '').trim(),
    username: (prefs['osUsername'] as String? ?? '').trim(),
    password: await secureStorage.read(key: 'osPassword') ?? '',
  );
  if (!client.loggedIn && (prefs['osUsername'] as String? ?? '').isNotEmpty) await client.login();
  return client;
}

class SubSearchSheet extends StatefulWidget {
  const SubSearchSheet({super.key, required this.player});
  final PlayerView player;

  static Future<void> open(BuildContext context, PlayerView s) {
    s.player.pause();
    s.panelOpen = true;
    return showSheet(context, title: t('Find subtitles online'), tall: true, builder: (_) => SubSearchSheet(player: s))
        .whenComplete(() => s.panelOpen = false);
  }

  @override
  State<SubSearchSheet> createState() => _SubSearchSheetState();
}

class _SubSearchSheetState extends State<SubSearchSheet> {
  late final _langs = TextEditingController(text: {
    if (Store.get('subLang') is String) Store.get('subLang') as String,
    WidgetsBinding.instance.platformDispatcher.locale.languageCode,
  }.join(', '));
  String _status = '';
  bool _statusIsPrefsError = false;
  List<SubtitleResult> _results = const [];
  int? _busy;

  @override
  void initState() {
    super.initState();
    _search();
  }

  List<String> get _languages => _langs.text
      .split(RegExp(r'[\s,]+'))
      .map((s) => s.trim().toLowerCase())
      .where((s) => s.isNotEmpty)
      .map((s) => normaliseLang(s) ?? s)
      .toSet()
      .toList();

  Future<void> _search() async {
    setState(() {
      _status = t('Searching OpenSubtitles…');
      _statusIsPrefsError = false;
      _results = const [];
    });
    try {
      final os = await openSubtitlesClient();
      final h = (await Api.call<Map<Object?, Object?>>('subs:hash', [widget.player.ih, widget.player.index]))!;
      var results = await os.search(hash: h['hash'] as String?, languages: _languages);
      var query = '';
      if (results.isEmpty) {
        query = queryFromFileName(h['name'] as String? ?? '');
        if (query.isEmpty) query = queryFromFileName(h['torrentName'] as String? ?? '');
        if (query.isNotEmpty) results = await os.search(query: query, languages: _languages);
      }
      results = results.take(60).toList();
      final matched = results.where((r) => r.hashMatch).length;
      final q = query.isNotEmpty ? query : baseName(h['name'] as String?);
      setState(() {
        _results = results;
        _status = results.isEmpty
            ? t('Nothing found for “{query}”. Try other languages.', {'query': q})
            : matched > 0
                ? t(matched == 1 ? '{n} found. {matched} is timed for this exact file.' : '{n} found. {matched} are timed for this exact file.',
                    {'n': results.length, 'matched': matched})
                : t('{n} found for “{query}”. None are confirmed for this exact file, so timing may need adjusting.', {'n': results.length, 'query': q});
      });
    } catch (e) {
      final msg = e is OpenSubtitlesException ? t(e.message) : '$e';
      setState(() {
        _status = msg;
        _statusIsPrefsError = e.toString().contains('Preferences') || msg.contains('الإعدادات');
      });
    }
  }

  /// subs:download: reuse a cached copy, else download (needs a login) and keep it.
  Future<void> _use(SubtitleResult r) async {
    setState(() => _busy = r.fileId);
    try {
      final dir = Directory('${(await getApplicationSupportDirectory()).path}/subtitles')..createSync(recursive: true);
      final cached = dir.listSync().whereType<File>().where((f) => f.uri.pathSegments.last.startsWith('${r.fileId}-')).firstOrNull;
      String path;
      int? remaining;
      if (cached != null) {
        path = cached.path;
      } else {
        final os = await openSubtitlesClient();
        if (!os.loggedIn) throw OpenSubtitlesException('Downloading needs your OpenSubtitles username and password. Add them in Preferences.');
        final d = await os.download(r.fileId);
        path = '${dir.path}/${safeSubtitleFileName(r.fileId, d.name)}';
        await File(path).writeAsBytes(d.bytes);
        remaining = d.remaining;
      }
      if (!mounted) return;
      Navigator.pop(context);
      await widget.player.addDiskSubtitle(path);
      if (remaining != null) Toasts.show(t('Subtitles added. {n} OpenSubtitles downloads left today.', {'n': remaining}));
    } catch (e) {
      final msg = e is OpenSubtitlesException ? t(e.message) : '$e';
      if (mounted) {
        setState(() {
          _busy = null;
          _status = msg;
          _statusIsPrefsError = msg.contains('Preferences') || msg.contains('الإعدادات');
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final p = context.palette;
    return ListView(padding: const EdgeInsets.fromLTRB(22, 0, 22, 24), children: [
      Text(t('Languages'), style: TextStyle(color: p.text, fontWeight: FontWeight.w500)),
      const SizedBox(height: 6),
      Row(children: [
        Expanded(child: Field(controller: _langs, hint: 'ar, en', textDirection: TextDirection.ltr, onSubmitted: (_) => _search())),
        const SizedBox(width: 8),
        Btn(t('Search'), kind: BtnKind.primary, onTap: _search),
      ]),
      const SizedBox(height: 12),
      Text(_status, style: TextStyle(color: p.muted, fontSize: Tokens.fsSm, height: 1.4)),
      if (_statusIsPrefsError)
        Padding(
          padding: const EdgeInsets.only(top: 8),
          child: Align(
            alignment: AlignmentDirectional.centerStart,
            child: Btn(t('Open Preferences'), small: true, inDialog: true, onTap: () {
              Navigator.pop(context);
              PrefsScreen.open(context);
            }),
          ),
        ),
      const SizedBox(height: 6),
      for (final r in _results)
        Container(
          padding: const EdgeInsets.symmetric(vertical: 10, horizontal: 2),
          decoration: BoxDecoration(border: Border(top: BorderSide(color: p.line))),
          child: Row(children: [
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(r.release.isNotEmpty ? r.release : r.fileName, maxLines: 2, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: Tokens.fsSm, color: p.text)),
                const SizedBox(height: 3),
                Wrap(spacing: 10, children: [
                  if (r.language.isNotEmpty) Text(languageName(normaliseLang(r.language) ?? r.language) ?? r.language, style: TextStyle(fontSize: Tokens.fsXs, color: p.muted)),
                  Text(t('{n} downloads', {'n': fmtCount(r.downloads)}), style: TextStyle(fontSize: Tokens.fsXs, color: p.muted)),
                  if (r.hashMatch) Text(t('Matches this file'), style: TextStyle(fontSize: Tokens.fsXs, color: p.seaText)),
                  if (r.hearingImpaired) Text(t('Includes sound descriptions'), style: TextStyle(fontSize: Tokens.fsXs, color: p.muted)),
                ]),
              ]),
            ),
            const SizedBox(width: 10),
            Btn(_busy == r.fileId ? t('Downloading…') : t('Use'), small: true, inDialog: true, onTap: _busy != null ? null : () => _use(r)),
          ]),
        ),
    ]);
  }
}
