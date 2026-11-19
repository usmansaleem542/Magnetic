// Preferences (index.html #prefsDialog, app.js:913-1121). Every control saves as soon as it changes.

import 'dart:async';

import 'package:flutter/material.dart';

import '../app_state.dart';
import '../bridge.dart';
import '../format.dart';
import '../l10n.dart';
import '../main.dart';
import '../theme.dart';
import '../ui/kit.dart';
import '../ui/toast.dart';
import 'file_browser.dart';
import 'sub_search.dart';

class PrefsScreen extends StatefulWidget {
  const PrefsScreen({super.key, this.scrollToLanguage = false});
  final bool scrollToLanguage;

  static Future<void> open(BuildContext context, {bool scrollToLanguage = false}) =>
      Navigator.of(context).push(MaterialPageRoute(builder: (_) => PrefsScreen(scrollToLanguage: scrollToLanguage)));

  @override
  State<PrefsScreen> createState() => _PrefsScreenState();
}

class _PrefsScreenState extends State<PrefsScreen> with WidgetsBindingObserver {
  int? _free;
  bool? _defaultHandler;
  String _version = '';
  final _trackers = TextEditingController();
  String _trackersNote = '';
  final _osKey = TextEditingController(), _osUser = TextEditingController(), _osPass = TextEditingController();
  bool _hasPassword = false;
  final _languageKey = GlobalKey();

