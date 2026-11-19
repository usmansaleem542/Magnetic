// Search the Internet Archive (archive.org). Every item there has a .torrent with an
// HTTP web seed, so even items with no peers stream straight away. Items are public
// domain or openly licensed, though licences vary per item: check the item page.
// Port of web-app/lib/archive.js (search part).
import 'dart:convert';

import 'package:http/http.dart' as http;

const appVersion = '0.1.0';

const _search = 'https://archive.org/advancedsearch.php';

class ArchiveKind {
  final String mediatype;
  final String popular;
  const ArchiveKind(this.mediatype, this.popular);
}

const kinds = <String, ArchiveKind>{
  'film': ArchiveKind('movies', 'collection:(feature_films)'),
  'music': ArchiveKind('audio', 'collection:(etree OR audio_music)'),
};

class ArchiveException implements Exception {
  final String message;
  ArchiveException(this.message);
  @override
  String toString() => message;
}

class ArchiveItem {
  final String id;
  final String title;
  final String year;
  final String creator;
  final int downloads;
  final String kind; // 'film' | 'music'
  final String torrentUrl;
  final String thumb;
  final String page;

  const ArchiveItem({
    required this.id,
    required this.title,
    required this.year,
    required this.creator,
    required this.downloads,
    required this.kind,
    required this.torrentUrl,
    required this.thumb,
    required this.page,
  });
}

/// Build the advancedsearch URL.
Uri searchUrl({String query = '', String kind = 'film', int page = 1, int rows = 40}) {
  final k = kinds[kind] ?? kinds['film']!;
  final terms = query
      .trim()
      .replaceAll(RegExp(r'[()[\]{}:"\\^~*?]'), ' ')
      .replaceAll(RegExp(r'\s+'), ' ')
      .trim();
  final q = [
    // every word must be in the title; matching all fields returns mostly noise
    terms.isNotEmpty ? 'title:(${terms.split(' ').join(' AND ')})' : k.popular,
    'mediatype:(${k.mediatype})',
    '-access-restricted-item:(true)', // lending-library items can't be downloaded
  ].join(' AND ');
  final params = <(String, String)>[
    ('q', q),
    ('rows', '$rows'),
    ('page', '$page'),
    ('output', 'json'),
    for (final f in ['identifier', 'title', 'year', 'creator', 'downloads', 'mediatype']) ('fl[]', f),
    ('sort[]', 'downloads desc'),
  ];
  final qs = params
      .map((p) => '${Uri.encodeQueryComponent(p.$1)}=${Uri.encodeQueryComponent(p.$2)}')
      .join('&');
  return Uri.parse('$_search?$qs');
}

dynamic _first(dynamic v) => v is List ? (v.isEmpty ? null : v.first) : v;

bool _truthy(dynamic v) =>
    v != null && v != false && v != '' && !(v is num && (v == 0 || v.isNaN));

int _toInt(dynamic v) {
  final n = v is num ? v : (v is String ? num.tryParse(v.trim()) : null);
  if (n == null || n.isNaN || n.isInfinite) return 0;
  return n.toInt();
}

({int total, List<ArchiveItem> items}) parseResults(Map<String, dynamic> json) {
  final response = json['response'];
  final res = response is Map ? response : const {};
  final docs = res['docs'] is List ? res['docs'] as List : const [];
  final items = <ArchiveItem>[];
  for (final d in docs) {
    if (d is! Map || !_truthy(d['identifier'])) continue;
    final id = '${d['identifier']}';
    final eid = Uri.encodeComponent(id);
    final title = _first(d['title']);
    final year = _first(d['year']);
    final creator = _first(d['creator']);
    final yearStr = _truthy(year) ? '$year' : '';
    items.add(ArchiveItem(
      id: id,
      title: _truthy(title) ? '$title' : id,
      year: yearStr.length > 4 ? yearStr.substring(0, 4) : yearStr,
      creator: _truthy(creator) ? '$creator' : '',
      downloads: _toInt(d['downloads']),
      kind: d['mediatype'] == 'audio' ? 'music' : 'film',
      torrentUrl: 'https://archive.org/download/$eid/${eid}_archive.torrent',
      thumb: 'https://archive.org/services/img/$eid',
      page: 'https://archive.org/details/$eid',
    ));
  }
  return (total: _toInt(res['numFound']), items: items);
}

Future<({int total, List<ArchiveItem> items})> searchArchive({
  required String query,
  required String kind,
  required int page,
  http.Client? client,
  String version = appVersion,
}) async {
  final c = client ?? http.Client();
  try {
    final res = await c.get(
      searchUrl(query: query, kind: kind, page: page),
      headers: {'Accept': 'application/json', 'User-Agent': 'Magnetic/$version'},
    );
    if (res.statusCode < 200 || res.statusCode > 299) {
      throw ArchiveException(
          'The Internet Archive search failed (HTTP ${res.statusCode}). Try again in a moment.');
    }
    final data = jsonDecode(utf8.decode(res.bodyBytes));
    return parseResults(data is Map<String, dynamic> ? data : <String, dynamic>{});
  } finally {
    if (client == null) c.close();
  }
}

final _torrentRe = RegExp(r'^https://archive\.org/download/[^/]+/[^/]+_archive\.torrent$');
final _pageRe = RegExp(r'^https://archive\.org/details/[^/?#]+$');

/// Only archive.org torrents may go through the Discover "add" path (main.js discover:add).
bool isArchiveTorrentUrl(String url) => _torrentRe.hasMatch(url);

/// Only archive.org item pages may be opened externally (main.js discover:openPage).
bool isArchivePageUrl(String url) => _pageRe.hasMatch(url);
