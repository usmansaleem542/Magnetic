import {
  app, BrowserWindow, ipcMain, dialog, shell, Menu, clipboard, Notification,
  powerSaveBlocker, Tray, nativeImage, nativeTheme, screen, safeStorage
} from 'electron'
import WebTorrent from 'webtorrent'
import parseTorrent from 'parse-torrent'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { kindOf, mimeOf, parseRange, pickPosterFile, stripFromBitfield } from './lib/media.js'
import { createCaster, lanAddress } from './lib/cast.js'
import { decodeSubtitle, ENCODINGS } from './lib/subtitle-decode.js'
import { createClient as createOpenSubtitles, movieHash, queryFromFileName } from './lib/opensubtitles.js'
import { extractEmbeddedSubtitles } from './lib/embedded-subs.js'
import { languageFromName } from './renderer/subtitles.js'
import { Readable } from 'node:stream'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const isMac = process.platform === 'darwin'
const isWin = process.platform === 'win32'
const isLinux = process.platform === 'linux'

// ---------- single instance + magnet / .torrent handling ----------
const pendingOpen = []
if (!app.requestSingleInstanceLock()) app.quit()

const collectArgs = argv => argv.filter(a => /^magnet:/i.test(a) || /\.torrent$/i.test(a))
pendingOpen.push(...collectArgs(process.argv.slice(1)))

app.on('second-instance', (_e, argv) => {
  collectArgs(argv).forEach(openExternalId)
  showWindow()
})
app.on('open-url', (e, url) => { e.preventDefault(); openExternalId(url) })
app.on('open-file', (e, file) => { e.preventDefault(); openExternalId(file) })

function openExternalId (id) {
  if (!ready) return pendingOpen.push(id)
  showWindow()
  addTorrent(id).catch(err => toast(err.message, 'error'))
}

// ---------- state ----------
let win = null
let tray = null
let ready = false
let client = null
let caster = null
let STATE_FILE, TORRENT_DIR, POSTER_DIR
let state = { prefs: {}, torrents: [] }
const live = new Map() // infoHash -> WebTorrent torrent
const TOKEN = crypto.randomBytes(12).toString('hex')
let localPort = 0
let lanServer = null
let lanPort = 0
let powerBlockId = null
let unseenCompletions = 0

const defaultPrefs = () => ({
  downloadPath: app.getPath('downloads'),
  notifyOnComplete: true,
  autoPlay: true,
  theme: 'system', // system | dark | light
  externalPlayer: 'builtin', // builtin | vlc | custom
  externalPlayerPath: '',
  downloadLimit: 0, // KB/s, 0 = unlimited
  uploadLimit: 0,
  seedRatioLimit: 0, // 0 = seed forever
  openAtLogin: false,
  closeToTray: !isMac,
  osApiKey: '',
  osUsername: '',
  osPassword: '' // encrypted with the OS keychain via safeStorage, base64
})

function loadState () {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
    state = { prefs: { ...defaultPrefs(), ...raw.prefs }, torrents: raw.torrents || [] }
  } catch {
    state = { prefs: defaultPrefs(), torrents: [] }
  }
}

let saveTimer = null
function saveState () {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(saveStateNow, 300)
}
function saveStateNow () {
  clearTimeout(saveTimer)
  for (const e of state.torrents) captureProgress(e)
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true })
    fs.writeFileSync(STATE_FILE + '.tmp', JSON.stringify(state, null, 2))
    fs.renameSync(STATE_FILE + '.tmp', STATE_FILE)
  } catch (err) {
    console.error('Could not save state', err)
  }
}

const entryOf = ih => state.torrents.find(e => e.infoHash === ih)

function captureProgress (entry) {
  const t = live.get(entry.infoHash)
  if (!t || !t.files.length) return
  entry.name = t.name
  entry.length = t.length
  entry.progress = t.progress
  entry.uploaded = (entry.uploadedBase || 0) + t.uploaded
  entry.files = t.files.map(f => ({ name: f.name, path: f.path, length: f.length, progress: f.progress }))
}

// ---------- torrent lifecycle ----------
async function resolveId (id) {
  if (typeof id === 'string' && /^https?:\/\//i.test(id)) {
    const res = await fetch(id)
    if (!res.ok) throw new Error(`Couldn't download the .torrent file (HTTP ${res.status}).`)
    return Buffer.from(await res.arrayBuffer())
  }
  if (typeof id === 'string' && !/^magnet:/i.test(id) && !/^[a-f0-9]{40}$/i.test(id) && fs.existsSync(id)) {
    return fs.readFileSync(id)
  }
  return typeof id === 'string' ? id.trim() : id
}

async function addTorrent (rawId, opts = {}) {
  const id = await resolveId(rawId)
  let parsed
  try {
    parsed = await parseTorrent(id)
  } catch {
    throw new Error('That isn\'t a valid magnet link, info hash or .torrent file.')
  }
  const infoHash = parsed.infoHash
  let entry = entryOf(infoHash)
  if (entry) {
    if (entry.paused) resumeTorrent(infoHash)
    toast(`${entry.name || 'This torrent'} is already in your list.`)
    return infoHash
  }
  entry = {
    infoHash,
    magnet: typeof id === 'string' ? id : parseTorrent.toMagnetURI(parsed),
    torrentFile: null,
    name: parsed.name || '',
    path: opts.path || state.prefs.downloadPath,
    paused: false,
    deselected: [],
    length: parsed.length || 0,
    progress: 0,
    files: [],
    addedAt: Date.now()
  }
  if (Buffer.isBuffer(id)) {
    entry.torrentFile = path.join(TORRENT_DIR, `${infoHash}.torrent`)
    fs.mkdirSync(TORRENT_DIR, { recursive: true })
    fs.writeFileSync(entry.torrentFile, id)
  }
  state.torrents.unshift(entry)
  startTorrent(entry, id)
  saveState()
  pushTorrents()
  return infoHash
}

