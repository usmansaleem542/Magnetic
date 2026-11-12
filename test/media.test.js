import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseRange, kindOf, mimeOf, pickPosterFile, stripFromBitfield } from '../lib/media.js'

test('parseRange: no header means the whole file', () => {
  assert.equal(parseRange(undefined, 100), null)
  assert.equal(parseRange('', 100), null)
})

test('parseRange: explicit, open-ended and suffix ranges', () => {
  assert.deepEqual(parseRange('bytes=0-99', 1000), { start: 0, end: 99 })
  assert.deepEqual(parseRange('bytes=500-', 1000), { start: 500, end: 999 })
  assert.deepEqual(parseRange('bytes=-100', 1000), { start: 900, end: 999 })
})

test('parseRange: end past the file is clamped, as browsers expect when seeking near the end', () => {
  assert.deepEqual(parseRange('bytes=900-5000', 1000), { start: 900, end: 999 })
  assert.deepEqual(parseRange('bytes=-5000', 1000), { start: 0, end: 999 })
})

test('parseRange: unsatisfiable ranges are flagged', () => {
  assert.deepEqual(parseRange('bytes=1000-', 1000), { unsatisfiable: true })
  assert.deepEqual(parseRange('bytes=50-10', 1000), { unsatisfiable: true })
  assert.deepEqual(parseRange('bytes=-0', 1000), { unsatisfiable: true })
})

test('parseRange: only the first of multiple ranges is served', () => {
  assert.deepEqual(parseRange('bytes=0-9, 20-29', 1000), { start: 0, end: 9 })
})

test('parseRange: malformed headers fall back to the whole file', () => {
  assert.equal(parseRange('items=0-9', 1000), null)
  assert.equal(parseRange('bytes=-', 1000), null)
})

test('kindOf and mimeOf classify by extension, case-insensitively', () => {
  assert.equal(kindOf('Movie.MKV'), 'video')
  assert.equal(kindOf('track.flac'), 'audio')
  assert.equal(kindOf('Sintel.en.srt'), 'subtitle')
  assert.equal(kindOf('cover.JPG'), 'image')
  assert.equal(kindOf('readme.txt'), 'other')
  assert.equal(mimeOf('a.mp4'), 'video/mp4')
  assert.equal(mimeOf('a.unknown'), 'application/octet-stream')
})

test('pickPosterFile prefers conventional names, then the largest image', () => {
  const files = [
    { name: 'screens/shot1.jpg', length: 900_000 },
    { name: 'poster.jpg', length: 40_000 },
    { name: 'movie.mp4', length: 5e9 }
  ]
  assert.equal(pickPosterFile(files).name, 'poster.jpg')
  assert.equal(pickPosterFile(files.filter(f => f.name !== 'poster.jpg')).name, 'screens/shot1.jpg')
  assert.equal(pickPosterFile([{ name: 'movie.mp4', length: 1 }]), null)
  assert.equal(pickPosterFile([{ name: 'huge.png', length: 50 * 1024 * 1024 }]), null)
})

test('stripFromBitfield buckets pieces into fractions', () => {
  const have = new Set([0, 1, 2, 3, 8, 9])
  const out = stripFromBitfield(i => have.has(i), 0, 9, 5)
  assert.deepEqual(out, [1, 1, 0, 0, 1])
})

test('stripFromBitfield respects a file’s piece range and never exceeds piece count', () => {
  const out = stripFromBitfield(i => i >= 12, 10, 13, 100)
  assert.deepEqual(out, [0, 0, 1, 1])
  assert.deepEqual(stripFromBitfield(() => true, 5, 4, 10), [])
})

test('displayName tidies raw Chromecast service names and leaves others alone', async () => {
  const { displayName } = await import('../lib/cast.js')
  assert.equal(displayName('Haier-MatrixTV-EE-c12176a9a627da288efb1886f1b44aaa', 'chromecast'), 'Haier MatrixTV EE')
  assert.equal(displayName('Living Room TV', 'chromecast'), 'Living Room TV')
  assert.equal(displayName('Kitchen-Speaker', 'airplay'), 'Kitchen-Speaker')
})
