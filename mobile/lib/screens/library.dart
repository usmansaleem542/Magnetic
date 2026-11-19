// The library (web-app/renderer index.html #library), in the desktop's narrow layout:
// brand + actions, a full-width add field, toolbar, Continue watching, posters or rows.

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../app_state.dart';
import '../bridge.dart';
import '../format.dart';
import '../l10n.dart';
import '../store.dart';
import '../theme.dart';
import '../ui/icons.dart';
import '../ui/kit.dart';
import '../ui/toast.dart';
import 'common.dart';
import 'discover.dart';
import 'file_browser.dart';
import 'player.dart';
import 'prefs.dart';
import 'share.dart';
import 'trackers.dart';

class LibraryScreen extends StatefulWidget {
  const LibraryScreen({super.key});

  @override
  State<LibraryScreen> createState() => _LibraryScreenState();
}

const _statusOrder = {'downloading': 0, 'metadata': 1, 'queued': 2, 'seeding': 3, 'done': 4, 'paused': 5};

class _LibraryScreenState extends State<LibraryScreen> with WidgetsBindingObserver {
  final _add = TextEditingController();
  final _search = TextEditingController();
  String _query = '';
  late String _view = Store.get('view') as String? ?? 'grid';
  late String _sort = Store.get('sortBy') as String? ?? 'added';
  final _open = <String>{};
  bool _storageOk = true;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    AppState.instance.onOpen = (id) => addTorrentId(context, id);
    _checkStorage();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _add.dispose();
    _search.dispose();
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState s) {
    if (s == AppLifecycleState.resumed) _checkStorage();
  }

  Future<void> _checkStorage() async {
    final st = await Api.call<Map<Object?, Object?>>('app:storage');
    if (mounted) setState(() => _storageOk = st?['allFiles'] == true);
  }

  Future<void> _submitAdd() async {
    final v = _add.text.trim();
    if (v.isEmpty) return;
    if (!looksLikeTorrentId(v)) {
      Toasts.show(t('Paste a magnet link (magnet:?xt=…), a 40-character info hash or a link to a .torrent file.'), error: true);
      return;
    }
    _add.clear();
    FocusScope.of(context).unfocus();
    await addTorrentId(context, v);
  }

  Future<void> _paste() async {
    final text = (await Clipboard.getData(Clipboard.kTextPlain))?.text?.trim() ?? '';
    if (looksLikeTorrentId(text)) {
      _add.text = text;
      await _submitAdd();
    } else {
      _add.text = text;
    }
  }

  Future<void> _openTorrentFile() async {
    final paths = await FileBrowser.pickFiles(context, title: t('Open torrent file'), extensions: {'torrent'}, multiple: true);
    if (paths == null || paths.isEmpty) return;
    await run(Api.call('torrent:addPaths', [paths]));
  }

  List<Torrent> _visible(List<Torrent> all) {
    final q = _query.trim().toLowerCase();
    final l = all.where((x) => q.isEmpty || x.name.toLowerCase().contains(q)).toList();
    int cmp(Torrent a, Torrent b) => switch (_sort) {
          'name' => naturalCompare(a.name, b.name),
          'progress' => a.progress.compareTo(b.progress),
          'size' => b.length.compareTo(a.length),
          'status' => (_statusOrder[a.status] ?? 9).compareTo(_statusOrder[b.status] ?? 9),
          _ => b.addedAt.compareTo(a.addedAt),
        };
    l.sort(cmp);
    return l;
  }

  void _play(Torrent tor) {
    if (tor.mediaKind == 'none') {
      openFilesSheet(context, tor.infoHash);
    } else {
      PlayerScreen.open(context, tor.infoHash);
    }
  }

  void _menu(Torrent tor) => showTorrentMenu(context, tor, onTrackers: () => TrackersSheet.open(context, tor.infoHash));

  @override
  Widget build(BuildContext context) {
    final p = context.palette;
    return Scaffold(
      body: SafeArea(
        bottom: false,
        child: ListenableBuilder(
          listenable: AppState.instance,
          builder: (context, _) {
            final st = AppState.instance;
            final all = st.torrents;
            final shown = _visible(all);
            final recent = _query.isEmpty ? Recent.list().where((r) => st.byHash(r.ih) != null).take(12).toList() : <RecentWatch>[];
            return CustomScrollView(
              keyboardDismissBehavior: ScrollViewKeyboardDismissBehavior.onDrag,
              slivers: [
                SliverToBoxAdapter(child: _topBar(st)),
                SliverToBoxAdapter(child: _addForm()),
                if (!_storageOk) SliverToBoxAdapter(child: _storageBanner()),
                if (all.isEmpty)
                  SliverFillRemaining(hasScrollBody: false, child: _EmptyState(onDiscover: () => DiscoverScreen.open(context)))
                else ...[
                  SliverToBoxAdapter(child: _toolbar()),
                  if (recent.isNotEmpty) ...[
                    SliverToBoxAdapter(child: _heading(t('Continue watching'))),
                    SliverToBoxAdapter(child: _ContinueRow(items: recent)),
                    SliverToBoxAdapter(child: _heading(t('Your library'), top: 18)),
                  ],
                  if (shown.isEmpty)
                    SliverToBoxAdapter(
                      child: Padding(
                        padding: const EdgeInsets.fromLTRB(24, 24, 24, 0),
                        child: Text(t('No torrents match “{query}”.', {'query': _query.trim()}), style: TextStyle(color: p.muted)),
                      ),
                    )
                  else if (_view == 'grid')
                    _grid(shown)
                  else
                    SliverPadding(
                      padding: const EdgeInsets.fromLTRB(8, 0, 8, 0),
                      sliver: SliverList.builder(
                        itemCount: shown.length,
                        itemBuilder: (ctx, i) => _Row(
                          key: ValueKey(shown[i].infoHash),
                          tor: shown[i],
                          open: _open.contains(shown[i].infoHash),
                          onToggle: () => setState(() => _open.contains(shown[i].infoHash) ? _open.remove(shown[i].infoHash) : _open.add(shown[i].infoHash)),
                          onPlay: () => _play(shown[i]),
                          onMore: () => _menu(shown[i]),
                        ),
                      ),
                    ),
                  SliverToBoxAdapter(child: SizedBox(height: 56 + MediaQuery.paddingOf(context).bottom)),
                ],
              ],
            );
          },
        ),
      ),
    );
  }

  Widget _topBar(AppState st) {
    final p = context.palette;
    return Padding(
      padding: const EdgeInsets.fromLTRB(18, 10, 8, 4),
      child: Row(children: [
        BrandMark(size: 22, active: st.active),
        const SizedBox(width: 9),
        Text('Magnetic', style: TextStyle(fontSize: Tokens.fsLg + 2, fontWeight: FontWeight.w700, letterSpacing: -.2, color: p.text)),
        const Spacer(),
        IconBtn('compass', tooltip: t('Find free films and music'), onTap: () => DiscoverScreen.open(context)),
        IconBtn('file', tooltip: t('Open a .torrent file'), onTap: _openTorrentFile),
        IconBtn('share', tooltip: t('Share files as a new torrent'), onTap: () => ShareSheet.open(context)),
        IconBtn('gear', tooltip: t('Preferences'), onTap: () => PrefsScreen.open(context)),
      ]),
    );
  }

  Widget _addForm() {
    final p = context.palette;
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 6, 16, 12),
      child: Row(children: [
        Expanded(
          child: Field(
            controller: _add,
            hint: t('Paste a magnet link, info hash or .torrent URL'),
            onSubmitted: (_) => _submitAdd(),
            textDirection: TextDirection.ltr,
            suffix: IconButton(onPressed: _paste, tooltip: t('Paste'), icon: MIcon('paste', size: 18, color: p.muted)),
          ),
        ),
        const SizedBox(width: 8),
        Btn(t('Add'), kind: BtnKind.primary, onTap: _submitAdd),
      ]),
    );
  }

  Widget _storageBanner() {
    final p = context.palette;
    return Container(
      margin: const EdgeInsets.fromLTRB(16, 0, 16, 12),
      padding: const EdgeInsets.fromLTRB(14, 12, 10, 12),
      decoration: BoxDecoration(color: p.surface, borderRadius: BorderRadius.circular(Tokens.rMd), border: Border.all(color: p.gold.withValues(alpha: .5))),
      child: Row(children: [
        MIcon('folder', size: 20, color: p.gold),
        const SizedBox(width: 12),
        Expanded(
          child: Text(t('Allow access to your files so downloads can be saved to your Download folder.'),
              style: TextStyle(color: p.text, fontSize: Tokens.fsSm, height: 1.4)),
        ),
        const SizedBox(width: 8),
        Btn(t('Allow'), small: true, kind: BtnKind.primary, onTap: () => Api.call('app:requestStorage')),
      ]),
    );
  }

  Widget _toolbar() {
    final p = context.palette;
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 0, 16, 6),
      child: Row(children: [
        Expanded(
          child: Field(
            controller: _search,
            height: 38,
            hint: t('Find'),
            prefix: Padding(padding: const EdgeInsetsDirectional.only(start: 10, end: 6), child: MIcon('search', size: 16, color: p.faint)),
            onChanged: (v) => setState(() => _query = v),
            suffix: _query.isEmpty
                ? null
                : IconButton(
                    onPressed: () => setState(() {
                          _search.clear();
                          _query = '';
                        }),
                    icon: MIcon('close', size: 16, color: p.muted)),
          ),
        ),
        const SizedBox(width: 8),
        Segmented<String>(
          value: _view,
          segments: [Segment('grid', icon: 'grid', tooltip: t('Posters')), Segment('list', icon: 'rows', tooltip: t('List'))],
          onChanged: (v) {
            setState(() => _view = v);
            Store.set('view', v);
          },
        ),
        const SizedBox(width: 8),
        _SortButton(value: _sort, onChanged: (v) {
          setState(() => _sort = v);
          Store.set('sortBy', v);
        }),
      ]),
    );
  }

  Widget _heading(String text, {double top = 12}) => Padding(
        padding: EdgeInsets.fromLTRB(18, top, 18, 12),
        child: Text(text, style: TextStyle(fontSize: Tokens.fsLg, fontWeight: FontWeight.w700, letterSpacing: -.2, color: context.palette.text)),
      );

  Widget _grid(List<Torrent> shown) {
    return SliverPadding(
      padding: const EdgeInsets.fromLTRB(16, 6, 16, 0),
      sliver: SliverLayoutBuilder(builder: (ctx, c) {
        final cols = (c.crossAxisExtent / 180).floor().clamp(2, 6);
        const gap = 14.0;
        final w = (c.crossAxisExtent - gap * (cols - 1)) / cols;
        return SliverGrid.builder(
          gridDelegate: SliverGridDelegateWithFixedCrossAxisCount(
            crossAxisCount: cols,
            crossAxisSpacing: gap,
            mainAxisSpacing: 22,
            mainAxisExtent: w * 1.5 + 66,
          ),
          itemCount: shown.length,
          itemBuilder: (ctx, i) => _Card(
            key: ValueKey(shown[i].infoHash),
            tor: shown[i],
            onPlay: () => _play(shown[i]),
            onMore: () => _menu(shown[i]),
          ),
        );
      }),
    );
  }
}

