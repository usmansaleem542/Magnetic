// Formatting helpers ported from web-app/renderer/app.js (fmtBytes, fmtClock, statusParts, …).

import 'dart:math' as math;

import 'l10n.dart';

const _units = ['B', 'KB', 'MB', 'GB', 'TB'];

String fmtBytes(num? n) {
  if (n == null || n <= 0) return ltr('0 B');
  final i = math.min(4, (math.log(n) / math.log(1024)).floor());
  final v = n / math.pow(1024, i);
  final s = (v >= 100 || i == 0) ? '${v.round()}' : v.toStringAsFixed(1);
  return ltr('$s ${_units[i]}');
}

String fmtSpeed(num? n) => ltr('${_strip(fmtBytes(n))}/s');

String _strip(String s) => s.replaceAll('\u2066', '').replaceAll('\u2069', '');

String fmtClock(num? s) {
  if (s == null || !s.isFinite) return '0:00';
  final t = math.max(0, s.floor());
  final h = t ~/ 3600, m = (t ~/ 60) % 60, sec = t % 60;
  final ss = sec.toString().padLeft(2, '0');
  return h > 0 ? '$h:${m.toString().padLeft(2, '0')}:$ss' : '$m:$ss';
}

/// [ms] remaining; negative or unknown → ''.
String fmtEta(num? ms) {
  if (ms == null || !ms.isFinite || ms <= 0) return '';
  final m = (ms / 60000).round();
  if (m < 1) return t('under a minute left');
  if (m < 60) return t('{m} min left', {'m': m});
  final h = m ~/ 60;
  if (h < 48) return t('{h} h {m} min left', {'h': h, 'm': m % 60});
  return t('{d} days left', {'d': (h / 24).round()});
}

/// Floors, so 99.9% shows 99%.
String pct(num? p) => ltr('${((p ?? 0) * 100).floor()}%');

/// Subtitle offset: "+0.5 s", "−1.2 s" (U+2212 minus), "0.0 s".
String fmtOffset(double v) => ltr('${v > 0 ? '+' : v < 0 ? '−' : ''}${v.abs().toStringAsFixed(1)} s');

final _mediaExt = RegExp(r'\.(mkv|mp4|m4v|webm|avi|mov|ts|ogv|mp3|m4a|flac|ogg|opus|wav)$', caseSensitive: false);

String prettyName(String name) => name.replaceAll(_mediaExt, '').replaceAll(RegExp(r'[._]+'), ' ').trim();

String baseName(String? n) {
  if (n == null || n.isEmpty) return t('Subtitles');
  final last = n.split(RegExp(r'[\\/]')).last;
  final dot = last.lastIndexOf('.');
  return dot > 0 ? last.substring(0, dot) : last;
}

/// Natural, case-insensitive name order ("Episode 2" before "Episode 10").
int naturalCompare(String a, String b) {
  final re = RegExp(r'(\d+)|(\D+)');
  final x = re.allMatches(a.toLowerCase()).toList(), y = re.allMatches(b.toLowerCase()).toList();
  for (var i = 0; i < math.min(x.length, y.length); i++) {
    final p = x[i][0]!, q = y[i][0]!;
    final pn = int.tryParse(p), qn = int.tryParse(q);
    final c = (pn != null && qn != null) ? pn.compareTo(qn) : p.compareTo(q);
    if (c != 0) return c;
  }
  return x.length.compareTo(y.length);
}

bool looksLikeTorrentId(String text) {
  final s = text.trim();
  return RegExp(r'^magnet:\?', caseSensitive: false).hasMatch(s) ||
      RegExp(r'^[a-f0-9]{40}$', caseSensitive: false).hasMatch(s) ||
      RegExp(r'^https?://\S+\.torrent(\?\S*)?$', caseSensitive: false).hasMatch(s);
}

/// Thousands separators the way the desktop app shows counts (toLocaleString('en')).
String fmtCount(num n) => n.toInt().toString().replaceAllMapped(RegExp(r'\B(?=(\d{3})+(?!\d))'), (_) => ',');
