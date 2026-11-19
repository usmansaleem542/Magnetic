import path from 'node:path'

export const EXT = {
  video: ['.mp4', '.m4v', '.webm', '.mkv', '.mov', '.ogv', '.avi', '.wmv', '.flv', '.ts'],
  audio: ['.mp3', '.m4a', '.aac', '.ogg', '.oga', '.opus', '.flac', '.wav'],
  subtitle: ['.srt', '.vtt'],
  image: ['.jpg', '.jpeg', '.png', '.webp', '.gif']
}

export const MIME = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/mp4', '.webm': 'video/webm',
  // Chromium's Matroska demuxer handles many .mkv files when labelled as webm
  '.mkv': 'video/webm', '.ogv': 'video/ogg', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4',
  '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/ogg',
  '.flac': 'audio/flac', '.wav': 'audio/wav', '.srt': 'text/plain', '.vtt': 'text/vtt',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif'
}

export const kindOf = name => {
  const ext = path.extname(name).toLowerCase()
  return Object.keys(EXT).find(k => EXT[k].includes(ext)) || 'other'
}

/** BEP 47 padding files (zeros between real files), shown by some clients as '.____padding_file/12'. */
export const isPaddingFile = p => /(^|[\\/])\.____padding_file([\\/]|$)/.test(String(p))

export const mimeOf = name => MIME[path.extname(name).toLowerCase()] || 'application/octet-stream'

/**
 * Parse a single HTTP Range header against a resource length.
 * Returns null when there's no usable header (serve the whole thing),
 * { start, end } for a satisfiable range, or { unsatisfiable: true }.
 */
export function parseRange (header, length) {
  if (!header) return null
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim().split(',')[0].trim())
  if (!m || (m[1] === '' && m[2] === '')) return null
  let start, end
  if (m[1] === '') {
    const suffix = Number(m[2])
    if (suffix === 0) return { unsatisfiable: true }
    start = Math.max(0, length - suffix)
    end = length - 1
  } else {
    start = Number(m[1])
    end = m[2] === '' ? length - 1 : Math.min(Number(m[2]), length - 1)
  }
  if (start >= length || start > end) return { unsatisfiable: true }
  return { start, end }
}

/** Pick the image a torrent ships as its cover, preferring conventional names over size. */
export function pickPosterFile (files) {
  const images = files.filter(f => kindOf(f.name) === 'image' && f.length < 10 * 1024 * 1024)
  if (!images.length) return null
  const named = images.find(f => /^(__ia_thumb|poster|cover|folder|thumb|front)\b/i.test(path.basename(f.name)))
  return named || images.reduce((a, b) => (b.length > a.length ? b : a))
}

/** Summarise a torrent's pieces into `buckets` values between 0 and 1. */
export function stripFromBitfield (has, from, to, buckets) {
  const total = to - from + 1
  if (total <= 0) return []
  const n = Math.min(buckets, total)
  const out = new Array(n)
  for (let b = 0; b < n; b++) {
    const s = from + Math.floor((b * total) / n)
    const e = from + Math.floor(((b + 1) * total) / n)
    let have = 0
    for (let i = s; i < e; i++) if (has(i)) have++
    out[b] = Math.round((have / Math.max(1, e - s)) * 100) / 100
  }
  return out
}

/** Bytes still to download for the files that are ticked. */
export function bytesNeeded (files, deselected = []) {
  const off = new Set(deselected)
  return files.reduce((sum, f, i) => off.has(i) ? sum : sum + Math.max(0, f.length * (1 - (f.progress || 0))), 0)
}
