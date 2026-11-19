// Player panels: audio & subtitles (renderCcMenu), cast menu, playlist (app.js:1394-1864).

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:media_kit/media_kit.dart';

import '../bridge.dart';
import '../format.dart';
import '../l10n.dart';
import '../services/subtitles.dart';
import '../store.dart';
import '../theme.dart';
import '../ui/icons.dart';
import '../ui/kit.dart';
import 'file_browser.dart';
import 'player.dart';
import 'sub_search.dart';

const _panelBg = Color(0xF2101010);

Future<void> _darkSheet(BuildContext context, PlayerView s, {required String title, required WidgetBuilder builder}) {
  s.panelOpen = true;
  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    backgroundColor: _panelBg,
    barrierColor: const Color(0x66000000),
    constraints: const BoxConstraints(maxWidth: 520),
    shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(14))),
    builder: (ctx) => Theme(
      data: buildTheme(Brightness.dark),
      child: ConstrainedBox(
        constraints: BoxConstraints(maxHeight: MediaQuery.sizeOf(ctx).height * .85),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Center(child: Container(margin: const EdgeInsets.only(top: 8), width: 36, height: 4, decoration: BoxDecoration(color: PlayerColors.line, borderRadius: BorderRadius.circular(2)))),
          Padding(
            padding: const EdgeInsets.fromLTRB(18, 12, 18, 6),
            child: Text(title, style: const TextStyle(color: PlayerColors.text, fontWeight: FontWeight.w700, fontSize: Tokens.fsLg)),
          ),
          Flexible(child: Builder(builder: builder)),
        ]),
      ),
    ),
  ).whenComplete(() {
    s.panelOpen = false;
    s.wake();
  });
}

Widget _h4(String text) => Padding(
      padding: const EdgeInsets.fromLTRB(18, 14, 18, 6),
      child: Text(text, style: const TextStyle(fontSize: Tokens.fsXs, fontWeight: FontWeight.w600, color: PlayerColors.muted)),
    );

Widget _item(String label, {String? detail, required bool checked, required VoidCallback onTap}) => InkWell(
      onTap: onTap,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 11),
        child: Row(children: [
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(label, style: const TextStyle(color: PlayerColors.text, fontSize: Tokens.fsSm)),
              if (detail != null && detail.isNotEmpty)
                Text(detail, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(color: PlayerColors.muted, fontSize: Tokens.fsXs)),
            ]),
          ),
          SizedBox(width: 18, child: checked ? const MIcon('check', size: 16, color: PlayerColors.gold) : null),
        ]),
      ),
    );

