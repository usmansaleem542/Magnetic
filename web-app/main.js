import {
  app, BrowserWindow, ipcMain, dialog, shell, Menu, clipboard, Notification,
  powerSaveBlocker, Tray, nativeImage, nativeTheme, screen, safeStorage
} from 'electron'
import WebTorrent from 'webtorrent'
import parseTorrent, { toMagnetURI } from 'parse-torrent'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { kindOf, mimeOf, parseRange, pickPosterFile, stripFromBitfield, isPaddingFile, bytesNeeded } from './lib/media.js'
import { searchArchive, archiveDeselect } from './lib/archive.js'
import { Client as TrackerClient } from 'bittorrent-tracker'
import ffmpegStatic from 'ffmpeg-static'
import { probeMedia, findKeyframe, transcodeArgs, needsAudioConversion } from './lib/transcode.js'

// Chromium hides a video's audio tracks unless this is on; we need it to switch languages
app.commandLine.appendSwitch('enable-blink-features', 'AudioVideoTracks')
import { DEFAULT_TRACKERS, planTrackers, parseTrackerList, mergeTrackers, normaliseTracker, trackerKey, instrumentTrackers, isDead } from './lib/trackers.js'
import { createCaster, lanAddress } from './lib/cast.js'
import { decodeSubtitle, ENCODINGS } from './lib/subtitle-decode.js'
import { createClient as createOpenSubtitles, movieHash, queryFromFileName } from './lib/opensubtitles.js'
import { extractEmbeddedSubtitles } from './lib/embedded-subs.js'
import { languageFromName } from './renderer/subtitles.js'
import { t, ltr, setLanguage, getLanguage, resolveLanguage } from './renderer/i18n.js'
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
const trackerRuntime = new Map() // infoHash -> { status: Map(url -> info), extra: TrackerClient, key }
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
  language: 'system', // system | en | ar
  externalPlayer: 'builtin', // builtin | vlc | custom
  externalPlayerPath: '',
  downloadLimit: 0, // KB/s, 0 = unlimited
  uploadLimit: 0,
  allowUploads: false, // off: nobody can download anything from this computer
  seedRatioLimit: 0, // 0 = seed forever
  openAtLogin: false,
  closeToTray: !isMac,
  osApiKey: '',
  osUsername: '',
  osPassword: '', // encrypted with the OS keychain via safeStorage, base64
  trackers: [...DEFAULT_TRACKERS], // added to downloads (if enabled) and used for new shares
  trackersForDownloads: true,
  maxActiveDownloads: 0, // 0 = no limit; the rest wait in a queue
  pauseOthersWhileWatching: true // give the torrent being watched all the bandwidth
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
    if (!res.ok) throw new Error(t("Couldn't download the .torrent file (HTTP {status}).", { status: res.status }))
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
    throw new Error(t("That isn't a valid magnet link, info hash or .torrent file."))
  }
  const infoHash = parsed.infoHash
  let entry = entryOf(infoHash)
  if (entry) {
    if (entry.paused) resumeTorrent(infoHash)
    toast(t('{name} is already in your list.', { name: entry.name || t('This torrent') }))
    return infoHash
  }
  let savePath = opts.path
  if (!savePath && state.prefs.askSavePath) {
    savePath = await askSavePath(parsed.name)
    if (!savePath) return null // the person cancelled
    if (entryOf(infoHash)) return infoHash // added again while the dialog was open
  }
  entry = {
    infoHash,
    magnet: typeof id === 'string' ? id : toMagnetURI(parsed),
    torrentFile: null,
    name: parsed.name || '',
    path: savePath || state.prefs.downloadPath,
    paused: false,
    deselected: opts.pickBest && parsed.files ? archiveDeselect(parsed.files) : [],
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
  if (parsed.files?.length) { entry.spaceChecked = true; checkSpace(entry, parsed.files) }
  schedule(entry.infoHash)
  saveState()
  return infoHash
}

async function askSavePath (name) {
  const r = await dialog.showOpenDialog(win, {
    title: name ? t('Save “{name}” to…', { name }) : t('Save torrent to…'),
    buttonLabel: t('Save here'),
    defaultPath: state.prefs.lastSavePath || state.prefs.downloadPath,
    properties: ['openDirectory', 'createDirectory']
  })
  if (r.canceled || !r.filePaths[0]) return null
  state.prefs.lastSavePath = r.filePaths[0]
  return r.filePaths[0]
}