function startTorrent (entry, idOverride) {
  if (live.has(entry.infoHash)) return live.get(entry.infoHash)
  const id = idOverride ||
    (entry.torrentFile && fs.existsSync(entry.torrentFile) ? fs.readFileSync(entry.torrentFile) : entry.magnet)
  const t = client.add(id, { path: entry.path })
  live.set(entry.infoHash, t)
  entry.paused = false
  entry.seedLimitReached = false
  entry.uploadedBase = entry.uploaded || 0
  wireTorrent(entry, t)
  return t
}

function wireTorrent (entry, t) {
  t.on('ready', () => {
    // keep a .torrent copy so restarts don't need to fetch metadata again
    if (!entry.torrentFile && t.torrentFile) {
      entry.torrentFile = path.join(TORRENT_DIR, `${entry.infoHash}.torrent`)
      fs.mkdirSync(TORRENT_DIR, { recursive: true })
      fs.writeFileSync(entry.torrentFile, t.torrentFile)
    }
    applySelection(entry, t)
    const poster = pickPosterFile(t.files)
    if (poster) poster.select() // small, and it makes the list look right sooner
    else extractAlbumArt(entry, t)
    captureProgress(entry)
    saveState()
    pushTorrents()
  })
  t.on('done', () => {
    captureProgress(entry)
    saveState()
    if (entry.notified) return
    entry.notified = true
    if (state.prefs.notifyOnComplete && Notification.isSupported()) {
      new Notification({ title: 'Download complete', body: t.name }).show()
    }
    if (isMac) app.dock?.bounce('informational')
    if (win && !win.isFocused()) { unseenCompletions++; updateBadge() }
  })
  t.on('error', err => {
    live.delete(entry.infoHash)
    entry.paused = true
    toast(`${entry.name || 'Torrent'}: ${err.message}`, 'error')
    saveState()
  })
}

function applySelection (entry, t) {
  if (!entry.deselected.length) return
  t.files.forEach((f, i) => { if (entry.deselected.includes(i)) f.deselect() })
  // re-select kept files so pieces shared at file boundaries stay wanted
  t.files.forEach((f, i) => { if (!entry.deselected.includes(i)) f.select() })
}

function waitReady (t) {
  return new Promise((resolve, reject) => {
    if (t.ready) return resolve(t)
    t.once('ready', () => resolve(t))
    t.once('error', reject)
  })
}

function pauseTorrent (ih) {
  const entry = entryOf(ih)
  const t = live.get(ih)
  if (!entry) return
  captureProgress(entry)
  entry.paused = true
  if (t) {
    live.delete(ih)
    client.remove(t, { destroyStore: false }).catch(() => {})
  }
  saveState()
  pushTorrents()
}

function resumeTorrent (ih) {
  const entry = entryOf(ih)
  if (!entry) return
  startTorrent(entry)
  saveState()
  pushTorrents()
}

async function removeTorrent (ih, deleteData) {
  const entry = entryOf(ih)
  if (!entry) return
  const t = live.get(ih)
  live.delete(ih)
  if (t) await client.remove(t, { destroyStore: false }).catch(() => {})
  if (deleteData) {
    const root = path.resolve(entry.path) + path.sep
    const dirs = new Set()
    for (const f of entry.files) {
      const full = path.resolve(entry.path, f.path)
      if (!full.startsWith(root)) continue // never escape the download folder
      fs.rmSync(full, { force: true })
      dirs.add(path.dirname(full))
    }
    // tidy up now-empty folders, deepest first
    ;[...dirs].sort((a, b) => b.length - a.length).forEach(d => {
      while (d.startsWith(root)) {
        try { fs.rmdirSync(d) } catch { break }
        d = path.dirname(d)
      }
    })
  }
  if (entry.torrentFile) fs.rmSync(entry.torrentFile, { force: true })
  fs.rmSync(posterPath(ih), { force: true })
  state.torrents = state.torrents.filter(e => e !== entry)
  saveState()
  pushTorrents()
}

function setFileSelected (ih, index, selected) {
  const entry = entryOf(ih)
  if (!entry) return
  entry.deselected = entry.deselected.filter(i => i !== index)
  if (!selected) entry.deselected.push(index)
  const t = live.get(ih)
  if (t?.ready) {
    if (selected) t.files[index].select()
    else { t.files[index].deselect(); applySelection(entry, t) }
  }
  saveState()
  pushTorrents()
}

function seedPath (input, opts = {}) {
  return new Promise((resolve, reject) => {
    const seedOpts = {}
    if (opts.announce?.length) seedOpts.announceList = opts.announce.map(u => [u])
    if (opts.comment) seedOpts.comment = opts.comment
    if (opts.private) seedOpts.private = true
    const t = client.seed(input, seedOpts, torrent => {
      if (entryOf(torrent.infoHash)) {
        toast(`${torrent.name} is already in your list.`)
        return resolve(entryOf(torrent.infoHash))
      }
      const entry = {
        infoHash: torrent.infoHash,
        magnet: torrent.magnetURI,
        torrentFile: path.join(TORRENT_DIR, `${torrent.infoHash}.torrent`),
        name: torrent.name,
        path: path.dirname(input),
        paused: false,
        deselected: [],
        length: torrent.length,
        progress: 1,
        files: [],
        addedAt: Date.now(),
        notified: true
      }
      fs.mkdirSync(TORRENT_DIR, { recursive: true })
      fs.writeFileSync(entry.torrentFile, torrent.torrentFile)
      state.torrents.unshift(entry)
      live.set(entry.infoHash, torrent)
      wireTorrent(entry, torrent)
      captureProgress(entry)
      saveState()
      pushTorrents()
      resolve(entry)
    })
    t.once('error', reject)
  })
}