class _SortButton extends StatelessWidget {
  const _SortButton({required this.value, required this.onChanged});
  final String value;
  final ValueChanged<String> onChanged;

  @override
  Widget build(BuildContext context) {
    final options = {'added': t('Newest first'), 'name': t('Name'), 'progress': t('Progress'), 'size': t('Size'), 'status': t('Status')};
    return Semantics(
      label: t('Sort torrents'),
      child: IconBtn('sort', tooltip: t('Sort torrents'), onTap: () {
        showActions(context, title: t('Sort torrents'), actions: [
          for (final e in options.entries) MenuAction(e.value, () => onChanged(e.key), checked: e.key == value),
        ]);
      }),
    );
  }
}

// ------------------------------------------------------------------ poster card

class _Card extends StatelessWidget {
  const _Card({super.key, required this.tor, required this.onPlay, required this.onMore});
  final Torrent tor;
  final VoidCallback onPlay, onMore;

  @override
  Widget build(BuildContext context) {
    final p = context.palette;
    final name = tor.name.isNotEmpty ? tor.name : t('Fetching torrent details…');
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      Semantics(
        button: true,
        label: tor.playable ? t('Play {name}', {'name': name}) : t('Show files in {name}', {'name': name}),
        child: Pressable(
          scale: .98,
          onTap: onPlay,
          onLongPress: onMore,
          child: AspectRatio(
            aspectRatio: 2 / 3,
            child: Stack(fit: StackFit.expand, children: [
              PosterArt(title: name, poster: tor.poster, icon: mediaIcon(tor)),
              if (tor.paused)
                PositionedDirectional(top: 8, start: 8, child: Pill(tor.seedLimitReached ? t('Done') : t('Paused'))),
            ]),
          ),
        ),
      ),
      const SizedBox(height: 8),
      Strip(pieces: tor.pieces, progress: tor.progress, status: tor.status),
      const SizedBox(height: 6),
      Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(name, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontWeight: FontWeight.w600, color: p.text, fontSize: Tokens.fsMd)),
            const SizedBox(height: 2),
            StatusLine(tor, short: true),
          ]),
        ),
        IconBtn(tor.paused ? 'resume' : 'pause', size: 32, iconSize: 17, tooltip: tor.paused ? t('Resume') : t('Pause'),
            onTap: () => run(Api.call(tor.paused ? 'torrent:resume' : 'torrent:pause', [tor.infoHash]))),
        IconBtn('more', size: 32, iconSize: 17, tooltip: t('More actions'), onTap: onMore),
      ]),
    ]);
  }
}

