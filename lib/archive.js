// Search the Internet Archive (archive.org). Every item there has a .torrent with an
// HTTP web seed, so even items with no peers stream straight away. Items are public
// domain or openly licensed, though licences vary per item: check the item page.
import path from 'node:path'
import { kindOf, isPaddingFile } from './media.js'

const SEARCH = 'https://archive.org/advancedsearch.php'

export const KINDS = {
  film: { mediatype: 'movies', popular: 'collection:(feature_films)' },
  music: { mediatype: 'audio', popular: 'collection:(etree OR audio_music)' }
}

/** Build the advancedsearch URL. Exported for tests. */
export function searchUrl ({ query = '', kind = 'film', page = 1, rows = 40 } = {}) {
  const k = KINDS[kind] || KINDS.film
  const terms = String(query).trim().replace(/[()[\]{}:"\\^~*?]/g, ' ').replace(/\s+/g, ' ').trim()
  const q = [
    // every word must be in the title; matching all fields returns mostly noise
    terms ? `title:(${terms.split(' ').join(' AND ')})` : k.popular,
    `mediatype:(${k.mediatype})`,
    '-access-restricted-item:(true)' // lending-library items can't be downloaded
  ].join(' AND ')
  const params = new URLSearchParams({ q, rows: String(rows), page: String(page), output: 'json' })
  for (const f of ['identifier', 'title', 'year', 'creator', 'downloads', 'mediatype']) params.append('fl[]', f)
  params.append('sort[]', 'downloads desc')
  return `${SEARCH}?${params}`
}

const first = v => (Array.isArray(v) ? v[0] : v)

export function parseResults (data) {
  const docs = data?.response?.docs || []
  return {
    total: data?.response?.numFound || 0,
    items: docs.filter(d => d.identifier).map(d => ({
      id: d.identifier,
      title: String(first(d.title) || d.identifier),
      year: first(d.year) ? String(first(d.year)).slice(0, 4) : '',
      creator: String(first(d.creator) || ''),
      downloads: Number(d.downloads) || 0,
      kind: d.mediatype === 'audio' ? 'music' : 'film',
      torrentUrl: `https://archive.org/download/${encodeURIComponent(d.identifier)}/${encodeURIComponent(d.identifier)}_archive.torrent`,
      thumb: `https://archive.org/services/img/${encodeURIComponent(d.identifier)}`,
      page: `https://archive.org/details/${encodeURIComponent(d.identifier)}`
    }))
  }
}

export async function searchArchive (opts, { userAgent } = {}) {
  const res = await fetch(searchUrl(opts), { headers: { Accept: 'application/json', ...(userAgent ? { 'User-Agent': userAgent } : {}) } })
  if (!res.ok) throw new Error(`The Internet Archive search failed (HTTP ${res.status}). Try again in a moment.`)
  return parseResults(await res.json())
}

// Archive items hold every derivative of a recording: the 11 GB original, an .mp4, an .ogv,
// a 512kb preview... Downloading all of them can mean 40 GB for one film. Keep the best
// copy Chromium can play for each recording, plus subtitles and the item thumbnail.
const RANK = {
  video: { '.mp4': 3, '.m4v': 3, '.webm': 3, '.mkv': 2, '.mov': 2, '.ogv': 1 },
  audio: { '.mp3': 3, '.m4a': 3, '.ogg': 2, '.opus': 2, '.oga': 2, '.flac': 1 }
}
const DERIVATIVE = /([._-](512kb|1080p|720p|480p|360p|hd|sd|hq|lq|vbr|64kb|128kb|256kb|320kb|ia|edit|dvd\d?|ps3|psp|iphone|ipod|ipad|h264|mpeg4|xvid|divx))+$/i

/** Indices of files to leave unticked when adding an Internet Archive torrent. */
export function archiveDeselect (files) {
  const best = new Map() // recording stem -> { index, rank, length }
  files.forEach((f, i) => {
    const p = f.path || f.name
    if (isPaddingFile(p)) return
    const kind = kindOf(f.name)
    if (kind !== 'video' && kind !== 'audio') return
    const ext = path.extname(f.name).toLowerCase()
    const stem = kind + ':' + path.join(path.dirname(p), path.basename(f.name, path.extname(f.name)).replace(DERIVATIVE, '')).toLowerCase()
    const rank = RANK[kind][ext] || 0
    const cur = best.get(stem)
    if (!cur || rank > cur.rank || (rank === cur.rank && f.length > cur.length)) best.set(stem, { index: i, rank, length: f.length })
  })
  // a film item's audio files are soundtrack rips of the same film: skip them
  const hasVideo = [...best.keys()].some(k => k.startsWith('video:'))
  const keep = new Set([...best].filter(([k]) => !hasVideo || k.startsWith('video:')).map(([, b]) => b.index))
  files.forEach((f, i) => {
    const n = f.name.toLowerCase()
    if (n === '__ia_thumb.jpg' || /\.(srt|vtt|ass|ssa)$/.test(n)) keep.add(i)
  })
  return files.map((_, i) => i).filter(i => !keep.has(i))
}
