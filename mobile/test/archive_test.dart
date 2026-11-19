import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:magnetic/services/archive.dart';

void main() {
  test('searchUrl: typed words must all be in the title; browsing shows popular items', () {
    final q = searchUrl(query: 'night of the "living" dead', kind: 'film').queryParameters['q']!;
    expect(q, matches(RegExp(r'^title:\(night AND of AND the AND living AND dead\) AND mediatype:\(movies\)')));
    final popular = searchUrl(kind: 'music');
    expect(popular.queryParameters['q'], matches(RegExp(r'^collection:.* AND mediatype:\(audio\)')));
    expect(popular.queryParameters['sort[]'], 'downloads desc');
  });

  test('searchUrl: full parameter set, order and unknown kind falls back to film', () {
    final u = searchUrl(query: 'x', kind: 'nope', page: 3, rows: 10);
    expect(u.toString().split('?').first, 'https://archive.org/advancedsearch.php');
    expect(u.queryParametersAll['fl[]'], ['identifier', 'title', 'year', 'creator', 'downloads', 'mediatype']);
    expect(u.queryParameters['rows'], '10');
    expect(u.queryParameters['page'], '3');
    expect(u.queryParameters['output'], 'json');
    expect(u.queryParameters['q'], 'title:(x) AND mediatype:(movies) AND -access-restricted-item:(true)');
    expect(u.query, startsWith('q='));
  });

  test('parseResults: maps docs to items with torrent and thumbnail URLs', () {
    final r = parseResults({
      'response': {
        'numFound': 1,
        'docs': [
          {'identifier': 'nosferatu', 'title': 'Nosferatu', 'year': '1922', 'mediatype': 'movies', 'downloads': 5}
        ]
      }
    });
    expect(r.total, 1);
    expect(r.items[0].torrentUrl, 'https://archive.org/download/nosferatu/nosferatu_archive.torrent');
    expect(r.items[0].year, '1922');
    expect(r.items[0].kind, 'film');
    expect(r.items[0].downloads, 5);
    expect(r.items[0].thumb, 'https://archive.org/services/img/nosferatu');
    expect(r.items[0].page, 'https://archive.org/details/nosferatu');
  });

  test('parseResults: arrays, missing fields, audio and docs without identifier', () {
    final r = parseResults({
      'response': {
        'docs': [
          {'identifier': 'a b', 'title': ['T1', 'T2'], 'year': ['1999-01-01'], 'creator': ['C'], 'mediatype': 'audio'},
          {'title': 'no id'},
          {'identifier': 'bare'},
        ]
      }
    });
    expect(r.total, 0);
    expect(r.items.length, 2);
    expect(r.items[0].title, 'T1');
    expect(r.items[0].year, '1999');
    expect(r.items[0].creator, 'C');
    expect(r.items[0].kind, 'music');
    expect(r.items[0].torrentUrl, 'https://archive.org/download/a%20b/a%20b_archive.torrent');
    expect(r.items[1].title, 'bare');
    expect(r.items[1].year, '');
    expect(r.items[1].downloads, 0);
    expect(parseResults({}).items, isEmpty);
  });

  test('searchArchive sends headers and maps errors', () async {
    late http.Request seen;
    final ok = MockClient((req) async {
      seen = req;
      return http.Response(jsonEncode({'response': {'numFound': 0, 'docs': []}}), 200);
    });
    final r = await searchArchive(query: 'q', kind: 'music', page: 2, client: ok);
    expect(r.total, 0);
    expect(seen.headers['Accept'], 'application/json');
    expect(seen.headers['User-Agent'], 'Magnetic/0.1.0');
    expect(seen.url.queryParameters['page'], '2');

    final bad = MockClient((req) async => http.Response('nope', 503));
    expect(
      () => searchArchive(query: 'q', kind: 'film', page: 1, client: bad),
      throwsA(isA<ArchiveException>().having((e) => e.message, 'message',
          'The Internet Archive search failed (HTTP 503). Try again in a moment.')),
    );
  });

  test('archive URL guards match main.js', () {
    expect(isArchiveTorrentUrl('https://archive.org/download/nosferatu/nosferatu_archive.torrent'), isTrue);
    expect(isArchiveTorrentUrl('https://archive.org/download/a/b/c_archive.torrent'), isFalse);
    expect(isArchiveTorrentUrl('http://archive.org/download/x/x_archive.torrent'), isFalse);
    expect(isArchiveTorrentUrl('https://evil.org/download/x/x_archive.torrent'), isFalse);
    expect(isArchivePageUrl('https://archive.org/details/nosferatu'), isTrue);
    expect(isArchivePageUrl('https://archive.org/details/nosferatu?x=1'), isFalse);
    expect(isArchivePageUrl('https://archive.org/details/a/b'), isFalse);
  });
}
