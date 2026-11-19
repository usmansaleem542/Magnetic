// Discover (index.html #discoverDialog, app.js:777-897): Internet Archive films and music.

import 'dart:async';

import 'package:flutter/material.dart';

import '../app_state.dart';
import '../bridge.dart';
import '../format.dart';
import '../l10n.dart';
import '../services/archive.dart';
import '../store.dart';
import '../theme.dart';
import '../ui/icons.dart';
import '../ui/kit.dart';
import '../ui/toast.dart';
import 'player.dart';

class DiscoverScreen extends StatefulWidget {
  const DiscoverScreen({super.key});

  static Future<void> open(BuildContext context) =>
      Navigator.of(context).push(MaterialPageRoute(fullscreenDialog: true, builder: (_) => const DiscoverScreen()));

  @override
  State<DiscoverScreen> createState() => _DiscoverScreenState();
}

/// Remembered url → infoHash for this run (desktop kept it in memory too).
final _added = <String, String>{};

class _DiscoverScreenState extends State<DiscoverScreen> {
  final _q = TextEditingController();
  late String _kind = Store.get('discoverKind') as String? ?? 'film';
  List<ArchiveItem> _items = const [];
  int _total = 0, _page = 1, _token = 0;
  bool _loading = false, _lastEmpty = false;
  String _status = '';
  String? _searchedQuery;
  Timer? _debounce;
  final _busy = <String>{};

  @override
  void initState() {
    super.initState();
    _run();
  }

  @override
  void dispose() {
    _debounce?.cancel();
    _q.dispose();
    super.dispose();
  }

  Future<void> _run({bool more = false}) async {
    final token = ++_token;
    final query = _q.text.trim();
    final page = more ? _page + 1 : 1;
    setState(() {
      _loading = true;
      _status = more ? t('Loading more…') : t('Searching the Internet Archive…');
      if (!more) _items = const [];
    });
    try {
      final r = await searchArchive(query: query, kind: _kind, page: page);
      if (token != _token || !mounted) return;
      setState(() {
        _page = page;
        _total = r.total;
        _lastEmpty = r.items.isEmpty;
        _items = more ? [..._items, ...r.items] : r.items;
        _searchedQuery = query;
        _status = _statusText(query);
      });
    } catch (e) {
      if (token != _token || !mounted) return;
      setState(() => _status = e is ArchiveException ? t(e.message) : '$e');
    } finally {
      if (token == _token && mounted) setState(() => _loading = false);
    }
  }

  String _statusText(String q) {
    if (_items.isEmpty) {
      if (q.isEmpty) return t('Nothing to show right now. Try a search.');
      return t(_kind == 'music' ? 'No music with “{query}” in the title. Try fewer or different words.' : 'No films with “{query}” in the title. Try fewer or different words.', {'query': q});
    }
    if (q.isNotEmpty) {
      return t(_total == 1 ? '{n} result for “{query}”, most downloaded first.' : '{n} results for “{query}”, most downloaded first.', {'n': fmtCount(_total), 'query': q});
    }
    return _kind == 'music'
        ? t('The most downloaded music. Tap an album to add it to your library.')
        : t('The most downloaded feature films. Tap one to add it to your library.');
  }

  Future<void> _tap(ArchiveItem item) async {
    final ih = _added[item.torrentUrl];
    if (ih != null && AppState.instance.byHash(ih) != null) {
      Navigator.pop(context);
      PlayerScreen.open(context, ih);
      return;
    }
    if (!isArchiveTorrentUrl(item.torrentUrl)) {
      Toasts.show(t('That isn’t an Internet Archive torrent.'), error: true);
      return;
    }
    setState(() => _busy.add(item.torrentUrl));
    try {
      final r = await Api.call<String>('torrent:add', [item.torrentUrl, null, true]);
      if (r != null) {
        _added[item.torrentUrl] = r;
        Toasts.show(t('Added “{title}”. It’s in your library, or tap it again to play.', {'title': item.title}));
      }
    } catch (e) {
      Toasts.show('$e', error: true);
    } finally {
      if (mounted) setState(() => _busy.remove(item.torrentUrl));
    }
  }

