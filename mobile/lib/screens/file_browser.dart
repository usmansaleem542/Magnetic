// One browser for every place the desktop opened a system dialog: .torrent files, the download
// folder, files or folders to share, subtitle files, and "Show in folder". Needs all-files access.

import 'dart:io';

import 'package:flutter/material.dart';

import '../bridge.dart';
import '../format.dart';
import '../l10n.dart';
import '../theme.dart';
import '../ui/icons.dart';
import '../ui/kit.dart';

enum BrowseMode { folder, file, fileOrFolder, view }

class FileBrowser extends StatefulWidget {
  const FileBrowser({super.key, required this.mode, required this.title, this.start, this.extensions, this.multiple = false});
  final BrowseMode mode;
  final String title;
  final String? start;
  final Set<String>? extensions;
  final bool multiple;

  static Future<String?> pickFolder(BuildContext context, {required String title, String? start}) async =>
      (await _push(context, FileBrowser(mode: BrowseMode.folder, title: title, start: start)))?.firstOrNull;

  static Future<List<String>?> pickFiles(BuildContext context, {required String title, required Set<String> extensions, bool multiple = false, String? start}) =>
      _push(context, FileBrowser(mode: BrowseMode.file, title: title, extensions: extensions, multiple: multiple, start: start));

  static Future<String?> pickShare(BuildContext context, {required String title}) async =>
      (await _push(context, FileBrowser(mode: BrowseMode.fileOrFolder, title: title)))?.firstOrNull;

  static Future<void> browse(BuildContext context, String path) => _push(context, FileBrowser(mode: BrowseMode.view, title: t('Show in folder'), start: path));

  static Future<List<String>?> _push(BuildContext context, FileBrowser b) =>
      Navigator.of(context).push<List<String>>(MaterialPageRoute(builder: (_) => b));

  @override
  State<FileBrowser> createState() => _FileBrowserState();
}

class _FileBrowserState extends State<FileBrowser> with WidgetsBindingObserver {
  String? _root;
  Directory? _dir;
  List<FileSystemEntity> _items = const [];
  bool _allowed = true;
  final _picked = <String>{};

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _init();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  // Coming back from the permission screen.
  @override
  void didChangeAppLifecycleState(AppLifecycleState s) {
    if (s == AppLifecycleState.resumed) _init();
  }

  Future<void> _init() async {
    final st = (await Api.call<Map<Object?, Object?>>('app:storage'))!;
    _allowed = st['allFiles'] == true;
    _root = st['root'] as String;
    var start = widget.start != null ? Directory(widget.start!) : Directory(st['downloads'] as String);
    while (!start.existsSync() && start.parent.path != start.path) {
      start = start.parent;
    }
    _open(start.existsSync() ? start : Directory(_root!));
  }

  void _open(Directory d) {
    List<FileSystemEntity> items;
    try {
      items = d.listSync().where((e) => !e.uri.pathSegments.where((s) => s.isNotEmpty).last.startsWith('.')).toList();
    } catch (_) {
      items = const [];
    }
    final ext = widget.extensions;
    items = items.where((e) => e is Directory || widget.mode != BrowseMode.folder).where((e) {
      if (e is Directory || ext == null) return true;
      return ext.contains(e.path.split('.').last.toLowerCase());
    }).toList()
      ..sort((a, b) {
        if ((a is Directory) != (b is Directory)) return a is Directory ? -1 : 1;
        return naturalCompare(_name(a), _name(b));
      });
    setState(() {
      _dir = d;
      _items = items;
    });
  }

  String _name(FileSystemEntity e) => e.uri.pathSegments.where((s) => s.isNotEmpty).last;

  String _shortPath(String p) => _root != null && p.startsWith(_root!) ? p.replaceFirst(_root!, t('Phone')) : p;

  void _tapFile(File f) {
    if (widget.mode == BrowseMode.view) return;
    if (widget.multiple) {
      setState(() => _picked.contains(f.path) ? _picked.remove(f.path) : _picked.add(f.path));
    } else {
      Navigator.pop(context, [f.path]);
    }
  }

