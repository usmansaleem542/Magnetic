// Tracker lists and live tracker status.
//
// WebTorrent announces to each torrent's own trackers. Trackers the user adds (in
// Preferences or on one torrent) run in a second tracker client per torrent that feeds
// peers into the same torrent, so they can be added or dropped without restarting it.

export const DEFAULT_TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.stealth.si:80/announce',
  'udp://exodus.desync.com:6969/announce',
  'wss://tracker.openwebtorrent.com',
  'wss://tracker.webtorrent.dev'
]

const PROTOCOLS = new Set(['http:', 'https:', 'udp:', 'ws:', 'wss:'])

/** bittorrent-tracker drops one trailing slash; match it so URLs compare equal. */
export function normaliseTracker (url) {
  const s = String(url).trim()
  return s.endsWith('/') ? s.slice(0, -1) : s
}

/** Identity for de-duplication: UDP trackers ignore the path, so host and port decide. */
export function trackerKey (url) {
  const n = normaliseTracker(url)
  try {
    const u = new URL(n)
    if (u.protocol === 'udp:') return `udp://${u.hostname.toLowerCase()}:${u.port}`
  } catch {}
  return n
}

export function isValidTracker (url) {
  try {
    const u = new URL(url)
    return PROTOCOLS.has(u.protocol) && !!u.hostname && (u.protocol !== 'udp:' || !!u.port)
  } catch {
    return false
  }
}

/** Split pasted text (lines, spaces or commas) into valid and invalid tracker URLs, de-duplicated. */
export function parseTrackerList (text) {
  const valid = []
  const invalid = []
  for (const raw of String(text || '').split(/[\s,]+/)) {
    if (!raw) continue
    const url = normaliseTracker(raw)
    if (!isValidTracker(url)) { if (!invalid.includes(raw)) invalid.push(raw); continue }
    if (!valid.some(v => trackerKey(v) === trackerKey(url))) valid.push(url)
  }
  return { valid, invalid }
}

/** Union of lists, normalised, in first-seen order. */
export function mergeTrackers (...lists) {
  const out = []
  const keys = new Set()
  for (const list of lists) for (const u of list || []) {
    const n = normaliseTracker(u)
    if (!n || keys.has(trackerKey(n))) continue
    keys.add(trackerKey(n))
    out.push(n)
  }
  return out
}

/**
 * Trackers for one torrent: its own (minus removed) and the extra ones we announce to.
 * Private torrents never get the Preferences list: that would leak them to public trackers.
 */
export function planTrackers ({ own = [], added = [], removed = [], global = [], useGlobal = true, isPrivate = false }) {
  const gone = new Set(removed.map(trackerKey))
  const ownList = mergeTrackers(own).filter(u => !gone.has(trackerKey(u)))
  const ownKeys = new Set(ownList.map(trackerKey))
  const extra = mergeTrackers(added, useGlobal && !isPrivate ? global : [])
    .filter(u => !gone.has(trackerKey(u)) && !ownKeys.has(trackerKey(u)))
  return { own: ownList, extra }
}

// ---------- live status ----------
// Each tracker object reports through `this.client.emit(...)`, and most failures are
// 'warning' events that don't say which tracker failed. Giving each tracker its own
// thin wrapper around the shared client tells us who said what.
const TAGGED = Symbol('Magnetic.tracker')

/** Record per-tracker results from a bittorrent-tracker Client into `status` (Map url -> info). */
export function instrumentTrackers (trackerClient, status) {
  for (const tr of trackerClient?._trackers || []) {
    if (tr[TAGGED]) continue
    tr[TAGGED] = true
    const url = normaliseTracker(tr.announceUrl)
    if (!status.has(url)) status.set(url, { state: 'checking' })
    const real = tr.client
    const proxy = Object.create(real)
    proxy.emit = (event, arg, ...rest) => {
      noteEvent(status, url, event, arg)
      return real.emit(event, arg, ...rest)
    }
    tr.client = proxy
  }
}

export function noteEvent (status, url, event, arg) {
  const cur = status.get(url) || { state: 'checking' }
  const now = Date.now()
  if (event === 'update' || event === 'scrape') {
    status.set(url, {
      ...cur,
      state: 'working',
      message: '',
      seeders: Number.isFinite(arg?.complete) ? arg.complete : cur.seeders,
      leechers: Number.isFinite(arg?.incomplete) ? arg.incomplete : cur.leechers,
      lastOk: now
    })
  } else if (event === 'peer') {
    status.set(url, { ...cur, state: 'working', peers: (cur.peers || 0) + 1, lastOk: cur.lastOk || now })
  } else if (event === 'warning' || event === 'error') {
    status.set(url, { ...cur, state: 'failing', message: tidyError(arg), lastError: now })
  }
}

export function tidyError (err) {
  const m = String(err?.message || err || 'No response')
  if (/timed out/i.test(m)) return 'Not responding'
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(m)) return 'Address not found'
  if (/ECONNREFUSED/i.test(m)) return 'Connection refused'
  if (/ECONNRESET|socket hang up/i.test(m)) return 'Connection dropped'
  if (/Connection error|Error connecting/i.test(m)) return 'Couldn’t connect'
  return m.length > 80 ? m.slice(0, 77) + '…' : m
}

/** A tracker counts as dead when its last answer was a failure, or it could never be used. */
export const isDead = info => info?.state === 'failing' || info?.state === 'invalid'
