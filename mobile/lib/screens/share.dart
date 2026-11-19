// Share files as a torrent (index.html #shareDialog, app.js:754-775, 898-911).

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../app_state.dart';
import '../bridge.dart';
import '../l10n.dart';
import '../theme.dart';
import '../ui/kit.dart';
import '../ui/toast.dart';
import 'file_browser.dart';

class ShareSheet extends StatefulWidget {
  const ShareSheet({super.key, this.preset});
  final String? preset;

  static Future<void> open(BuildContext context, {String? preset}) =>
      showSheet(context, title: t('Share files as a torrent'), tall: true, builder: (_) => ShareSheet(preset: preset));

  @override
  State<ShareSheet> createState() => _ShareSheetState();
}

class _ShareSheetState extends State<ShareSheet> {
  late String? _path = widget.preset;
  final _trackers = TextEditingController();
  final _comment = TextEditingController();
  bool _private = false, _advanced = false, _working = false;

  @override
  void initState() {
    super.initState();
    Api.call<List<Object?>>('torrent:defaultTrackers').then((l) => _trackers.text = (l ?? const []).join('\n'));
  }

  Future<void> _pick() async {
    final p = await FileBrowser.pickShare(context, title: t('Choose a file or folder to share'));
    if (p != null) setState(() => _path = p);
  }

  Future<void> _create() async {
    final path = _path;
    if (path == null) return;
    setState(() => _working = true);
    Toasts.show(t('Preparing torrent. Large folders take a moment to hash.'));
    final announce = _trackers.text.split(RegExp(r'\s+')).where((s) => s.isNotEmpty).toList();
    final r = await run(Api.call<Map<Object?, Object?>>('torrent:seedPath', [
      path,
      {'announce': announce, 'comment': _comment.text.trim(), 'private': _private},
    ]));
    if (r != null) {
      await Clipboard.setData(ClipboardData(text: r['magnet'] as String));
      Toasts.show(t('Sharing “{name}”. Magnet link copied.', {'name': r['name']}));
      if (mounted) Navigator.pop(context);
    } else if (mounted) {
      setState(() => _working = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final p = context.palette;
    final uploadsOff = AppState.instance.prefs['allowUploads'] != true;
    return Column(children: [
      Expanded(
        child: ListView(padding: const EdgeInsets.fromLTRB(22, 0, 22, 16), children: [
          Text(t('Magnetic seeds straight from where the files are, so keep them in place while you share.'), style: TextStyle(color: p.muted, height: 1.45)),
          if (uploadsOff) ...[
            const SizedBox(height: 10),
            Text(t('Uploading is off in Preferences, so nobody can download these files from you. Turn it on to share.'),
                style: TextStyle(color: p.danger, fontSize: Tokens.fsXs, height: 1.4)),
          ],
          const SizedBox(height: 16),
          Btn(t('Choose a file or folder…'), inDialog: true, icon: 'folder', onTap: _pick),
          const SizedBox(height: 10),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
            decoration: BoxDecoration(color: p.bg, borderRadius: BorderRadius.circular(Tokens.rSm)),
            child: Text(_path ?? t('Nothing chosen yet.'), textDirection: _path != null ? TextDirection.ltr : null,
                style: TextStyle(color: _path != null ? p.text : p.muted, fontSize: Tokens.fsSm)),
          ),
          const SizedBox(height: 14),
          InkWell(
            onTap: () => setState(() => _advanced = !_advanced),
            child: Padding(
              padding: const EdgeInsets.symmetric(vertical: 8),
              child: Row(children: [
                AnimatedRotation(turns: _advanced ? .25 : 0, duration: const Duration(milliseconds: 150), child: Icon(Icons.chevron_right, size: 18, color: p.muted)),
                const SizedBox(width: 4),
                Text(t('Advanced options'), style: TextStyle(color: p.text, fontWeight: FontWeight.w500)),
              ]),
            ),
          ),
          if (_advanced) ...[
            const SizedBox(height: 8),
            Text(t('Trackers, one per line'), style: TextStyle(color: p.text, fontWeight: FontWeight.w500)),
            const SizedBox(height: 6),
            Field(controller: _trackers, maxLines: 5, textDirection: TextDirection.ltr),
            const SizedBox(height: 12),
            Text(t('Comment'), style: TextStyle(color: p.text, fontWeight: FontWeight.w500)),
            const SizedBox(height: 6),
            Field(controller: _comment, hint: t('Optional')),
            PrefRow(
              label: t('Private torrent'),
              help: t('Only the trackers above can find peers. DHT and peer exchange are off.'),
              trailing: Toggle(value: _private, onChanged: (v) => setState(() => _private = v)),
            ),
          ],
        ]),
      ),
      Container(
        padding: EdgeInsets.fromLTRB(22, 12, 22, 12 + MediaQuery.paddingOf(context).bottom),
        decoration: BoxDecoration(border: Border(top: BorderSide(color: p.line))),
        child: Row(mainAxisAlignment: MainAxisAlignment.end, children: [
          Btn(t('Cancel'), inDialog: true, onTap: () => Navigator.pop(context)),
          const SizedBox(width: 8),
          Btn(t('Create torrent'), kind: BtnKind.primary, onTap: _path == null || _working ? null : _create),
        ]),
      ),
    ]);
  }
}
