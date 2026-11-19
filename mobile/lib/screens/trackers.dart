// Trackers for one torrent (index.html #trackersDialog, app.js:1001-1089). Refreshes every 2 s.

import 'dart:async';

import 'package:flutter/material.dart';

import '../app_state.dart';
import '../bridge.dart';
import '../l10n.dart';
import '../theme.dart';
import '../ui/kit.dart';
import '../ui/toast.dart';

class TrackersSheet extends StatefulWidget {
  const TrackersSheet({super.key, required this.ih});
  final String ih;

  static Future<void> open(BuildContext context, String ih) {
    final tor = AppState.instance.byHash(ih);
    return showSheet(
      context,
      title: tor?.name.isNotEmpty == true ? t('Trackers for {name}', {'name': tor!.name}) : t('Trackers'),
      tall: true,
      builder: (_) => TrackersSheet(ih: ih),
    );
  }

  @override
  State<TrackersSheet> createState() => _TrackersSheetState();
}

class _TrackersSheetState extends State<TrackersSheet> {
  Map<Object?, Object?>? _data;
  Timer? _timer;
  final _add = TextEditingController();
  final _removing = <String>{};

  @override
  void initState() {
    super.initState();
    _refresh();
    _timer = Timer.periodic(const Duration(seconds: 2), (_) => _refresh());
  }

  @override
  void dispose() {
    _timer?.cancel();
    _add.dispose();
    super.dispose();
  }

  Future<void> _refresh() async {
    try {
      final d = await Api.call<Map<Object?, Object?>>('trackers:list', [widget.ih]);
      if (mounted) setState(() => _data = d);
    } catch (_) {
      if (mounted) Navigator.pop(context); // torrent is gone
    }
  }

  List<Map<Object?, Object?>> get _rows => ((_data?['trackers'] as List?) ?? const []).map((r) => (r as Map).cast<Object?, Object?>()).toList();

  bool _dead(Map<Object?, Object?> r) => r['state'] == 'failing' || r['state'] == 'invalid';

  String _summary() {
    if (_data == null) return '';
    if (_data!['paused'] == true) return t('This torrent is paused. Resume it to check which trackers respond.');
    final rows = _rows;
    final working = rows.where((r) => r['state'] == 'working').length;
    final dead = rows.where(_dead).length;
    var s = dead > 0
        ? t('{working} of {total} working, {dead} not responding. People are also found through DHT and connected peers.', {'working': working, 'total': rows.length, 'dead': dead})
        : t('{working} of {total} working. People are also found through DHT and connected peers.', {'working': working, 'total': rows.length});
    if (_data!['private'] == true) s += ' ${t('This is a private torrent, so trackers from Preferences aren’t added.')}';
    return s;
  }

  String _stateText(Map<Object?, Object?> r) {
    final seeders = r['seeders'] as num?, leechers = r['leechers'] as num?, peers = r['peers'] as num?;
    switch (r['state']) {
      case 'working':
        if (seeders != null) {
          return t(seeders == 1 ? 'Working, {n} seeder and {d} downloading' : 'Working, {n} seeders and {d} downloading', {'n': seeders, 'd': leechers ?? 0});
        }
        if (peers != null && peers > 0) return t(peers == 1 ? 'Working, {n} peer found' : 'Working, {n} peers found', {'n': peers});
        return t('Working');
      case 'checking':
        return t('Checking…');
      case 'paused':
        return t('Paused');
      default:
        final m = r['message'] as String?;
        return m != null && m.isNotEmpty ? t(m) : t('Not responding');
    }
  }

  Future<void> _addTrackers() async {
    final text = _add.text.trim();
    if (text.isEmpty) return;
    final r = await run(Api.call<Map<Object?, Object?>>('trackers:add', [widget.ih, text]));
    if (r == null) return;
    final invalid = ((r['invalid'] as List?) ?? const []).cast<String>();
    final added = (r['added'] as num?)?.toInt() ?? 0;
    _add.text = invalid.join('\n');
    if (invalid.isNotEmpty) {
      Toasts.show(
          invalid.length == 1
              ? t('That isn’t a tracker address. Trackers start with udp://, http://, https:// or wss://.')
              : t('Some of those aren’t tracker addresses. Trackers start with udp://, http://, https:// or wss://.'),
          error: true);
    } else {
      Toasts.show(t(added == 1 ? 'Added {n} tracker.' : 'Added {n} trackers.', {'n': added}));
    }
    _refresh();
  }

