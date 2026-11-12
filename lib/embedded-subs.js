// Read subtitle tracks embedded in an .mkv while it downloads. We only read pieces the
// torrent already has, so this never competes with playback for bandwidth: cues appear
// up to the point where the file is contiguously downloaded, and fill in as it completes.
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { SubtitleParser } = require('matroska-subtitles')

export function extractEmbeddedSubtitles (torrent, file, { onTracks, onCues, onDone }) {
  const parser = new SubtitleParser()
  let cancelled = false
  let pending = []
  let flushTimer = null

  const flush = () => {
    flushTimer = null
    if (!pending.length || cancelled) return
    const batch = pending
    pending = []
    onCues(batch)
  }

  parser.once('tracks', tracks => { if (!cancelled) onTracks(tracks) })
  parser.on('subtitle', (sub, trackNumber) => {
    pending.push({ track: trackNumber, start: sub.time / 1000, end: (sub.time + (sub.duration || 2000)) / 1000, text: sub.text, raw: sub })
    if (!flushTimer) flushTimer = setTimeout(flush, 400)
  })
  parser.on('error', () => { cancelled = true })

  const pieceLength = torrent.pieceLength
  const has = i => torrent.bitfield.get(i)
  const pieceAt = pos => Math.floor((file.offset + pos) / pieceLength)

  const waitForPiece = index => new Promise(resolve => {
    if (has(index) || cancelled) return resolve()
    const onVerified = i => { if (i === index) { torrent.off('verified', onVerified); clearInterval(poll); resolve() } }
    torrent.on('verified', onVerified)
    // also poll, in case the piece arrived between our check and the listener
    const poll = setInterval(() => {
      if (has(index) || cancelled || torrent.destroyed) { torrent.off('verified', onVerified); clearInterval(poll); resolve() }
    }, 2000)
  })

  const write = chunk => new Promise(resolve => {
    if (parser.write(chunk)) resolve()
    else parser.once('drain', resolve)
  })

  ;(async () => {
    let pos = 0
    while (pos < file.length && !cancelled && !torrent.destroyed) {
      const p = pieceAt(pos)
      if (!has(p)) { await waitForPiece(p); continue }
      // read the run of pieces we already have, in one go
      let q = p
      const lastPiece = pieceAt(file.length - 1)
      while (q + 1 <= lastPiece && has(q + 1)) q++
      const end = Math.min(file.length - 1, (q + 1) * pieceLength - file.offset - 1)
      for await (const chunk of file.createReadStream({ start: pos, end })) {
        if (cancelled) break
        await write(Buffer.from(chunk))
      }
      pos = end + 1
    }
    if (!cancelled) {
      parser.end()
      flush()
      onDone?.()
    }
  })().catch(() => { cancelled = true })

  return () => {
    cancelled = true
    clearTimeout(flushTimer)
    parser.destroy?.()
  }
}