/// The audio & subtitles panel (renderCcMenu, app.js:1627-1693).
Future<void> showCcPanel(BuildContext context, PlayerView s) {
  return _darkSheet(context, s, title: t('Audio and subtitles'), builder: (ctx) {
    return StatefulBuilder(builder: (ctx, setLocal) {
      void refresh() => setLocal(() {});
      final audio = s.player.state.tracks.audio.where((a) => a.id != 'auto' && a.id != 'no').toList();
      final curAudio = s.player.state.track.audio;
      final active = s.subtitles.where((x) => x.key == s.activeSubKey).firstOrNull;
      return ListView(shrinkWrap: true, padding: const EdgeInsets.only(bottom: 20), children: [
        if (audio.length > 1) ...[
          _h4(t('Audio')),
          for (final a in audio)
            _item(s.audioLabel(a), detail: _audioDetail(a), checked: a.id == curAudio.id, onTap: () {
              s.selectAudio(a);
              refresh();
            }),
          const Divider(color: PlayerColors.line, height: 9),
        ],
        _h4(t('Subtitles')),
        _item(t('Off'), checked: s.activeSubKey == null, onTap: () async {
          await s.selectSubtitle(null);
          refresh();
        }),
        for (final sub in s.subtitles)
          _item(sub.label, detail: sub.detail, checked: sub.key == s.activeSubKey, onTap: () async {
            await s.selectSubtitle(sub.key);
            refresh();
          }),
        Padding(
          padding: const EdgeInsets.fromLTRB(14, 8, 14, 4),
          child: Row(children: [
            Expanded(
              child: Btn(t('Add from file…'), small: true, inDialog: true, onTap: () async {
                final picked = await FileBrowser.pickFiles(ctx, title: t('Add subtitles'), extensions: {'srt', 'vtt', 'ass', 'ssa'});
                if (picked != null && picked.isNotEmpty) await s.addDiskSubtitle(picked.first);
                refresh();
              }),
            ),
            const SizedBox(width: 6),
            Expanded(
              child: Btn(t('Search online…'), small: true, inDialog: true, onTap: () {
                Navigator.pop(ctx);
                SubSearchSheet.open(context, s);
              }),
            ),
          ]),
        ),
        const Divider(color: PlayerColors.line, height: 17),
        _row(t('Timing'), Directionality(
          textDirection: TextDirection.ltr,
          child: Row(mainAxisSize: MainAxisSize.min, children: [
            IconBtn('minus', size: 34, iconSize: 16, color: PlayerColors.text, background: const Color(0x12FFFFFF), tooltip: t('Show subtitles 0.1 seconds earlier'), onTap: () {
              s.setSubOffset(s.subOffset - .1);
              refresh();
            }),
            SizedBox(width: 70, child: Text(fmtOffset(s.subOffset), textAlign: TextAlign.center, style: const TextStyle(color: PlayerColors.text, fontSize: Tokens.fsSm))),
            IconBtn('plus', size: 34, iconSize: 16, color: PlayerColors.text, background: const Color(0x12FFFFFF), tooltip: t('Show subtitles 0.1 seconds later'), onTap: () {
              s.setSubOffset(s.subOffset + .1);
              refresh();
            }),
          ]),
        )),
        Padding(
          padding: const EdgeInsets.fromLTRB(18, 0, 18, 6),
          child: s.subOffset != 0
              ? Row(children: [
                  Text(t('Saved for this video.'), style: const TextStyle(fontSize: Tokens.fsXs, color: PlayerColors.muted)),
                  TextButton(
                    onPressed: () {
                      s.setSubOffset(0);
                      refresh();
                    },
                    child: Text(t('Reset'), style: const TextStyle(fontSize: Tokens.fsXs, color: PlayerColors.gold, decoration: TextDecoration.underline)),
                  ),
                ])
              : Text(t('Tap − or + to shift by a tenth of a second.'), style: const TextStyle(fontSize: Tokens.fsXs, color: PlayerColors.muted)),
        ),
        _row(t('Size'), Segmented<String>(
          dark: true,
          value: s.subStyle['size'] as String? ?? 'm',
          segments: const [Segment('s', label: 'S'), Segment('m', label: 'M'), Segment('l', label: 'L'), Segment('xl', label: 'XL')],
          onChanged: (v) {
            s.setSubStyle('size', v);
            refresh();
          },
        )),
        _row(t('Background'), Segmented<String>(
          dark: true,
          value: s.subStyle['bg'] as String? ?? 'shade',
          segments: [Segment('none', label: t('None')), Segment('shade', label: t('Shaded')), Segment('solid', label: t('Solid'))],
          onChanged: (v) {
            s.setSubStyle('bg', v);
            refresh();
          },
        )),
        if (active != null && active.kind != 'embedded' && active.encoding != null) _EncodingRow(s: s, sub: active, onChanged: refresh),
      ]);
    });
  });
}

Widget _row(String label, Widget control) => Padding(
      padding: const EdgeInsets.fromLTRB(18, 6, 14, 6),
      child: Row(children: [
        Expanded(child: Text(label, style: const TextStyle(color: PlayerColors.text, fontSize: Tokens.fsSm))),
        control,
      ]),
    );

String _audioDetail(AudioTrack a) {
  final lang = normaliseLang(a.language);
  final name = lang != null ? languageName(lang) : null;
  final parts = <String>[
    if (name != null && !(a.title ?? '').toLowerCase().contains(name.toLowerCase())) name,
    if (a.channels != null && a.channels != 'stereo' && a.channels != 'mono') '${a.channels}',
    if (a.codec != null) a.codec!.toUpperCase().replaceAll('EAC3', 'E-AC3'),
  ];
  return parts.join(', ');
}

class _EncodingRow extends StatefulWidget {
  const _EncodingRow({required this.s, required this.sub, required this.onChanged});
  final PlayerView s;
  final SubSource sub;
  final VoidCallback onChanged;

  @override
  State<_EncodingRow> createState() => _EncodingRowState();
}

class _EncodingRowState extends State<_EncodingRow> {
  List<(String, String)> _encodings = const [];

  @override
  void initState() {
    super.initState();
    Api.call<List<Object?>>('subs:encodings').then((l) {
      if (!mounted || l == null) return;
      setState(() => _encodings = l.map((e) => ((e as Map)['id'] as String, e['label'] as String)).toList());
    });
  }

