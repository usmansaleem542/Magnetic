// Library helpers shared by several screens: status text, the file list, add/remove flows.

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../app_state.dart';
import '../bridge.dart';
import '../format.dart';
import '../l10n.dart';
import '../theme.dart';
import '../ui/icons.dart';
import '../ui/kit.dart';
import '../ui/toast.dart';
import 'file_browser.dart';
import 'player.dart';

/// statusParts (app.js:376-405): ordered (style, text) parts. Styles: dl, sea, paused, ''.
List<(String, String)> statusParts(Torrent tor, {required bool short}) {
  final peers = tor.numPeers;
  final size = fmtBytes(tor.length);
  switch (tor.status) {
    case 'metadata':
      return [('dl', short ? t('Connecting') : t(peers == 1 ? 'Connecting, {n} peer' : 'Connecting, {n} peers', {'n': peers}))];
    case 'downloading':
      if (short) return [('dl', pct(tor.progress)), ('', fmtSpeed(tor.downloadSpeed))];
      final eta = fmtEta(tor.timeRemaining);
      return [('dl', pct(tor.progress)), ('', t('of {size}', {'size': size})), if (eta.isNotEmpty) ('', eta)];
    case 'done':
      return [('sea', t('Downloaded')), ('', size)];
    case 'seeding':
      return [('sea', t('Seeding')), ('', size), if (!short && tor.ratio > 0) ('', t('Ratio {ratio}', {'ratio': tor.ratio.toStringAsFixed(2)}))];
    case 'queued':
      final watching = tor.queueReason == 'watching';
      return [
        ('paused', watching ? t(short ? 'Waiting' : 'Waiting while you watch') : t('Queued')),
        if (tor.length > 0) ('', short ? pct(tor.progress) : t('{pct} of {size}', {'pct': pct(tor.progress), 'size': size})),
      ];
    default:
      if (tor.seedLimitReached) return [('sea', t('Done seeding')), if (!short) ('', t('Reached your share ratio'))];
      return [
        ('paused', t('Paused')),
        if (tor.length > 0) ('', short ? pct(tor.progress) : t('{pct} of {size}', {'pct': pct(tor.progress), 'size': size})),
      ];
  }
}

class StatusLine extends StatelessWidget {
  const StatusLine(this.tor, {super.key, required this.short});
  final Torrent tor;
  final bool short;

  @override
  Widget build(BuildContext context) {
    final p = context.palette;
    final color = {'dl': p.goldText, 'sea': p.seaText, 'paused': p.faint};
    return Wrap(
      spacing: short ? 10 : 14,
      children: [
        for (final (cls, text) in statusParts(tor, short: short))
          Text(text, maxLines: 1, style: TextStyle(fontSize: Tokens.fsXs, color: color[cls] ?? p.muted, fontFeatures: const [FontFeature.tabularFigures()])),
      ],
    );
  }
}

/// renderFiles (app.js:550-603): tick to download, size, progress, play.
class FileList extends StatelessWidget {
  const FileList({super.key, required this.tor, this.onPlay});
  final Torrent tor;
  final void Function(TFile f)? onPlay;

  @override
  Widget build(BuildContext context) {
    final p = context.palette;
    final files = tor.files.where((f) => f.kind != 'padding').toList();
    if (files.isEmpty) {
      return Padding(
        padding: const EdgeInsets.symmetric(vertical: 10, horizontal: 6),
        child: Text(t('The file list appears once peers send the torrent details.'), style: TextStyle(color: p.muted, fontSize: Tokens.fsSm)),
      );
    }
    return Column(children: [
      for (final f in files)
        Padding(
          padding: const EdgeInsets.symmetric(vertical: 1),
          child: Row(children: [
            SizedBox(
              width: 36,
              child: Semantics(
                label: t('Download {name}', {'name': f.name}),
                child: GoldCheck(value: f.selected, onChanged: (v) => run(Api.call('torrent:selectFile', [tor.infoHash, f.index, v]))),
              ),
            ),
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(f.name,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(fontSize: Tokens.fsSm, color: f.selected ? p.text : p.faint)),
                const SizedBox(height: 2),
                Text('${fmtBytes(f.length)}   ${pct(f.progress)}', style: TextStyle(fontSize: Tokens.fsXs, color: p.muted)),
              ]),
            ),
            Opacity(
              opacity: f.isMedia ? 1 : 0,
              child: IgnorePointer(
                ignoring: !f.isMedia,
                child: IconBtn('play', size: 36, iconSize: 17, color: p.text, tooltip: t('Play {name}', {'name': f.name}), onTap: () => onPlay?.call(f)),
              ),
            ),
          ]),
        ),
    ]);
  }
}

// ------------------------------------------------------------------ flows

/// addId (app.js:700-705): add, then play the first video when autoPlay is on.
Future<void> addTorrentId(BuildContext context, String id) async {
  final st = AppState.instance;
  String? path;
  if (st.prefs['askSavePath'] == true) {
    path = await FileBrowser.pickFolder(context, title: t('Save torrent to…'), start: st.prefs['lastSavePath'] as String? ?? st.prefs['downloadPath'] as String?);
    if (path == null) return;
  }
  final ih = await run(Api.call<String>('torrent:add', [id, path]));
  if (ih == null || !context.mounted) return;
  if (st.prefs['autoPlay'] != false) PlayerScreen.open(context, ih);
}