// ---------- posters + album art ----------
const posterPath = ih => path.join(POSTER_DIR, `${ih}.jpg`)

function posterUrl (entry) {
  const saved = posterPath(entry.infoHash)
  let v = null
  try { v = Math.floor(fs.statSync(saved).mtimeMs) } catch {}
  if (v == null) {
    const t = live.get(entry.infoHash)
    const files = t?.files?.length ? t.files : entry.files
    if (!pickPosterFile(files)) return null
    v = 't'
  }
  return `http://127.0.0.1:${localPort}/${TOKEN}/poster/${entry.infoHash}?v=${v}`
}

async function extractAlbumArt (entry, t) {
  if (fs.existsSync(posterPath(entry.infoHash))) return
  const audio = t.files.filter(f => kindOf(f.name) === 'audio')
  // only for music torrents: a stray mp3 in a film torrent shouldn't become its cover
  if (!audio.length || t.files.some(f => kindOf(f.name) === 'video')) return
  audio.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
  const meta = await readAudioMetadata(audio[0])
  if (meta?.picture) savePoster(entry.infoHash, meta.picture.data)
}

async function readAudioMetadata (file) {
  const { parseStream } = await import('music-metadata')
  // tags and cover art live at the start of the file; don't pull the whole track for them
  const stream = file.createReadStream({ start: 0, end: Math.min(file.length - 1, 4 * 1024 * 1024) })
  try {
    const m = await parseStream(stream, { mimeType: mimeOf(file.name), size: file.length }, { duration: false, skipPostHeaders: true })
    const pic = m.common.picture?.[0]
    return {
      title: m.common.title || '',
      artist: m.common.artist || m.common.albumartist || '',
      album: m.common.album || '',
      picture: pic ? { data: Buffer.from(pic.data), format: pic.format } : null
    }
  } catch {
    return null
  } finally {
    stream.destroy()
  }
}

function savePoster (ih, buffer) {
  try {
    fs.mkdirSync(POSTER_DIR, { recursive: true })
    const img = nativeImage.createFromBuffer(buffer)
    if (img.isEmpty()) return
    const resized = img.getSize().width > 640 ? img.resize({ width: 640 }) : img
    fs.writeFileSync(posterPath(ih), resized.toJPEG(82))
    pushTorrents()
  } catch {}
}

// ---------- snapshots for the UI ----------
const strip = (t, from, to, buckets) =>
  t.bitfield ? stripFromBitfield(i => t.bitfield.get(i), from, to, buckets) : []

function snapshot (entry) {
  const t = live.get(entry.infoHash)
  const fileList = (t && t.files.length ? t.files : entry.files).map((f, i) => ({
    index: i,
    name: f.name,
    path: f.path,
    length: f.length,
    progress: f.progress ?? 0,
    selected: !entry.deselected.includes(i),
    kind: kindOf(f.name)
  }))
  const base = {
    infoHash: entry.infoHash,
    name: (t && t.name) || entry.name || '',
    path: entry.path,
    files: fileList,
    length: (t && t.length) || entry.length || 0,
    addedAt: entry.addedAt,
    poster: posterUrl(entry),
    seedLimitReached: !!entry.seedLimitReached
  }
  if (!t) {
    return { ...base, status: 'paused', progress: entry.progress || 0, downloadSpeed: 0, uploadSpeed: 0, numPeers: 0, timeRemaining: Infinity, pieces: [] }
  }
  const status = !t.ready ? 'metadata' : t.done ? 'seeding' : 'downloading'
  return {
    ...base,
    status,
    progress: t.progress,
    downloaded: t.downloaded,
    uploaded: t.uploaded,
    ratio: t.length ? ((entry.uploadedBase || 0) + t.uploaded) / t.length : 0,
    downloadSpeed: t.downloadSpeed,
    uploadSpeed: t.uploadSpeed,
    numPeers: t.numPeers,
    timeRemaining: t.timeRemaining,
    pieces: t.ready ? strip(t, 0, t.pieces.length - 1, 160) : []
  }
}

function pushTorrents () {
  if (!win || win.isDestroyed()) return
  win.webContents.send('torrents', {
    torrents: state.torrents.map(snapshot),
    totals: { down: client?.downloadSpeed || 0, up: client?.uploadSpeed || 0 }
  })
}

function tick () {
  // stop seeding once the share ratio limit is reached
  const limit = Number(state.prefs.seedRatioLimit) || 0
  if (limit > 0) {
    for (const entry of state.torrents) {
      const t = live.get(entry.infoHash)
      if (!t?.done || !t.length) continue
      if (((entry.uploadedBase || 0) + t.uploaded) / t.length >= limit) {
        pauseTorrent(entry.infoHash)
        entry.seedLimitReached = true
      }
    }
  }
  updateTaskbarProgress()
  updateTray()
  pushTorrents()
}

function updateTaskbarProgress () {
  if (!win || win.isDestroyed()) return
  let total = 0
  let done = 0
  for (const t of live.values()) {
    if (!t.ready || t.done) continue
    total += t.length
    done += t.downloaded
  }
  win.setProgressBar(total ? Math.min(1, done / total) : -1)
}

function updateBadge () {
  if (isMac || isLinux) app.setBadgeCount(unseenCompletions)
}