// ------------------------------------------------------------------ list row

class _Row extends StatelessWidget {
  const _Row({super.key, required this.tor, required this.open, required this.onToggle, required this.onPlay, required this.onMore});
  final Torrent tor;
  final bool open;
  final VoidCallback onToggle, onPlay, onMore;

  @override
  Widget build(BuildContext context) {
    final p = context.palette;
    final name = tor.name.isNotEmpty ? tor.name : t('Fetching torrent details…');
    return AnimatedContainer(
      duration: const Duration(milliseconds: 150),
      margin: const EdgeInsets.only(bottom: 2),
      padding: const EdgeInsets.fromLTRB(10, 10, 6, 14),
      decoration: BoxDecoration(color: open ? p.surface : Colors.transparent, borderRadius: BorderRadius.circular(Tokens.rMd)),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Row(children: [
          Expanded(
            child: GestureDetector(
              behavior: HitTestBehavior.opaque,
              onTap: onToggle,
              onLongPress: onMore,
              child: Row(children: [
                SizedBox(
                  width: 64,
                  height: 40,
                  child: ClipRRect(
                    borderRadius: BorderRadius.circular(5),
                    child: Stack(fit: StackFit.expand, children: [
                      Container(color: p.surface2, alignment: Alignment.center, child: MIcon(mediaIcon(tor), size: 16, color: p.faint)),
                      if (tor.poster != null) Image.network(tor.poster!, fit: BoxFit.cover, errorBuilder: (_, _, _) => const SizedBox.shrink()),
                    ]),
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Row(children: [
                      Flexible(child: Text(name, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontWeight: FontWeight.w600, color: p.text, fontSize: Tokens.fsMd))),
                      const SizedBox(width: 4),
                      AnimatedRotation(
                        turns: open ? (isRtl ? -.25 : .25) : 0,
                        duration: const Duration(milliseconds: 150),
                        curve: Tokens.easeOut,
                        child: MIcon('chevron', size: 14, color: p.faint, mirror: true),
                      ),
                    ]),
                    const SizedBox(height: 2),
                    StatusLine(tor, short: false),
                  ]),
                ),
              ]),
            ),
          ),
          if (tor.playable)
            Padding(
              padding: const EdgeInsetsDirectional.only(start: 6),
              child: IconBtn('play', size: 36, iconSize: 18, color: p.accentInk, background: p.accent, tooltip: t('Play'), onTap: onPlay),
            ),
          IconBtn(tor.paused ? 'resume' : 'pause', size: 36, iconSize: 18, tooltip: tor.paused ? t('Resume') : t('Pause'),
              onTap: () => run(Api.call(tor.paused ? 'torrent:resume' : 'torrent:pause', [tor.infoHash]))),
          IconBtn('more', size: 36, iconSize: 18, tooltip: t('More actions'), onTap: onMore),
        ]),
        const SizedBox(height: 10),
        Strip(pieces: tor.pieces, progress: tor.progress, status: tor.status, height: 6),
        if (open) ...[
          const SizedBox(height: 10),
          FileList(tor: tor, onPlay: (f) => PlayerScreen.open(context, tor.infoHash, index: f.index)),
        ],
      ]),
    );
  }
}

