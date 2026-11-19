// The player (web-app/renderer index.html #player and app.js openPlayer…wake), on mpv.
// Always dark, landscape, chrome that hides after 2.6 s, gold piece map in the seek bar.

import 'dart:async';
import 'dart:math' as math;
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:media_kit/media_kit.dart';
import 'package:media_kit_video/media_kit_video.dart';

import '../app_state.dart';
import '../bridge.dart';
import '../format.dart';
import '../l10n.dart';
import '../services/subtitles.dart';
import '../store.dart';
import '../theme.dart';
import '../ui/icons.dart';
import '../ui/kit.dart';
import '../ui/toast.dart';
import 'player_panels.dart';

/// Always-dark player palette (styles.css .player).
abstract final class PlayerColors {
  static const text = Color(0xFFE5E5E5), muted = Color(0xFFA3A3A3), line = Color(0xFF2C2C2C);
  static const surface = Color(0xFF141414), surface2 = Color(0xFF1F1F1F), gold = Color(0xFFF0BE4B);
}

/// A subtitle the user can pick (desktop player.subs entries).
class SubSource {
  SubSource({required this.key, required this.kind, required this.label, required this.detail, this.fileIndex, this.path, this.track, this.language});
  final String key; // t:<index> | d:<path> | e:<track id>
  final String kind; // file | disk | embedded
  final String label, detail;
  final int? fileIndex;
  final String? path, language;
  final SubtitleTrack? track;
  String? utf8Path, encoding, text;
  List<Cue> cues = const [];
}

class PlayerScreen extends StatefulWidget {
  const PlayerScreen({super.key, required this.ih, this.index});
  final String ih;
  final int? index;

  static PlayerView? _current;

  static Future<void> open(BuildContext context, String ih, {int? index}) async {
    final st = AppState.instance;
    final ext = st.prefs['externalPlayer'] as String? ?? 'builtin';
    if (ext != 'builtin') return _openExternal(ih, index);
    final cur = _current;
    if (cur != null && cur.mounted) {
      cur.load(ih, index);
      return;
    }
    await Navigator.of(context).push(PageRouteBuilder(
      opaque: true,
      transitionDuration: const Duration(milliseconds: 200),
      pageBuilder: (_, _, _) => PlayerScreen(ih: ih, index: index),
      transitionsBuilder: (_, a, _, child) => FadeTransition(opacity: a, child: child),
    ));
  }

  static Future<void> _openExternal(String ih, int? index) async {
    var i = index;
    if (i == null) {
      Toasts.show(t('Fetching torrent details…'));
      final tor = await waitForFiles(ih);
      final f = tor == null ? null : pickDefaultFile(tor);
      if (f == null) {
        Toasts.show(t('This torrent has no video or audio files.'), error: true);
        return;
      }
      i = f.index;
    }
    try {
      await Api.call('media:external', [ih, i]);
      Toasts.show(t('Opening in your video player.'));
    } catch (e) {
      Toasts.show('$e', error: true);
    }
  }

  /// Closes the player if it shows [ih] (the torrent was removed).
  static void closeIfShowing(String ih) {
    final cur = _current;
    if (cur != null && cur.mounted && cur.ih == ih) cur.close();
  }

  @override
  State<PlayerScreen> createState() => PlayerView();
}

/// waitForFiles (app.js:1160): resumes a paused torrent, then polls every 400 ms until its files are known.
Future<Torrent?> waitForFiles(String ih, {bool Function()? cancelled}) async {
  var tor = AppState.instance.byHash(ih);
  if (tor == null) return null;
  if (tor.paused) await run(Api.call('torrent:resume', [ih]));
  while (true) {
    tor = AppState.instance.byHash(ih);
    if (tor == null || (cancelled?.call() ?? false)) return null;
    if (tor.files.isNotEmpty) return tor;
    await Future<void>.delayed(const Duration(milliseconds: 400));
  }
}

class PlayerView extends State<PlayerScreen> with WidgetsBindingObserver {
  final player = Player(configuration: const PlayerConfiguration(bufferSize: 64 * 1024 * 1024));
  late final controller = VideoController(player);

  late String ih = widget.ih;
  int? index;
  String kind = 'video';
  String fileName = '';
  int _loadToken = 0;

  // status / error overlays
  String? status;
  String? error;
  bool errorIsCodec = false;

  // chrome
  bool chrome = true;
  Timer? _hideTimer;
  bool dragging = false;
  bool panelOpen = false;
  bool playlistOpen = false;

  // playback
  Duration position = Duration.zero, duration = Duration.zero;
  bool playing = false, buffering = false, muted = false;
  double rate = 1;
  List<double> strip = const [];
  Timer? _poll;
  DateTime _lastSave = DateTime.fromMillisecondsSinceEpoch(0);
  bool _resumeDone = false;
  bool _posterTried = false;
  double _seekWidth = 300;
  final _subs = <StreamSubscription<Object?>>[];

  // audio-only card
  Map<Object?, Object?>? audioMeta;

  // subtitles
  final subtitles = <SubSource>[];
  String? activeSubKey;
  double subOffset = 0;
  bool _subPickedManually = false;
  Map<String, Object?> subStyle = {'size': 'm', 'bg': 'shade'};

  // casting
  Map<Object?, Object?>? casting; // {id, name, type, subtitles}
  Map<Object?, Object?>? castStatus;
  Timer? _castPoll;

  Torrent? get torrent => AppState.instance.byHash(ih);
  bool get isCasting => casting != null;

  @override
  void initState() {
    super.initState();
    PlayerScreen._current = this;
    WidgetsBinding.instance.addObserver(this);
    final stored = Store.get('subStyle');
    if (stored is Map) subStyle = {...subStyle, ...stored.cast<String, Object?>()};
    SystemChrome.setEnabledSystemUIMode(SystemUiMode.immersiveSticky);
    SystemChrome.setPreferredOrientations([DeviceOrientation.landscapeLeft, DeviceOrientation.landscapeRight]);
    _listen();
    AppState.instance.addListener(_onTorrents);
    AppState.instance.onMediaAction = _onMediaAction;
    load(widget.ih, widget.index);
  }