// one at a time, so "ask where to save" never stacks dialogs
async function addEach (ids, opts) {
  const out = []
  for (const id of ids) out.push(await addTorrent(id, opts))
  return out
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

function wireTorrent (entry, tor) {
  // Uploads off: never "unchoke" a peer, which is how BitTorrent agrees to send data.
  // Requests from choked peers are refused by the protocol, and our own downloads are
  // unaffected. (Throttling uploads to 0 would also stall our own piece requests.)
  tor.on('wire', wire => {
    const unchoke = wire.unchoke.bind(wire)
    wire.unchoke = () => { if (state.prefs.allowUploads) unchoke() }
  })
  // fires after WebTorrent has merged the announce list, before it starts announcing
  tor.once('infoHash', () => {
    entry.ownTrackers = mergeTrackers(tor.announce)
    tor.announce = planFor(entry, tor).own
    const startDiscovery = tor._startDiscovery.bind(tor)
    tor._startDiscovery = () => {
      startDiscovery()
      instrumentTrackers(tor.discovery?.tracker, runtimeOf(entry.infoHash).status)
    }
    syncExtraTrackers(entry, tor)
  })
  tor.once('close', () => {
    const rt = trackerRuntime.get(entry.infoHash)
    if (rt?.extra) { rt.extra.destroy(); rt.extra = null; rt.key = '' }
    rt?.status.clear()
  })
  tor.on('ready', () => {
    // keep a .torrent copy so restarts don't need to fetch metadata again
    if (!entry.torrentFile && tor.torrentFile) {
      entry.torrentFile = path.join(TORRENT_DIR, `${entry.infoHash}.torrent`)
      fs.mkdirSync(TORRENT_DIR, { recursive: true })
      fs.writeFileSync(entry.torrentFile, tor.torrentFile)
    }
    applySelection(entry, tor)
    if (!entry.spaceChecked) { entry.spaceChecked = true; checkSpace(entry, tor.files) }
    const poster = pickPosterFile(tor.files)
    if (poster) poster.select() // small, and it makes the list look right sooner
    else extractAlbumArt(entry, tor)
    captureProgress(entry)
    saveState()
    pushTorrents()
  })
  tor.on('done', () => {
    captureProgress(entry)
    saveState()
    setImmediate(schedule) // a download slot is free
    if (entry.notified) return
    entry.notified = true
    if (state.prefs.notifyOnComplete && Notification.isSupported()) {
      new Notification({ title: t('Download complete'), body: tor.name }).show()
    }
    if (isMac) app.dock?.bounce('informational')
    if (win && !win.isFocused()) { unseenCompletions++; updateBadge() }
  })
  tor.on('error', err => {
    live.delete(entry.infoHash)
    entry.paused = true
    const full = err.code === 'ENOSPC' || /ENOSPC|no space left/i.test(err.message)
    toast(full ? t('{name} stopped: the drive is full. Free up space, then resume it.', { name: entry.name || t('A torrent') }) : `${entry.name || t('Torrent')}: ${err.message}`, 'error')
    saveState()
  })
}

// ---------- trackers ----------
function runtimeOf (ih) {
  if (!trackerRuntime.has(ih)) trackerRuntime.set(ih, { status: new Map(), extra: null, key: '' })
  return trackerRuntime.get(ih)
}

function planFor (entry, t) {
  return planTrackers({
    own: entry.ownTrackers || t?.announce || [],
    added: entry.addedTrackers || [],
    removed: entry.removedTrackers || [],
    global: state.prefs.trackers || [],
    useGlobal: state.prefs.trackersForDownloads !== false,
    isPrivate: !!t?.private
  })
}

/** Run (or rebuild) the second tracker client that announces to the trackers we add. */
function syncExtraTrackers (entry, t) {
  if (!t || t.destroyed || !t.infoHash) return
  const rt = runtimeOf(entry.infoHash)
  const { extra } = planFor(entry, t)
  const key = extra.join('\n')
  if (key === rt.key) return
  if (rt.extra) { rt.extra.destroy(); rt.extra = null }
  for (const url of rt.status.keys()) if (!extra.includes(url) && !(t.announce || []).includes(url)) rt.status.delete(url)
  rt.key = key
  if (!extra.length) return
  const tc = new TrackerClient({
    infoHash: t.infoHash,
    peerId: client.peerId,
    announce: extra,
    port: client.torrentPort,
    wrtc: client.tracker?.wrtc,
    getAnnounceOpts: () => ({
      uploaded: t.uploaded || 0,
      downloaded: t.downloaded || 0,
      left: t.length ? Math.max(t.length - t.downloaded, 0) : 1
    })
  })
  tc.on('peer', peer => { if (!t.destroyed) { try { t.addPeer(peer, 'tracker') } catch {} } })
  tc.on('warning', () => {}) // recorded per tracker by instrumentTrackers
  tc.on('error', () => {})
  instrumentTrackers(tc, rt.status)
  tc.start()
  rt.extra = tc
}

/** Stop announcing to some of the torrent's own trackers without restarting it. */
function dropOwnTrackers (t, urls) {
  if (!t) return
  const gone = new Set(urls.map(trackerKey))
  t.announce = (t.announce || []).filter(u => !gone.has(trackerKey(u)))
  const tc = t.discovery?.tracker
  if (!tc?._trackers) return
  tc._trackers = tc._trackers.filter(tr => {
    if (!gone.has(trackerKey(tr.announceUrl))) return true
    try { tr.destroy() } catch {}
    return false
  })
}

function trackerList (ih) {
  const entry = entryOf(ih)
  if (!entry) throw new Error(t('That torrent is no longer in your list.'))
  const tor = live.get(ih)
  const rt = runtimeOf(ih)
  if (tor) instrumentTrackers(tor.discovery?.tracker, rt.status)
  const plan = planFor(entry, tor)
  const added = new Set((entry.addedTrackers || []).map(normaliseTracker))
  const fromTorrent = new Set(entry.ownTrackers || [])
  const running = new Set(tor?.discovery?.tracker?._trackers?.map(tr => normaliseTracker(tr.announceUrl)) || [])
  const row = url => {
    const info = rt.status.get(url)
    let st = info || { state: tor ? 'checking' : 'paused' }
    if (!tor) st = { state: 'paused' }
    // the tracker client skips addresses it can't use (bad port, unknown protocol)
    else if (fromTorrent.has(url) && tor.discovery?.tracker && !running.has(url)) st = { state: 'invalid', message: t('Unsupported address') }
    return {
      url,
      source: fromTorrent.has(url) ? 'torrent' : added.has(url) ? 'added' : 'preferences',
      ...st
    }
  }
  return {
    private: !!tor?.private,
    paused: !tor,
    trackers: [...plan.own, ...plan.extra].map(row)
  }
}

function addTrackersTo (ih, text) {
  const entry = entryOf(ih)
  if (!entry) throw new Error(t('That torrent is no longer in your list.'))
  const { valid, invalid } = parseTrackerList(text)
  entry.addedTrackers = mergeTrackers(entry.addedTrackers, valid)
  const addedKeys = new Set(valid.map(trackerKey))
  entry.removedTrackers = (entry.removedTrackers || []).filter(u => !addedKeys.has(trackerKey(u)))
  syncExtraTrackers(entry, live.get(ih))
  saveState()
  return { added: valid.length, invalid }
}

function removeTrackersFrom (ih, urls) {
  const entry = entryOf(ih)
  if (!entry) throw new Error(t('That torrent is no longer in your list.'))
  const list = urls.map(normaliseTracker)
  entry.removedTrackers = mergeTrackers(entry.removedTrackers, list)
  const keys = new Set(list.map(trackerKey))
  entry.addedTrackers = (entry.addedTrackers || []).filter(u => !keys.has(trackerKey(u)))
  const tor = live.get(ih)
  dropOwnTrackers(tor, list)
  syncExtraTrackers(entry, tor)
  const rt = runtimeOf(ih)
  for (const u of list) rt.status.delete(u)
  saveState()
  return list.length
}

function removeDeadTrackers (ih) {
  const dead = trackerList(ih).trackers.filter(isDead).map(r => r.url)
  return dead.length ? removeTrackersFrom(ih, dead) : 0
}

function resyncAllTrackers () {
  for (const entry of state.torrents) syncExtraTrackers(entry, live.get(entry.infoHash))
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

function stopTorrent (entry) {
  const t = live.get(entry.infoHash)
  if (!t) return
  captureProgress(entry)
  live.delete(entry.infoHash)
  client.remove(t, { destroyStore: false }).catch(() => {})
}

function pauseTorrent (ih) {
  const entry = entryOf(ih)
  if (!entry) return
  entry.paused = true
  entry.queued = null
  stopTorrent(entry)
  schedule() // frees a download slot
  saveState()
}

function resumeTorrent (ih) {
  const entry = entryOf(ih)
  if (!entry) return
  entry.paused = false
  schedule(ih)
  saveState()
}

// ---------- disk space ----------
const LOW_SPACE = 1024 ** 3 // below 1 GB free, downloads pause before the drive fills up
const gb = n => ltr(n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : `${Math.round(n / 1024 ** 2)} MB`)

/** Free bytes on the drive holding `dir` (or its nearest existing parent), or null. */
function freeBytes (dir) {
  let d = path.resolve(dir)
  while (!fs.existsSync(d) && path.dirname(d) !== d) d = path.dirname(d)
  try {
    const st = fs.statfsSync(d)
    return st.bavail * st.bsize
  } catch {
    return null
  }
}

/** Warn when a torrent won't fit. Called when its size becomes known. */
function checkSpace (entry, files) {
  const need = bytesNeeded(files, entry.deselected)
  const free = freeBytes(entry.path)
  if (free == null || need <= free) return true
  toast(t('{name} needs {need}, but only {free} is free on that drive. Free up space, or untick some files under ⋯ → Choose files.', { name: entry.name || t('This torrent'), need: gb(need), free: gb(free) }), 'error')
  return false
}

let lowSpaceWarned = false
function guardDiskSpace () {
  const downloading = state.torrents.filter(e => live.has(e.infoHash) && !isComplete(e))
  if (!downloading.length) { lowSpaceWarned = false; return }
  const paths = [...new Set(downloading.map(e => e.path))]
  for (const dir of paths) {
    const free = freeBytes(dir)
    if (free == null || free >= LOW_SPACE) continue
    for (const e of downloading) if (e.path === dir) pauseTorrent(e.infoHash)
    if (!lowSpaceWarned) toast(t('Downloads paused: only {free} is left on the drive. Free up space, then resume them.', { free: gb(free) }), 'error')
    lowSpaceWarned = true
    return
  }
  lowSpaceWarned = false
}

// ---------- queue: which torrents run ----------
// Torrents the person hasn't paused run unless (a) the download limit is reached, oldest
// first, or (b) they're watching another torrent that's still downloading and asked for
// other downloads to wait. Finished torrents keep seeding either way.
let watching = null // infoHash open in the player
const isComplete = entry => {
  const t = live.get(entry.infoHash)
  return t ? !!t.done : entry.length > 0 && entry.progress >= 1
}

function schedule (forceIh = null) {
  if (!client) return
  const limit = Math.floor(Number(state.prefs.maxActiveDownloads)) || 0
  const watched = watching && entryOf(watching)
  const holding = !!watched && !watched.paused && !isComplete(watched) && state.prefs.pauseOthersWhileWatching !== false
  const allowed = new Set()
  let slots = limit > 0 ? limit : Infinity
  if (watched && !watched.paused) { allowed.add(watched.infoHash); slots-- }
  if (!holding) {
    // running downloads keep their slot; free slots go to the oldest waiting torrent
    const waiting = state.torrents.filter(e => !e.paused && !isComplete(e) && !allowed.has(e.infoHash))
      .sort((a, b) => Number(live.has(b.infoHash)) - Number(live.has(a.infoHash)) || (a.addedAt || 0) - (b.addedAt || 0))
    for (const e of waiting) if (slots-- > 0) allowed.add(e.infoHash)
  }
  for (const e of state.torrents) {
    if (e.paused) { e.queued = null; continue }
    // with uploads off, finished torrents have nothing to do online unless they're playing
    const run = allowed.has(e.infoHash) || (isComplete(e) && state.prefs.allowUploads)
    if (!run && isComplete(e)) { e.queued = null; stopTorrent(e); continue }
    if (run) {
      e.queued = null
      if (!live.has(e.infoHash)) startTorrent(e)
    } else {
      e.queued = holding ? 'watching' : 'limit'
      stopTorrent(e)
    }
  }
  if (forceIh && entryOf(forceIh)?.queued === 'limit') {
    toast(t('{name} is queued. It starts when another download finishes.', { name: entryOf(forceIh).name || t('This torrent') }))
  }
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
  if (watching === ih) watching = null
  saveState()
  schedule() // frees a download slot
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
    const seeding = client.seed(input, seedOpts, torrent => {
      if (entryOf(torrent.infoHash)) {
        toast(t('{name} is already in your list.', { name: torrent.name }))
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
    seeding.once('error', reject)
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
    kind: isPaddingFile(f.path) ? 'padding' : kindOf(f.name)
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
    const status = entry.paused ? 'paused' : isComplete(entry) ? 'done' : entry.queued ? 'queued' : 'paused'
    return { ...base, status, queueReason: entry.queued || null, progress: entry.progress || 0, downloadSpeed: 0, uploadSpeed: 0, numPeers: 0, timeRemaining: Infinity, pieces: [] }
  }
  const status = !t.ready ? 'metadata' : t.done ? (state.prefs.allowUploads ? 'seeding' : 'done') : 'downloading'
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

let lastSpaceCheck = 0
function tick () {
  if (Date.now() - lastSpaceCheck > 10000) { lastSpaceCheck = Date.now(); guardDiskSpace() }
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

  if (parts[1] === 'tx' && /^[a-f0-9]{40}$/.test(parts[2] || '') && /^\d+$/.test(parts[3] || '')) {
    return sendConverted(req, res, parts[2], Number(parts[3]), Number(url.searchParams.get('start')) || 0, Number(url.searchParams.get('audio')) || 0)
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

// ---------- audio conversion (AC3, DTS…) ----------
// The bundled ffmpeg sits inside node_modules; packaged builds unpack it next to app.asar.
const ffmpegPath = () => state.prefs.ffmpegPath || (ffmpegStatic ? ffmpegStatic.replace('app.asar', 'app.asar.unpacked') : null)
const probes = new Map() // "ih:index" -> Promise<probe>
const converting = new Set() // running ffmpeg processes

function probeFile (ih, index) {
  const key = `${ih}:${index}`
  if (!probes.has(key)) {
    const file = live.get(ih)?.files[index]
    if (!file) throw new Error(t('File not found in this torrent.'))
    const p = probeMedia(ffmpegPath(), streamUrl(ih, index, file.name)).then(info => ({
      ...info,
      convertAudio: info.audio.some(a => needsAudioConversion(a.codec)),
      audio: info.audio.map(a => ({ ...a, needsConversion: needsAudioConversion(a.codec) }))
    }))
    p.catch(() => probes.delete(key)) // try again next time
    probes.set(key, p)
  }
  return probes.get(key)
}

function sendConverted (req, res, ih, index, start, audio) {
  const t = live.get(ih)
  const file = t?.ready && t.files[index]
  const bin = ffmpegPath()
  if (!file || !bin) { res.statusCode = 404; return res.end() }
  Promise.resolve(probes.get(`${ih}:${index}`)).then(info => run(info?.video?.codec || ''), () => run(''))
  function run (videoCodec) {
    if (res.destroyed) return
    const ff = spawn(bin, transcodeArgs({ input: streamUrl(ih, index, file.name), start, audio, videoCodec }), { windowsHide: true })
    converting.add(ff)
    ff.on('close', () => converting.delete(ff))
    ff.on('error', () => { if (!res.headersSent) { res.statusCode = 500; res.end() } })
    ff.stderr.on('data', d => console.error('[ffmpeg]', String(d).trim()))
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Cache-Control': 'no-store' })
    ff.stdout.pipe(res)
    // the player dropped this stream (seek, new file, closed): stop converting
    res.on('close', () => ff.kill('SIGKILL'))
  }
}

async function liveReady (ih) {
  const entry = entryOf(ih)
  if (!entry) throw new Error(t('Torrent not found.'))
  const tor = startTorrent(entry)
  pushTorrents()
  return waitReady(tor)
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
    osClient = createOpenSubtitles({ apiKey: state.prefs.osApiKey, userAgent: `Magnetic v${app.getVersion()}` })
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
    ? t("Couldn't start {app}. Choose the player again in Preferences.", { app: path.basename(state.prefs.externalPlayerPath) })
    : t("VLC wasn't found. Install it from videolan.org, or choose another player in Preferences.")
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

function applyUploadPolicy () {
  if (state.prefs.allowUploads) return // WebTorrent's regular rechoke unchokes peers within seconds
  for (const tor of live.values()) for (const wire of tor.wires || []) wire.choke()
}

function applyTheme () {
  nativeTheme.themeSource = state.prefs.theme
}

function applyLanguage () {
  setLanguage(resolveLanguage(state.prefs.language, app.getLocale()))
}

function applyLoginItem () {
  if (isLinux) {
    const file = path.join(os.homedir(), '.config', 'autostart', 'magnetic.desktop')
    if (state.prefs.openAtLogin) {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, `[Desktop Entry]\nType=Application\nName=Magnetic\nExec="${process.execPath}" --hidden\nX-GNOME-Autostart-enabled=true\n`)
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
  tray.setToolTip('Magnetic')
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
  tray.setToolTip(active ? t('Magnetic: {n} downloading', { n: active }) : 'Magnetic')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: t('Show Magnetic'), click: showWindow },
    { type: 'separator' },
    { label: t('Pause all'), click: pauseAll },
    { label: t('Resume all'), click: resumeAll },
    { type: 'separator' },
    { label: t('Quit'), click: () => { app.isQuitting = true; app.quit() } }
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
    // messages from lib/ are English; known ones are translated here (t() leaves the rest as is)
    try { return { ok: true, value: await fn(...args) } } catch (err) { return { ok: false, error: t(err.message) } }
  })

  h('torrents:list', () => { pushTorrents(); return null })
  h('app:language', () => getLanguage())
  h('torrent:add', id => addTorrent(id))
  h('discover:search', opts => searchArchive(opts, { userAgent: `Magnetic/${app.getVersion()}` }))
  h('discover:openPage', url => {
    if (!/^https:\/\/archive\.org\/details\/[^/?#]+$/.test(String(url))) throw new Error(t('That isn’t an Internet Archive page.'))
    return shell.openExternal(url)
  })
  h('discover:add', url => {
    // only archive.org torrents come through here; they get the duplicate-copy filter
    if (!/^https:\/\/archive\.org\/download\/[^/]+\/[^/]+_archive\.torrent$/.test(String(url))) throw new Error(t('That isn’t an Internet Archive torrent.'))
    return addTorrent(url, { pickBest: true })
  })
  h('torrent:addPaths', paths => addEach(paths))
  h('torrent:openDialog', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: t('Open torrent file'),
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: t('Torrent files'), extensions: ['torrent'] }]
    })
    if (r.canceled) return []
    return addEach(r.filePaths)
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
    if (!entry?.torrentFile) throw new Error(t('The .torrent file is available once metadata has downloaded.'))
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
      title: kind === 'folder' ? t('Choose a folder to share') : t('Choose a file to share'),
      properties: [kind === 'folder' ? 'openDirectory' : 'openFile']
    })
    return r.canceled ? null : r.filePaths[0]
  })
  h('torrent:seedPath', async (p, opts) => {
    if (!p || !fs.existsSync(p)) throw new Error(t('That file or folder no longer exists.'))
    const entry = await seedPath(p, opts)
    clipboard.writeText(entry.magnet)
    return { name: entry.name, magnet: entry.magnet }
  })
  h('torrent:defaultTrackers', () => state.prefs.trackers?.length ? state.prefs.trackers : DEFAULT_TRACKERS)
  h('trackers:list', ih => trackerList(ih))
  h('trackers:add', (ih, text) => addTrackersTo(ih, text))
  h('trackers:remove', (ih, urls) => removeTrackersFrom(ih, urls))
  h('trackers:removeDead', ih => removeDeadTrackers(ih))
  h('trackers:defaults', () => DEFAULT_TRACKERS)
  h('prefs:setTrackers', text => {
    const { valid, invalid } = parseTrackerList(text)
    state.prefs.trackers = valid
    resyncAllTrackers()
    saveState()
    return { trackers: valid, invalid }
  })
  h('media:stream', async (ih, index) => {
    const tor = await liveReady(ih)
    const file = tor.files[index]
    if (!file) throw new Error(t('File not found in this torrent.'))
    if (entryOf(ih).deselected.includes(index)) setFileSelected(ih, index, true)
    return { url: streamUrl(ih, index, file.name), name: file.name, kind: kindOf(file.name), mime: mimeOf(file.name) }
  })
  h('media:probe', async (ih, index) => {
    await liveReady(ih)
    if (!ffmpegPath()) return null
    return probeFile(ih, index)
  })
  h('media:converted', async (ih, index, start = 0, audio = 0) => {
    const tor = await liveReady(ih)
    const file = tor.files[index]
    if (!file) throw new Error(t('File not found in this torrent.'))
    // ask ffmpeg which keyframe it will start from, so the player's clock matches
    const offset = await findKeyframe(ffmpegPath(), streamUrl(ih, index, file.name), start).catch(() => start)
    return { url: `http://127.0.0.1:${localPort}/${TOKEN}/tx/${ih}/${index}?start=${offset > 0 ? start : 0}&audio=${audio}`, offset }
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
      title: t('Add subtitles'),
      properties: ['openFile'],
      filters: [{ name: t('Subtitles'), extensions: ['srt', 'vtt', 'ass', 'ssa'] }]
    })
    if (r.canceled) return null
    const p = r.filePaths[0]
    return { name: path.basename(p), path: p, ...decodeNamed(fs.readFileSync(p), p, 'auto') }
  })
  h('media:subtitleFile', (p, encoding = 'auto') => {
    if (!/\.(srt|vtt|ass|ssa)$/i.test(p) || !fs.existsSync(p)) throw new Error(t('That subtitle file is no longer there.'))
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
    if (!client.loggedIn) throw new Error(t('Downloading needs your OpenSubtitles username and password. Add them in Preferences.'))
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
      else throw new Error(t('This system can’t store the password securely, so it wasn’t saved.'))
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
  h('player:watching', ih => {
    watching = ih && entryOf(ih) ? ih : null
    schedule()
  })
  h('player:playing', playing => {
    if (playing && powerBlockId == null) powerBlockId = powerSaveBlocker.start('prevent-display-sleep')
    if (!playing && powerBlockId != null) { powerSaveBlocker.stop(powerBlockId); powerBlockId = null }
  })

  h('cast:list', () => caster.list())
  h('cast:play', async (deviceId, ih, index, startTime, subtitleVtt) => {
    const tor = await liveReady(ih)
    const file = tor.files[index]
    const host = lanAddress()
    if (!host) throw new Error(t('Connect to a Wi-Fi or wired network to cast.'))
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
  h('disk:free', dir => freeBytes(dir || state.prefs.downloadPath))
  h('prefs:set', patch => {
    Object.assign(state.prefs, patch)
    if ('downloadLimit' in patch || 'uploadLimit' in patch) applyLimits()
    if ('theme' in patch) applyTheme()
    if ('language' in patch) { applyLanguage(); buildMenu(); lastTrayKey = ''; updateTray() } // the renderer reloads itself
    if ('openAtLogin' in patch) applyLoginItem()
    if ('trackersForDownloads' in patch) resyncAllTrackers()
    if ('allowUploads' in patch) applyUploadPolicy()
    if ('maxActiveDownloads' in patch || 'pauseOthersWhileWatching' in patch || 'allowUploads' in patch) schedule()
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
      title: t('Choose a video player'),
      defaultPath: isMac ? '/Applications' : undefined,
      properties: ['openFile'],
      filters: isMac ? [{ name: t('Applications'), extensions: ['app'] }] : isWin ? [{ name: t('Programs'), extensions: ['exe'] }] : []
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
    if (!ok) throw new Error(t("The system didn't allow changing the magnet link handler."))
    return true
  })
  h('prefs:isDefaultHandler', () => app.isDefaultProtocolClient('magnet'))
  h('app:openSubtitleSite', () => shell.openExternal('https://www.opensubtitles.com/en/consumers'))
  h('app:info', () => ({ version: app.getVersion(), platform: process.platform, webrtc: !!globalThis.WRTC, tray: !!tray, packaged: app.isPackaged }))
}

// ---------- window + menu ----------
function sendMenu (action) { showWindow(); win?.webContents.send('menu', action) }

function buildMenu () {
  // role items get explicit labels: Electron's own role labels are English only
  const quit = { label: isMac ? t('Quit Magnetic') : t('Quit'), accelerator: isMac ? 'Cmd+Q' : 'Ctrl+Q', click: () => { app.isQuitting = true; app.quit() } }
  const template = [
    ...(isMac ? [{ role: 'appMenu', submenu: [{ role: 'about', label: t('About Magnetic') }, { label: t('Check for updates…'), click: () => checkForUpdates(true) }, { type: 'separator' }, { label: t('Preferences…'), accelerator: 'Cmd+,', click: () => sendMenu('prefs') }, { type: 'separator' }, { role: 'hide', label: t('Hide Magnetic') }, { role: 'hideOthers', label: t('Hide Others') }, { role: 'unhide', label: t('Show All') }, { type: 'separator' }, { ...quit, role: 'quit' }] }] : []),
    {
      label: t('File'),
      submenu: [
        { label: t('Add magnet link…'), accelerator: 'CmdOrCtrl+U', click: () => sendMenu('add-magnet') },
        { label: t('Open torrent file…'), accelerator: 'CmdOrCtrl+O', click: () => sendMenu('open-torrent') },
        { type: 'separator' },
        { label: t('Share files as a torrent…'), accelerator: 'CmdOrCtrl+N', click: () => sendMenu('share') },
        { type: 'separator' },
        { label: t('Pause all'), click: pauseAll },
        { label: t('Resume all'), click: resumeAll },
        ...(isMac
          ? [{ type: 'separator' }, { role: 'close', label: t('Close Window') }]
          : [{ type: 'separator' }, { label: t('Preferences'), accelerator: 'Ctrl+,', click: () => sendMenu('prefs') }, { label: t('Check for updates…'), click: () => checkForUpdates(true) }, { type: 'separator' }, quit])
      ]
    },
    {
      label: t('Edit'),
      submenu: [
        { role: 'undo', label: t('Undo') }, { role: 'redo', label: t('Redo') }, { type: 'separator' },
        { role: 'cut', label: t('Cut') }, { role: 'copy', label: t('Copy') }, { role: 'paste', label: t('Paste') },
        ...(isMac ? [{ role: 'pasteAndMatchStyle', label: t('Paste and Match Style') }] : []),
        { role: 'delete', label: t('Delete') }, { role: 'selectAll', label: t('Select All') }
      ]
    },
    { label: t('View'), submenu: [{ label: t('Find torrent'), accelerator: 'CmdOrCtrl+F', click: () => sendMenu('search') }, { type: 'separator' }, { role: 'reload', label: t('Reload') }, { role: 'toggleDevTools', label: t('Toggle Developer Tools') }, { type: 'separator' }, { role: 'togglefullscreen', label: t('Toggle Full Screen') }] },
    {
      role: 'windowMenu',
      label: t('Window'),
      submenu: [
        { role: 'minimize', label: t('Minimize') },
        ...(isMac ? [{ role: 'zoom', label: t('Zoom') }, { type: 'separator' }, { role: 'front', label: t('Bring All to Front') }] : [{ role: 'close', label: t('Close') }])
      ]
    }
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
    title: 'Magnetic',
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
    if (manual) dialog.showMessageBox({ message: t('Updates are checked only in the installed app.') })
    return
  }
  // electron-builder writes this file only when a publish target is configured
  if (!fs.existsSync(path.join(process.resourcesPath, 'app-update.yml'))) {
    if (manual) dialog.showMessageBox({ message: t("Automatic updates aren't set up for this build.") })
    return
  }
  try {
    const { default: updater } = await import('electron-updater')
    const { autoUpdater } = updater
    if (!updaterWired) {
      updaterWired = true
      autoUpdater.on('update-downloaded', info => {
        toast(t('Version {version} is ready. It installs when you quit Magnetic.', { version: info.version }))
      })
    }
    const result = await autoUpdater.checkForUpdates()
    if (manual && !result?.isUpdateAvailable) dialog.showMessageBox({ message: t('You have the latest version ({version}).', { version: app.getVersion() }) })
  } catch (err) {
    // no publish settings yet, offline, or the app isn't signed: updates simply stay off
    if (manual) dialog.showMessageBox({ type: 'warning', message: t("Couldn't check for updates."), detail: err.message })
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

// The app was called onlyTorrent before it became Magnetic. Electron names the data
// folder after the app, so copy the old one across once (and leave it in place).
function migrateOldData () {
  const appData = app.getPath('appData')
  const current = app.getPath('userData')
  if (current !== path.join(appData, app.getName())) return // a test or custom profile
  const old = path.join(appData, 'onlyTorrent')
  if (old === current || fs.existsSync(path.join(current, 'state.json')) || !fs.existsSync(path.join(old, 'state.json'))) return
  try {
    fs.cpSync(old, current, { recursive: true, errorOnExist: false })
    const statePath = path.join(current, 'state.json')
    // saved .torrent copies are referenced by absolute path
    fs.writeFileSync(statePath, fs.readFileSync(statePath, 'utf8').split(JSON.stringify(old).slice(1, -1)).join(JSON.stringify(current).slice(1, -1)))
  } catch (err) {
    console.error('Couldn’t copy settings from onlyTorrent:', err.message)
  }
}

app.on('will-quit', () => { for (const ff of converting) ff.kill('SIGKILL') })

app.whenReady().then(async () => {
  migrateOldData()
  STATE_FILE = path.join(app.getPath('userData'), 'state.json')
  TORRENT_DIR = path.join(app.getPath('userData'), 'torrents')
  POSTER_DIR = path.join(app.getPath('userData'), 'posters')
  loadState()
  applyTheme()
  applyLanguage()

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

  schedule()
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