// ------------------------------------------------------------------ continue watching

class _ContinueRow extends StatelessWidget {
  const _ContinueRow({required this.items});
  final List<RecentWatch> items;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      height: 140 * 1.5 + 54,
      child: ListView.separated(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.symmetric(horizontal: 16),
        itemCount: items.length,
        separatorBuilder: (_, _) => const SizedBox(width: 14),
        itemBuilder: (ctx, i) => _ContinueCard(r: items[i]),
      ),
    );
  }
}

class _ContinueCard extends StatelessWidget {
  const _ContinueCard({required this.r});
  final RecentWatch r;

  @override
  Widget build(BuildContext context) {
    final p = context.palette;
    final tor = AppState.instance.byHash(r.ih)!;
    final multi = tor.files.where((f) => f.kind == 'video').length > 1;
    final title = prettyName(multi ? r.name : (tor.name.isNotEmpty ? tor.name : r.name));
    final left = ((r.d - r.t) / 60).round().clamp(1, 1 << 30);
    return SizedBox(
      width: 140,
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Semantics(
          button: true,
          label: t('Resume {title}', {'title': title}),
          child: Pressable(
            scale: .98,
            onTap: () => PlayerScreen.open(context, r.ih, index: r.index),
            child: AspectRatio(
              aspectRatio: 2 / 3,
              child: Stack(fit: StackFit.expand, children: [
                PosterArt(title: title, poster: tor.poster, titleSize: 17),
                Positioned(
                  left: 0,
                  right: 0,
                  bottom: 0,
                  height: 4,
                  child: ClipRRect(
                    borderRadius: const BorderRadius.vertical(bottom: Radius.circular(8)),
                    child: Stack(children: [
                      Container(color: const Color(0x38FFFFFF)),
                      FractionallySizedBox(
                        alignment: AlignmentDirectional.centerStart,
                        widthFactor: (r.t / r.d).clamp(0, 1),
                        child: Container(color: p.gold),
                      ),
                    ]),
                  ),
                ),
                PositionedDirectional(
                  top: 6,
                  end: 6,
                  child: IconBtn('close', size: 28, iconSize: 14, color: Colors.white, background: const Color(0x9E000000),
                      tooltip: t('Remove {title} from Continue watching', {'title': title}),
                      onTap: () {
                        Recent.forget(r.ih);
                        AppState.instance.refresh();
                      }),
                ),
              ]),
            ),
          ),
        ),
        const SizedBox(height: 8),
        Text(title, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontWeight: FontWeight.w600, color: p.text, fontSize: Tokens.fsSm)),
        Text(
          [t('{m} min left', {'m': left}), if (multi && tor.name.isNotEmpty) tor.name].join('  '),
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          style: TextStyle(fontSize: Tokens.fsXs, color: p.muted),
        ),
      ]),
    );
  }
}

