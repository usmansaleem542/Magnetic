import 'package:flutter_test/flutter_test.dart';
import 'package:magnetic/format.dart';
import 'package:magnetic/l10n.dart';

void main() {
  setUp(() => L10n.use('en', const {}));

  test('fmtBytes: whole numbers from 100 up, one decimal below', () {
    expect(fmtBytes(0), '0 B');
    expect(fmtBytes(512), '512 B');
    expect(fmtBytes(1536), '1.5 KB');
    expect(fmtBytes(150 * 1024 * 1024), '150 MB');
    expect(fmtBytes(1.86 * 1024 * 1024 * 1024), '1.9 GB');
  });

  test('fmtSpeed', () => expect(fmtSpeed(2048), '2.0 KB/s'));

  test('fmtClock with and without hours', () {
    expect(fmtClock(double.nan), '0:00');
    expect(fmtClock(65), '1:05');
    expect(fmtClock(3725), '1:02:05');
  });

  test('fmtEta follows the desktop wording', () {
    expect(fmtEta(-1), '');
    expect(fmtEta(20000), 'under a minute left');
    expect(fmtEta(5 * 60000), '5 min left');
    expect(fmtEta(125 * 60000), '2 h 5 min left');
    expect(fmtEta(72 * 3600000), '3 days left');
  });

  test('pct floors', () => expect(pct(0.999), '99%'));

  test('fmtOffset uses a real minus sign', () {
    expect(fmtOffset(0.5), '+0.5 s');
    expect(fmtOffset(-1.2), '−1.2 s');
    expect(fmtOffset(0), '0.0 s');
  });

  test('prettyName', () => expect(prettyName('The.Odyssey.2026.1080p.mp4'), 'The Odyssey 2026 1080p'));

  test('naturalCompare puts 2 before 10', () {
    final l = ['Ep 10.mkv', 'ep 2.mkv', 'Ep 1.mkv']..sort(naturalCompare);
    expect(l, ['Ep 1.mkv', 'ep 2.mkv', 'Ep 10.mkv']);
  });

  test('looksLikeTorrentId', () {
    expect(looksLikeTorrentId('magnet:?xt=urn:btih:abc'), isTrue);
    expect(looksLikeTorrentId('a' * 40), isTrue);
    expect(looksLikeTorrentId('https://x.org/a.torrent?x=1'), isTrue);
    expect(looksLikeTorrentId('hello'), isFalse);
  });

  test('fmtCount', () => expect(fmtCount(1234567), '1,234,567'));
}
