import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseProbe, parseKeyframe, transcodeArgs, needsAudioConversion } from '../lib/transcode.js'

// trimmed from real `ffmpeg -i` output
const SAMPLE = `Input #0, matroska,webm, from 'http://127.0.0.1:5000/x/0/film.mkv':
  Metadata:
    ENCODER         : Lavf60.3.100
  Duration: 01:52:07.04, start: 0.000000, bitrate: 6011 kb/s
  Stream #0:0: Video: hevc (Main 10), yuv420p10le(tv), 1920x800, SAR 1:1 DAR 12:5, 23.98 fps, 23.98 tbr, 1k tbn (default)
  Stream #0:1(eng): Audio: eac3, 48000 Hz, 5.1(side), fltp, 640 kb/s (default)
    Metadata:
      title           : English DD+ 5.1
  Stream #0:2(ara): Audio: ac3, 48000 Hz, stereo, fltp, 192 kb/s
    Metadata:
      title           : Arabic
  Stream #0:3(eng): Subtitle: subrip
  Stream #0:4: Video: mjpeg (Baseline), yuvj420p(pc), 600x900, 90k tbr, 90k tbn (attached pic)
At least one output file must be specified`

test('parseProbe: duration, video codec and every audio track', () => {
  const p = parseProbe(SAMPLE)
  assert.equal(Math.round(p.duration), 6727)
  assert.deepEqual(p.video, { index: 0, codec: 'hevc' })
  assert.equal(p.audio.length, 2)
  assert.deepEqual(p.audio[0], { order: 0, index: 1, codec: 'eac3', language: 'eng', title: 'English DD+ 5.1', channels: '5.1', default: true })
  assert.deepEqual(p.audio[1], { order: 1, index: 2, codec: 'ac3', language: 'ara', title: 'Arabic', channels: 'stereo', default: false })
})

test('needsAudioConversion: the codecs Chromium plays silently', () => {
  for (const c of ['ac3', 'eac3', 'dts', 'truehd', 'mp2']) assert.ok(needsAudioConversion(c), c)
  for (const c of ['aac', 'mp3', 'opus', 'vorbis', 'flac']) assert.ok(!needsAudioConversion(c), c)
})

test('parseKeyframe: first packet time from framemd5 output', () => {
  assert.equal(parseKeyframe('#tb 0: 1/1000\n#media_type 0: video\n0,      19923,      20006,       41,    10524, 758e\n'), 19.923)
  assert.equal(parseKeyframe('#tb 0: 1/12288\n0,      -1024,          0,      512,     7273, 18ab\n'), -1024 / 12288)
  assert.equal(parseKeyframe(''), null)
})

test('transcodeArgs: copies video, converts the chosen audio track, seeks only when needed', () => {
  const a = transcodeArgs({ input: 'http://x/f.mkv', start: 42, audio: 1, videoCodec: 'hevc' })
  assert.deepEqual(a.slice(a.indexOf('-ss'), a.indexOf('-ss') + 3), ['-ss', '42.000', '-noaccurate_seek'])
  assert.ok(a.includes('0:a:1') && a.includes('hvc1'))
  assert.equal(a[a.indexOf('-c:v') + 1], 'copy')
  assert.ok(!transcodeArgs({ input: 'x', start: 0 }).includes('-ss'))
})