  @override
  Widget build(BuildContext context) {
    final p = context.palette;
    final rows = _rows;
    final dead = rows.where(_dead).length;
    const source = {'torrent': 'From the torrent', 'added': 'Added by you', 'preferences': 'From Preferences'};
    return Column(children: [
      Expanded(
        child: ListView(padding: const EdgeInsets.fromLTRB(22, 0, 22, 16), children: [
          Text(_summary(), style: TextStyle(color: p.muted, height: 1.45)),
          const SizedBox(height: 14),
          if (_data != null && rows.isEmpty)
            Text(t('No trackers. This torrent finds people through DHT and the peers it’s connected to.'), style: TextStyle(color: p.muted)),
          for (final r in rows)
            Container(
              padding: const EdgeInsets.symmetric(vertical: 9, horizontal: 2),
              decoration: BoxDecoration(border: Border(top: BorderSide(color: p.line))),
              child: Row(children: [
                Container(
                  width: 8,
                  height: 8,
                  decoration: BoxDecoration(
                    shape: BoxShape.circle,
                    color: switch (r['state']) { 'working' => p.sea, 'checking' => p.gold, 'failing' || 'invalid' => p.danger, _ => p.faint },
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Text(r['url'] as String, maxLines: 1, overflow: TextOverflow.ellipsis, textDirection: TextDirection.ltr, style: TextStyle(fontSize: Tokens.fsSm, color: p.text)),
                    const SizedBox(height: 2),
                    Wrap(spacing: 10, children: [
                      Text(_stateText(r),
                          style: TextStyle(fontSize: Tokens.fsXs, color: r['state'] == 'working' ? p.seaText : (_dead(r) ? p.danger : p.muted))),
                      Text(t(source[r['source']] ?? ''), style: TextStyle(fontSize: Tokens.fsXs, color: p.muted)),
                    ]),
                  ]),
                ),
                IconBtn('close', size: 34, iconSize: 15, tooltip: t('Remove {url}', {'url': r['url']}),
                    onTap: _removing.contains(r['url']) ? null : () async {
                      setState(() => _removing.add(r['url'] as String));
                      await run(Api.call('trackers:remove', [widget.ih, [r['url']]]));
                      _removing.remove(r['url']);
                      _refresh();
                    }),
              ]),
            ),
          const SizedBox(height: 16),
          Text(t('Add trackers'), style: TextStyle(color: p.text, fontWeight: FontWeight.w500)),
          const SizedBox(height: 6),
          Field(controller: _add, maxLines: 2, hint: 'udp://tracker.example.org:1337/announce', textDirection: TextDirection.ltr),
        ]),
      ),
      Container(
        padding: EdgeInsets.fromLTRB(16, 12, 16, 12 + MediaQuery.paddingOf(context).bottom),
        decoration: BoxDecoration(border: Border(top: BorderSide(color: p.line))),
        child: Wrap(alignment: WrapAlignment.end, spacing: 8, runSpacing: 8, children: [
          Btn(
            dead > 0 ? t(dead == 1 ? 'Remove {n} dead tracker' : 'Remove {n} dead trackers', {'n': dead}) : t('Remove dead trackers'),
            kind: BtnKind.danger,
            inDialog: true,
            onTap: dead == 0
                ? null
                : () async {
                    final n = await run(Api.call<int>('trackers:removeDead', [widget.ih]));
                    if (n != null) Toasts.show(t(n == 1 ? 'Removed {n} dead tracker.' : 'Removed {n} dead trackers.', {'n': n}));
                    _refresh();
                  },
          ),
          Btn(t('Add'), inDialog: true, onTap: _addTrackers),
          Btn(t('Done'), kind: BtnKind.primary, onTap: () => Navigator.pop(context)),
        ]),
      ),
    ]);
  }
}