  void _listen() {
    _subs.addAll([
      player.stream.position.listen((p) {
        if (dragging || isCasting) return;
        position = p;
        _onTime();
        if (mounted) setState(() {});
      }),
      player.stream.duration.listen((d) {
        duration = d;
        _maybeResume();
        if (mounted) setState(() {});
      }),
      player.stream.playing.listen((p) {
        playing = p;
        Api.call('player:playing', [p]);
        _session();
        if (!p) wake();
        if (mounted) setState(() {});
      }),
      player.stream.buffering.listen((b) {
        buffering = b;
        if (b && status == null && error == null) {
          status = t('Fetching pieces…');
        } else if (!b && duration > Duration.zero) {
          status = null;
        }
        if (mounted) setState(() {});
      }),
      player.stream.completed.listen((done) {
        if (done) _ended();
      }),
      player.stream.error.listen(_onError),
      player.stream.tracks.listen((_) {
        _syncEmbedded();
        if (mounted) setState(() {});
      }),
      player.stream.width.listen((_) => _aspect()),
      player.stream.height.listen((_) => _aspect()),
    ]);
  }

  @override
  void dispose() {
    _teardown();
    if (PlayerScreen._current == this) PlayerScreen._current = null;
    WidgetsBinding.instance.removeObserver(this);
    AppState.instance.removeListener(_onTorrents);
    AppState.instance.onMediaAction = null;
    for (final s in _subs) {
      s.cancel();
    }
    player.dispose();
    SystemChrome.setEnabledSystemUIMode(SystemUiMode.edgeToEdge);
    SystemChrome.setPreferredOrientations(const []);
    super.dispose();
  }

  void _teardown() {
    savePosition();
    _poll?.cancel();
    _hideTimer?.cancel();
    _castPoll?.cancel();
    if (isCasting) {
      Api.call('cast:stop');
      casting = null;
    }
    Api.call('player:watching', [null]);
    Api.call('player:playing', [false]);
    Api.call('player:sessionClear');
  }

  void close() {
    if (mounted) Navigator.of(context).maybePop();
  }

  // ---------------------------------------------------------------- loading

  /// openPlayer (app.js:1170-1248).
  Future<void> load(String newIh, int? newIndex) async {
    final token = ++_loadToken;
    if (index != null) savePosition();
    setState(() {
      ih = newIh;
      error = null;
      status = t('Connecting to peers…');
      fileName = torrent?.name.isNotEmpty == true ? torrent!.name : t('Loading…');
      playlistOpen = false;
    });
    wake();
    await Api.call('player:watching', [ih]);

    var i = newIndex;
    if (i == null) {
      final tor = await waitForFiles(ih, cancelled: () => token != _loadToken || !mounted);
      if (token != _loadToken || !mounted) return;
      if (tor == null) return close();
      final f = pickDefaultFile(tor);
      if (f == null) {
        close();
        Toasts.show(t('This torrent has no video or audio files.'), error: true);
        return;
      }
      i = f.index;
    }

    Map<Object?, Object?>? info;
    try {
      info = await Api.call<Map<Object?, Object?>>('media:stream', [ih, i]);
    } catch (e) {
      if (token != _loadToken || !mounted) return;
      setState(() {
        status = null;
        error = '$e';
      });
      return;
    }
    if (token != _loadToken || !mounted || info == null) return;

    index = i;
    kind = info['kind'] as String? ?? 'video';
    fileName = info['name'] as String? ?? '';
    position = Duration.zero;
    duration = Duration.zero;
    strip = const [];
    _resumeDone = false;
    _posterTried = false;
    _subPickedManually = false;
    subtitles.clear();
    activeSubKey = null;
    audioMeta = null;
    subOffset = (Store.get('suboff:$ih:$i') as num?)?.toDouble() ?? 0;
    setState(() => status = t('Fetching the first pieces…'));

    if (isCasting) {
      await castTo(casting!['id'] as String, 0);
    } else {
      final native = player.platform as NativePlayer;
      // Pieces after a far seek can take a while; mpv's default 5 s timeout would drop and retry.
      await native.setProperty('network-timeout', '60');
      await native.setProperty('sub-delay', subOffset.toStringAsFixed(1));
      await player.open(Media(info['url'] as String), play: true);
      if (rate != 1) await player.setRate(rate);
    }

    _poll?.cancel();
    _poll = Timer.periodic(const Duration(seconds: 1), (_) => _pollStrip());
    _pollStrip();
    if (kind == 'audio') _loadAudioCard();
    _loadTorrentSubtitles();
    _session();
  }

  Future<void> _pollStrip() async {
    final i = index;
    if (i == null) return;
    final buckets = math.max(40, (_seekWidth / 3).floor());
    final s = await Api.call<List<Object?>>('media:strip', [ih, i, buckets]).catchError((_) => null);
    if (s != null && mounted) setState(() => strip = s.map((v) => (v as num).toDouble()).toList());
  }

  void _onTorrents() {
    final tor = torrent;
    if (tor == null) return close();
    // "Buffering from {n} peers, {speed}" while waiting for the first frame.
    if (status != null && error == null && (buffering || duration == Duration.zero) && !isCasting && index != null) {
      final n = tor.numPeers;
      status = n == 0
          ? t('Looking for peers…')
          : t(n == 1 ? 'Buffering from {n} peer, {speed}' : 'Buffering from {n} peers, {speed}', {'n': n, 'speed': fmtSpeed(tor.downloadSpeed)});
    }
    if (mounted) setState(() {});
  }

