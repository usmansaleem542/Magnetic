// Subtitle parsing shared by the player (and unit tests). Every format becomes the same
// cue list: start/end in seconds, text in WebVTT cue markup, `top` for lines placed at
// the top of the picture. Port of web-app/renderer/subtitles.js.

class Cue {
  final double start;
  final double end;
  final String text;
  final bool top;
  const Cue({required this.start, required this.end, required this.text, this.top = false});

  @override
  String toString() => 'Cue($start, $end, ${top ? 'top, ' : ''}$text)';
}

const _langs = <String, String>{
  'ar': 'Arabic', 'en': 'English', 'fr': 'French', 'de': 'German', 'es': 'Spanish', 'it': 'Italian',
  'pt': 'Portuguese', 'ru': 'Russian', 'tr': 'Turkish', 'fa': 'Persian', 'ur': 'Urdu', 'hi': 'Hindi',
  'bn': 'Bengali', 'zh': 'Chinese', 'ja': 'Japanese', 'ko': 'Korean', 'nl': 'Dutch', 'pl': 'Polish',
  'sv': 'Swedish', 'no': 'Norwegian', 'da': 'Danish', 'fi': 'Finnish', 'el': 'Greek', 'he': 'Hebrew',
  'id': 'Indonesian', 'ms': 'Malay', 'th': 'Thai', 'vi': 'Vietnamese', 'uk': 'Ukrainian', 'cs': 'Czech',
  'hu': 'Hungarian', 'ro': 'Romanian', 'bg': 'Bulgarian', 'hr': 'Croatian', 'sr': 'Serbian',
  'sk': 'Slovak', 'sl': 'Slovenian', 'tl': 'Filipino',
};

// three-letter codes (MKV tracks, some file names) and spelled-out names
final Map<String, String> _aliases = {
  'ara': 'ar', 'eng': 'en', 'fre': 'fr', 'fra': 'fr', 'ger': 'de', 'deu': 'de', 'spa': 'es', 'ita': 'it',
  'por': 'pt', 'rus': 'ru', 'tur': 'tr', 'per': 'fa', 'fas': 'fa', 'urd': 'ur', 'hin': 'hi', 'ben': 'bn',
  'chi': 'zh', 'zho': 'zh', 'jpn': 'ja', 'kor': 'ko', 'dut': 'nl', 'nld': 'nl', 'pol': 'pl', 'swe': 'sv',
  'nor': 'no', 'dan': 'da', 'fin': 'fi', 'gre': 'el', 'ell': 'el', 'heb': 'he', 'ind': 'id', 'may': 'ms',
  'msa': 'ms', 'tha': 'th', 'vie': 'vi', 'ukr': 'uk', 'cze': 'cs', 'ces': 'cs', 'hun': 'hu', 'rum': 'ro',
  'ron': 'ro', 'bul': 'bg', 'hrv': 'hr', 'srp': 'sr', 'slo': 'sk', 'slk': 'sk', 'slv': 'sl', 'fil': 'tl',
  'tgl': 'tl', 'pob': 'pt', 'pt-br': 'pt', 'es-419': 'es', 'zh-cn': 'zh', 'zh-tw': 'zh', 'zh-hans': 'zh',
  'zh-hant': 'zh',
  for (final e in _langs.entries) e.value.toLowerCase(): e.key,
};

/// Two-letter code to English name, or null.
String? languageName(String code) => _langs[code];

/// Normalise any language tag ("ara", "Arabic", "pt-BR") to a two-letter code, or null.
String? normaliseLang(String? tag) {
  if (tag == null || tag.isEmpty) return null;
  final t = tag.trim().toLowerCase();
  if (_langs.containsKey(t)) return t;
  if (_aliases.containsKey(t)) return _aliases[t];
  final base = t.split(RegExp(r'[-_]')).first;
  return _langs.containsKey(base) ? base : _aliases[base];
}