function toast (message, tone = 'info') {
  if (win && !win.isDestroyed()) win.webContents.send('toast', { message, tone })
}

// ---------- streaming server (HTTP Range -> prioritised pieces) ----------
function sendFile (req, res, { length, name, open }) {
  const range = parseRange(req.headers.range, length)
  if (range?.unsatisfiable) {
    res.writeHead(416, { 'Content-Range': `bytes */${length}` })
    return res.end()
  }
  const start = range ? range.start : 0
  const end = range ? range.end : length - 1
  res.writeHead(range ? 206 : 200, {
    'Accept-Ranges': 'bytes',
    'Content-Type': mimeOf(name),
    'Content-Length': end - start + 1,
    ...(range ? { 'Content-Range': `bytes ${start}-${end}/${length}` } : {}),
    'Cache-Control': 'no-store'
  })
  if (req.method === 'HEAD' || length === 0) return res.end()
  const stream = open(start, end)
  stream.on('error', () => res.destroy())
  res.on('close', () => stream.destroy())
  stream.pipe(res)
}

function handleRequest (req, res) {
  // the player canvas reads frames for posters, which needs CORS from the file:// page
  res.setHeader('Access-Control-Allow-Origin', '*')
  const url = new URL(req.url, 'http://x')
  const parts = url.pathname.split('/').filter(Boolean)
  const notFound = () => { res.statusCode = 404; res.end() }
  if (parts[0] !== TOKEN) return notFound()

  if (parts[1] === 'poster' && /^[a-f0-9]{40}$/.test(parts[2] || '')) {
    const ih = parts[2]
    const saved = posterPath(ih)
    if (fs.existsSync(saved)) {
      const length = fs.statSync(saved).size
      return sendFile(req, res, { length, name: 'poster.jpg', open: (s, e) => fs.createReadStream(saved, { start: s, end: e }) })
    }
    const t = live.get(ih)
    const file = t?.ready && pickPosterFile(t.files)
    if (file) return sendFile(req, res, { length: file.length, name: file.name, open: (s, e) => file.createReadStream({ start: s, end: e }) })
    const entry = entryOf(ih)
    const known = entry && pickPosterFile(entry.files)
    const onDisk = known && path.resolve(entry.path, known.path)
    if (onDisk && known.progress === 1 && fs.existsSync(onDisk)) {
      return sendFile(req, res, { length: known.length, name: known.name, open: (s, e) => fs.createReadStream(onDisk, { start: s, end: e }) })
    }
    return notFound()
  }

  if (parts[1] === 'subs' && castSubs.has(parts[2])) {
    const body = Buffer.from(castSubs.get(parts[2]), 'utf8')
    return sendFile(req, res, { length: body.length, name: 'subs.vtt', open: (s, e) => Readable.from([body.subarray(s, e + 1)]) })
  }

  if (/^[a-f0-9]{40}$/.test(parts[1] || '') && /^\d+$/.test(parts[2] || '')) {
    const t = live.get(parts[1])
    const file = t?.ready && t.files[Number(parts[2])]
    if (!file) return notFound()
    // WebTorrent gives the pieces this stream needs top priority, which is what makes seeking work
    return sendFile(req, res, { length: file.length, name: file.name, open: (s, e) => file.createReadStream({ start: s, end: e }) })
  }
  notFound()
}

function listen (host, port = 0) {
  const server = http.createServer(handleRequest)
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => resolve(server))
  })
}

const streamUrl = (ih, index, name, host = '127.0.0.1', port = localPort) =>
  `http://${host}:${port}/${TOKEN}/${ih}/${index}/${encodeURIComponent(name)}`

async function liveReady (ih) {
  const entry = entryOf(ih)
  if (!entry) throw new Error('Torrent not found.')
  const t = startTorrent(entry)
  pushTorrents()
  return waitReady(t)
}

async function readFileBytes (file, start = 0, end = file.length - 1) {
  const chunks = []
  for await (const chunk of file.createReadStream({ start, end })) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks)
}

// ---------- subtitles ----------
const embeddedJobs = new Map() // `${ih}:${index}` -> stop()
const castSubs = new Map() // id -> vtt text served to TVs
let osClient = null
let osClientKey = ''

function decodeNamed (buffer, name, encoding) {
  return decodeSubtitle(buffer, { encoding, lang: languageFromName(name) })
}

function stopEmbedded (key) {
  embeddedJobs.get(key)?.()
  embeddedJobs.delete(key)
}

function storedPassword () {
  if (!state.prefs.osPassword) return ''
  try {
    return safeStorage.isEncryptionAvailable()
      ? safeStorage.decryptString(Buffer.from(state.prefs.osPassword, 'base64'))
      : ''
  } catch { return '' }
}

async function openSubtitles () {
  const key = `${state.prefs.osApiKey}|${state.prefs.osUsername}|${state.prefs.osPassword}`
  if (!osClient || key !== osClientKey) {
    osClient = createOpenSubtitles({ apiKey: state.prefs.osApiKey, userAgent: `onlyTorrent v${app.getVersion()}` })
    osClientKey = key
    osClient.loggedIn = false
  }
  if (!osClient.loggedIn && state.prefs.osUsername) {
    osClient.loggedIn = await osClient.login(state.prefs.osUsername, storedPassword())
  }
  return osClient
}

// ---------- casting: TVs fetch the stream over the LAN, so it needs a non-loopback listener ----------
async function ensureLanServer () {
  if (lanServer) return
  lanServer = await listen('0.0.0.0')
  lanPort = lanServer.address().port
}
function closeLanServer () {
  lanServer?.close()
  lanServer = null
}

