// The link to the Android engine, mirroring the desktop's preload API: Api.call('<channel>', [...])
// with the same channel names as web-app/main.js, plus a push stream ('torrents', 'toast', ...).

import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

import 'l10n.dart';

class ApiError implements Exception {
  ApiError(this.message);
  final String message;
  @override
  String toString() => message;
}

abstract final class Api {
  static const _methods = MethodChannel('magnetic/api');
  static const _events = EventChannel('magnetic/events');
  static Stream<Map<Object?, Object?>>? _stream;

  /// Push events from the engine: {type: 'torrents' | 'toast' | 'open' | 'media' | 'pip', ...}.
  static Stream<Map<Object?, Object?>> get events =>
      _stream ??= _events.receiveBroadcastStream().map((e) => (e as Map).cast<Object?, Object?>()).asBroadcastStream();

  /// Calls an engine channel. Errors come back as translated, user-facing [ApiError]s.
  static Future<T?> call<T>(String channel, [List<Object?> args = const []]) async {
    try {
      final r = await _methods.invokeMethod<Object?>(channel, args);
      return r as T?;
    } on PlatformException catch (e) {
      if (e.code == 'user') {
        final vars = (e.details as Map?)?.map((k, v) => MapEntry('$k', v));
        throw ApiError(t(e.message ?? '', vars));
      }
      throw ApiError(e.message ?? e.code);
    }
  }
}

// ------------------------------------------------------------------ models (desktop snapshot shapes)

class TFile {
  TFile(Map<Object?, Object?> m)
      : index = (m['index'] as num).toInt(),
        name = m['name'] as String? ?? '',
        path = m['path'] as String? ?? '',
        length = (m['length'] as num?)?.toInt() ?? 0,
        progress = (m['progress'] as num?)?.toDouble() ?? 0,
        selected = m['selected'] as bool? ?? true,
        kind = m['kind'] as String? ?? 'other';

  final int index;
  final String name, path, kind;
  final int length;
  final double progress;
  final bool selected;

  bool get isMedia => kind == 'video' || kind == 'audio';
}

class Torrent {
  Torrent(Map<Object?, Object?> m)
      : infoHash = m['infoHash'] as String,
        name = m['name'] as String? ?? '',
        path = m['path'] as String? ?? '',
        files = ((m['files'] as List?) ?? const []).map((f) => TFile((f as Map).cast())).toList(),
        length = (m['length'] as num?)?.toInt() ?? 0,
        addedAt = (m['addedAt'] as num?)?.toInt() ?? 0,
        poster = m['poster'] as String?,
        seedLimitReached = m['seedLimitReached'] as bool? ?? false,
        status = m['status'] as String? ?? 'paused',
        queueReason = m['queueReason'] as String?,
        progress = (m['progress'] as num?)?.toDouble() ?? 0,
        ratio = (m['ratio'] as num?)?.toDouble() ?? 0,
        downloadSpeed = (m['downloadSpeed'] as num?)?.toInt() ?? 0,
        uploadSpeed = (m['uploadSpeed'] as num?)?.toInt() ?? 0,
        numPeers = (m['numPeers'] as num?)?.toInt() ?? 0,
        timeRemaining = (m['timeRemaining'] as num?)?.toInt() ?? -1,
        pieces = ((m['pieces'] as List?) ?? const []).map((v) => (v as num).toDouble()).toList();

  final String infoHash, name, path, status;
  final List<TFile> files;
  final int length, addedAt, downloadSpeed, uploadSpeed, numPeers, timeRemaining;
  final String? poster, queueReason;
  final bool seedLimitReached;
  final double progress, ratio;
  final List<double> pieces;

  bool get paused => status == 'paused';

  /// 'video' | 'audio' | 'none' (files but no media) | 'unknown' (no files yet; treated as playable).
  String get mediaKind {
    if (files.isEmpty) return 'unknown';
    if (files.any((f) => f.kind == 'video')) return 'video';
    if (files.any((f) => f.isMedia)) return 'audio';
    return 'none';
  }

  bool get playable => mediaKind != 'none';
}

class Totals {
  const Totals(this.down, this.up);
  final int down, up;
}

/// Desktop pickDefaultFile: largest selected video, else largest selected audio (any media if none selected).
TFile? pickDefaultFile(Torrent t) {
  var media = t.files.where((f) => f.isMedia).toList();
  if (media.isEmpty) return null;
  if (media.any((f) => f.selected)) media = media.where((f) => f.selected).toList();
  final videos = media.where((f) => f.kind == 'video').toList();
  final pool = videos.isNotEmpty ? videos : media;
  pool.sort((a, b) => b.length.compareTo(a.length));
  return pool.first;
}

@visibleForTesting
Torrent torrentFromMap(Map<Object?, Object?> m) => Torrent(m);
