import { test } from 'node:test'
import assert from 'node:assert/strict'
import iconv from 'iconv-lite'
import { parseSubtitles, parseAss, cleanCueText, assTextToCue, cuesToVtt, languageFromName, normaliseLang } from '../renderer/subtitles.js'
import { decodeSubtitle, detectEncoding } from '../lib/subtitle-decode.js'
import { movieHash, queryFromFileName } from '../lib/opensubtitles.js'

const ARABIC = 'مرحبا بالعالم، كيف حالك اليوم؟ هذا اختبار للترجمة العربية.'
const RUSSIAN = 'Привет, мир! Это проверка русских субтитров, как они выглядят.'
const srt = body => `1\r\n00:00:01,000 --> 00:00:02,500\r\n${body}\r\n\r\n2\r\n00:00:03,000 --> 00:00:04,000\r\n${body}\r\n`

test('decodes Arabic Windows-1256 subtitles that are not valid UTF-8', () => {
  const bytes = iconv.encode(srt(ARABIC), 'windows-1256')
  const { text, encoding } = decodeSubtitle(bytes, { lang: 'ar' })
  assert.equal(encoding, 'windows-1256')
  assert.ok(text.includes(ARABIC))
})

test('detects Arabic Windows-1256 even without a language hint', () => {
  const bytes = iconv.encode(srt(ARABIC).repeat(8), 'windows-1256')
  const { text } = decodeSubtitle(bytes)
  assert.ok(text.includes(ARABIC), `got ${detectEncoding(bytes)}`)
})

test('decodes Cyrillic Windows-1251 with the language hint', () => {
  const bytes = iconv.encode(srt(RUSSIAN), 'windows-1251')
  assert.ok(decodeSubtitle(bytes, { lang: 'ru' }).text.includes(RUSSIAN))
})

test('honours BOMs and plain UTF-8', () => {
  assert.equal(decodeSubtitle(Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(ARABIC)])).text, ARABIC)
  assert.equal(decodeSubtitle(Buffer.concat([Buffer.from([0xFF, 0xFE]), iconv.encode(RUSSIAN, 'utf-16le')])).encoding, 'utf-16le')
  assert.equal(decodeSubtitle(Buffer.from(ARABIC, 'utf8')).encoding, 'utf-8')
})

test('a manual encoding overrides detection', () => {
  const bytes = iconv.encode(RUSSIAN, 'windows-1251')
  assert.equal(decodeSubtitle(bytes, { encoding: 'windows-1251' }).text, RUSSIAN)
})

test('parses SRT: times, multi-line text and allowed tags', () => {
  const cues = parseSubtitles('1\n00:00:01,500 --> 00:00:03,250\n<i>Hello</i>\n<font color="red">there</font>\n\n2\n00:01:00,000 --> 00:01:02,000\nA & B\n', 'a.srt')
  assert.equal(cues.length, 2)
  assert.equal(cues[0].start, 1.5)
  assert.equal(cues[0].end, 3.25)
  assert.equal(cues[0].text, '<i>Hello</i>\nthere')
  assert.equal(cues[1].text, 'A &amp; B')
})

test('parses WebVTT and skips header, NOTE and STYLE blocks', () => {
  const vtt = 'WEBVTT\n\nNOTE a comment\n\nSTYLE\n::cue { color: red }\n\n00:01.000 --> 00:02.000 align:start\nHi\n\nid-2\n00:00:03.000 --> 00:00:04.000\nBye'
  const cues = parseSubtitles(vtt, 'x.vtt')
  assert.deepEqual(cues.map(c => [c.start, c.end, c.text]), [[1, 2, 'Hi'], [3, 4, 'Bye']])
})

test('parses ASS: commas in text, override tags, line breaks and top positioning', () => {
  const ass = `[Script Info]
Title: x

[V4+ Styles]
Format: Name, Fontname
Style: Default,Arial

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.50,0:00:03.00,Default,,0,0,0,,{\\i1}Well,{\\i0} hello\\Nthere
Dialogue: 0,0:00:05.00,0:00:06.00,Default,,0,0,0,,{\\an8\\b1}Top line
Comment: 0,0:00:07.00,0:00:08.00,Default,,0,0,0,,ignored`
  const cues = parseAss(ass)
  assert.equal(cues.length, 2)
  assert.deepEqual([cues[0].start, cues[0].end], [1.5, 3])
  assert.equal(cues[0].text, '<i>Well,</i> hello\nthere')
  assert.equal(cues[1].text, '<b>Top line</b>')
  assert.equal(cues[1].line, 0)
  assert.equal(parseSubtitles(ass, 'show.ass').length, 2)
})

test('cue text cleaning escapes stray markup', () => {
  assert.equal(cleanCueText('<b>Hi</b> <script>x</script> 1 < 2'), '<b>Hi</b> x 1 &lt; 2')
  assert.equal(assTextToCue('{\\fs20}Plain').text, 'Plain')
})

test('cuesToVtt shifts timing and drops cues that end before zero', () => {
  const vtt = cuesToVtt([{ start: 0.2, end: 0.4, text: 'gone', line: null }, { start: 10, end: 12.5, text: 'Hi', line: 0 }], -1)
  assert.equal(vtt, 'WEBVTT\n\n00:00:09.000 --> 00:00:11.500 line:0\nHi\n')
})

test('language detection from file names and track tags', () => {
  assert.equal(languageFromName('Sintel.ar.srt'), 'ar')
  assert.equal(languageFromName('Movie.2010.1080p.ENG.srt'), 'en')
  assert.equal(languageFromName('Subs/Arabic.srt'), 'ar')
  assert.equal(languageFromName('It.2017.srt'), null) // "It" is the title, not Italian
  assert.equal(normaliseLang('ara'), 'ar')
  assert.equal(normaliseLang('pt-BR'), 'pt')
  assert.equal(normaliseLang('Klingon'), null)
})

test('OpenSubtitles hash adds size and 64-bit words of head and tail', () => {
  const head = Buffer.alloc(65536)
  const tail = Buffer.alloc(65536)
  head.writeBigUInt64LE(5n, 0)
  tail.writeBigUInt64LE(0xFFFFFFFFFFFFFFFFn, 8) // forces a wrap past 2^64
  assert.equal(movieHash(131072, head, tail), (131072n + 5n - 1n).toString(16).padStart(16, '0'))
})

test('search query from a release name keeps the title and year', () => {
  assert.equal(queryFromFileName('The.Matrix.1999.1080p.BluRay.x264.mkv'), 'The Matrix 1999')
  assert.equal(queryFromFileName('Sintel.mp4'), 'Sintel')
})