  Map<String, Object?> get prefs => AppState.instance.prefs;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _load();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState s) {
    if (s == AppLifecycleState.resumed) _loadHandler();
  }

  Future<void> _load() async {
    await AppState.instance.reloadPrefs();
    _trackers.text = ((prefs['trackers'] as List?) ?? const []).join('\n');
    _osKey.text = prefs['osApiKey'] as String? ?? '';
    _osUser.text = prefs['osUsername'] as String? ?? '';
    _hasPassword = (await secureStorage.read(key: 'osPassword'))?.isNotEmpty == true;
    final info = await Api.call<Map<Object?, Object?>>('app:info');
    _version = info?['version'] as String? ?? '';
    await _loadFree();
    await _loadHandler();
    if (mounted) setState(() {});
    if (widget.scrollToLanguage) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        final c = _languageKey.currentContext;
        if (c != null) Scrollable.ensureVisible(c, alignment: .3);
      });
    }
  }

  Future<void> _loadFree() async {
    _free = (await Api.call<num>('disk:free'))?.toInt();
    if (mounted) setState(() {});
  }

  Future<void> _loadHandler() async {
    _defaultHandler = await Api.call<bool>('prefs:isDefaultHandler');
    if (mounted) setState(() {});
  }

  Future<void> _set(Map<String, Object?> patch) async {
    try {
      await AppState.instance.setPrefs(patch);
    } catch (e) {
      Toasts.show('$e', error: true);
    }
    if (mounted) setState(() {});
  }

  Future<void> _saveTrackers(String text) async {
    final r = await run(Api.call<Map<Object?, Object?>>('prefs:setTrackers', [text]));
    if (r == null) return;
    final valid = ((r['trackers'] as List?) ?? const []).cast<String>();
    final invalid = ((r['invalid'] as List?) ?? const []).cast<String>();
    _trackers.text = valid.join('\n');
    await AppState.instance.reloadPrefs();
    setState(() {
      _trackersNote = invalid.isEmpty
          ? t(valid.length == 1 ? 'Saved {n} tracker.' : 'Saved {n} trackers.', {'n': valid.length})
          : t(invalid.length == 1 ? 'Skipped an address that isn’t a tracker: {list}' : 'Skipped {n} addresses that aren’t trackers: {list}',
              {'n': invalid.length, 'list': invalid.join(', ')});
    });
  }

  @override
  Widget build(BuildContext context) {
    final p = context.palette;
    final allow = prefs['allowUploads'] == true;
    final path = prefs['downloadPath'] as String? ?? '';
    final player = prefs['externalPlayer'] as String? ?? 'builtin';
    return Scaffold(
      appBar: AppBar(
        backgroundColor: p.bg,
        surfaceTintColor: Colors.transparent,
        automaticallyImplyLeading: false,
        title: Text(t('Preferences'), style: TextStyle(fontWeight: FontWeight.w700, color: p.text, fontSize: Tokens.fsLg + 2)),
        actions: [Padding(padding: const EdgeInsets.only(right: 12, left: 12), child: Btn(t('Done'), kind: BtnKind.primary, small: true, onTap: () => Navigator.pop(context)))],
      ),
      body: ListenableBuilder(
        listenable: AppState.instance,
        builder: (context, _) => ListView(padding: const EdgeInsets.fromLTRB(20, 0, 20, 48), children: [
          SectionHeading(t('Downloads')),
          PrefRow(
            label: t('Save downloads to'),
            help: _free != null ? t('{path} ({size} free)', {'path': path, 'size': fmtBytes(_free)}) : path,
            trailing: Btn(t('Change…'), small: true, inDialog: true, onTap: () async {
              final dir = await FileBrowser.pickFolder(context, title: t('Save downloads to'), start: path);
              if (dir != null) {
                await _set({'downloadPath': dir});
                _loadFree();
              }
            }),
          ),
          PrefRow(label: t('Ask where to save each torrent'), trailing: Toggle(value: prefs['askSavePath'] == true, onChanged: (v) => _set({'askSavePath': v}))),
          PrefRow(label: t('Download speed limit'), trailing: _NumField(value: prefs['downloadLimit'], hint: t('No limit'), unit: 'KB/s', onSave: (v) => _set({'downloadLimit': v}))),
          PrefRow(
            label: t('Upload to other people'),
            help: t('When off, nobody can download anything from this phone. Downloads may be slower, because many people send faster to those who share back.'),
            trailing: Toggle(value: allow, onChanged: (v) => _set({'allowUploads': v})),
          ),
          if (allow) ...[
            PrefRow(label: t('Upload speed limit'), trailing: _NumField(value: prefs['uploadLimit'], hint: t('No limit'), unit: 'KB/s', onSave: (v) => _set({'uploadLimit': v}))),
            PrefRow(
              label: t('Stop seeding at share ratio'),
              help: t('Leave empty to keep seeding until you pause or remove the torrent.'),
              trailing: _NumField(value: prefs['seedRatioLimit'], hint: t('Never'), decimal: true, onSave: (v) => _set({'seedRatioLimit': v})),
            ),
          ],
          PrefRow(
            label: t('Download at most'),
            help: t('The rest wait in a queue and start, oldest first, as others finish.'),
            trailing: _NumField(value: prefs['maxActiveDownloads'], hint: t('All'), unit: t('at once'), onSave: (v) => _set({'maxActiveDownloads': v.floor()})),
          ),
          PrefRow(
            label: t('Pause other downloads while I watch'),
            help: t('The video you’re watching gets all the bandwidth. Others carry on when you close it.'),
            trailing: Toggle(value: prefs['pauseOthersWhileWatching'] != false, onChanged: (v) => _set({'pauseOthersWhileWatching': v})),
          ),

          SectionHeading(t('Playback')),
          PrefRow(label: t('Play the first video when a torrent is added'), trailing: Toggle(value: prefs['autoPlay'] != false, onChanged: (v) => _set({'autoPlay': v}))),
          PrefRow(
            label: t('Play videos in'),
            help: switch (player) {
              'vlc' => t('VLC plays almost every format. Install it from videolan.org.'),
              'custom' => t('Android asks which app to use each time.'),
              _ => t('Built-in player. You can still open any file in VLC from the player.'),
            },
            trailing: Select<String>(
              value: player,
              options: [SelectOption('builtin', 'Magnetic'), SelectOption('vlc', 'VLC'), SelectOption('custom', t('Another app…'))],
              onChanged: (v) => _set({'externalPlayer': v}),
            ),
          ),

          SectionHeading(t('System')),
          PrefRow(
            label: t('Appearance'),
            trailing: Select<String>(
              value: prefs['theme'] as String? ?? 'system',
              options: [SelectOption('system', t('Match system')), SelectOption('dark', t('Dark')), SelectOption('light', t('Light'))],
              onChanged: (v) async {
                await _set({'theme': v});
                MagneticApp.reload();
              },
            ),
          ),
          PrefRow(
            key: _languageKey,
            label: t('Language'),
            trailing: Select<String>(
              value: prefs['language'] as String? ?? 'system',
              options: [SelectOption('system', t('Match system')), const SelectOption('en', 'English'), const SelectOption('ar', 'العربية')],
              onChanged: (v) async {
                await _set({'language': v});
                await MagneticApp.reload();
              },
            ),
          ),
          PrefRow(
            label: t('Notify me when a download finishes'),
            trailing: Toggle(value: prefs['notifyOnComplete'] != false, onChanged: (v) {
              if (v) Api.call('app:requestNotifications');
              _set({'notifyOnComplete': v});
            }),
          ),
          PrefRow(
            label: t('Keep downloading in the background'),
            help: t('Downloads and sharing carry on after you leave Magnetic, with a notification to pause or quit.'),
            trailing: Toggle(value: prefs['closeToTray'] != false, onChanged: (v) {
              if (v) Api.call('app:requestNotifications');
              _set({'closeToTray': v});
            }),
          ),
          PrefRow(
            label: t('Carry on after the phone restarts'),
            trailing: Toggle(value: prefs['openAtLogin'] == true, onChanged: (v) => _set({'openAtLogin': v})),
          ),
          PrefRow(
            label: t('Open magnet links from the browser in Magnetic'),
            help: _defaultHandler == null ? null : (_defaultHandler! ? t('Magnetic opens magnet links.') : t('Another app opens magnet links.')),
            trailing: _defaultHandler == true ? null : Btn(t('Make default'), small: true, inDialog: true, onTap: () => Api.call('prefs:makeDefaultHandler')),
          ),

          SectionHeading(t('Trackers')),
          PrefRow(
            label: t('Add these trackers to every download'),
            help: t('Helps magnet links find people sooner. Private torrents are left alone.'),
            trailing: Toggle(value: prefs['trackersForDownloads'] != false, onChanged: (v) => _set({'trackersForDownloads': v})),
          ),
          const SizedBox(height: 8),
          Text(t('One per line. New shares start with this list too.'), style: TextStyle(color: p.muted, fontSize: Tokens.fsXs)),
          const SizedBox(height: 6),
          Focus(
            onFocusChange: (f) {
              if (!f) _saveTrackers(_trackers.text);
            },
            child: Field(controller: _trackers, maxLines: 5, textDirection: TextDirection.ltr),
          ),
          const SizedBox(height: 6),
          Row(children: [
            Expanded(child: Text(_trackersNote, style: TextStyle(color: p.muted, fontSize: Tokens.fsXs))),
            Btn(t('Restore defaults'), small: true, inDialog: true, onTap: () async {
              final d = await Api.call<List<Object?>>('trackers:defaults');
              await _saveTrackers((d ?? const []).join('\n'));
            }),
          ]),

          SectionHeading(t('Online subtitles')),
          Text.rich(
            TextSpan(children: [
              TextSpan(text: t('Search uses your own free OpenSubtitles.com account. Create an API key under Profile, then API consumers. Downloads also need your username and password, which are stored encrypted on this phone.')),
              const TextSpan(text: '  '),
              WidgetSpan(
                child: GestureDetector(
                  onTap: () => Api.call('app:openUrl', ['https://www.opensubtitles.com/en/consumers']),
                  child: Text('OpenSubtitles.com', style: TextStyle(color: p.text, decoration: TextDecoration.underline, fontSize: Tokens.fsXs)),
                ),
              ),
            ]),
            style: TextStyle(color: p.muted, fontSize: Tokens.fsXs, height: 1.5),
          ),
          const SizedBox(height: 6),
          PrefRow(label: t('API key'), below: _SaveOnLeave(controller: _osKey, hint: t('Not set'), onSave: (v) => _set({'osApiKey': v.trim()}))),
          PrefRow(label: t('Username'), below: _SaveOnLeave(controller: _osUser, hint: t('Not set'), onSave: (v) => _set({'osUsername': v.trim()}))),
          PrefRow(
            label: t('Password'),
            below: _SaveOnLeave(
              controller: _osPass,
              obscure: true,
              hint: _hasPassword ? t('Saved') : t('Not set'),
              onSave: (v) async {
                if (v.isEmpty) return;
                await secureStorage.write(key: 'osPassword', value: v);
                _osPass.clear();
                setState(() => _hasPassword = true);
              },
            ),
          ),
          const SizedBox(height: 18),
          Text('${t('Magnetic {version}.', {'version': _version})} ${t('Browser peers are unavailable on this system.')}',
              style: TextStyle(color: p.faint, fontSize: Tokens.fsXs)),
        ]),
      ),
    );
  }
}