/// Find the language in a subtitle file name such as "Movie.2010.ar.srt" or "Arabic.srt".
String? languageFromName(String name) {
  final base = name.split(RegExp(r'[\\/]')).last.replaceFirst(RegExp(r'\.[^.]+$'), '').toLowerCase();
  final parts = base.split(RegExp(r'[\s._\-[\]()]+')).where((p) => p.isNotEmpty).toList();
  for (var i = parts.length - 1; i >= 0; i--) {
    final p = parts[i];
    if (_aliases.containsKey(p) || (_langs.containsKey(p) && (i > 0 || parts.length == 1))) {
      return normaliseLang(p);
    }
  }
  return null;
}

// ---------- time ----------
final _timeRe = RegExp(r'(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.,:](\d{1,3}))?');

double _parseTime(String s) {
  final m = _timeRe.firstMatch(s.trim());
  if (m == null) return double.nan;
  final frac = m[4] != null ? int.parse(m[4]!.padRight(3, '0')) / 1000 : 0.0;
  return int.parse(m[1] ?? '0') * 3600 + int.parse(m[2]!) * 60 + int.parse(m[3]!) + frac;
}

String formatVttTime(double t) {
  if (t < 0) t = 0;
  final h = (t / 3600).floor();
  final m = ((t % 3600) / 60).floor();
  final s = (t % 60).floor();
  final ms = ((t - t.floor()) * 1000).round();
  String p(int n, [int w = 2]) => '$n'.padLeft(w, '0');
  return '${p(h)}:${p(m)}:${p(s)}.${p(ms == 1000 ? 999 : ms, 3)}';
}

// ---------- cue text ----------
String _escapeText(String s) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

/// Keep italic/bold/underline from SRT/VTT markup, drop anything else (fonts, colours, voices).
String cleanCueText(String raw) {
  final kept = <String>[];
  final marked = raw.replaceAllMapped(RegExp(r'<\s*(\/?)\s*([ibu])\s*>', caseSensitive: false), (m) {
    kept.add('<${m[1]}${m[2]!.toLowerCase()}>');
    return '\u0000${kept.length - 1}\u0000';
  });
  final stripped = marked.replaceAll(RegExp(r'<[^>]*>'), '').replaceAll(RegExp(r'\{\\[^}]*\}'), '');
  return _escapeText(stripped
          .replaceAll('&nbsp;', ' ')
          .replaceAll('&amp;', '&')
          .replaceAll('&lt;', '<')
          .replaceAll('&gt;', '>'))
      .replaceAllMapped(RegExp('\u0000(\\d+)\u0000'), (m) => kept[int.parse(m[1]!)])
      .trim();
}

