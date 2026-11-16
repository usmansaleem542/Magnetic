import { test } from 'node:test'
import assert from 'node:assert/strict'
import { searchUrl, parseResults, archiveDeselect } from '../lib/archive.js'
import { isPaddingFile, pickPosterFile } from '../lib/media.js'

const f = (p, mb) => ({ path: p, name: p.split('/').pop(), length: mb * 1e6 })

test('searchUrl: typed words must all be in the title; browsing shows popular items', () => {
  const q = new URL(searchUrl({ query: 'night of the "living" dead', kind: 'film' })).searchParams.get('q')
  assert.match(q, /^title:\(night AND of AND the AND living AND dead\) AND mediatype:\(movies\)/)
  const popular = new URL(searchUrl({ kind: 'music' }))
  assert.match(popular.searchParams.get('q'), /^collection:.* AND mediatype:\(audio\)/)
  assert.equal(popular.searchParams.get('sort[]'), 'downloads desc')
})

test('parseResults: maps docs to items with torrent and thumbnail URLs', () => {
  const { total, items } = parseResults({ response: { numFound: 1, docs: [{ identifier: 'nosferatu', title: 'Nosferatu', year: '1922', mediatype: 'movies', downloads: 5 }] } })
  assert.equal(total, 1)
  assert.equal(items[0].torrentUrl, 'https://archive.org/download/nosferatu/nosferatu_archive.torrent')
  assert.equal(items[0].year, '1922')
  assert.equal(items[0].kind, 'film')
})

test('archiveDeselect: one playable copy per recording, plus subtitles and thumbnail', () => {
  const files = [
    f('N/N_meta.xml', 0), f('N/.____padding_file/1', 3), f('N/__ia_thumb.jpg', 0.02),
    f('N/Night.m2ts', 17000), f('N/Night.mp4', 596), f('N/Night.ogv', 425),
    f('N/Night_1080p.mkv', 11500), f('N/Night_1080p.mp4', 597), f('N/Night_1080p_512kb.mp4', 407),
    f('N/Night_720p.mp4', 598), f('N/Night.asr.srt', 0.1),
    f('N/part-2of5.mpg', 999), f('N/part-2of5_512kb.mp4', 86), f('N/part-2of5.ogv', 85),
    f('N/Night_DVD5.mp4', 590), f('N/Night_iPod.mp4', 570), f('N/Night_DVD5.mp3', 69)
  ]
  const off = archiveDeselect(files)
  const kept = files.map((x, i) => i).filter(i => !off.includes(i)).map(i => files[i].name)
  assert.deepEqual(kept, ['__ia_thumb.jpg', 'Night_720p.mp4', 'Night.asr.srt', 'part-2of5_512kb.mp4'])
})

test('archiveDeselect: music keeps the mp3 of each track', () => {
  const files = [f('A/t01.mp3', 11), f('A/t01.ogg', 6), f('A/t01.flac', 40), f('A/t01_spectrogram.png', 0.2), f('A/t02_vbr.mp3', 5), f('A/t02.flac', 30)]
  const off = archiveDeselect(files)
  assert.deepEqual(files.filter((_, i) => !off.includes(i)).map(x => x.name), ['t01.mp3', 't02_vbr.mp3'])
})

test('isPaddingFile and the archive thumbnail as poster', () => {
  assert.ok(isPaddingFile('X/.____padding_file/12'))
  assert.ok(!isPaddingFile('X/padding_file.mp4'))
  assert.equal(pickPosterFile([f('X/big.gif', 0.3), f('X/__ia_thumb.jpg', 0.02)]).name, '__ia_thumb.jpg')
})
