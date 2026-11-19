// OpenSubtitles.com REST API (v1). Needs the user's own API key; downloads also need their login.
// Endpoint shapes follow the public docs at opensubtitles.stoplight.io as of 2026; verify if calls start failing.
// Port of web-app/lib/opensubtitles.js plus the file-naming rule from main.js subs:download.
import 'dart:convert';
import 'dart:typed_data';

import 'package:http/http.dart' as http;

const _base = 'https://api.opensubtitles.com/api/v1';

class OpenSubtitlesException implements Exception {
  final String message;
  OpenSubtitlesException(this.message);
  @override
  String toString() => message;
}

class SubtitleResult {
  final int fileId;
  final String fileName;
  final String release;
  final String language;
  final int downloads;
  final bool hashMatch;
  final bool hearingImpaired;
  final String title;
  final int? year;

  const SubtitleResult({
    required this.fileId,
    required this.fileName,
    required this.release,
    required this.language,
    required this.downloads,
    required this.hashMatch,
    required this.hearingImpaired,
    required this.title,
    required this.year,
  });
}

/// The OpenSubtitles "moviehash": file size plus the 64-bit little-endian word sums
/// of the first and last 64 KiB, modulo 2^64, as 16 hex digits.
String movieHash(int size, Uint8List head, Uint8List tail) {
  var h = size; // Dart VM ints are 64-bit and wrap, which is exactly mod 2^64
  void add(Uint8List buf) {
    final bd = ByteData.sublistView(buf);
    for (var i = 0; i + 8 <= buf.length; i += 8) {
      h += bd.getUint64(i, Endian.little);
    }
  }

  add(head);
  add(tail);
  return BigInt.from(h).toUnsigned(64).toRadixString(16).padLeft(16, '0');
}

String _str(dynamic v) => v is String ? v : '';
bool _truthy(dynamic v) => v != null && v != false && v != '' && v != 0;

class OpenSubtitles {
  final String apiKey;
  final String username;
  final String password;
  final String version;
  final http.Client _client;
  String? _token;
  bool _loggedIn = false;

  OpenSubtitles({
    required this.apiKey,
    this.username = '',
    this.password = '',
    this.version = '0.1.0',
    http.Client? client,
  }) : _client = client ?? http.Client();

  String get _userAgent => 'Magnetic v$version';

  /// Mirrors main.js: true once [login] has succeeded (it sets `loggedIn` to login()'s result).
  bool get loggedIn => _loggedIn;

  Map<String, String> _headers({bool json = false}) => {
        'Api-Key': apiKey,
        'User-Agent': _userAgent,
        'Accept': 'application/json',
        if (_token != null) 'Authorization': 'Bearer $_token',
        if (json) 'Content-Type': 'application/json',
      };

  Future<Map<String, dynamic>> _request(String method, String path, [Map<String, dynamic>? body]) async {
    if (apiKey.isEmpty) {
      throw OpenSubtitlesException('Add your OpenSubtitles API key in Preferences to search for subtitles.');
    }
    final req = http.Request(method, Uri.parse(_base + path));
    req.headers.addAll(_headers(json: body != null));
    if (body != null) req.body = jsonEncode(body);
    final res = await http.Response.fromStream(await _client.send(req));
    Map<String, dynamic> data = {};
    try {
      final d = jsonDecode(utf8.decode(res.bodyBytes));
      if (d is Map<String, dynamic>) data = d;
    } catch (_) {}
    final message = _str(data['message']);
    if (res.statusCode == 401) {
      throw OpenSubtitlesException('OpenSubtitles rejected the API key or login. Check them in Preferences.');
    }
    if (res.statusCode == 406 || res.statusCode == 429) {
      throw OpenSubtitlesException(
          message.isNotEmpty ? message : 'You’ve reached today’s OpenSubtitles download limit. It resets in 24 hours.');
    }
    if (res.statusCode < 200 || res.statusCode > 299) {
      throw OpenSubtitlesException(
          message.isNotEmpty ? message : 'OpenSubtitles returned an error (HTTP ${res.statusCode}).');
    }
    return data;
  }

  /// Logs in with the stored username/password. Returns false (no request) when either is empty.
  Future<bool> login() async {
    if (username.isEmpty || password.isEmpty) return _loggedIn = false;
    final data = await _request('POST', '/login', {'username': username, 'password': password});
    final token = data['token'];
    _token = token is String && token.isNotEmpty ? token : null;
    return _loggedIn = true;
  }