  Future<void> _loadAudioCard() async {
    final m = await Api.call<Map<Object?, Object?>>('media:metadata', [ih, index]).catchError((_) => null);
    if (mounted) setState(() => audioMeta = m);
    _session();
  }

  void _aspect() {
    final w = player.state.width, h = player.state.height;
    if (w != null && h != null && h > 0) Api.call('player:aspect', [w / h]);
  }

  // ---------------------------------------------------------------- position, resume, end

  String get _posKey => 'pos:$ih:$index';

  /// savePosition (app.js:1275): keep 5 s < t < d − 15 s, else forget it.
  void savePosition() {
    final i = index;
    final d = duration.inMilliseconds / 1000;
    if (i == null || d <= 0) return;
    final tt = (isCasting ? (castStatus?['currentTime'] as num?)?.toDouble() : null) ?? position.inMilliseconds / 1000;
    if (tt > 5 && tt < d - 15) {
      Store.set(_posKey, tt);
    } else {
      Store.remove(_posKey);
    }
    if (kind == 'video') Recent.remember(ih, i, tt, d, fileName);
  }

  void _maybeResume() {
    if (_resumeDone || duration == Duration.zero || isCasting) return;
    _resumeDone = true;
    final saved = (Store.get(_posKey) as num?)?.toDouble();
    final d = duration.inMilliseconds / 1000;
    if (saved != null && saved < d - 15) {
      player.seek(Duration(milliseconds: (saved * 1000).round()));
      Toasts.show(t('Resumed at {time}.', {'time': fmtClock(saved)}));
    }
  }

  void _onTime() {
    if (status != null && !buffering && position > Duration.zero) status = null;
    if (DateTime.now().difference(_lastSave) > const Duration(seconds: 5)) {
      _lastSave = DateTime.now();
      savePosition();
      _session();
    }
    _maybeCapturePoster();
  }

  void _ended() {
    Store.remove(_posKey);
    Recent.forget(ih);
    if (!step(1)) wake();
  }

  void _onError(String e) {
    if (isCasting || !mounted) return;
    final codec = RegExp(r'(codec|decoder|no video or audio|unrecognized file format|unsupported)', caseSensitive: false).hasMatch(e);
    final fatal = codec || e.startsWith('Failed to open') || e.contains('Failed to recognize file format');
    if (!fatal) return;
    setState(() {
      status = null;
      errorIsCodec = codec || e.contains('recognize');
      error = errorIsCodec
          ? t('This file uses a format or codec the built-in player can’t decode. It keeps downloading, and you can watch it in VLC or another player while it does.')
          : t('Playback stopped because the stream was interrupted. Try again, or open it in another player.');
    });
  }

  /// maybeCapturePoster (app.js:1367): one bright frame becomes the library poster.
  Future<void> _maybeCapturePoster() async {
    if (_posterTried || kind != 'video' || isCasting || torrent?.poster != null) return;
    final d = duration.inMilliseconds / 1000;
    if (d <= 0 || position.inMilliseconds / 1000 < math.min(60, d * .1)) return;
    _posterTried = true;
    try {
      final shot = await player.screenshot(format: 'image/jpeg');
      if (shot == null) return;
      final codec = await ui.instantiateImageCodec(shot, targetWidth: 16, targetHeight: 9);
      final frame = await codec.getNextFrame();
      final data = await frame.image.toByteData(format: ui.ImageByteFormat.rawRgba);
      if (data == null) return;
      var sum = 0.0;
      for (var p = 0; p < data.lengthInBytes; p += 4) {
        sum += .2126 * data.getUint8(p) + .7152 * data.getUint8(p + 1) + .0722 * data.getUint8(p + 2);
      }
      if (sum / (data.lengthInBytes / 4) < 28) {
        // Too dark; try again a little later.
        Future<void>.delayed(const Duration(seconds: 20), () => _posterTried = false);
        return;
      }
      await Api.call('media:savePoster', [ih, shot]);
    } catch (_) {}
  }

  // ---------------------------------------------------------------- controls

  List<TFile> get playlist {
    final tor = torrent;
    if (tor == null) return const [];
    var l = tor.files.where((f) => f.isMedia && (f.selected || f.index == index)).toList();
    if (l.isEmpty) l = tor.files.where((f) => f.isMedia).toList();
    l.sort((a, b) => naturalCompare(a.name, b.name));
    return l;
  }

  /// step (app.js:1415): next/previous in name order, no wrap-around.
  bool step(int dir) {
    final l = playlist;
    final at = l.indexWhere((f) => f.index == index);
    final next = at + dir;
    if (at < 0 || next < 0 || next >= l.length) return false;
    load(ih, l[next].index);
    return true;
  }

  void togglePlay() {
    if (isCasting) {
      final paused = castStatus?['paused'] == true;
      run(Api.call(paused ? 'cast:resume' : 'cast:pause'));
    } else {
      player.playOrPause();
    }
    wake();
  }

  double get curTime => isCasting ? (castStatus?['currentTime'] as num?)?.toDouble() ?? 0 : position.inMilliseconds / 1000;
  double get curDuration {
    final d = duration.inMilliseconds / 1000;
    return isCasting ? ((castStatus?['duration'] as num?)?.toDouble() ?? d) : d;
  }

  /// seekTo (app.js:1977): clamp to [0, duration − 0.1].
  void seekTo(double seconds) {
    final d = curDuration;
    if (d <= 0) return;
    final s = seconds.clamp(0, math.max(0, d - .1)).toDouble();
    if (isCasting) {
      run(Api.call('cast:seek', [s]));
      castStatus = {...?castStatus, 'currentTime': s};
    } else {
      position = Duration(milliseconds: (s * 1000).round());
      player.seek(position);
      if (strip.isNotEmpty) {
        final bucket = (s / d * strip.length).floor().clamp(0, strip.length - 1);
        if (strip[bucket] < 1) status = t('Fetching pieces for this point…');
      }
    }
    setState(() {});
  }