  @override
  Widget build(BuildContext context) {
    if (_encodings.isEmpty) return const SizedBox.shrink();
    final current = Store.get('subenc:${widget.s.ih}:${widget.sub.key}') as String? ?? 'auto';
    String short(String id) => (_encodings.where((e) => e.$1 == id).firstOrNull?.$2 ?? id).replaceAll(RegExp(r' \(.*\)$'), '');
    return _row(
      t('Text encoding'),
      Directionality(
        textDirection: TextDirection.ltr,
        child: Select<String>(
          width: 190,
          value: current,
          options: [
            for (final (id, label) in _encodings)
              SelectOption(id, id == 'auto' ? t('Automatic ({encoding})', {'encoding': short(widget.sub.encoding ?? 'utf-8')}) : t(label)),
          ],
          onChanged: (v) async {
            await widget.s.changeEncoding(v);
            widget.onChanged();
          },
        ),
      ),
    );
  }
}

// ------------------------------------------------------------------ cast menu

/// Cast menu (app.js:1778-1864): devices refresh every 1.5 s while open.
Future<void> showCastMenu(BuildContext context, PlayerView s) {
  return _darkSheet(context, s, title: t('Play on a TV or speaker'), builder: (ctx) => _CastList(s: s));
}

class _CastList extends StatefulWidget {
  const _CastList({required this.s});
  final PlayerView s;

  @override
  State<_CastList> createState() => _CastListState();
}

class _CastListState extends State<_CastList> {
  List<Map<Object?, Object?>> _devices = const [];
  Timer? _timer;

  @override
  void initState() {
    super.initState();
    _refresh();
    _timer = Timer.periodic(const Duration(milliseconds: 1500), (_) => _refresh());
  }

  Future<void> _refresh() async {
    final l = await Api.call<List<Object?>>('cast:list').catchError((_) => null);
    if (mounted && l != null) setState(() => _devices = l.map((d) => (d as Map).cast<Object?, Object?>()).toList());
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final s = widget.s;
    const typeLabel = {'chromecast': 'Chromecast', 'dlna': 'DLNA', 'airplay': 'AirPlay'};
    return ListView(shrinkWrap: true, padding: const EdgeInsets.only(bottom: 20), children: [
      if (s.isCasting) ...[
        Padding(
          padding: const EdgeInsets.fromLTRB(18, 4, 18, 8),
          child: Text(t('Playing on {name}', {'name': s.casting!['name']}), style: const TextStyle(color: PlayerColors.muted, fontSize: Tokens.fsXs)),
        ),
        _item(t('Stop casting'), checked: false, onTap: () {
          Navigator.pop(context);
          s.stopCasting();
        }),
      ] else ...[
        Padding(
          padding: const EdgeInsets.fromLTRB(18, 4, 18, 8),
          child: Row(children: [
            const SizedBox.square(dimension: 14, child: CircularProgressIndicator(strokeWidth: 2, color: PlayerColors.gold)),
            const SizedBox(width: 10),
            Expanded(child: Text(t('Looking for TVs and speakers on your network…'), style: const TextStyle(color: PlayerColors.muted, fontSize: Tokens.fsXs))),
          ]),
        ),
        for (final d in _devices)
          _item(d['name'] as String? ?? '', detail: typeLabel[d['type']] ?? '', checked: false, onTap: () {
            Navigator.pop(context);
            s.castTo(d['id'] as String, s.curTime);
          }),
      ],
    ]);
  }
}

// ------------------------------------------------------------------ playlist

/// "In this torrent" panel (styles.css .playlist).
class PlaylistPanel extends StatelessWidget {
  const PlaylistPanel({super.key, required this.files, required this.current, required this.onPick});
  final List<TFile> files;
  final int? current;
  final ValueChanged<TFile> onPick;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 14),
      decoration: BoxDecoration(color: const Color(0xF0101010), borderRadius: BorderRadius.circular(12), border: Border.all(color: PlayerColors.line)),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(10, 0, 10, 8),
          child: Text(t('In this torrent'), style: const TextStyle(fontSize: Tokens.fsSm, fontWeight: FontWeight.w600, color: PlayerColors.muted)),
        ),
        Expanded(
          child: ListView(padding: EdgeInsets.zero, children: [
            for (final f in files)
              InkWell(
                borderRadius: BorderRadius.circular(6),
                onTap: () => onPick(f),
                child: Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 9),
                  child: Row(children: [
                    Expanded(
                      child: Text(f.name,
                          maxLines: 2,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(fontSize: Tokens.fsSm, color: f.index == current ? PlayerColors.gold : PlayerColors.text)),
                    ),
                    const SizedBox(width: 8),
                    Text(pct(f.progress), style: const TextStyle(fontSize: Tokens.fsXs, color: PlayerColors.muted)),
                  ]),
                ),
              ),
          ]),
        ),
      ]),
    );
  }
}