/// Number input with a unit label; empty or 0 means "none" (desktop numPref).
class _NumField extends StatefulWidget {
  const _NumField({required this.value, required this.hint, required this.onSave, this.unit, this.decimal = false});
  final Object? value;
  final String hint;
  final String? unit;
  final bool decimal;
  final ValueChanged<num> onSave;

  @override
  State<_NumField> createState() => _NumFieldState();
}

class _NumFieldState extends State<_NumField> {
  late final _c = TextEditingController(text: _fmt(widget.value));
  Timer? _debounce;

  static String _fmt(Object? v) {
    final n = (v as num?) ?? 0;
    if (n <= 0) return '';
    return n == n.roundToDouble() ? '${n.toInt()}' : '$n';
  }

  void _save(String s) {
    final n = num.tryParse(s.trim()) ?? 0;
    widget.onSave(n < 0 ? 0 : n);
  }

  @override
  void dispose() {
    _debounce?.cancel();
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Row(mainAxisSize: MainAxisSize.min, children: [
      SizedBox(
        width: 96,
        child: Field(
          controller: _c,
          height: 38,
          hint: widget.hint,
          textAlign: TextAlign.end,
          keyboardType: TextInputType.numberWithOptions(decimal: widget.decimal),
          onChanged: (s) {
            _debounce?.cancel();
            _debounce = Timer(const Duration(milliseconds: 700), () => _save(s));
          },
          onSubmitted: _save,
        ),
      ),
      if (widget.unit != null) ...[
        const SizedBox(width: 6),
        Text(widget.unit!, style: TextStyle(color: context.palette.muted, fontSize: Tokens.fsXs)),
      ],
    ]);
  }
}

/// Text field that saves when you leave it or press done.
class _SaveOnLeave extends StatelessWidget {
  const _SaveOnLeave({required this.controller, required this.onSave, this.hint, this.obscure = false});
  final TextEditingController controller;
  final ValueChanged<String> onSave;
  final String? hint;
  final bool obscure;

  @override
  Widget build(BuildContext context) => Focus(
        onFocusChange: (f) {
          if (!f) onSave(controller.text);
        },
        child: Field(controller: controller, hint: hint, obscure: obscure, background: context.palette.bg, textDirection: TextDirection.ltr, onSubmitted: onSave),
      );
}