  void setRate(double r) {
    rate = r;
    player.setRate(r);
    setState(() {});
  }

  void toggleMute() {
    muted = !muted;
    player.setVolume(muted ? 0 : 100);
    setState(() {});
  }

  void wake() {
    _hideTimer?.cancel();
    if (!chrome) setState(() => chrome = true);
    _hideTimer = Timer(const Duration(milliseconds: 2600), () {
      if (!mounted || panelOpen || dragging || isCasting || (!playing && !isCasting)) return;
      setState(() {
        chrome = false;
        playlistOpen = false;
      });
    });
  }

  void _toggleChrome() {
    if (chrome && playing) {
      _hideTimer?.cancel();
      setState(() {
        chrome = false;
        playlistOpen = false;
      });
    } else {
      wake();
    }
  }

  Future<void> openExternal() async {
    if (index == null) return;
    player.pause();
    try {
      await Api.call('media:external', [ih, index]);
      Toasts.show(t('Opening in your video player.'));
    } catch (e) {
      Toasts.show('$e', error: true);
    }
  }

  void _rotate() {
    final portrait = MediaQuery.orientationOf(context) == Orientation.portrait;
    SystemChrome.setPreferredOrientations(portrait
        ? [DeviceOrientation.landscapeLeft, DeviceOrientation.landscapeRight]
        : [DeviceOrientation.portraitUp]);
  }

  // ---------------------------------------------------------------- media session

  void _session() {
    if (index == null) return;
    final meta = audioMeta;
    final title = (meta?['title'] as String?)?.isNotEmpty == true ? meta!['title'] as String : baseName(fileName);
    final l = playlist;
    final at = l.indexWhere((f) => f.index == index);
    Api.call('player:session', [
      {
        'title': title,
        'artist': meta?['artist'] ?? '',
        'album': (meta?['album'] as String?)?.isNotEmpty == true ? meta!['album'] : (torrent?.name ?? ''),
        'art': meta?['picture'],
        'playing': isCasting ? (castStatus?['paused'] != true) : playing,
        'position': curTime,
        'duration': curDuration,
        'hasPrev': at > 0,
        'hasNext': at >= 0 && at < l.length - 1,
      }
    ]).catchError((_) => null);
  }

  void _onMediaAction(String a) {
    switch (a) {
      case 'play':
        isCasting ? run(Api.call('cast:resume')) : player.play();
      case 'pause':
        isCasting ? run(Api.call('cast:pause')) : player.pause();
      case 'next':
        step(1);
      case 'previous':
        step(-1);
      case 'forward':
        seekTo(curTime + 10);
      case 'backward':
        seekTo(curTime - 10);
      default:
        if (a.startsWith('seek:')) seekTo(double.tryParse(a.substring(5)) ?? curTime);
    }
  }

  // ---------------------------------------------------------------- subtitles

  String get _pickKey => 'subpick:$ih:$index';

  /// Subtitle files inside the torrent (loadTorrentSubtitles).
  void _loadTorrentSubtitles() {
    final tor = torrent;
    if (tor == null || kind != 'video') return;
    for (final f in tor.files) {
      if (!RegExp(r'\.(srt|vtt|ass|ssa)$', caseSensitive: false).hasMatch(f.name)) continue;
      final lang = languageFromName(f.name);
      subtitles.add(SubSource(
        key: 't:${f.index}',
        kind: 'file',
        label: (lang != null ? languageName(lang) : null) ?? baseName(f.name),
        detail: f.name,
        fileIndex: f.index,
        language: lang,
      ));
    }
    _restoreDiskPick();
    _autoSelect();
    setState(() {});
  }

  void _restoreDiskPick() {
    final pick = Store.get(_pickKey);
    if (pick is Map && pick['path'] is String && !subtitles.any((s) => s.key == pick['key'])) {
      final path = pick['path'] as String;
      final lang = languageFromName(path);
      subtitles.add(SubSource(key: 'd:$path', kind: 'disk', label: (lang != null ? languageName(lang) : null) ?? baseName(path), detail: path.split('/').last, path: path, language: lang));
    }
  }

  /// Embedded tracks reported by mpv (desktop extracted them from MKV itself).
  void _syncEmbedded() {
    if (kind != 'video') return;
    final tracks = player.state.tracks.subtitle.where((s) => s.id != 'auto' && s.id != 'no' && !(s.uri)).toList();
    var changed = false;
    for (final tr in tracks) {
      final key = 'e:${tr.id}';
      if (subtitles.any((s) => s.key == key)) continue;
      final lang = normaliseLang(tr.language);
      subtitles.add(SubSource(
        key: key,
        kind: 'embedded',
        label: (lang != null ? languageName(lang) : null) ?? tr.title ?? t('Track {n}', {'n': tr.id}),
        detail: (tr.title?.isNotEmpty == true) ? t('{name}, in the video', {'name': tr.title}) : t('In the video'),
        track: tr,
        language: lang,
      ));
      changed = true;
    }
    if (changed) _autoSelect();
  }

  /// autoSelectSubtitle (app.js:1520): remembered pick, else best language score.
  void _autoSelect() {
    if (_subPickedManually || subtitles.isEmpty) return;
    final pick = Store.get(_pickKey);
    if (pick is Map) {
      if (pick['off'] == true) return;
      final s = subtitles.where((s) => s.key == pick['key']).firstOrNull;
      if (s != null && activeSubKey != s.key) selectSubtitle(s.key, manual: false);
      return;
    }
    final subLang = Store.get('subLang') as String?;
    final sys = WidgetsBinding.instance.platformDispatcher.locale.languageCode;
    final base = baseName(fileName).toLowerCase();
    int score(SubSource s) =>
        (s.language != null && s.language == subLang ? 4 : 0) +
        (s.language != null && s.language == sys ? 2 : 0) +
        (s.kind == 'file' && s.detail.toLowerCase().startsWith(base) ? 1 : 0);
    var best = subtitles.first;
    for (final s in subtitles) {
      if (score(s) > score(best)) best = s;
    }
    final cur = subtitles.where((s) => s.key == activeSubKey).firstOrNull;
    if (cur == null || score(best) > score(cur)) selectSubtitle(best.key, manual: false);
  }