  @override
  Widget build(BuildContext context) {
    final p = context.palette;
    final showMore = !_lastEmpty && _items.isNotEmpty && _items.length < _total;
    return Scaffold(
      body: SafeArea(
        child: CustomScrollView(keyboardDismissBehavior: ScrollViewKeyboardDismissBehavior.onDrag, slivers: [
          SliverToBoxAdapter(
            child: Padding(
              padding: const EdgeInsets.fromLTRB(20, 14, 10, 0),
              child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Expanded(
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Text(t('Discover'), style: TextStyle(fontSize: Tokens.fsXl, fontWeight: FontWeight.w700, letterSpacing: -.5, color: p.text)),
                    const SizedBox(height: 4),
                    Text(t('Public-domain and openly licensed films and music from the Internet Archive.'), style: TextStyle(color: p.muted, fontSize: Tokens.fsSm, height: 1.4)),
                  ]),
                ),
                IconBtn('close', tooltip: t('Close'), color: p.text, onTap: () => Navigator.pop(context)),
              ]),
            ),
          ),
          SliverToBoxAdapter(
            child: Padding(
              padding: const EdgeInsets.fromLTRB(16, 16, 16, 0),
              child: Row(children: [
                Expanded(
                  child: Field(
                    controller: _q,
                    height: 38,
                    hint: t('Search titles, e.g. Nosferatu'),
                    prefix: Padding(padding: const EdgeInsetsDirectional.only(start: 10, end: 6), child: MIcon('search', size: 16, color: p.faint)),
                    onChanged: (_) {
                      _debounce?.cancel();
                      _debounce = Timer(const Duration(milliseconds: 450), _run);
                    },
                    onSubmitted: (_) {
                      _debounce?.cancel();
                      _run();
                    },
                  ),
                ),
                const SizedBox(width: 8),
                Segmented<String>(
                  value: _kind,
                  segments: [Segment('film', label: t('Films')), Segment('music', label: t('Music'))],
                  onChanged: (v) {
                    setState(() => _kind = v);
                    Store.set('discoverKind', v);
                    _run();
                  },
                ),
              ]),
            ),
          ),
          SliverToBoxAdapter(
            child: Padding(
              padding: const EdgeInsets.fromLTRB(20, 12, 20, 4),
              child: Text(_status, style: TextStyle(color: p.muted, fontSize: Tokens.fsSm)),
            ),
          ),
          SliverPadding(
            padding: const EdgeInsets.fromLTRB(16, 10, 16, 8),
            sliver: SliverLayoutBuilder(builder: (ctx, c) {
              final cols = (c.crossAxisExtent / 150).floor().clamp(2, 6);
              const gap = 14.0;
              final w = (c.crossAxisExtent - gap * (cols - 1)) / cols;
              final ratio = _searchedQuery != null && _kind == 'music' ? 1.0 : 1.5;
              return SliverGrid.builder(
                gridDelegate: SliverGridDelegateWithFixedCrossAxisCount(crossAxisCount: cols, crossAxisSpacing: gap, mainAxisSpacing: 20, mainAxisExtent: w * ratio + 62),
                itemCount: _items.length,
                itemBuilder: (ctx, i) => _DiscoverCard(
                  item: _items[i],
                  busy: _busy.contains(_items[i].torrentUrl),
                  inLibrary: _added[_items[i].torrentUrl] != null && AppState.instance.byHash(_added[_items[i].torrentUrl]!) != null,
                  onTap: () => _tap(_items[i]),
                ),
              );
            }),
          ),
          if (showMore)
            SliverToBoxAdapter(
              child: Center(child: Padding(padding: const EdgeInsets.all(16), child: Btn(t('Show more'), onTap: _loading ? null : () => _run(more: true)))),
            ),
          if (_loading && _items.isEmpty) const SliverToBoxAdapter(child: Padding(padding: EdgeInsets.all(40), child: Center(child: Spinner()))),
          const SliverToBoxAdapter(child: SizedBox(height: 40)),
        ]),
      ),
    );
  }
}

class _DiscoverCard extends StatelessWidget {
  const _DiscoverCard({required this.item, required this.busy, required this.inLibrary, required this.onTap});
  final ArchiveItem item;
  final bool busy, inLibrary;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final p = context.palette;
    final music = item.kind == 'music';
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      Pressable(
        scale: .98,
        onTap: busy ? null : onTap,
        child: AspectRatio(
          aspectRatio: music ? 1 : 2 / 3,
          child: Opacity(
            opacity: busy ? .6 : 1,
            child: Stack(fit: StackFit.expand, children: [
              ClipRRect(
                borderRadius: BorderRadius.circular(8),
                child: Stack(fit: StackFit.expand, children: [
                  Container(
                    color: p.surface2,
                    padding: const EdgeInsets.all(12),
                    alignment: AlignmentDirectional.bottomStart,
                    child: Column(mainAxisAlignment: MainAxisAlignment.end, crossAxisAlignment: CrossAxisAlignment.start, children: [
                      MIcon(music ? 'music' : 'play', size: 20, color: p.gold),
                      const SizedBox(height: 6),
                      Text(item.title, maxLines: 3, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 17, fontWeight: FontWeight.w700, height: 1.1, color: p.text)),
                    ]),
                  ),
                  Image.network(item.thumb, fit: BoxFit.cover, errorBuilder: (_, _, _) => const SizedBox.shrink(),
                      frameBuilder: (ctx, child, f, s) => AnimatedOpacity(opacity: f == null ? 0 : 1, duration: const Duration(milliseconds: 200), child: child)),
                ]),
              ),
              if (inLibrary) PositionedDirectional(top: 8, start: 8, child: Pill(t('In library'), background: p.sea, color: const Color(0xFF0B1F1C))),
              PositionedDirectional(
                bottom: 8,
                end: 8,
                child: Container(
                  height: 32,
                  padding: const EdgeInsets.symmetric(horizontal: 12),
                  decoration: BoxDecoration(color: p.accent, borderRadius: BorderRadius.circular(999), boxShadow: const [BoxShadow(color: Color(0x99000000), blurRadius: 24, offset: Offset(0, 10), spreadRadius: -8)]),
                  child: Row(mainAxisSize: MainAxisSize.min, children: [
                    MIcon(inLibrary ? 'play' : 'plus', size: 15, color: p.accentInk),
                    const SizedBox(width: 6),
                    Text(busy ? t('Adding…') : (inLibrary ? t('Play') : t('Add')),
                        style: TextStyle(color: p.accentInk, fontWeight: FontWeight.w700, fontSize: Tokens.fsSm)),
                  ]),
                ),
              ),
            ]),
          ),
        ),
      ),
      const SizedBox(height: 8),
      Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(item.title, maxLines: 2, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: Tokens.fsSm, height: 1.3, color: p.text, fontWeight: FontWeight.w500)),
            Text([item.year, item.creator].where((s) => s.isNotEmpty).join('  '),
                maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: Tokens.fsXs, color: p.muted)),
          ]),
        ),
        IconBtn('external', size: 30, iconSize: 15, tooltip: t('Details and licence on archive.org'), onTap: () {
          if (isArchivePageUrl(item.page)) Api.call('app:openUrl', [item.page]);
        }),
      ]),
    ]);
  }
}