void openFilesSheet(BuildContext context, String ih) {
  final tor = AppState.instance.byHash(ih);
  showSheet(
    context,
    title: tor?.name.isNotEmpty == true ? tor!.name : t('Files'),
    tall: true,
    builder: (ctx) => ListenableBuilder(
      listenable: AppState.instance,
      builder: (ctx, _) {
        final tor = AppState.instance.byHash(ih);
        if (tor == null) return const SizedBox.shrink();
        return ListView(padding: const EdgeInsets.fromLTRB(12, 0, 12, 16), children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(10, 0, 10, 12),
            child: Text(t('Untick files you don’t want. They won’t be downloaded.'), style: TextStyle(color: ctx.palette.muted)),
          ),
          FileList(
            tor: tor,
            onPlay: (f) {
              Navigator.pop(ctx);
              PlayerScreen.open(context, ih, index: f.index);
            },
          ),
        ]);
      },
    ),
    actions: [Builder(builder: (ctx) => Btn(t('Done'), kind: BtnKind.primary, onTap: () => Navigator.pop(ctx)))],
  );
}

Future<void> confirmRemove(BuildContext context, Torrent tor) async {
  final choice = await showChoice<String>(
    context,
    title: tor.name.isNotEmpty ? t('Remove “{name}”?', {'name': tor.name}) : t('Remove this torrent?'),
    body: t('Removing it stops downloading and seeding. You can keep the files you already downloaded, or delete them too.'),
    choices: [
      (t('Cancel'), 'cancel', BtnKind.ghost),
      (t('Remove and delete files'), 'delete', BtnKind.danger),
      (t('Remove, keep files'), 'keep', BtnKind.primary),
    ],
  );
  if (choice == 'keep' || choice == 'delete') {
    PlayerScreen.closeIfShowing(tor.infoHash);
    await run(Api.call('torrent:remove', [tor.infoHash, choice == 'delete']));
  }
}

/// The row "more" menu (index.html:452-460).
void showTorrentMenu(BuildContext context, Torrent tor, {required VoidCallback onTrackers}) {
  showActions(context, title: tor.name.isNotEmpty ? tor.name : null, actions: [
    MenuAction(t('Choose files…'), () => openFilesSheet(context, tor.infoHash), icon: 'list'),
    MenuAction(t('Trackers…'), onTrackers, icon: 'compass'),
    MenuAction(t('Show in folder'), () => FileBrowser.browse(context, tor.path), icon: 'folder'),
    MenuAction(t('Copy magnet link'), () async {
      final m = await run(Api.call<String>('torrent:magnet', [tor.infoHash]));
      if (m == null) return;
      await Clipboard.setData(ClipboardData(text: m));
      Toasts.show(t('Magnet link copied.'));
    }, icon: 'paste'),
    MenuAction(t('Save .torrent file…'), () async {
      final dir = await FileBrowser.pickFolder(context, title: t('Save .torrent file…'));
      if (dir == null) return;
      final saved = await run(Api.call<String>('torrent:saveFile', [tor.infoHash, dir]));
      if (saved != null) Toasts.show(t('Torrent file saved.'));
    }, icon: 'file'),
    null,
    MenuAction(t('Remove…'), () => confirmRemove(context, tor), icon: 'close', danger: true),
  ]);
}

/// Poster image with the desktop fallback (gradient, icon, big title) behind it.
class PosterArt extends StatelessWidget {
  const PosterArt({super.key, required this.title, this.poster, this.icon = 'play', this.titleSize = 21, this.radius = 8});
  final String title;
  final String? poster;
  final String icon;
  final double titleSize, radius;

  @override
  Widget build(BuildContext context) {
    final p = context.palette;
    final rtl = isRtl;
    final fallback = Container(
      padding: const EdgeInsets.fromLTRB(14, 14, 14, 14),
      decoration: BoxDecoration(
        gradient: LinearGradient(
          begin: rtl ? Alignment.topRight : Alignment.topLeft,
          end: rtl ? Alignment.bottomLeft : Alignment.bottomRight,
          colors: [p.surface2, p.fallbackEnd],
        ),
        border: Border.all(color: p.fallbackEdge),
        borderRadius: BorderRadius.circular(radius),
      ),
      foregroundDecoration: BoxDecoration(
        borderRadius: BorderRadius.circular(radius),
        gradient: RadialGradient(
          center: rtl ? Alignment.topLeft : Alignment.topRight,
          radius: 1.1,
          colors: [p.gold.withValues(alpha: .16), p.gold.withValues(alpha: 0)],
          stops: const [0, .6],
        ),
      ),
      child: Column(mainAxisAlignment: MainAxisAlignment.end, crossAxisAlignment: CrossAxisAlignment.start, children: [
        MIcon(icon, size: 22, color: p.gold),
        const SizedBox(height: 8),
        Text(title,
            maxLines: 3,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(fontSize: titleSize, fontWeight: FontWeight.w700, height: 1.1, letterSpacing: -.4, color: p.text)),
      ]),
    );
    return ClipRRect(
      borderRadius: BorderRadius.circular(radius),
      child: Stack(fit: StackFit.expand, children: [
        fallback,
        if (poster != null)
          Image.network(
            poster!,
            fit: BoxFit.cover,
            gaplessPlayback: true,
            frameBuilder: (ctx, child, frame, sync) =>
                AnimatedOpacity(opacity: frame == null ? 0 : 1, duration: const Duration(milliseconds: 200), child: child),
            errorBuilder: (ctx, e, s) => const SizedBox.shrink(),
          ),
      ]),
    );
  }
}

String mediaIcon(Torrent tor) => switch (tor.mediaKind) { 'audio' => 'music', 'none' => 'file', _ => 'play' };