  Future<void> selectSubtitle(String? key, {bool manual = true, String? encoding}) async {
    if (manual) {
      _subPickedManually = true;
      final s = subtitles.where((s) => s.key == key).firstOrNull;
      Store.set(_pickKey, key == null ? {'off': true} : {'key': key, 'path': s?.kind == 'disk' ? s!.path : null});
      if (s?.language != null) Store.set('subLang', s!.language);
    }
    if (key == null) {
      activeSubKey = null;
      await player.setSubtitleTrack(SubtitleTrack.no());
      setState(() {});
      if (manual && isCasting) _recastSoon();
      return;
    }
    final s = subtitles.firstWhere((s) => s.key == key);
    try {
      if (s.kind == 'embedded') {
        await player.setSubtitleTrack(s.track!);
      } else {
        final enc = encoding ?? Store.get('subenc:$ih:${s.key}') as String? ?? 'auto';
        final r = s.kind == 'file'
            ? await Api.call<Map<Object?, Object?>>('media:subtitle', [ih, s.fileIndex, enc])
            : await Api.call<Map<Object?, Object?>>('media:subtitleFile', [s.path, enc]);
        s.utf8Path = r!['utf8Path'] as String;
        s.encoding = r['encoding'] as String;
        s.text = r['text'] as String;
        s.cues = parseSubtitles(s.text!, s.detail);
        if (s.cues.isEmpty && s.kind == 'disk') {
          Toasts.show(t('No subtitles found in {name}.', {'name': s.detail}), error: true);
          return;
        }
        await player.setSubtitleTrack(SubtitleTrack.uri(Uri.file(s.utf8Path!).toString(), title: s.label, language: s.language));
      }
      activeSubKey = key;
      if (mounted) setState(() {});
      if (manual && isCasting) _recastSoon();
    } catch (e) {
      Toasts.show('$e', error: true);
    }
  }

  Future<void> changeEncoding(String enc) async {
    final s = subtitles.where((s) => s.key == activeSubKey).firstOrNull;
    if (s == null) return;
    enc == 'auto' ? Store.remove('subenc:$ih:${s.key}') : Store.set('subenc:$ih:${s.key}', enc);
    await selectSubtitle(s.key, manual: false, encoding: enc);
  }

  /// A subtitle file from the phone or from OpenSubtitles.
  Future<void> addDiskSubtitle(String path) async {
    final key = 'd:$path';
    if (!subtitles.any((s) => s.key == key)) {
      final lang = languageFromName(path);
      subtitles.add(SubSource(key: key, kind: 'disk', label: (lang != null ? languageName(lang) : null) ?? baseName(path), detail: path.split('/').last, path: path, language: lang));
    }
    await selectSubtitle(key);
  }

  /// setSubOffset: 0.1 s steps, remembered per video.
  void setSubOffset(double v) {
    var o = (v * 10).round() / 10;
    if (o.abs() < .05) o = 0;
    subOffset = o;
    o == 0 ? Store.remove('suboff:$ih:$index') : Store.set('suboff:$ih:$index', o);
    (player.platform as NativePlayer).setProperty('sub-delay', o.toStringAsFixed(1));
    setState(() {});
  }

  void setSubStyle(String k, String v) {
    subStyle = {...subStyle, k: v};
    Store.set('subStyle', subStyle);
    setState(() {});
  }

  void selectAudio(AudioTrack a) {
    player.setAudioTrack(a);
    Store.set('audio:$ih:$index', a.id);
    final lang = normaliseLang(a.language);
    if (lang != null) Store.set('audioLang', lang);
    Toasts.show(t('Audio: {name}', {'name': audioLabel(a)}));
    setState(() {});
  }

  String audioLabel(AudioTrack a) {
    final lang = normaliseLang(a.language);
    return (a.title?.isNotEmpty == true ? a.title : null) ?? (lang != null ? languageName(lang) : null) ?? a.language ?? t('Track {n}', {'n': a.id});
  }

  // ---------------------------------------------------------------- casting

  Timer? _recast;
  void _recastSoon() {
    _recast?.cancel();
    _recast = Timer(const Duration(milliseconds: 900), () => castTo(casting!['id'] as String, curTime));
  }

  Future<void> castTo(String deviceId, double start) async {
    final s = subtitles.where((s) => s.key == activeSubKey).firstOrNull;
    final vtt = s != null && s.cues.isNotEmpty ? cuesToVtt(s.cues, offset: subOffset) : null;
    try {
      final r = await Api.call<Map<Object?, Object?>>('cast:play', [deviceId, ih, index, start, vtt]);
      player.pause();
      setState(() {
        casting = r;
        status = null;
      });
      _castPoll?.cancel();
      _castPoll = Timer.periodic(const Duration(seconds: 1), (_) async {
        final st = await Api.call<Map<Object?, Object?>>('cast:status').catchError((_) => null);
        if (mounted && isCasting) setState(() => castStatus = st);
      });
    } catch (e) {
      Toasts.show('$e', error: true);
    }
  }

  Future<void> stopCasting({bool resumeHere = true}) async {
    final at = curTime;
    _castPoll?.cancel();
    await run(Api.call('cast:stop'));
    setState(() {
      casting = null;
      castStatus = null;
    });
    if (resumeHere) {
      await player.seek(Duration(milliseconds: (at * 1000).round()));
      await player.play();
    }
  }

