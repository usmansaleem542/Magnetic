import 'package:flutter_test/flutter_test.dart';
import 'package:magnetic/services/subtitles.dart';

void main() {
  test('parses SRT: times, multi-line text and allowed tags', () {
    final cues = parseSubtitles(
        '1\n00:00:01,500 --> 00:00:03,250\n<i>Hello</i>\n<font color="red">there</font>\n\n2\n00:01:00,000 --> 00:01:02,000\nA & B\n',
        'a.srt');
    expect(cues.length, 2);
    expect(cues[0].start, 1.5);
    expect(cues[0].end, 3.25);
    expect(cues[0].text, '<i>Hello</i>\nthere');
    expect(cues[1].text, 'A &amp; B');
  });

  test('parses SRT with CRLF, BOM and a too-short cue', () {
    final cues = parseSubtitles('﻿1\r\n00:00:01,000 --> 00:00:01,000\r\nHi\r\n');
    expect(cues.length, 1);
    expect(cues[0].end, closeTo(1.1, 1e-9));
  });

  test('parses WebVTT and skips header, NOTE and STYLE blocks', () {
    const vtt =
        'WEBVTT\n\nNOTE a comment\n\nSTYLE\n::cue { color: red }\n\n00:01.000 --> 00:02.000 align:start\nHi\n\nid-2\n00:00:03.000 --> 00:00:04.000\nBye';
    final cues = parseSubtitles(vtt, 'x.vtt');
    expect(cues.map((c) => [c.start, c.end, c.text]).toList(), [
      [1, 2, 'Hi'],
      [3, 4, 'Bye']
    ]);
  });

  const ass = '''[Script Info]
Title: x

[V4+ Styles]
Format: Name, Fontname
Style: Default,Arial

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.50,0:00:03.00,Default,,0,0,0,,{\\i1}Well,{\\i0} hello\\Nthere
Dialogue: 0,0:00:05.00,0:00:06.00,Default,,0,0,0,,{\\an8\\b1}Top line
Comment: 0,0:00:07.00,0:00:08.00,Default,,0,0,0,,ignored''';

  test('parses ASS: commas in text, override tags, line breaks and top positioning', () {
    final cues = parseAss(ass);
    expect(cues.length, 2);
    expect([cues[0].start, cues[0].end], [1.5, 3]);
    expect(cues[0].text, '<i>Well,</i> hello\nthere');
    expect(cues[0].top, isFalse);
    expect(cues[1].text, '<b>Top line</b>');
    expect(cues[1].top, isTrue);
    expect(parseSubtitles(ass, 'show.ass').length, 2);
    expect(parseSubtitles(ass).length, 2); // detected from [Script Info]
  });

  test('ASS \\an and legacy \\a positioning rules', () {
    expect(assTextToCue(r'{\an7}x').top, isTrue);
    expect(assTextToCue(r'{\an2}x').top, isFalse);
    expect(assTextToCue(r'{\a6}x').top, isTrue);
    expect(assTextToCue(r'{\a2}x').top, isFalse);
    expect(assTextToCue(r'{\u1}a\hb').text, '<u>a b</u>');
  });

  test('cue text cleaning escapes stray markup', () {
    expect(cleanCueText('<b>Hi</b> <script>x</script> 1 < 2'), '<b>Hi</b> x 1 &lt; 2');
    expect(assTextToCue(r'{\fs20}Plain').text, 'Plain');
  });

  test('cuesToVtt shifts timing and drops cues that end before zero', () {
    final vtt = cuesToVtt([
      const Cue(start: 0.2, end: 0.4, text: 'gone'),
      const Cue(start: 10, end: 12.5, text: 'Hi', top: true),
    ], offset: -1);
    expect(vtt, 'WEBVTT\n\n00:00:09.000 --> 00:00:11.500 line:0\nHi\n');
  });

  test('formatVttTime', () {
    expect(formatVttTime(3661.25), '01:01:01.250');
    expect(formatVttTime(-5), '00:00:00.000');
    expect(formatVttTime(1.9996), '00:00:01.999');
  });

  test('language detection from file names and track tags', () {
    expect(languageFromName('Sintel.ar.srt'), 'ar');
    expect(languageFromName('Movie.2010.1080p.ENG.srt'), 'en');
    expect(languageFromName('Subs/Arabic.srt'), 'ar');
    expect(languageFromName('It.2017.srt'), isNull); // "It" is the title, not Italian
    expect(normaliseLang('ara'), 'ar');
    expect(normaliseLang('pt-BR'), 'pt');
    expect(normaliseLang('Klingon'), isNull);
    expect(normaliseLang(null), isNull);
    expect(languageName('ar'), 'Arabic');
    expect(languageName('xx'), isNull);
  });
}
