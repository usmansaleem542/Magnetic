// OpenSubtitles.com REST API (v1). Needs the user's own API key; downloads also need their login.
// Endpoint shapes follow the public docs at opensubtitles.stoplight.io as of 2026; verify if calls start failing.
const BASE = 'https://api.opensubtitles.com/api/v1'

export class OpenSubtitlesError extends Error {}

/**
 * The OpenSubtitles "moviehash": file size plus the 64-bit little-endian word sums
 * of the first and last 64 KiB, modulo 2^64, as 16 hex digits.
 */
export function movieHash (size, head, tail) {
  let h = BigInt(size)
  const add = buf => {
    for (let i = 0; i + 8 <= buf.length; i += 8) h = (h + buf.readBigUInt64LE(i)) & 0xFFFFFFFFFFFFFFFFn
  }
  add(head)
  add(tail)
  return h.toString(16).padStart(16, '0')
}

export function createClient ({ apiKey, userAgent }) {
  let token = null
  const headers = extra => ({
    'Api-Key': apiKey,
    'User-Agent': userAgent,
    Accept: 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...extra
  })

  async function request (method, path, body) {
    if (!apiKey) throw new OpenSubtitlesError('Add your OpenSubtitles API key in Preferences to search for subtitles.')
    const res = await fetch(BASE + path, {
      method,
      headers: headers(body ? { 'Content-Type': 'application/json' } : {}),
      body: body ? JSON.stringify(body) : undefined
    })
    const data = await res.json().catch(() => ({}))
    if (res.status === 401) throw new OpenSubtitlesError('OpenSubtitles rejected the API key or login. Check them in Preferences.')
    if (res.status === 406 || res.status === 429) throw new OpenSubtitlesError(data.message || 'You’ve reached today’s OpenSubtitles download limit. It resets in 24 hours.')
    if (!res.ok) throw new OpenSubtitlesError(data.message || `OpenSubtitles returned an error (HTTP ${res.status}).`)
    return data
  }

  return {
    async login (username, password) {
      if (!username || !password) return false
      const data = await request('POST', '/login', { username, password })
      token = data.token
      return true
    },

    async search ({ hash, query, languages }) {
      // the API asks for parameters in alphabetical order and lower case
      const params = new URLSearchParams()
      if (languages?.length) params.set('languages', [...new Set(languages)].sort().join(','))
      if (hash) params.set('moviehash', hash)
      if (query) params.set('query', query.toLowerCase())
      const data = await request('GET', `/subtitles?${params.toString()}`)
      return (data.data || []).flatMap(item => {
        const a = item.attributes || {}
        return (a.files || []).map(f => ({
          fileId: f.file_id,
          fileName: f.file_name || a.release || '',
          release: a.release || f.file_name || '',
          language: a.language || '',
          downloads: a.download_count || 0,
          hashMatch: !!a.moviehash_match,
          hearingImpaired: !!a.hearing_impaired,
          title: a.feature_details?.title || '',
          year: a.feature_details?.year || null
        }))
      }).sort((x, y) => Number(y.hashMatch) - Number(x.hashMatch) || y.downloads - x.downloads)
    },

    async download (fileId) {
      const data = await request('POST', '/download', { file_id: fileId })
      if (!data.link) throw new OpenSubtitlesError('OpenSubtitles didn’t return a download link.')
      const res = await fetch(data.link, { headers: { 'User-Agent': userAgent } })
      if (!res.ok) throw new OpenSubtitlesError(`Couldn’t download the subtitle file (HTTP ${res.status}).`)
      return { buffer: Buffer.from(await res.arrayBuffer()), name: data.file_name || 'subtitles.srt', remaining: data.remaining }
    }
  }
}

/** Movie title guess from a release file name, for text search when the hash finds nothing. */
export function queryFromFileName (name) {
  return String(name)
    .split(/[\\/]/).pop()
    .replace(/\.[^.]+$/, '')
    .replace(/[._]+/g, ' ')
    .replace(/\b(19|20)\d{2}\b.*$/, m => m.slice(0, 4)) // keep the year, drop the release tags after it
    .replace(/\b(480p|720p|1080p|2160p|4k|x264|x265|h264|hevc|bluray|web-?dl|webrip|hdrip|brrip|dvdrip|aac|ac3)\b.*$/i, '')
    .trim()
}