  // ---------------------------------------------------------------- UI

  @override
  Widget build(BuildContext context) {
    final pip = AppState.instance.pip;
    final tor = torrent;
    final size = MediaQuery.sizeOf(context);
    final subPx = size.height * switch (subStyle['size']) { 's' => .034, 'l' => .056, 'xl' => .07, _ => .044 };
    final bg = subStyle['bg'];
    final subText = TextStyle(
      fontFamily: Tokens.font,
      fontSize: subPx,
      color: Colors.white,
      height: 1.25,
      backgroundColor: bg == 'shade' ? const Color(0x8C000000) : bg == 'solid' ? const Color(0xE6000000) : null,
      shadows: bg == 'none' ? const [Shadow(blurRadius: 3), Shadow(blurRadius: 3), Shadow(offset: Offset(0, 1), blurRadius: 2)] : null,
    );
    return PopScope(
      onPopInvokedWithResult: (_, _) => _teardown(),
      child: Theme(
        data: buildTheme(Brightness.dark),
        child: Scaffold(
          backgroundColor: Colors.black,
          body: Stack(fit: StackFit.expand, children: [
            // video + gestures
            GestureDetector(
              behavior: HitTestBehavior.opaque,
              onTap: _toggleChrome,
              onDoubleTapDown: (d) {
                final left = d.localPosition.dx < size.width / 2;
                seekTo(curTime + (left != isRtl ? -10 : 10));
                Toasts.show(left != isRtl ? '−10 s' : '+10 s');
              },
              onDoubleTap: () {},
              child: Video(
                controller: controller,
                controls: NoVideoControls,
                fill: Colors.black,
                subtitleViewConfiguration: SubtitleViewConfiguration(
                  style: subText,
                  padding: EdgeInsets.fromLTRB(24, 0, 24, chrome && !pip ? 110 : 28),
                ),
              ),
            ),
            if (kind == 'audio' && !isCasting) IgnorePointer(child: _AudioCard(meta: audioMeta, fileName: fileName, poster: tor?.poster)),
            if (isCasting) _CastOverlay(name: casting!['name'] as String? ?? '', onStop: () => stopCasting()),
            if (status != null && error == null && !isCasting && !pip) IgnorePointer(child: _StatusOverlay(text: status!)),
            if (error != null) _ErrorOverlay(text: error!, onExternal: openExternal),
            if (!pip)
              AnimatedOpacity(
                opacity: chrome ? 1 : 0,
                duration: Duration(milliseconds: chrome ? 120 : 400),
                child: IgnorePointer(ignoring: !chrome, child: _chrome(tor)),
              ),
          ]),
        ),
      ),
    );
  }

  Widget _chrome(Torrent? tor) {
    final pad = MediaQuery.paddingOf(context);
    final stats = tor == null
        ? ''
        : tor.paused
            ? t('Paused')
            : [
                t('{pct} downloaded', {'pct': pct(tor.files.where((f) => f.index == index).firstOrNull?.progress ?? tor.progress)}),
                t('Down {speed}', {'speed': fmtSpeed(tor.downloadSpeed)}),
                t(tor.numPeers == 1 ? '{n} peer' : '{n} peers', {'n': tor.numPeers}),
              ].join('    ');
    final multi = playlist.length > 1;
    return Stack(children: [
      // top chrome
      Positioned(
        top: 0,
        left: 0,
        right: 0,
        child: Container(
          padding: EdgeInsets.fromLTRB(math.max(14, pad.left), math.max(10, pad.top), math.max(14, pad.right), 40),
          decoration: const BoxDecoration(gradient: LinearGradient(begin: Alignment.topCenter, end: Alignment.bottomCenter, colors: [Color(0xB3000000), Color(0x00000000)])),
          child: Row(children: [
            IconBtn('back', mirror: true, color: PlayerColors.text, tooltip: t('Back to list'), onTap: close),
            const SizedBox(width: 6),
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(fileName, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontWeight: FontWeight.w600, color: PlayerColors.text, fontSize: Tokens.fsMd)),
                const SizedBox(height: 2),
                Text(stats, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: Tokens.fsXs, color: PlayerColors.muted)),
              ]),
            ),
            if (multi) IconBtn('list', color: PlayerColors.text, on: playlistOpen, tooltip: t('Playlist'), onTap: () => setState(() => playlistOpen = !playlistOpen)),
          ]),
        ),
      ),
      if (playlistOpen && multi)
        PositionedDirectional(
          top: 64 + MediaQuery.paddingOf(context).top,
          end: 14,
          bottom: 100,
          width: math.min(340, MediaQuery.sizeOf(context).width - 28),
          child: PlaylistPanel(files: playlist, current: index, onPick: (f) => load(ih, f.index)),
        ),
      // bottom chrome (always LTR, like desktop)
      Positioned(
        left: 0,
        right: 0,
        bottom: 0,
        child: Directionality(
          textDirection: TextDirection.ltr,
          child: Container(
            padding: EdgeInsets.fromLTRB(math.max(18, pad.left), 40, math.max(18, pad.right), math.max(10, pad.bottom)),
            decoration: const BoxDecoration(gradient: LinearGradient(begin: Alignment.topCenter, end: Alignment.bottomCenter, colors: [Color(0x00000000), Color(0xC7000000)])),
            child: Column(mainAxisSize: MainAxisSize.min, children: [
              LayoutBuilder(builder: (ctx, c) {
                _seekWidth = c.maxWidth;
                return SeekBar(
                  strip: strip,
                  time: curTime,
                  duration: curDuration,
                  onDragStart: () {
                    dragging = true;
                    wake();
                  },
                  onDrag: (s) {
                    if (!isCasting) seekTo(s);
                  },
                  onDragEnd: (s) {
                    dragging = false;
                    seekTo(s);
                    wake();
                  },
                );
              }),
              const SizedBox(height: 4),
              Row(children: [
                if (multi) IconBtn('prev', color: PlayerColors.text, tooltip: t('Previous file'), onTap: () => step(-1)),
                IconBtn(
                  (isCasting ? (castStatus?['paused'] == true) : !playing) ? 'play' : 'pause',
                  size: 46,
                  iconSize: 26,
                  color: PlayerColors.text,
                  tooltip: playing ? t('Pause') : t('Play'),
                  onTap: togglePlay,
                ),
                if (multi) IconBtn('next', color: PlayerColors.text, tooltip: t('Next file'), onTap: () => step(1)),
                IconBtn(muted ? 'mute' : 'volume', color: PlayerColors.text, tooltip: t('Mute'), onTap: toggleMute),
                const SizedBox(width: 8),
                Text('${fmtClock(curTime)} / ${fmtClock(curDuration)}',
                    style: const TextStyle(fontSize: Tokens.fsSm, color: PlayerColors.text, fontFeatures: [FontFeature.tabularFigures()])),
                const Spacer(),
                _SpeedButton(state: this),
                IconBtn('cc', color: PlayerColors.text, on: activeSubKey != null, tooltip: t('Audio and subtitles'), onTap: () => showCcPanel(context, this)),
                IconBtn('cast', color: PlayerColors.text, on: isCasting, tooltip: t('Play on a TV or speaker'), onTap: () => showCastMenu(context, this)),
                IconBtn('external', color: PlayerColors.text, tooltip: t('Open in external player'), onTap: openExternal),
                if (kind == 'video')
                  IconBtn('pip', color: PlayerColors.text, tooltip: t('Picture in picture'), onTap: isCasting ? null : () => Api.call('player:pip')),
                IconBtn('full', color: PlayerColors.text, tooltip: t('Full screen'), onTap: _rotate),
              ]),
            ]),
          ),
        ),
      ),
    ]);
  }
}