// ------------------------------------------------------------------ empty state

class _EmptyState extends StatelessWidget {
  const _EmptyState({required this.onDiscover});
  final VoidCallback onDiscover;

  @override
  Widget build(BuildContext context) {
    final p = context.palette;
    return Padding(
      padding: const EdgeInsets.fromLTRB(24, 40, 24, 80),
      child: Column(mainAxisAlignment: MainAxisAlignment.center, crossAxisAlignment: CrossAxisAlignment.start, children: [
        // Decorative strip: a few pieces already on disk.
        SizedBox(height: 10, width: double.infinity, child: CustomPaint(painter: _EmptyStripPainter(p.gold, p.line, p.bg))),
        const SizedBox(height: 26),
        Text(t('Paste a magnet link to start watching.'),
            style: TextStyle(fontSize: Tokens.fsXl, fontWeight: FontWeight.w700, height: 1.15, letterSpacing: -.5, color: p.text)),
        const SizedBox(height: 12),
        Text(t('Videos play while they download, and you can skip to any point. Pieces you jump to are fetched first.'),
            style: TextStyle(color: p.muted, fontSize: Tokens.fsMd, height: 1.5)),
        const SizedBox(height: 22),
        Btn(t('Browse free films and music'), icon: 'compass', kind: BtnKind.primary, onTap: onDiscover),
        const SizedBox(height: 18),
        Text(t('You can also open magnet links and .torrent files from other apps, or share them to Magnetic.'),
            style: TextStyle(color: p.muted, fontSize: Tokens.fsSm, height: 1.5)),
      ]),
    );
  }
}

class _EmptyStripPainter extends CustomPainter {
  _EmptyStripPainter(this.gold, this.line, this.bg);
  final Color gold, line, bg;

  @override
  void paint(Canvas canvas, Size size) {
    const segs = [(0.0, .18, true), (.18, .31, false), (.31, .38, true), (.38, .64, false), (.64, .70, true), (.70, 1.0, false)];
    final w = size.width, h = size.height;
    final clip = RRect.fromRectAndRadius(Offset.zero & size, const Radius.circular(3));
    canvas.save();
    canvas.clipRRect(clip);
    for (final (a, b, on) in segs) {
      canvas.drawRect(Rect.fromLTWH(w * a, 0, w * (b - a), h), Paint()..color = on ? gold : line);
    }
    // 7px pieces with 2px gaps.
    for (var x = 7.0; x < w; x += 9) {
      canvas.drawRect(Rect.fromLTWH(x, 0, 2, h), Paint()..color = bg);
    }
    canvas.restore();
  }

  @override
  bool shouldRepaint(_EmptyStripPainter o) => o.gold != gold || o.line != line || o.bg != bg;
}