// ---------- external player ----------
function openExternalPlayer (url) {
  const custom = state.prefs.externalPlayer === 'custom' && state.prefs.externalPlayerPath
  const notFound = custom
    ? `Couldn't start ${path.basename(state.prefs.externalPlayerPath)}. Choose the player again in Preferences.`
    : 'VLC wasn\'t found. Install it from videolan.org, or choose another player in Preferences.'
  return new Promise((resolve, reject) => {
    let cmd, args
    if (custom) {
      const p = state.prefs.externalPlayerPath
      if (isMac && p.endsWith('.app')) { cmd = 'open'; args = ['-a', p, url] } else { cmd = p; args = [url] }
    } else if (isMac) {
      cmd = 'open'; args = ['-a', 'VLC', url]
    } else if (isWin) {
      const candidates = [
        path.join(process.env.ProgramFiles || 'C:\\Program Files', 'VideoLAN', 'VLC', 'vlc.exe'),
        path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'VideoLAN', 'VLC', 'vlc.exe')
      ]
      cmd = candidates.find(c => fs.existsSync(c)) || 'vlc'
      args = [url]
    } else { cmd = 'vlc'; args = [url] }
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' })
    child.once('error', () => reject(new Error(notFound)))
    child.once('spawn', () => { child.unref(); if (cmd !== 'open') resolve() })
    // `open` exits quickly: 0 means the app launched, anything else means it wasn't found
    if (cmd === 'open') child.once('exit', code => code ? reject(new Error(notFound)) : resolve())
  })
}

// ---------- preferences that touch the system ----------
function applyLimits () {
  const bytes = v => (Number(v) > 0 ? Math.round(Number(v) * 1024) : -1)
  client.throttleDownload(bytes(state.prefs.downloadLimit))
  client.throttleUpload(bytes(state.prefs.uploadLimit))
}

function applyTheme () {
  nativeTheme.themeSource = state.prefs.theme
}

function applyLoginItem () {
  if (isLinux) {
    const file = path.join(os.homedir(), '.config', 'autostart', 'onlytorrent.desktop')
    if (state.prefs.openAtLogin) {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, `[Desktop Entry]\nType=Application\nName=onlyTorrent\nExec="${process.execPath}" --hidden\nX-GNOME-Autostart-enabled=true\n`)
    } else fs.rmSync(file, { force: true })
    return
  }
  if (!app.isPackaged) return // registering the dev Electron binary as a login item would be wrong
  app.setLoginItemSettings({ openAtLogin: !!state.prefs.openAtLogin, args: ['--hidden'] })
}

// ---------- tray (Windows/Linux) ----------
function appIcon () {
  const file = path.join(__dirname, 'build', 'icon.png')
  return fs.existsSync(file) ? nativeImage.createFromPath(file) : nativeImage.createEmpty()
}

function createTray () {
  if (isMac || tray) return
  const icon = appIcon()
  tray = new Tray(icon.isEmpty() ? icon : icon.resize({ width: 22, height: 22 }))
  tray.setToolTip('onlyTorrent')
  tray.on('click', showWindow)
  updateTray()
}

let lastTrayKey = ''
function updateTray () {
  if (!tray) return
  const active = [...live.values()].filter(t => t.ready && !t.done).length
  const key = String(active)
  if (key === lastTrayKey) return
  lastTrayKey = key
  tray.setToolTip(active ? `onlyTorrent: ${active} downloading` : 'onlyTorrent')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show onlyTorrent', click: showWindow },
    { type: 'separator' },
    { label: 'Pause all', click: pauseAll },
    { label: 'Resume all', click: resumeAll },
    { type: 'separator' },
    { label: 'Quit', click: () => { app.isQuitting = true; app.quit() } }
  ]))
}

const pauseAll = () => state.torrents.forEach(e => !e.paused && pauseTorrent(e.infoHash))
const resumeAll = () => state.torrents.forEach(e => e.paused && resumeTorrent(e.infoHash))