  @override
  Widget build(BuildContext context) {
    final p = context.palette;
    final dir = _dir;
    final canUp = dir != null && _root != null && dir.path != _root && dir.path.startsWith(_root!);
    return Scaffold(
      appBar: AppBar(
        backgroundColor: p.bg,
        surfaceTintColor: Colors.transparent,
        leading: IconBtn('back', mirror: true, color: p.text, onTap: () => Navigator.pop(context)),
        title: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(widget.title, style: TextStyle(fontSize: Tokens.fsLg, fontWeight: FontWeight.w700, color: p.text)),
          if (dir != null)
            Text(_shortPath(dir.path), maxLines: 1, overflow: TextOverflow.ellipsis, textDirection: TextDirection.ltr, style: TextStyle(fontSize: Tokens.fsXs, color: p.muted)),
        ]),
      ),
      body: !_allowed
          ? _PermissionPrompt(onGrant: () => Api.call('app:requestStorage'))
          : ListView(children: [
              if (canUp)
                _Row(icon: 'back', name: '..', onTap: () => _open(dir.parent)),
              for (final e in _items)
                e is Directory
                    ? _Row(
                        icon: 'folder',
                        name: _name(e),
                        onTap: () => _open(e),
                        trailing: widget.mode == BrowseMode.fileOrFolder
                            ? Btn(t('Share'), small: true, onTap: () => Navigator.pop(context, [e.path]))
                            : MIcon('chevron', size: 16, color: p.faint, mirror: true),
                      )
                    : _Row(
                        icon: 'file',
                        name: _name(e),
                        detail: fmtBytes((e as File).statSync().size),
                        dim: widget.mode == BrowseMode.folder || widget.mode == BrowseMode.view,
                        onTap: () => _tapFile(e),
                        trailing: widget.multiple ? GoldCheck(value: _picked.contains(e.path), onChanged: (_) => _tapFile(e)) : null,
                      ),
              if (_items.isEmpty)
                Padding(padding: const EdgeInsets.all(32), child: Text(t('This folder is empty.'), textAlign: TextAlign.center, style: TextStyle(color: p.muted))),
            ]),
      bottomNavigationBar: !_allowed || dir == null || (widget.mode != BrowseMode.folder && !widget.multiple)
          ? null
          : SafeArea(
              child: Container(
                padding: const EdgeInsets.fromLTRB(16, 12, 16, 12),
                decoration: BoxDecoration(color: p.surface, border: Border(top: BorderSide(color: p.line))),
                child: widget.multiple
                    ? Btn(t('Open {n}', {'n': _picked.length}), kind: BtnKind.primary, expand: true,
                        onTap: _picked.isEmpty ? null : () => Navigator.pop(context, _picked.toList()))
                    : Row(children: [
                        Expanded(child: Btn(t('New folder'), onTap: () => _newFolder(dir))),
                        const SizedBox(width: 8),
                        Expanded(child: Btn(t('Use this folder'), kind: BtnKind.primary, onTap: () => Navigator.pop(context, [dir.path]))),
                      ]),
              ),
            ),
    );
  }

  Future<void> _newFolder(Directory dir) async {
    final c = TextEditingController();
    final name = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: ctx.palette.surface,
        title: Text(t('New folder')),
        content: Field(controller: c, autofocus: true, onSubmitted: (v) => Navigator.pop(ctx, v)),
        actions: [
          Btn(t('Cancel'), inDialog: true, onTap: () => Navigator.pop(ctx)),
          Btn(t('Create'), kind: BtnKind.primary, onTap: () => Navigator.pop(ctx, c.text)),
        ],
      ),
    );
    if (name == null || name.trim().isEmpty) return;
    final d = Directory('${dir.path}/${name.trim()}')..createSync(recursive: true);
    _open(d);
  }
}

class _Row extends StatelessWidget {
  const _Row({required this.icon, required this.name, this.onTap, this.trailing, this.detail, this.dim = false});
  final String icon, name;
  final String? detail;
  final VoidCallback? onTap;
  final Widget? trailing;
  final bool dim;

  @override
  Widget build(BuildContext context) {
    final p = context.palette;
    return InkWell(
      onTap: onTap,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
        child: Row(children: [
          MIcon(icon, size: 20, color: icon == 'folder' ? p.gold : p.muted, mirror: icon == 'back'),
          const SizedBox(width: 14),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(name, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(color: dim ? p.faint : p.text, fontSize: Tokens.fsMd)),
              if (detail != null) Text(detail!, style: TextStyle(color: p.muted, fontSize: Tokens.fsXs)),
            ]),
          ),
          ?trailing,
        ]),
      ),
    );
  }
}

class _PermissionPrompt extends StatelessWidget {
  const _PermissionPrompt({required this.onGrant});
  final VoidCallback onGrant;

  @override
  Widget build(BuildContext context) {
    final p = context.palette;
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(28),
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          MIcon('folder', size: 40, color: p.gold),
          const SizedBox(height: 16),
          Text(t('Allow access to your files'), style: TextStyle(fontSize: Tokens.fsLg, fontWeight: FontWeight.w700, color: p.text)),
          const SizedBox(height: 8),
          Text(t('Magnetic saves downloads where you choose and shares files from where they are, so it needs access to all files.'),
              textAlign: TextAlign.center, style: TextStyle(color: p.muted, height: 1.45)),
          const SizedBox(height: 20),
          Btn(t('Allow access'), kind: BtnKind.primary, onTap: onGrant),
        ]),
      ),
    );
  }
}