/// Convert an ASS/SSA event's text: override tags to markup, \N to line breaks.
({String text, bool top}) assTextToCue(String text) {
  var top = false;
  final open = {'i': false, 'b': false, 'u': false};
  final out = StringBuffer();
  var last = 0;
  for (final m in RegExp(r'\{([^}]*)\}').allMatches(text)) {
    out.write(_escapeText(text.substring(last, m.start)));
    last = m.end;
    for (final tag in m[1]!.split(r'\').where((t) => t.isNotEmpty)) {
      final an = RegExp(r'^an?(\d)').firstMatch(tag);
      if (an != null) {
        final n = int.parse(an[1]!);
        // \an7-9 (and legacy \a5-7,9-11) place the line at the top of the picture
        if (tag.startsWith('an') ? n >= 7 : n >= 5) top = true;
      }
      final st = RegExp(r'^([ibu])(\d)$').firstMatch(tag);
      if (st != null) {
        final t = st[1]!;
        final on = st[2] != '0';
        if (on && !open[t]!) {
          out.write('<$t>');
          open[t] = true;
        } else if (!on && open[t]!) {
          out.write('</$t>');
          open[t] = false;
        }
      }
    }
  }
  out.write(_escapeText(text.substring(last)));
  for (final t in ['u', 'b', 'i']) {
    if (open[t]!) out.write('</$t>');
  }
  final result = out.toString().replaceAll(r'\N', '\n').replaceAll(r'\n', '\n').replaceAll(r'\h', ' ');
  return (text: result.trim(), top: top);
}

// ---------- parsers ----------
List<Cue> _parseSrtLike(String text) {
  final cues = <Cue>[];
  final blocks = text.replaceAll(RegExp(r'\r\n?'), '\n').split(RegExp(r'\n{2,}'));
  for (final block in blocks) {
    final lines = block.split('\n');
    final i = lines.indexWhere((l) => l.contains('-->'));
    if (i < 0) continue;
    final halves = lines[i].split('-->');
    final b = halves[1].trim().split(RegExp(r'\s+')).first;
    final start = _parseTime(halves[0]);
    final end = _parseTime(b);
    if (!start.isFinite || !end.isFinite) continue;
    final body = cleanCueText(lines.sublist(i + 1).join('\n'));
    if (body.isNotEmpty) cues.add(Cue(start: start, end: end > start + 0.1 ? end : start + 0.1, text: body));
  }
  return cues;
}

List<Cue> parseAss(String text) {
  final cues = <Cue>[];
  List<String>? format;
  var inEvents = false;
  final formatRe = RegExp(r'^format\s*:', caseSensitive: false);
  final dialogueRe = RegExp(r'^dialogue\s*:', caseSensitive: false);
  for (final rawLine in text.replaceAll(RegExp(r'\r\n?'), '\n').split('\n')) {
    final line = rawLine.trim();
    if (RegExp(r'^\[.*\]$').hasMatch(line)) {
      inEvents = RegExp(r'^\[events\]$', caseSensitive: false).hasMatch(line);
      continue;
    }
    if (!inEvents) continue;
    if (formatRe.hasMatch(line)) {
      format = line.replaceFirst(formatRe, '').split(',').map((s) => s.trim().toLowerCase()).toList();
      continue;
    }
    final fmt = format;
    if (!dialogueRe.hasMatch(line) || fmt == null) continue;
    final values = line.replaceFirst(dialogueRe, '').split(',');
    // the text field is last and may itself contain commas
    final cut = fmt.length - 1 < values.length ? fmt.length - 1 : values.length;
    final fields = [...values.sublist(0, cut), values.sublist(cut).join(',')];
    String get(String k) {
      final idx = fmt.indexOf(k);
      return idx >= 0 && idx < fields.length ? fields[idx] : '';
    }

    final start = _parseTime(get('start'));
    final end = _parseTime(get('end'));
    if (!start.isFinite || !end.isFinite) continue;
    final c = assTextToCue(get('text'));
    if (c.text.isNotEmpty) cues.add(Cue(start: start, end: end, text: c.text, top: c.top));
  }
  // stable sort by start, like JS Array.prototype.sort
  final indexed = cues.indexed.toList()
    ..sort((a, b) {
      final d = a.$2.start.compareTo(b.$2.start);
      return d != 0 ? d : a.$1 - b.$1;
    });
  return [for (final e in indexed) e.$2];
}

/// Parse subtitle text. [hint] is a file name or format ("srt", "vtt", "ass", "ssa").
List<Cue> parseSubtitles(String text, [String hint = '']) {
  final clean = text.startsWith('﻿') ? text.substring(1) : text;
  final fmt = hint.toLowerCase().split('.').last;
  if (fmt == 'ass' || fmt == 'ssa' || RegExp(r'^\s*\[script info\]', caseSensitive: false).hasMatch(clean)) {
    return parseAss(clean);
  }
  return _parseSrtLike(clean); // also handles WebVTT: header, NOTE and STYLE blocks have no "-->"
}

/// Serialise cues back to WebVTT, shifted by [offset] seconds (used for casting).
String cuesToVtt(List<Cue> cues, {double offset = 0}) {
  final body = cues
      .map((c) => Cue(start: c.start + offset, end: c.end + offset, text: c.text, top: c.top))
      .where((c) => c.end > 0)
      .map((c) => '${formatVttTime(c.start)} --> ${formatVttTime(c.end)}${c.top ? ' line:0' : ''}\n${c.text}');
  return 'WEBVTT\n\n${body.join('\n\n')}\n';
}