function showWindow () {
  if (!win) createWindow()
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

// ---------- IPC ----------
function registerIpc () {
  const h = (ch, fn) => ipcMain.handle(ch, async (_e, ...args) => {
    try { return { ok: true, value: await fn(...args) } } catch (err) { return { ok: false, error: err.message } }
  })

  h('torrents:list', () => { pushTorrents(); return null })
  h('torrent:add', id => addTorrent(id))
  h('torrent:addPaths', paths => Promise.all(paths.map(p => addTorrent(p))))
  h('torrent:openDialog', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Open torrent file',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Torrent files', extensions: ['torrent'] }]
    })
    if (r.canceled) return []
    return Promise.all(r.filePaths.map(p => addTorrent(p)))
  })
  h('torrent:pause', ih => pauseTorrent(ih))
  h('torrent:resume', ih => resumeTorrent(ih))
  h('torrent:pauseAll', pauseAll)
  h('torrent:resumeAll', resumeAll)
  h('torrent:remove', (ih, deleteData) => removeTorrent(ih, deleteData))
  h('torrent:selectFile', (ih, index, selected) => setFileSelected(ih, index, selected))
  h('torrent:copyMagnet', ih => {
    const entry = entryOf(ih)
    clipboard.writeText(live.get(ih)?.magnetURI || entry.magnet)
  })
  h('torrent:saveFile', async ih => {
    const entry = entryOf(ih)
    if (!entry?.torrentFile) throw new Error('The .torrent file is available once metadata has downloaded.')
    const r = await dialog.showSaveDialog(win, { defaultPath: `${entry.name || ih}.torrent` })
    if (!r.canceled) fs.copyFileSync(entry.torrentFile, r.filePath)
    return !r.canceled
  })
  h('torrent:showFolder', (ih, index) => {
    const entry = entryOf(ih)
    const f = entry.files[index ?? 0]
    const target = f ? path.join(entry.path, f.path) : entry.path
    if (fs.existsSync(target)) shell.showItemInFolder(target)
    else shell.openPath(entry.path)
  })
  h('torrent:pickShare', async kind => {
    const r = await dialog.showOpenDialog(win, {
      title: kind === 'folder' ? 'Choose a folder to share' : 'Choose a file to share',
      properties: [kind === 'folder' ? 'openDirectory' : 'openFile']
    })
    return r.canceled ? null : r.filePaths[0]
  })
  h('torrent:seedPath', async (p, opts) => {
    if (!p || !fs.existsSync(p)) throw new Error('That file or folder no longer exists.')
    const entry = await seedPath(p, opts)
    clipboard.writeText(entry.magnet)
    return { name: entry.name, magnet: entry.magnet }
  })
  h('torrent:defaultTrackers', () => [
    'udp://tracker.opentrackr.org:1337/announce',
    'udp://open.stealth.si:80/announce',
    'udp://exodus.desync.com:6969/announce',
    'wss://tracker.openwebtorrent.com',
    'wss://tracker.webtorrent.dev'
  ])

  h('media:stream', async (ih, index) => {
    const t = await liveReady(ih)
    const file = t.files[index]
    if (!file) throw new Error('File not found in this torrent.')
    if (entryOf(ih).deselected.includes(index)) setFileSelected(ih, index, true)
    return { url: streamUrl(ih, index, file.name), name: file.name, kind: kindOf(file.name), mime: mimeOf(file.name) }
  })
  h('media:strip', (ih, index, buckets) => {
    const t = live.get(ih)
    const f = t?.ready && t.files[index]
    if (!f) return []
    return strip(t, f._startPiece, f._endPiece, buckets)
  })
  h('subs:encodings', () => ENCODINGS)
  h('media:subtitle', async (ih, index, encoding = 'auto') => {
    const t = await liveReady(ih)
    const file = t.files[index]
    return { name: file.name, ...decodeNamed(await readFileBytes(file), file.name, encoding) }
  })
  h('media:subtitleFromDisk', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Add subtitles',
      properties: ['openFile'],
      filters: [{ name: 'Subtitles', extensions: ['srt', 'vtt', 'ass', 'ssa'] }]
    })
    if (r.canceled) return null
    const p = r.filePaths[0]
    return { name: path.basename(p), path: p, ...decodeNamed(fs.readFileSync(p), p, 'auto') }
  })
  h('media:subtitleFile', (p, encoding = 'auto') => {
    if (!/\.(srt|vtt|ass|ssa)$/i.test(p) || !fs.existsSync(p)) throw new Error('That subtitle file is no longer there.')
    return { name: path.basename(p), path: p, ...decodeNamed(fs.readFileSync(p), p, encoding) }
  })
  h('media:embeddedStart', async (ih, index) => {
    const t = await liveReady(ih)
    const file = t.files[index]
    if (!/\.(mkv|webm)$/i.test(file.name)) return false
    const key = `${ih}:${index}`
    stopEmbedded(key)
    const send = (type, payload) => win && !win.isDestroyed() && win.webContents.send('embedded-subs', { ih, index, type, ...payload })
    embeddedJobs.set(key, extractEmbeddedSubtitles(t, file, {
      onTracks: tracks => send('tracks', { tracks: tracks.map(tr => ({ number: tr.number, language: tr.language || null, name: tr.name || null, type: tr.type })) }),
      onCues: cues => send('cues', { cues: cues.map(c => ({ track: c.track, start: c.start, end: c.end, text: c.text })) }),
      onDone: () => { send('done', {}); embeddedJobs.delete(key) }
    }))
    return true
  })
  h('media:embeddedStop', (ih, index) => stopEmbedded(`${ih}:${index}`))

  h('subs:search', async (ih, index, languages) => {
    const client = await openSubtitles()
    const t = await liveReady(ih)
    const file = t.files[index]
    const CHUNK = 64 * 1024
    let hash = null
    if (file.length >= CHUNK * 2) {
      // a couple of small reads; WebTorrent fetches these pieces first if they're missing
      const [head, tail] = await Promise.all([
        readFileBytes(file, 0, CHUNK - 1),
        readFileBytes(file, file.length - CHUNK, file.length - 1)
      ])
      hash = movieHash(file.length, head, tail)
    }
    const langs = (languages || []).filter(Boolean)
    let results = hash ? await client.search({ hash, languages: langs }) : []
    const query = queryFromFileName(file.name) || queryFromFileName(t.name)
    if (!results.length && query) results = await client.search({ query, languages: langs })
    return { results: results.slice(0, 60), query }
  })
  h('subs:download', async fileId => {
    // keep downloads on disk: reopening the video reuses them without spending another download
    const dir = path.join(app.getPath('userData'), 'subtitles')
    fs.mkdirSync(dir, { recursive: true })
    const existing = fs.readdirSync(dir).find(f => f.startsWith(`${fileId}-`))
    if (existing) return { path: path.join(dir, existing), remaining: null }
    const client = await openSubtitles()
    if (!client.loggedIn) throw new Error('Downloading needs your OpenSubtitles username and password. Add them in Preferences.')
    const item = await client.download(fileId)
    const safe = path.basename(item.name).replace(/[^\w.\- ]+/g, '_').slice(0, 120) || 'subtitles.srt'
    const file = path.join(dir, `${fileId}-${/\.(srt|vtt|ass|ssa)$/i.test(safe) ? safe : safe + '.srt'}`)
    fs.writeFileSync(file, item.buffer)
    return { path: file, remaining: item.remaining ?? null }
  })
  h('subs:credentials', () => ({
    apiKey: state.prefs.osApiKey,
    username: state.prefs.osUsername,
    hasPassword: !!state.prefs.osPassword,
    canEncrypt: safeStorage.isEncryptionAvailable()
  }))
  h('subs:setCredentials', ({ apiKey, username, password }) => {
    if (apiKey !== undefined) state.prefs.osApiKey = String(apiKey).trim()
    if (username !== undefined) state.prefs.osUsername = String(username).trim()
    if (password !== undefined) {
      if (!password) state.prefs.osPassword = ''
      else if (safeStorage.isEncryptionAvailable()) state.prefs.osPassword = safeStorage.encryptString(password).toString('base64')
      else throw new Error('This system can’t store the password securely, so it wasn’t saved.')
    }
    osClient = null
    saveState()
    return true
  })
  h('media:external', async (ih, index) => {
    const t = await liveReady(ih)
    return openExternalPlayer(streamUrl(ih, index, t.files[index].name))
  })
  h('media:metadata', async (ih, index) => {
    const t = await liveReady(ih)
    const meta = await readAudioMetadata(t.files[index])
    if (!meta) return null
    if (meta.picture && !fs.existsSync(posterPath(ih)) && !pickPosterFile(t.files)) savePoster(ih, meta.picture.data)
    return {
      title: meta.title,
      artist: meta.artist,
      album: meta.album,
      picture: meta.picture ? `data:${meta.picture.format};base64,${meta.picture.data.toString('base64')}` : null
    }
  })
  h('media:savePoster', (ih, dataUrl) => {
    const entry = entryOf(ih)
    if (!entry || fs.existsSync(posterPath(ih))) return false
    const t = live.get(ih)
    if (pickPosterFile(t?.files?.length ? t.files : entry.files)) return false // the torrent ships its own
    const m = /^data:image\/\w+;base64,(.+)$/.exec(dataUrl || '')
    if (m) savePoster(ih, Buffer.from(m[1], 'base64'))
    return !!m
  })

  h('player:aspect', ratio => {
    if (!win || win.isFullScreen()) return
    if (!ratio) return win.setAspectRatio(0)
    win.setAspectRatio(ratio)
    // fit the window to the video's shape, keeping it on screen
    const [w] = win.getContentSize()
    const area = screen.getDisplayMatching(win.getBounds()).workArea
    let width = w
    let height = Math.round(width / ratio)
    if (height > area.height - 40) { height = area.height - 40; width = Math.round(height * ratio) }
    win.setContentSize(width, height, true)
  })
  h('player:playing', playing => {
    if (playing && powerBlockId == null) powerBlockId = powerSaveBlocker.start('prevent-display-sleep')
    if (!playing && powerBlockId != null) { powerSaveBlocker.stop(powerBlockId); powerBlockId = null }
  })

  h('cast:list', () => caster.list())
  h('cast:play', async (deviceId, ih, index, startTime, subtitleVtt) => {
    const t = await liveReady(ih)
    const file = t.files[index]
    const host = lanAddress()
    if (!host) throw new Error('Connect to a Wi-Fi or wired network to cast.')
    await ensureLanServer()
    castSubs.clear()
    let subtitlesUrl = null
    if (subtitleVtt) {
      const id = crypto.randomBytes(6).toString('hex')
      castSubs.set(id, subtitleVtt)
      subtitlesUrl = `http://${host}:${lanPort}/${TOKEN}/subs/${id}`
    }
    return caster.play(deviceId, streamUrl(ih, index, file.name, host, lanPort), { title: file.name, mime: mimeOf(file.name), startTime, subtitlesUrl })
  })
  h('cast:status', () => caster.status())
  h('cast:pause', () => caster.pause())
  h('cast:resume', () => caster.resume())
  h('cast:seek', seconds => caster.seek(seconds))
  h('cast:stop', async () => { await caster.stop(); closeLanServer() })

  h('prefs:get', () => state.prefs)
  h('prefs:set', patch => {
    Object.assign(state.prefs, patch)
    if ('downloadLimit' in patch || 'uploadLimit' in patch) applyLimits()
    if ('theme' in patch) applyTheme()
    if ('openAtLogin' in patch) applyLoginItem()
    saveState()
    return state.prefs
  })
  h('prefs:chooseDownloadPath', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'], defaultPath: state.prefs.downloadPath })
    if (r.canceled) return state.prefs
    state.prefs.downloadPath = r.filePaths[0]
    saveState()
    return state.prefs
  })
  h('prefs:chooseExternalPlayer', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Choose a video player',
      defaultPath: isMac ? '/Applications' : undefined,
      properties: ['openFile'],
      filters: isMac ? [{ name: 'Applications', extensions: ['app'] }] : isWin ? [{ name: 'Programs', extensions: ['exe'] }] : []
    })
    if (r.canceled) return state.prefs
    Object.assign(state.prefs, { externalPlayer: 'custom', externalPlayerPath: r.filePaths[0] })
    saveState()
    return state.prefs
  })
  h('prefs:makeDefaultHandler', () => {
    const ok = process.defaultApp
      ? app.setAsDefaultProtocolClient('magnet', process.execPath, [path.resolve(process.argv[1])])
      : app.setAsDefaultProtocolClient('magnet')
    if (!ok) throw new Error('The system didn\'t allow changing the magnet link handler.')
    return true
  })
  h('prefs:isDefaultHandler', () => app.isDefaultProtocolClient('magnet'))
  h('app:openSubtitleSite', () => shell.openExternal('https://www.opensubtitles.com/en/consumers'))
  h('app:info', () => ({ version: app.getVersion(), platform: process.platform, webrtc: !!globalThis.WRTC, tray: !!tray, packaged: app.isPackaged }))
}