  Future<List<SubtitleResult>> search({String? hash, String? query, List<String> languages = const []}) async {
    // the API asks for parameters in alphabetical order and lower case
    final params = <String, String>{};
    if (languages.isNotEmpty) params['languages'] = (languages.toSet().toList()..sort()).join(',');
    if (hash != null && hash.isNotEmpty) params['moviehash'] = hash;
    if (query != null && query.isNotEmpty) params['query'] = query.toLowerCase();
    final qs = params.entries
        .map((e) => '${Uri.encodeQueryComponent(e.key)}=${Uri.encodeQueryComponent(e.value)}')
        .join('&');
    final data = await _request('GET', '/subtitles?$qs');
    final out = <SubtitleResult>[];
    for (final item in data['data'] is List ? data['data'] as List : const []) {
      final a = item is Map && item['attributes'] is Map ? item['attributes'] as Map : const {};
      final fd = a['feature_details'] is Map ? a['feature_details'] as Map : const {};
      for (final f in a['files'] is List ? a['files'] as List : const []) {
        if (f is! Map) continue;
        final release = _str(a['release']);
        final fileName = _str(f['file_name']);
        final dl = a['download_count'];
        final year = fd['year'];
        out.add(SubtitleResult(
          fileId: f['file_id'] is num ? (f['file_id'] as num).toInt() : 0,
          fileName: fileName.isNotEmpty ? fileName : release,
          release: release.isNotEmpty ? release : fileName,
          language: _str(a['language']),
          downloads: dl is num ? dl.toInt() : 0,
          hashMatch: _truthy(a['moviehash_match']),
          hearingImpaired: _truthy(a['hearing_impaired']),
          title: _str(fd['title']),
          year: year is num && year != 0 ? year.toInt() : null,
        ));
      }
    }
    // hash matches first, then most downloaded; stable like JS Array.prototype.sort
    final indexed = out.indexed.toList()
      ..sort((x, y) {
        final h = (y.$2.hashMatch ? 1 : 0) - (x.$2.hashMatch ? 1 : 0);
        if (h != 0) return h;
        final d = y.$2.downloads - x.$2.downloads;
        return d != 0 ? d : x.$1 - y.$1;
      });
    return [for (final e in indexed) e.$2];
  }

  Future<({List<int> bytes, String name, int? remaining})> download(int fileId) async {
    final data = await _request('POST', '/download', {'file_id': fileId});
    final link = _str(data['link']);
    if (link.isEmpty) throw OpenSubtitlesException('OpenSubtitles didn’t return a download link.');
    final res = await _client.get(Uri.parse(link), headers: {'User-Agent': _userAgent});
    if (res.statusCode < 200 || res.statusCode > 299) {
      throw OpenSubtitlesException('Couldn’t download the subtitle file (HTTP ${res.statusCode}).');
    }
    final name = _str(data['file_name']);
    final remaining = data['remaining'];
    return (
      bytes: res.bodyBytes as List<int>,
      name: name.isNotEmpty ? name : 'subtitles.srt',
      remaining: remaining is num ? remaining.toInt() : null,
    );
  }

  void close() => _client.close();
}

/// Movie title guess from a release file name, for text search when the hash finds nothing.
String queryFromFileName(String name) {
  return name
      .split(RegExp(r'[\\/]'))
      .last
      .replaceFirst(RegExp(r'\.[^.]+$'), '')
      .replaceAll(RegExp(r'[._]+'), ' ')
      // keep the year, drop the release tags after it
      .replaceFirstMapped(RegExp(r'\b(19|20)\d{2}\b.*$'), (m) => m[0]!.substring(0, 4))
      .replaceFirst(
          RegExp(r'\b(480p|720p|1080p|2160p|4k|x264|x265|h264|hevc|bluray|web-?dl|webrip|hdrip|brrip|dvdrip|aac|ac3)\b.*$',
              caseSensitive: false),
          '')
      .trim();
}

/// File name for a downloaded subtitle, from main.js subs:download: `<fileId>-<safe>`,
/// with ".srt" appended unless it already ends in .srt/.vtt/.ass/.ssa.
String safeSubtitleFileName(int fileId, String name) {
  // path.basename: last segment, ignoring trailing separators
  final trimmed = name.replaceFirst(RegExp(r'/+$'), '');
  final base = trimmed.split('/').last;
  var safe = base.replaceAll(RegExp(r'[^\w.\- ]+'), '_');
  if (safe.length > 120) safe = safe.substring(0, 120);
  if (safe.isEmpty) safe = 'subtitles.srt';
  final withExt = RegExp(r'\.(srt|vtt|ass|ssa)$', caseSensitive: false).hasMatch(safe) ? safe : '$safe.srt';
  return '$fileId-$withExt';
}