class _SpeedButton extends StatelessWidget {
  const _SpeedButton({required this.state});
  final PlayerView state;

  static String label(double r) => '${r == r.roundToDouble() ? r.toInt() : r}×';

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 4),
      child: Pressable(
        onTap: () {
          state.panelOpen = true;
          showActions(context, title: t('Playback speed'), actions: [
            for (final s in const [.5, .75, 1.0, 1.25, 1.5, 2.0]) MenuAction(s == 1 ? t('Normal') : label(s), () => state.setRate(s), checked: s == state.rate),
          ]).whenComplete(() => state.panelOpen = false);
        },
        child: Container(
          height: 30,
          padding: const EdgeInsets.symmetric(horizontal: 10),
          alignment: Alignment.center,
          decoration: BoxDecoration(color: const Color(0x14FFFFFF), borderRadius: BorderRadius.circular(6)),
          child: Text(label(state.rate), style: const TextStyle(color: PlayerColors.text, fontSize: Tokens.fsSm, fontWeight: FontWeight.w600)),
        ),
      ),
    );
  }
}

// ------------------------------------------------------------------ seek bar

/// drawSeek (app.js:2078-2165): rounded track, pieces on disk in gold, watched part pale gold.
class SeekBar extends StatefulWidget {
  const SeekBar({super.key, required this.strip, required this.time, required this.duration, required this.onDragStart, required this.onDrag, required this.onDragEnd});
  final List<double> strip;
  final double time, duration;
  final VoidCallback onDragStart;
  final ValueChanged<double> onDrag, onDragEnd;

  @override
  State<SeekBar> createState() => _SeekBarState();
}

class _SeekBarState extends State<SeekBar> {
  double? _drag; // ratio while dragging

  double _ratio(Offset p, double w) => (p.dx / w).clamp(0.0, 1.0);

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(builder: (ctx, c) {
      final w = c.maxWidth;
      final d = widget.duration;
      final played = _drag ?? (d > 0 ? (widget.time / d).clamp(0.0, 1.0) : 0.0);
      String? tip;
      var notYet = false;
      if (_drag != null && d > 0) {
        tip = fmtClock(_drag! * d);
        if (widget.strip.isNotEmpty) {
          final b = (_drag! * widget.strip.length).floor().clamp(0, widget.strip.length - 1);
          notYet = widget.strip[b] < 1;
        }
      }
      return Semantics(
        slider: true,
        label: t('Seek'),
        value: t('{time} of {duration}', {'time': fmtClock(widget.time), 'duration': fmtClock(d)}),
        child: GestureDetector(
          behavior: HitTestBehavior.opaque,
          onHorizontalDragStart: (e) {
            setState(() => _drag = _ratio(e.localPosition, w));
            widget.onDragStart();
            widget.onDrag(_drag! * d);
          },
          onHorizontalDragUpdate: (e) {
            setState(() => _drag = _ratio(e.localPosition, w));
            widget.onDrag(_drag! * d);
          },
          onHorizontalDragEnd: (_) {
            final r = _drag ?? played;
            setState(() => _drag = null);
            widget.onDragEnd(r * d);
          },
          onTapUp: (e) {
            widget.onDragStart();
            widget.onDragEnd(_ratio(e.localPosition, w) * d);
          },
          child: SizedBox(
            height: 32,
            child: Stack(clipBehavior: Clip.none, children: [
              Positioned.fill(child: CustomPaint(painter: _SeekPainter(widget.strip, played, _drag != null))),
              if (tip != null)
                Positioned(
                  bottom: 34,
                  left: (played * w - 70).clamp(0, math.max(0, w - 140)),
                  width: 140,
                  child: Center(
                    child: Container(
                      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                      decoration: BoxDecoration(color: const Color(0xF2141414), borderRadius: BorderRadius.circular(5), border: Border.all(color: PlayerColors.line)),
                      child: Text.rich(TextSpan(children: [
                        TextSpan(text: tip, style: const TextStyle(color: PlayerColors.text)),
                        if (notYet) TextSpan(text: '  ${t('not downloaded yet')}', style: const TextStyle(color: PlayerColors.gold)),
                      ]), style: const TextStyle(fontSize: Tokens.fsXs)),
                    ),
                  ),
                ),
            ]),
          ),
        ),
      );
    });
  }
}