// ---------- window + menu ----------
function sendMenu (action) { showWindow(); win?.webContents.send('menu', action) }

function buildMenu () {
  const template = [
    ...(isMac ? [{ role: 'appMenu', submenu: [{ role: 'about' }, { label: 'Check for updates…', click: () => checkForUpdates(true) }, { type: 'separator' }, { label: 'Preferences…', accelerator: 'Cmd+,', click: () => sendMenu('prefs') }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'Add magnet link…', accelerator: 'CmdOrCtrl+U', click: () => sendMenu('add-magnet') },
        { label: 'Open torrent file…', accelerator: 'CmdOrCtrl+O', click: () => sendMenu('open-torrent') },
        { type: 'separator' },
        { label: 'Share files as a torrent…', accelerator: 'CmdOrCtrl+N', click: () => sendMenu('share') },
        { type: 'separator' },
        { label: 'Pause all', click: pauseAll },
        { label: 'Resume all', click: resumeAll },
        ...(isMac
          ? [{ type: 'separator' }, { role: 'close' }]
          : [{ type: 'separator' }, { label: 'Preferences', accelerator: 'Ctrl+,', click: () => sendMenu('prefs') }, { label: 'Check for updates…', click: () => checkForUpdates(true) }, { type: 'separator' }, { label: 'Quit', accelerator: 'Ctrl+Q', click: () => { app.isQuitting = true; app.quit() } }])
      ]
    },
    { role: 'editMenu' },
    { label: 'View', submenu: [{ label: 'Find torrent', accelerator: 'CmdOrCtrl+F', click: () => sendMenu('search') }, { type: 'separator' }, { role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
    { role: 'windowMenu' }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function createWindow () {
  win = new BrowserWindow({
    width: 1080,
    height: 720,
    minWidth: 520,
    minHeight: 360,
    show: !process.argv.includes('--hidden'),
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#141414' : '#FAFAFA',
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
    title: 'onlyTorrent',
    icon: isLinux ? appIcon() : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true
    }
  })
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'))
  win.on('focus', () => { unseenCompletions = 0; updateBadge() })
  win.on('close', e => {
    if (!app.isQuitting && tray && state.prefs.closeToTray) { e.preventDefault(); win.hide() }
  })
  win.on('closed', () => { win = null })
}

// ---------- updates ----------
let updaterWired = false
async function checkForUpdates (manual = false) {
  if (!app.isPackaged) {
    if (manual) dialog.showMessageBox({ message: 'Updates are checked only in the installed app.' })
    return
  }
  // electron-builder writes this file only when a publish target is configured
  if (!fs.existsSync(path.join(process.resourcesPath, 'app-update.yml'))) {
    if (manual) dialog.showMessageBox({ message: 'Automatic updates aren\'t set up for this build.' })
    return
  }
  try {
    const { default: updater } = await import('electron-updater')
    const { autoUpdater } = updater
    if (!updaterWired) {
      updaterWired = true
      autoUpdater.on('update-downloaded', info => {
        toast(`Version ${info.version} is ready. It installs when you quit onlyTorrent.`)
      })
    }
    const result = await autoUpdater.checkForUpdates()
    if (manual && !result?.isUpdateAvailable) dialog.showMessageBox({ message: `You have the latest version (${app.getVersion()}).` })
  } catch (err) {
    // no publish settings yet, offline, or the app isn't signed: updates simply stay off
    if (manual) dialog.showMessageBox({ type: 'warning', message: 'Couldn\'t check for updates.', detail: err.message })
  }
}

// ---------- startup ----------
async function enableWebRtc () {
  // lets this app trade pieces with people streaming in web browsers (WebTorrent's "hybrid" mode)
  try {
    globalThis.WRTC = await import('webrtc-polyfill')
  } catch (err) {
    console.warn('WebRTC peers unavailable:', err.message)
  }
}

app.whenReady().then(async () => {
  STATE_FILE = path.join(app.getPath('userData'), 'state.json')
  TORRENT_DIR = path.join(app.getPath('userData'), 'torrents')
  POSTER_DIR = path.join(app.getPath('userData'), 'posters')
  loadState()
  applyTheme()

  await enableWebRtc()
  client = new WebTorrent()
  client.on('error', err => toast(err.message, 'error'))
  applyLimits()
  caster = createCaster()
  const server = await listen('127.0.0.1')
  localPort = server.address().port

  registerIpc()
  buildMenu()
  createWindow()
  createTray()
  if (state.prefs.openAtLogin) applyLoginItem() // only touch the system setting when the user opted in

  for (const entry of state.torrents) if (!entry.paused) startTorrent(entry)
  ready = true
  pendingOpen.splice(0).forEach(openExternalId)

  setInterval(tick, 1000)
  setInterval(saveState, 10000)
  setTimeout(() => checkForUpdates(false), 10000)

  app.on('activate', showWindow)
})

app.on('window-all-closed', () => { if (!isMac && !tray) app.quit() })

let quitting = false
app.on('before-quit', e => {
  app.isQuitting = true
  if (quitting || !client) return
  e.preventDefault()
  quitting = true
  saveStateNow()
  if (powerBlockId != null) powerSaveBlocker.stop(powerBlockId)
  caster?.stop().catch(() => {})
  caster?.destroy()
  client.destroy(() => app.quit())
  setTimeout(() => app.exit(0), 3000)
})
