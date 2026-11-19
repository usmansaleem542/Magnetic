import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:magnetic/services/opensubtitles.dart';

http.Response _json(Object body, [int status = 200]) =>
    http.Response.bytes(utf8.encode(jsonEncode(body)), status, headers: {'content-type': 'application/json'});

Matcher _osError(String message) =>
    throwsA(isA<OpenSubtitlesException>().having((e) => e.message, 'message', message));

void main() {
  test('OpenSubtitles hash adds size and 64-bit words of head and tail', () {
    final head = Uint8List(65536);
    final tail = Uint8List(65536);
    ByteData.sublistView(head).setUint64(0, 5, Endian.little);
    ByteData.sublistView(tail).setUint64(8, -1, Endian.little); // 0xFFFFFFFFFFFFFFFF forces a wrap past 2^64
    expect(movieHash(131072, head, tail), (131072 + 5 - 1).toRadixString(16).padLeft(16, '0'));
  });

  test('search query from a release name keeps the title and year', () {
    expect(queryFromFileName('The.Matrix.1999.1080p.BluRay.x264.mkv'), 'The Matrix 1999');
    expect(queryFromFileName('Sintel.mp4'), 'Sintel');
    expect(queryFromFileName('dir/Big_Buck_Bunny.720p.mkv'), 'Big Buck Bunny');
  });

  test('safeSubtitleFileName follows main.js subs:download', () {
    expect(safeSubtitleFileName(7, 'Movie.en.srt'), '7-Movie.en.srt');
    expect(safeSubtitleFileName(7, 'x/y/Movie (2010).ASS'), '7-Movie _2010_.ASS');
    expect(safeSubtitleFileName(7, 'Movie.sub'), '7-Movie.sub.srt');
    expect(safeSubtitleFileName(7, ''), '7-subtitles.srt');
    expect(safeSubtitleFileName(7, 'é'), '7-_.srt');
    expect(safeSubtitleFileName(1, 'a' * 200), '1-${'a' * 120}.srt');
  });

  test('no API key fails before any request', () {
    final os = OpenSubtitles(apiKey: '', client: MockClient((_) async => fail('no request expected')));
    expect(() => os.search(query: 'x'), _osError('Add your OpenSubtitles API key in Preferences to search for subtitles.'));
  });

  test('search: sorted lower-case params, headers and result mapping/sorting', () async {
    late http.Request seen;
    final os = OpenSubtitles(
      apiKey: 'KEY',
      version: '1.2.3',
      client: MockClient((req) async {
        seen = req;
        return _json({
          'data': [
            {
              'attributes': {
                'release': 'Rel A',
                'language': 'en',
                'download_count': 10,
                'feature_details': {'title': 'Matrix', 'year': 1999},
                'files': [
                  {'file_id': 1, 'file_name': 'a.srt'}
                ]
              }
            },
            {
              'attributes': {
                'language': 'ar',
                'download_count': 50,
                'hearing_impaired': true,
                'files': [
                  {'file_id': 2, 'file_name': 'b.srt'}
                ]
              }
            },
            {
              'attributes': {
                'release': 'Rel C',
                'download_count': 1,
                'moviehash_match': true,
                'files': [
                  {'file_id': 3}
                ]
              }
            },
          ]
        });
      }),
    );
    final results = await os.search(hash: 'abc', query: 'The Matrix', languages: ['en', 'ar', 'en']);
    expect(seen.method, 'GET');
    expect(seen.url.toString(),
        'https://api.opensubtitles.com/api/v1/subtitles?languages=ar%2Cen&moviehash=abc&query=the+matrix');
    expect(seen.headers['Api-Key'], 'KEY');
    expect(seen.headers['User-Agent'], 'Magnetic v1.2.3');
    expect(seen.headers['Accept'], 'application/json');
    expect(seen.headers.containsKey('Authorization'), isFalse);
    expect(seen.headers.containsKey('Content-Type'), isFalse);

    expect(results.map((r) => r.fileId).toList(), [3, 2, 1]);
    expect(results[0].hashMatch, isTrue);
    expect(results[0].fileName, 'Rel C');
    expect(results[0].release, 'Rel C');
    expect(results[0].year, isNull);
    expect(results[1].hearingImpaired, isTrue);
    expect(results[1].release, 'b.srt');
    expect(results[2].title, 'Matrix');
    expect(results[2].year, 1999);
    expect(results[2].downloads, 10);
  });

  test('search with no parameters', () async {
    late Uri url;
    final os = OpenSubtitles(apiKey: 'K', client: MockClient((req) async {
      url = req.url;
      return _json({});
    }));
    expect(await os.search(), isEmpty);
    expect(url.toString(), 'https://api.opensubtitles.com/api/v1/subtitles?');
  });

  test('error mapping: 401, 406/429 with and without message, other', () async {
    OpenSubtitles withStatus(int status, [Object body = const {}]) =>
        OpenSubtitles(apiKey: 'K', client: MockClient((_) async => _json(body, status)));
    await expectLater(withStatus(401, {'message': 'ignored'}).search(query: 'x'),
        _osError('OpenSubtitles rejected the API key or login. Check them in Preferences.'));
    await expectLater(withStatus(429).search(query: 'x'),
        _osError('You’ve reached today’s OpenSubtitles download limit. It resets in 24 hours.'));
    await expectLater(withStatus(406, {'message': 'Quota hit'}).search(query: 'x'), _osError('Quota hit'));
    await expectLater(withStatus(500).search(query: 'x'), _osError('OpenSubtitles returned an error (HTTP 500).'));
    await expectLater(withStatus(503, {'message': 'Down'}).search(query: 'x'), _osError('Down'));
    final html = OpenSubtitles(apiKey: 'K', client: MockClient((_) async => http.Response('<html>', 502)));
    await expectLater(html.search(query: 'x'), _osError('OpenSubtitles returned an error (HTTP 502).'));
  });

  test('login: skipped without credentials, then bearer token on later calls', () async {
    expect(await OpenSubtitles(apiKey: 'K', client: MockClient((_) async => fail('no request'))).login(), isFalse);

    final requests = <http.Request>[];
    final os = OpenSubtitles(
      apiKey: 'K',
      username: 'u',
      password: 'p',
      client: MockClient((req) async {
        requests.add(req);
        return req.url.path.endsWith('/login') ? _json({'token': 'TOK'}) : _json({'data': []});
      }),
    );
    expect(os.loggedIn, isFalse);
    expect(await os.login(), isTrue);
    expect(os.loggedIn, isTrue);
    expect(requests[0].method, 'POST');
    expect(requests[0].url.toString(), 'https://api.opensubtitles.com/api/v1/login');
    expect(requests[0].headers['Content-Type'], startsWith('application/json'));
    expect(jsonDecode(requests[0].body), {'username': 'u', 'password': 'p'});
    await os.search(query: 'x');
    expect(requests[1].headers['Authorization'], 'Bearer TOK');
  });

  test('download: link then file fetch', () async {
    final requests = <http.Request>[];
    final os = OpenSubtitles(
      apiKey: 'K',
      client: MockClient((req) async {
        requests.add(req);
        if (req.url.host == 'api.opensubtitles.com') {
          return _json({'link': 'https://dl.example/f.srt', 'file_name': 'Movie.srt', 'remaining': 4});
        }
        return http.Response.bytes([1, 2, 3], 200);
      }),
    );
    final d = await os.download(42);
    expect(d.bytes, [1, 2, 3]);
    expect(d.name, 'Movie.srt');
    expect(d.remaining, 4);
    expect(requests[0].method, 'POST');
    expect(requests[0].url.toString(), 'https://api.opensubtitles.com/api/v1/download');
    expect(jsonDecode(requests[0].body), {'file_id': 42});
    expect(requests[1].url.toString(), 'https://dl.example/f.srt');
    expect(requests[1].headers['User-Agent'], 'Magnetic v0.1.0');
    expect(requests[1].headers.containsKey('Api-Key'), isFalse);
  });

  test('download: defaults and failures', () async {
    final noName = OpenSubtitles(
      apiKey: 'K',
      client: MockClient((req) async =>
          req.url.host == 'api.opensubtitles.com' ? _json({'link': 'https://dl.example/x'}) : http.Response('s', 200)),
    );
    final d = await noName.download(1);
    expect(d.name, 'subtitles.srt');
    expect(d.remaining, isNull);

    final noLink = OpenSubtitles(apiKey: 'K', client: MockClient((_) async => _json({})));
    await expectLater(noLink.download(1), _osError('OpenSubtitles didn’t return a download link.'));

    final fileFails = OpenSubtitles(
      apiKey: 'K',
      client: MockClient((req) async =>
          req.url.host == 'api.opensubtitles.com' ? _json({'link': 'https://dl.example/x'}) : http.Response('', 404)),
    );
    await expectLater(fileFails.download(1), _osError('Couldn’t download the subtitle file (HTTP 404).'));
  });
}