class _SeekPainter extends CustomPainter {
  _SeekPainter(this.cells, this.played, this.hot);
  final List<double> cells;
  final double played;
  final bool hot;

  @override
  void paint(Canvas canvas, Size size) {
    final w = size.width, h = size.height;
    final th = hot ? 6.0 : 4.0;
    final y = (h - th) / 2;
    final track = RRect.fromRectAndRadius(Rect.fromLTWH(0, y, w, th), Radius.circular(th / 2));
    canvas.drawRRect(track, Paint()..color = const Color(0x29FFFFFF));
    canvas.save();
    canvas.clipRRect(track);
    final px = w * played;
    final list = cells.isEmpty ? const [0.0] : cells;
    final cw = w / list.length;
    for (var i = 0; i < list.length; i++) {
      final x = i * cw;
      final watched = x + cw / 2 <= px;
      final v = list[i];
      Color? c;
      if (v > 0) {
        c = watched ? const Color(0xFFFFE3A1) : PlayerColors.gold.withValues(alpha: .35 + .4 * v);
      } else if (watched) {
        c = const Color(0x4DFFFFFF);
      }
      if (c != null) canvas.drawRect(Rect.fromLTWH(x, y, cw + .5, th), Paint()..color = c);
    }
    canvas.restore();
    canvas.drawCircle(Offset(px, h / 2), hot ? 8 : 6.5, Paint()..color = Colors.white);
  }

  @override
  bool shouldRepaint(_SeekPainter o) => o.played != played || o.hot != hot || o.cells != cells;
}

// ------------------------------------------------------------------ overlays

class _StatusOverlay extends StatelessWidget {
  const _StatusOverlay({required this.text});
  final String text;

  @override
  Widget build(BuildContext context) => Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            const Spinner(),
            const SizedBox(height: 14),
            Text(text, textAlign: TextAlign.center, style: const TextStyle(color: PlayerColors.muted, fontSize: Tokens.fsSm)),
          ]),
        ),
      );
}

class _ErrorOverlay extends StatelessWidget {
  const _ErrorOverlay({required this.text, required this.onExternal});
  final String text;
  final VoidCallback onExternal;

  @override
  Widget build(BuildContext context) => Container(
        color: const Color(0xB3000000),
        alignment: Alignment.center,
        padding: const EdgeInsets.all(32),
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 440),
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            Text(text, textAlign: TextAlign.center, style: const TextStyle(color: PlayerColors.text, fontSize: Tokens.fsMd, height: 1.5)),
            const SizedBox(height: 18),
            Btn(t('Open in external player'), kind: BtnKind.primary, onTap: onExternal),
          ]),
        ),
      );
}

class _CastOverlay extends StatelessWidget {
  const _CastOverlay({required this.name, required this.onStop});
  final String name;
  final VoidCallback onStop;

  @override
  Widget build(BuildContext context) => Container(
        decoration: const BoxDecoration(
          gradient: RadialGradient(center: Alignment(0, -.1), radius: .9, colors: [Color(0xFF1A1A1A), Colors.black], stops: [0, .7]),
        ),
        alignment: Alignment.center,
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          const MIcon('cast', size: 40, color: PlayerColors.gold),
          const SizedBox(height: 14),
          Text(t('Playing on {name}', {'name': name}), style: const TextStyle(fontSize: Tokens.fsLg, fontWeight: FontWeight.w600, color: PlayerColors.text)),
          const SizedBox(height: 18),
          Btn(t('Stop casting'), onTap: onStop),
        ]),
      );
}

class _AudioCard extends StatelessWidget {
  const _AudioCard({required this.meta, required this.fileName, this.poster});
  final Map<Object?, Object?>? meta;
  final String fileName;
  final String? poster;

  @override
  Widget build(BuildContext context) {
    final pic = meta?['picture'];
    final title = (meta?['title'] as String?)?.isNotEmpty == true ? meta!['title'] as String : baseName(fileName);
    final sub = [meta?['artist'], meta?['album']].whereType<String>().where((s) => s.isNotEmpty).join(', ');
    final art = pic is Uint8List ? Image.memory(pic, fit: BoxFit.cover) : (poster != null ? Image.network(poster!, fit: BoxFit.cover) : null);
    final h = MediaQuery.sizeOf(context).height;
    return Padding(
      padding: const EdgeInsets.fromLTRB(40, 40, 40, 110),
      child: Row(mainAxisAlignment: MainAxisAlignment.center, children: [
        if (art != null)
          Container(
            width: math.min(h * .5, 320),
            height: math.min(h * .5, 320),
            clipBehavior: Clip.antiAlias,
            decoration: BoxDecoration(borderRadius: BorderRadius.circular(12), boxShadow: const [BoxShadow(color: Color(0xCC000000), offset: Offset(0, 30), blurRadius: 60, spreadRadius: -20)]),
            child: art,
          ),
        if (art != null) const SizedBox(width: 36),
        Flexible(
          child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(title, style: TextStyle(fontSize: (h * .06).clamp(22, 40), fontWeight: FontWeight.w700, color: PlayerColors.text, height: 1.15)),
            if (sub.isNotEmpty) ...[
              const SizedBox(height: 8),
              Text(sub, style: const TextStyle(fontSize: Tokens.fsLg, color: PlayerColors.muted)),
            ],
          ]),
        ),
      ]),
    );
  }
}
