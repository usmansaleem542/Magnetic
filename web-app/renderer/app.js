import { MARK } from './mark.js'
import { parseSubtitles, cleanCueText, assTextToCue, cuesToVtt, languageFromName, languageName, normaliseLang } from './subtitles.js'
import { t, tHtml, setLanguage, getLanguage, isRtl, translateDom, ltr } from './i18n.js'

const api = window.api
document.documentElement.classList.add(`platform-${api.platform}`)

// language first: the page stays hidden (see .i18n-ready in styles.css) until it's translated
setLanguage(await api.call('app:language').catch(() => 'en'))
document.documentElement.lang = getLanguage()
document.documentElement.dir = isRtl() ? 'rtl' : 'ltr'
translateDom(document.body)
document.documentElement.classList.add('i18n-ready')

const $ = sel => document.querySelector(sel)
const store = {
  get (k) { try { return JSON.parse(localStorage.getItem(k)) } catch { return null } },
  set (k, v) { try { localStorage.setItem(k, JSON.stringify(v)) } catch {} },
  del (k) { try { localStorage.removeItem(k) } catch {} }
}

// canvas colours follow the theme, so read them from CSS whenever it changes
let COLORS = {}
function readColors () {
  const cs = getComputedStyle(document.documentElement)
  const v = n => cs.getPropertyValue(n).trim()
  COLORS = { gold: v('--gold'), sea: v('--sea'), line: v('--line'), faint: v('--faint') }
}
readColors()

// ---------- formatting ----------
const fmtBytes = n => {
  if (!n) return ltr('0 B')
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)))
  const v = n / 1024 ** i
  return ltr(`${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`)
}
const fmtSpeed = n => ltr(`${fmtBytes(n)}/s`)
const fmtClock = s => {
  if (!Number.isFinite(s)) return '0:00'
  s = Math.max(0, Math.floor(s))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`
}
const fmtEta = ms => {
  if (!Number.isFinite(ms) || ms <= 0) return ''
  const m = Math.round(ms / 60000)
  if (m < 1) return t('under a minute left')
  if (m < 60) return t('{m} min left', { m })
  const h = Math.floor(m / 60)
  return h < 48 ? t('{h} h {m} min left', { h, m: m % 60 }) : t('{d} days left', { d: Math.round(h / 24) })
}
const pct = p => ltr(`${Math.floor((p || 0) * 100)}%`)
const naturalSort = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
const isMedia = f => f.kind === 'video' || f.kind === 'audio'
const escapeHtml = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

const looksLikeTorrentId = text => {
  const s = (text || '').trim()
  return /^magnet:\?/i.test(s) || /^[a-f0-9]{40}$/i.test(s) || /^https?:\/\/\S+\.torrent(\?\S*)?$/i.test(s)
}

// ---------- toasts: pause while hovered or while the window is hidden ----------
function toast (message, tone = 'info') {
  const el = document.createElement('div')
  el.className = `toast ${tone}`
  el.textContent = message
  const host = $('#toasts')
  host.append(el)
  // a popover sits in the top layer; re-showing it lifts it above any open modal dialog
  try { if (host.matches(':popover-open')) host.hidePopover(); host.showPopover() } catch {}
  let remaining = tone === 'error' ? 6000 : 3500
  let started = Date.now()
  let timer = null
  const leave = () => {
    el.classList.add('leaving')
    el.addEventListener('transitionend', () => el.remove(), { once: true })
    setTimeout(() => el.remove(), 400)
  }
  const run = () => { started = Date.now(); timer = setTimeout(leave, remaining) }
  const hold = () => { clearTimeout(timer); remaining -= Date.now() - started }
  el.addEventListener('pointerenter', hold)
  el.addEventListener('pointerleave', run)
  el.hold = hold
  el.run = run
  if (document.hidden) hold(); else run()
}
document.addEventListener('visibilitychange', () => {
  for (const el of document.querySelectorAll('.toast:not(.leaving)')) document.hidden ? el.hold() : el.run()
})
api.onToast(({ message, tone }) => toast(message, tone))

async function run (promise) {
  try { return await promise } catch (err) { toast(err.message, 'error') }
}

// ---------- theme ----------
let prefs = {}
let appInfo = {}
function applyTheme () {
  if (prefs.theme === 'light' || prefs.theme === 'dark') document.documentElement.dataset.theme = prefs.theme
  else delete document.documentElement.dataset.theme
  readColors()
  redrawStrips()
}
matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => { readColors(); redrawStrips() })

// ---------- canvas strips ----------
function sizeCanvas (canvas) {
  const dpr = window.devicePixelRatio || 1
  const w = Math.max(1, Math.round(canvas.clientWidth * dpr))
  const h = Math.max(1, Math.round(canvas.clientHeight * dpr))
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h }
  return { ctx: canvas.getContext('2d'), w, h, dpr }
}

function drawStrip (canvas, t) {
  const { ctx, w, h, dpr } = sizeCanvas(canvas)
  ctx.clearRect(0, 0, w, h)
  const cells = t.pieces?.length ? t.pieces : null
  const color = t.status === 'seeding' ? COLORS.sea : COLORS.gold
  if (!cells) {
    ctx.fillStyle = COLORS.line
    roundRect(ctx, 0, 0, w, h, h / 2)
    if (t.progress > 0) {
      ctx.fillStyle = t.status === 'paused' || t.status === 'queued' ? COLORS.faint : color
      roundRect(ctx, 0, 0, w * t.progress, h, h / 2)
    }
    return
  }
  const n = cells.length
  const cw = w / n
  const gap = cw >= 3 * dpr ? dpr : 0
  for (let i = 0; i < n; i++) {
    ctx.globalAlpha = 1
    ctx.fillStyle = COLORS.line
    ctx.fillRect(i * cw, 0, cw - gap, h)
    if (cells[i] > 0) {
      ctx.globalAlpha = 0.35 + 0.65 * cells[i]
      ctx.fillStyle = color
      ctx.fillRect(i * cw, 0, cw - gap, h)
    }
  }
  ctx.globalAlpha = 1
}

function roundRect (ctx, x, y, w, h, r) {
  ctx.beginPath()
  ctx.roundRect(x, y, Math.max(w, 0), h, Math.min(r, Math.max(w, 0) / 2))
  ctx.fill()
}

// The title-bar mark animates only when it means something: pieces arrive once at launch,
// and the missing piece breathes while a download is running. Otherwise it's still.
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)')
const BRAND_ORDER = [...MARK.cells].sort((a, b) => a[1] - b[1] || a[0] - b[0]) // fills left to right, like a download
const brand = { start: null, raf: 0, active: false, dim: 0.3 }
const easeOutCubic = t => 1 - Math.pow(1 - t, 3)

function brandFrame (now) {
  brand.raf = 0
  brand.start ??= now
  const c = $('.brand-mark')
  const ctx = c.getContext('2d')
  const cell = 6
  const gap = 2
  const w = MARK.cols * cell + (MARK.cols - 1) * gap
  const h = MARK.rows * cell + (MARK.rows - 1) * gap
  const ox = (c.width - w) / 2 + w * 0.07
  const oy = (c.height - h) / 2
  const still = reduceMotion.matches
  let moving = false

  // ease the missing piece towards its target so starting and stopping never snaps
  const pulse = 0.3 + 0.55 * (0.5 - 0.5 * Math.cos(((now % 1600) / 1600) * Math.PI * 2))
  const target = brand.active && !still ? pulse : 0.3
  brand.dim += (target - brand.dim) * (still ? 1 : 0.18)
  if (brand.active && !still) moving = true
  if (Math.abs(brand.dim - 0.3) > 0.01) moving = true

  ctx.clearRect(0, 0, c.width, c.height)
  ctx.fillStyle = COLORS.gold
  BRAND_ORDER.forEach(([r, col, v], i) => {
    const t = still ? 1 : Math.min(1, Math.max(0, (now - brand.start - i * 35) / 260))
    if (t < 1) moving = true
    const e = easeOutCubic(t)
    const size = cell * (0.6 + 0.4 * e) // pieces grow in from 60%, never from nothing
    const x = ox + col * (cell + gap) + (cell - size) / 2
    const y = oy + r * (cell + gap) + (cell - size) / 2
    ctx.globalAlpha = (v === 1 ? 1 : brand.dim) * e
    ctx.beginPath()
    ctx.roundRect(x, y, size, size, 1.6 * (size / cell))
    ctx.fill()
  })
  ctx.globalAlpha = 1
  if (moving && !document.hidden) brand.raf = requestAnimationFrame(brandFrame)
}
function drawBrand () {
  if (!brand.raf) brand.raf = requestAnimationFrame(brandFrame)
}
function setBrandActive (on) {
  if (on === brand.active) return
  brand.active = on
  drawBrand()
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) drawBrand() })
reduceMotion.addEventListener('change', drawBrand)

function redrawStrips () {
  drawBrand()
  for (const map of [rows, cards]) for (const [ih, item] of map) { const t = torrentById(ih); if (t) drawStrip(item.canvas, t) }
  drawSeek()
}

// ---------- library ----------
let torrents = []
let lastTotals = { down: 0, up: 0 }
const rows = new Map()
const openRows = new Set()
let query = ''
let sortBy = store.get('sortBy') || 'added'
$('#sortSelect').value = sortBy

Promise.all([run(api.call('prefs:get')), run(api.call('app:info'))]).then(([p, info]) => {
  prefs = p || {}
  appInfo = info || {}
  applyTheme()
  let reopen = false
  try { reopen = sessionStorage.getItem('reopenPrefs') === '1'; sessionStorage.removeItem('reopenPrefs') } catch {}
  if (reopen) openPrefs().then(() => $('#prefLanguage').scrollIntoView({ block: 'center' }))
})

api.onTorrents(({ torrents: list, totals }) => {
  torrents = list
  lastTotals = totals
  renderLibrary()
  if (player.active) updatePlayerFromTorrents()
})
run(api.call('torrents:list'))

const torrentById = ih => torrents.find(t => t.infoHash === ih)

const STATUS_ORDER = { downloading: 0, metadata: 1, seeding: 2, paused: 3 }
function visibleTorrents () {
  const q = query.trim().toLowerCase()
  const list = q ? torrents.filter(t => (t.name || '').toLowerCase().includes(q)) : [...torrents]
  const by = {
    added: (a, b) => (b.addedAt || 0) - (a.addedAt || 0),
    name: (a, b) => (a.name || '').localeCompare(b.name || '', undefined, { numeric: true, sensitivity: 'base' }),
    progress: (a, b) => (a.progress || 0) - (b.progress || 0),
    size: (a, b) => (b.length || 0) - (a.length || 0),
    status: (a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status]
  }[sortBy]
  return list.sort(by)
}

let view = store.get('view') || 'grid'
const cards = new Map()
function syncViewSwitch () {
  for (const b of document.querySelectorAll('[data-view]')) b.setAttribute('aria-checked', String(b.dataset.view === view))
}
syncViewSwitch()
$('.toolbar .segmented').addEventListener('click', e => {
  const v = e.target.closest('[data-view]')?.dataset.view
  if (!v || v === view) return
  view = v
  store.set('view', v)
  syncViewSwitch()
  renderLibrary()
})

function renderLibrary () {
  setBrandActive(torrents.some(t => t.status === 'downloading' || t.status === 'metadata'))
  const any = torrents.length > 0
  $('#emptyState').hidden = any
  $('#toolbar').hidden = !any
  const active = torrents.filter(t => t.status !== 'paused').length
  $('#summary').innerHTML = any
    ? `<span>${tHtml(torrents.length === 1 ? '{n} torrent, {active} active' : '{n} torrents, {active} active', { n: `<b>${torrents.length}</b>`, active })}</span>
       <span>${tHtml('Down {speed}', { speed: `<b>${fmtSpeed(lastTotals.down)}</b>` })}</span><span>${tHtml('Up {speed}', { speed: `<b>${fmtSpeed(lastTotals.up)}</b>` })}</span>`
    : ''

  renderContinue()
  const shown = visibleTorrents()
  $('#noMatches').hidden = !(any && query && !shown.length)
  $('#noMatches').textContent = t('No torrents match “{query}”.', { query })
  const grid = $('#torrentGrid')
  const list = $('#torrentList')
  grid.hidden = view !== 'grid' || !shown.length
  list.hidden = view !== 'list' || !shown.length
  if (view === 'grid') { reconcile(grid, cards, shown, createCard, updateCard); clearItems(rows) } else { reconcile(list, rows, shown, createRow, updateRow); clearItems(cards) }
  for (const ih of openRows) if (!torrentById(ih)) openRows.delete(ih)
  if (filesDialogIh) {
    const t = torrentById(filesDialogIh)
    if (t) renderFiles($('#filesDialogList'), t, filesHolder)
    else $('#filesDialog').close()
  }
}

// ---------- continue watching ----------
// The video files you stopped part-way through, newest first, one per torrent.
const RECENT_KEY = 'recent'
const recentList = () => (store.get(RECENT_KEY) || []).filter(r => r && r.ih && Number.isFinite(r.t) && r.d > 0)
function rememberWatch (t, d) {
  if (!player.ih || player.index == null || player.kind !== 'video') return
  const list = recentList().filter(r => r.ih !== player.ih)
  if (t > 5 && t < d - 15) list.unshift({ ih: player.ih, index: player.index, t, d, at: Date.now(), name: player.name })
  store.set(RECENT_KEY, list.slice(0, 20))
}
function forgetWatch (ih) {
  store.set(RECENT_KEY, recentList().filter(r => r.ih !== ih))
  renderContinue()
}
const prettyName = name => String(name || '').replace(/\.(mkv|mp4|m4v|webm|avi|mov|ts|ogv|mp3|m4a|flac|ogg|opus|wav)$/i, '').replace(/[._]+/g, ' ').trim()
let continueKey = ''
function renderContinue () {
  const items = query ? [] : recentList().filter(r => torrentById(r.ih)).slice(0, 12)
  const row = $('#continueRow')
  row.hidden = !items.length
  $('#libraryHeading').hidden = !items.length || !torrents.length
  const key = items.map(r => `${r.ih}:${r.index}:${Math.round(r.t / 30)}:${torrentById(r.ih)?.poster || ''}`).join('|')
  if (key === continueKey) return
  continueKey = key
  $('#continueTrack').innerHTML = items.map(r => {
    const tor = torrentById(r.ih)
    const multi = tor.files.filter(f => f.kind === 'video').length > 1
    const title = prettyName(multi ? r.name : (tor.name || r.name))
    const left = Math.max(1, Math.round((r.d - r.t) / 60))
    return `
      <article class="card" data-ih="${r.ih}" data-index="${r.index}">
        <button class="card-art" data-act="resume" aria-label="${escapeHtml(t('Resume {title}', { title }))}">
          ${tor.poster ? `<img alt="" src="${escapeHtml(tor.poster)}">` : ''}
          <span class="card-fallback"><svg class="ic"><use href="#i-play"/></svg><span class="card-fallback-title">${escapeHtml(title)}</span></span>
          <span class="card-overlay"><span class="card-play"><svg class="ic"><use href="#i-play"/></svg></span></span>
          <span class="card-watched"><i data-w="${Math.min(100, (r.t / r.d) * 100).toFixed(1)}"></i></span>
        </button>
        <button class="continue-remove" data-act="forget" title="${escapeHtml(t('Remove from Continue watching'))}" aria-label="${escapeHtml(t('Remove {title} from Continue watching', { title }))}"><svg class="ic"><use href="#i-plus"/></svg></button>
        <div class="card-info"><div class="card-text">
          <div class="card-title" title="${escapeHtml(title)}">${escapeHtml(title)}</div>
          <div class="card-meta"><span>${escapeHtml(t('{m} min left', { m: left }))}</span>${multi && tor.name ? `<span>${escapeHtml(tor.name)}</span>` : ''}</div>
        </div></div>
      </article>`
  }).join('')
  // CSP blocks inline style attributes; CSSOM is fine
  for (const bar of $('#continueTrack').querySelectorAll('[data-w]')) bar.style.width = `${bar.dataset.w}%`
}
$('#continueTrack').addEventListener('load', e => { if (e.target.tagName === 'IMG') e.target.classList.add('loaded') }, true)
$('#continueTrack').addEventListener('error', e => { if (e.target.tagName === 'IMG') e.target.remove() }, true)
$('#continueTrack').addEventListener('click', e => {
  const b = e.target.closest('[data-act]')
  const card = e.target.closest('.card')
  if (!b || !card) return
  if (b.dataset.act === 'forget') return forgetWatch(card.dataset.ih)
  openPlayer(card.dataset.ih, Number(card.dataset.index))
})

function reconcile (container, map, shown, create, update) {
  const seen = new Set()
  shown.forEach((t, i) => {
    seen.add(t.infoHash)
    let item = map.get(t.infoHash)
    if (!item) { item = create(t); map.set(t.infoHash, item) }
    if (container.children[i] !== item.el) container.insertBefore(item.el, container.children[i] || null)
    update(item, t)
  })
  for (const [ih, item] of map) if (!seen.has(ih)) { item.el.remove(); map.delete(ih) }
}
function clearItems (map) {
  for (const item of map.values()) item.el.remove()
  map.clear()
}

// short status for cards and the long one for list rows
function statusParts (tor, short) {
  if (tor.status === 'metadata') return [['st-downloading', short ? t('Connecting') : t(tor.numPeers === 1 ? 'Connecting, {n} peer' : 'Connecting, {n} peers', { n: tor.numPeers })]]
  if (tor.status === 'downloading') {
    const parts = [['st-downloading', pct(tor.progress)]]
    if (short) parts.push(['', fmtSpeed(tor.downloadSpeed)])
    else {
      parts.push(['', t('of {size}', { size: fmtBytes(tor.length) })])
      const eta = fmtEta(tor.timeRemaining)
      if (eta) parts.push(['', eta])
    }
    return parts
  }
  if (tor.status === 'done') return [['st-seeding', t('Downloaded')], ['', fmtBytes(tor.length)]]
  if (tor.status === 'seeding') {
    const parts = [['st-seeding', t('Seeding')], ['', fmtBytes(tor.length)]]
    if (!short && tor.ratio) parts.push(['', t('Ratio {ratio}', { ratio: tor.ratio.toFixed(2) })])
    return parts
  }
  const progressOf = () => short ? pct(tor.progress) : t('{pct} of {size}', { pct: pct(tor.progress), size: fmtBytes(tor.length) })
  if (tor.status === 'queued') {
    const label = tor.queueReason === 'watching' ? (short ? t('Waiting') : t('Waiting while you watch')) : t('Queued')
    return [['st-paused', label], ...(tor.length ? [['', progressOf()]] : [])]
  }
  if (tor.seedLimitReached) return [['st-seeding', t('Done seeding')], ...(short ? [] : [['', t('Reached your share ratio')]])]
  const parts = [['st-paused', t('Paused')]]
  if (tor.length) parts.push(['', progressOf()])
  return parts
}
const partsHtml = parts => parts.map(([c, s]) => `<span class="${c}">${escapeHtml(s)}</span>`).join('')
const mediaKind = t => {
  const media = t.files.filter(isMedia)
  return media.some(f => f.kind === 'video') ? 'video' : media.length ? 'audio' : t.files.length ? 'none' : 'unknown'
}

function createCard (tor) {
  const el = document.createElement('article')
  el.className = 'card'
  el.dataset.ih = tor.infoHash
  el.innerHTML = `
    <button class="card-art" data-act="play">
      <img alt="">
      <span class="card-fallback"><svg class="ic"><use href="#i-play"/></svg><span class="card-fallback-title"></span></span>
      <span class="card-overlay"><span class="card-play"><svg class="ic"><use href="#i-play"/></svg></span></span>
      <span class="card-badge" hidden></span>
    </button>
    <canvas class="card-strip"></canvas>
    <div class="card-info">
      <div class="card-text"><div class="card-title"></div><div class="card-meta"></div></div>
      <button class="btn btn-icon" data-act="pause"><svg class="ic"><use href="#i-pause"/></svg></button>
      <button class="btn btn-icon" data-act="more" aria-label="${escapeHtml(t('More actions'))}" aria-haspopup="menu"><svg class="ic"><use href="#i-more"/></svg></button>
    </div>`
  const img = el.querySelector('img')
  img.addEventListener('load', () => img.classList.add('loaded'))
  img.addEventListener('error', () => { img.classList.remove('loaded'); img.removeAttribute('src') })
  return {
    el,
    art: el.querySelector('.card-art'),
    img,
    fallbackIcon: el.querySelector('.card-fallback use'),
    fallbackTitle: el.querySelector('.card-fallback-title'),
    overlayIcon: el.querySelector('.card-play use'),
    badge: el.querySelector('.card-badge'),
    canvas: el.querySelector('canvas'),
    title: el.querySelector('.card-title'),
    meta: el.querySelector('.card-meta'),
    pause: el.querySelector('[data-act=pause]'),
    poster: null
  }
}

function updateCard (card, tor) {
  const name = tor.name || t('Fetching torrent details…')
  card.title.textContent = name
  card.title.title = tor.name
  card.fallbackTitle.textContent = name
  card.meta.innerHTML = partsHtml(statusParts(tor, true))
  const kind = mediaKind(tor)
  const playable = kind !== 'none'
  card.art.setAttribute('aria-label', playable ? t('Play {name}', { name }) : t('Show files in {name}', { name }))
  card.overlayIcon.setAttribute('href', playable ? '#i-play' : '#i-file')
  card.fallbackIcon.setAttribute('href', kind === 'audio' ? '#i-music' : kind === 'none' ? '#i-file' : '#i-play')
  if (tor.poster !== card.poster) {
    card.poster = tor.poster
    card.img.classList.remove('loaded')
    if (tor.poster) card.img.src = tor.poster
    else card.img.removeAttribute('src')
  }
  const paused = tor.status === 'paused'
  card.badge.hidden = !paused
  card.badge.textContent = tor.seedLimitReached ? t('Done') : t('Paused')
  card.pause.querySelector('use').setAttribute('href', paused ? '#i-resume' : '#i-pause')
  card.pause.title = paused ? t('Resume') : t('Pause')
  card.pause.setAttribute('aria-label', card.pause.title)
  drawStrip(card.canvas, tor)
}

function createRow (tor) {
  const el = document.createElement('article')
  el.className = 'torrent'
  el.dataset.ih = tor.infoHash
  el.innerHTML = `
    <div class="t-head">
      <button class="t-main" data-act="toggle" aria-expanded="false">
        <span class="t-poster"><svg class="ic"><use href="#i-file"/></svg><img alt=""></span>
        <span class="t-text">
          <span class="t-name"><span></span><svg class="ic"><use href="#i-chevron"/></svg></span>
          <span class="t-meta"></span>
        </span>
      </button>
      <div class="t-rates"></div>
      <div class="t-actions">
        <button class="btn btn-primary t-play" data-act="play"><svg class="ic"><use href="#i-play"/></svg>${escapeHtml(t('Play'))}</button>
        <button class="btn btn-icon t-pause" data-act="pause"><svg class="ic"><use href="#i-pause"/></svg></button>
        <button class="btn btn-icon" data-act="more" aria-label="${escapeHtml(t('More actions'))}" aria-haspopup="menu"><svg class="ic"><use href="#i-more"/></svg></button>
      </div>
    </div>
    <div class="strip"><canvas></canvas></div>
    <ul class="files" hidden></ul>`
  const img = el.querySelector('.t-poster img')
  img.addEventListener('load', () => img.classList.add('loaded'))
  img.addEventListener('error', () => { img.classList.remove('loaded'); img.removeAttribute('src') })
  return {
    el,
    main: el.querySelector('.t-main'),
    name: el.querySelector('.t-name span'),
    meta: el.querySelector('.t-meta'),
    rates: el.querySelector('.t-rates'),
    play: el.querySelector('.t-play'),
    pause: el.querySelector('.t-pause'),
    posterIcon: el.querySelector('.t-poster use'),
    img,
    canvas: el.querySelector('canvas'),
    files: el.querySelector('.files'),
    fileKey: '',
    poster: null
  }
}

function updateRow (row, tor) {
  row.name.textContent = tor.name || t('Fetching torrent details…')
  row.main.title = tor.name

  row.meta.innerHTML = partsHtml(statusParts(tor, false))

  row.rates.innerHTML = tor.status === 'paused'
    ? ''
    : `<span>${tHtml('Down {speed}', { speed: `<b>${fmtSpeed(tor.downloadSpeed)}</b>` })}</span><span>${tHtml('Up {speed}', { speed: `<b>${fmtSpeed(tor.uploadSpeed)}</b>` })}</span><span>${tHtml(tor.numPeers === 1 ? '{n} peer' : '{n} peers', { n: `<b>${tor.numPeers}</b>` })}</span>`

  const media = tor.files.filter(isMedia)
  row.play.hidden = tor.files.length > 0 && !media.length
  const kind = media.some(f => f.kind === 'video') ? 'i-play' : media.length ? 'i-music' : 'i-file'
  row.posterIcon.setAttribute('href', `#${kind}`)
  if (tor.poster !== row.poster) {
    row.poster = tor.poster
    row.img.classList.remove('loaded')
    if (tor.poster) row.img.src = tor.poster
    else row.img.removeAttribute('src')
  }

  const paused = tor.status === 'paused'
  row.pause.querySelector('use').setAttribute('href', paused ? '#i-resume' : '#i-pause')
  row.pause.title = paused ? t('Resume') : t('Pause')
  row.pause.setAttribute('aria-label', row.pause.title)

  drawStrip(row.canvas, tor)

  const isOpen = openRows.has(tor.infoHash)
  row.el.classList.toggle('open', isOpen)
  row.main.setAttribute('aria-expanded', String(isOpen))
  row.files.hidden = !isOpen
  if (isOpen) renderFiles(row.files, tor, row)
}

function renderFiles (container, tor, holder) {
  const key = tor.infoHash + '\n' + tor.files.map(f => f.name).join('\n')
  if (key !== holder.fileKey) {
    holder.fileKey = key
    const shown = tor.files.filter(f => f.kind !== 'padding')
    container.innerHTML = shown.length
      ? shown.map(f => `
        <li class="file" data-ih="${tor.infoHash}" data-index="${f.index}">
          <input type="checkbox" data-act="select" aria-label="${escapeHtml(t('Download {name}', { name: f.name }))}">
          <span class="file-name" title="${escapeHtml(f.path)}">${escapeHtml(f.name)}</span>
          <span class="file-size">${fmtBytes(f.length)}</span>
          <span class="file-pct"></span>
          <button type="button" class="btn btn-icon" data-act="play-file" aria-label="${escapeHtml(t('Play {name}', { name: f.name }))}" ${isMedia(f) ? '' : 'disabled'}>
            <svg class="ic"><use href="#i-play"/></svg>
          </button>
        </li>`).join('')
      : `<li class="file"><span></span><span class="file-name">${escapeHtml(t('The file list appears once peers send the torrent details.'))}</span></li>`
  }
  for (const f of tor.files) {
    const li = container.querySelector(`[data-index="${f.index}"]`)
    if (!li) continue
    li.classList.toggle('off', !f.selected)
    li.querySelector('input').checked = f.selected
    li.querySelector('.file-pct').textContent = pct(f.progress)
  }
}

let filesDialogIh = null
const filesHolder = { fileKey: '' }
function openFiles (ih) {
  const tor = torrentById(ih)
  if (!tor) return
  filesDialogIh = ih
  filesHolder.fileKey = ''
  $('#filesTitle').textContent = tor.name || t('Files')
  renderFiles($('#filesDialogList'), tor, filesHolder)
  $('#filesDialog').showModal()
  $('#filesDialog').focus() // no checkbox should look selected before you touch one
}
$('#filesDialog').addEventListener('close', () => { filesDialogIh = null })

// file rows behave the same in the list and in the files dialog
document.addEventListener('change', e => {
  if (e.target.dataset?.act !== 'select') return
  const li = e.target.closest('.file')
  run(api.call('torrent:selectFile', li.dataset.ih, Number(li.dataset.index), e.target.checked))
})
document.addEventListener('click', e => {
  const b = e.target.closest('[data-act="play-file"]')
  if (!b) return
  const li = b.closest('.file')
  if ($('#filesDialog').open) $('#filesDialog').close()
  openPlayer(li.dataset.ih, Number(li.dataset.index))
})

function onLibraryClick (e) {
  const actEl = e.target.closest('[data-act]')
  const host = e.target.closest('.torrent, .card')
  if (!actEl || !host) return
  const act = actEl.dataset.act
  if (act === 'select' || act === 'play-file') return
  const ih = host.dataset.ih
  const t = torrentById(ih)
  if (act === 'toggle') {
    openRows.has(ih) ? openRows.delete(ih) : openRows.add(ih)
    updateRow(rows.get(ih), t)
  } else if (act === 'play') {
    if (mediaKind(t) === 'none') openFiles(ih)
    else openPlayer(ih)
  } else if (act === 'pause') run(api.call(t.status === 'paused' ? 'torrent:resume' : 'torrent:pause', ih))
  else if (act === 'more') openRowMenu(actEl, ih, e.detail === 0)
}
$('#torrentList').addEventListener('click', onLibraryClick)
$('#torrentGrid').addEventListener('click', onLibraryClick)

$('#searchInput').addEventListener('input', e => { query = e.target.value; renderLibrary() })
$('#searchInput').addEventListener('keydown', e => {
  if (e.key === 'Escape') { e.target.value = ''; query = ''; renderLibrary(); e.target.blur() }
})
$('#sortSelect').addEventListener('change', e => { sortBy = e.target.value; store.set('sortBy', sortBy); renderLibrary() })

// ---------- menus: grow from their trigger; no animation when opened from the keyboard ----------
let openMenu = null
function showMenu (menu, anchor, fromKeyboard) {
  closeMenus()
  menu.classList.toggle('instant', !!fromKeyboard)
  menu.hidden = false
  openMenu = { menu, anchor }
  anchor?.setAttribute('aria-expanded', 'true')
  if (fromKeyboard) menu.querySelector('button')?.focus({ preventScroll: true })
}
function closeMenus () {
  if (!openMenu) return
  openMenu.menu.hidden = true
  openMenu.anchor?.setAttribute('aria-expanded', 'false')
  openMenu.onClose?.()
  openMenu = null
}
function toggleMenu (menu, anchor, e, render) {
  if (openMenu?.menu === menu) return closeMenus()
  render?.()
  showMenu(menu, anchor, e.detail === 0)
}
document.addEventListener('pointerdown', e => {
  if (openMenu && !openMenu.menu.contains(e.target) && !openMenu.anchor?.contains(e.target)) closeMenus()
})

let rowMenuIh = null
function openRowMenu (anchor, ih, fromKeyboard) {
  rowMenuIh = ih
  const menu = $('#rowMenu')
  const r = anchor.getBoundingClientRect()
  showMenu(menu, anchor, fromKeyboard)
  const mw = menu.offsetWidth
  const mh = menu.offsetHeight
  const above = r.bottom + mh + 8 > innerHeight
  // the menu lines up with the trigger's outer edge: its right edge, or its left edge in Arabic
  const rtl = isRtl()
  menu.style.transformOrigin = `${above ? 'bottom' : 'top'} ${rtl ? 'left' : 'right'}`
  menu.style.left = `${Math.max(8, Math.min(rtl ? r.left : r.right - mw, innerWidth - mw - 8))}px`
  menu.style.top = `${above ? r.top - mh - 6 : r.bottom + 6}px`
}
$('#rowMenu').addEventListener('click', async e => {
  const act = e.target.closest('[data-act]')?.dataset.act
  const ih = rowMenuIh
  closeMenus()
  if (!act) return
  if (act === 'files') openFiles(ih)
  if (act === 'folder') run(api.call('torrent:showFolder', ih))
  if (act === 'trackers') openTrackers(ih)
  if (act === 'magnet') { await run(api.call('torrent:copyMagnet', ih)); toast(t('Magnet link copied.')) }
  if (act === 'save') { if (await run(api.call('torrent:saveFile', ih))) toast(t('Torrent file saved.')) }
  if (act === 'remove') confirmRemove(ih)
})

function confirmRemove (ih) {
  const tor = torrentById(ih)
  const dlg = $('#removeDialog')
  $('#removeTitle').textContent = tor?.name ? t('Remove “{name}”?', { name: tor.name }) : t('Remove this torrent?')
  dlg.returnValue = ''
  dlg.showModal()
  dlg.addEventListener('close', () => {
    const v = dlg.returnValue
    if (v !== 'keep' && v !== 'delete') return
    if (player.active && player.ih === ih) closePlayer()
    run(api.call('torrent:remove', ih, v === 'delete'))
  }, { once: true })
}

// ---------- adding torrents ----------
async function addId (id) {
  const ih = await run(api.call('torrent:add', id))
  if (!ih) return
  openRows.add(ih)
  if (prefs.autoPlay) openPlayer(ih)
}

$('#addForm').addEventListener('submit', e => {
  e.preventDefault()
  const input = $('#magnetInput')
  const value = input.value.trim()
  if (!value) return input.focus()
  if (!looksLikeTorrentId(value)) return toast(t('Paste a magnet link (magnet:?xt=…), a 40-character info hash or a link to a .torrent file.'), 'error')
  input.value = ''
  input.blur()
  addId(value)
})

$('#openTorrentBtn').addEventListener('click', () => run(api.call('torrent:openDialog')))

document.addEventListener('paste', e => {
  if (e.target.closest('input, textarea') || player.active) return
  const text = e.clipboardData.getData('text')
  if (looksLikeTorrentId(text)) { e.preventDefault(); addId(text.trim()) }
})

// drag & drop: .torrent files are added, anything else opens the share dialog
let dragDepth = 0
window.addEventListener('dragenter', e => { e.preventDefault(); dragDepth++; if (!player.active) $('#dropOverlay').hidden = false })
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#dropOverlay').hidden = true } })
window.addEventListener('dragover', e => e.preventDefault())
window.addEventListener('drop', async e => {
  e.preventDefault()
  dragDepth = 0
  $('#dropOverlay').hidden = true
  if (player.active) {
    const sub = [...e.dataTransfer.files].find(f => /\.(srt|vtt|ass|ssa)$/i.test(f.name))
    const p = sub && api.pathForFile(sub)
    if (p) loadDiskSubtitle(p)
    return
  }
  const files = [...e.dataTransfer.files]
  if (!files.length) {
    const text = e.dataTransfer.getData('text/plain')
    if (looksLikeTorrentId(text)) addId(text.trim())
    return
  }
  const paths = files.map(f => api.pathForFile(f)).filter(Boolean)
  const torrentFiles = paths.filter(p => /\.torrent$/i.test(p))
  const others = paths.filter(p => !/\.torrent$/i.test(p))
  if (torrentFiles.length) run(api.call('torrent:addPaths', torrentFiles))
  if (others.length) openShare(others[0])
})

// ---------- share ----------
let sharePathValue = null
let defaultTrackers = null
async function openShare (presetPath = null) {
  defaultTrackers ||= await run(api.call('torrent:defaultTrackers')) || []
  sharePathValue = presetPath
  $('#shareTrackers').value = defaultTrackers.join('\n')
  $('#shareComment').value = ''
  $('#sharePrivate').checked = false
  $('#shareUploadNote').hidden = !!prefs.allowUploads
  $('.advanced').open = false
  renderSharePath()
  $('#shareDialog').returnValue = ''
  $('#shareDialog').showModal()
  $('#shareDialog').focus()
}
function renderSharePath () {
  $('#sharePath').textContent = sharePathValue || t('Nothing chosen yet.')
  $('#sharePath').classList.toggle('chosen', !!sharePathValue)
  $('#shareCreateBtn').disabled = !sharePathValue
}
$('#shareBtn').addEventListener('click', () => openShare())

// ---------- discover: free films and music from the Internet Archive ----------
const discover = { kind: store.get('discoverKind') === 'music' ? 'music' : 'film', page: 1, items: [], token: 0, timer: null, added: new Map() }
const discoverDlg = $('#discoverDialog')
const discoverGrid = $('#discoverResults')

function openDiscover () {
  if (player.active) closePlayer()
  renderDiscoverKind()
  discoverDlg.showModal()
  $('#discoverInput').focus()
  if (!discover.items.length) runDiscover()
}
function renderDiscoverKind () {
  for (const b of discoverDlg.querySelectorAll('[data-kind]')) b.setAttribute('aria-checked', String(b.dataset.kind === discover.kind))
  discoverGrid.classList.toggle('is-music', discover.kind === 'music')
}
async function runDiscover (more = false) {
  clearTimeout(discover.timer)
  const token = ++discover.token
  const query = $('#discoverInput').value.trim()
  const page = more ? discover.page + 1 : 1
  const status = $('#discoverStatus')
  const moreBtn = $('#discoverMore')
  status.textContent = more ? t('Loading more…') : t('Searching the Internet Archive…')
  moreBtn.disabled = true
  try {
    const r = await api.call('discover:search', { query, kind: discover.kind, page })
    if (token !== discover.token) return
    discover.page = page
    discover.items = more ? discover.items.concat(r.items) : r.items
    renderDiscover(more ? r.items.length : null)
    const film = discover.kind === 'film'
    status.textContent = !discover.items.length
      ? (query ? t(film ? 'No films with “{query}” in the title. Try fewer or different words.' : 'No music with “{query}” in the title. Try fewer or different words.', { query }) : t('Nothing to show right now. Try a search.'))
      : query ? t(r.total === 1 ? '{n} result for “{query}”, most downloaded first.' : '{n} results for “{query}”, most downloaded first.', { n: r.total.toLocaleString('en'), query })
        : film ? t('The most downloaded feature films. Click one to add it to your library.') : t('The most downloaded music. Click an album to add it to your library.')
    moreBtn.hidden = discover.items.length >= r.total || !r.items.length
  } catch (err) {
    if (token === discover.token) status.textContent = err.message
  } finally {
    if (token === discover.token) moreBtn.disabled = false
  }
}
function discoverCard (item, i) {
  const ih = discover.added.get(item.torrentUrl)
  const added = !!(ih && torrentById(ih))
  const meta = [item.year, item.creator].filter(Boolean).map(m => `<span>${escapeHtml(m)}</span>`).join('')
  return `
    <div class="card" data-i="${i}">
      <button type="button" class="card-art" data-act="add" aria-label="${escapeHtml(t(added ? 'Play {name}' : 'Add {name}', { name: item.title }))}">
        <img alt="" loading="lazy" decoding="async" src="${escapeHtml(item.thumb)}">
        <div class="card-fallback"><svg class="ic"><use href="#i-${item.kind === 'music' ? 'music' : 'play'}"/></svg><div class="card-fallback-title">${escapeHtml(item.title)}</div></div>
        <span class="card-badge is-added" ${added ? '' : 'hidden'}>${escapeHtml(t('In library'))}</span>
        <div class="card-overlay"><span class="discover-add">${added ? `<svg class="ic"><use href="#i-play"/></svg>${escapeHtml(t('Play'))}` : `<svg class="ic"><use href="#i-plus"/></svg>${escapeHtml(t('Add'))}`}</span></div>
      </button>
      <div class="card-info">
        <div class="card-text">
          <div class="card-title" title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</div>
          <div class="card-meta">${meta}</div>
        </div>
        <button type="button" class="btn btn-icon" data-act="page" title="${escapeHtml(t('Details and licence on archive.org'))}" aria-label="${escapeHtml(t('Open {name} on archive.org', { name: item.title }))}"><svg class="ic"><use href="#i-external"/></svg></button>
      </div>
    </div>`
}
function renderDiscover (appended) {
  if (appended == null) {
    discoverGrid.innerHTML = discover.items.map(discoverCard).join('')
    discoverGrid.scrollTop = 0
  } else {
    const from = discover.items.length - appended
    discoverGrid.insertAdjacentHTML('beforeend', discover.items.slice(from).map((it, k) => discoverCard(it, from + k)).join(''))
  }
}
// images can't use inline handlers under our CSP; load/error don't bubble, so capture them
discoverGrid.addEventListener('load', e => { if (e.target.tagName === 'IMG') e.target.classList.add('loaded') }, true)
discoverGrid.addEventListener('error', e => { if (e.target.tagName === 'IMG') e.target.remove() }, true)

discoverGrid.addEventListener('click', async e => {
  const el = e.target.closest('[data-act]')
  const card = e.target.closest('.card')
  if (!el || !card) return
  const item = discover.items[Number(card.dataset.i)]
  if (el.dataset.act === 'page') return run(api.call('discover:openPage', item.page))
  const known = discover.added.get(item.torrentUrl)
  if (known && torrentById(known)) { discoverDlg.close(); openPlayer(known); return }
  if (card.getAttribute('aria-busy') === 'true') return
  card.setAttribute('aria-busy', 'true')
  card.querySelector('.discover-add').textContent = t('Adding…')
  try {
    const ih = await api.call('discover:add', item.torrentUrl)
    if (!ih) return // cancelled the save dialog
    discover.added.set(item.torrentUrl, ih)
    toast(t('Added “{title}”. It’s in your library, or click it again to play.', { title: item.title }))
  } catch (err) {
    toast(err.message, 'error')
  } finally {
    card.removeAttribute('aria-busy')
    card.outerHTML = discoverCard(item, Number(card.dataset.i))
  }
})
$('#discoverInput').addEventListener('input', () => {
  clearTimeout(discover.timer)
  discover.timer = setTimeout(() => runDiscover(), 450)
})
$('#discoverForm').addEventListener('submit', e => {
  if (e.submitter?.value === 'close') return
  e.preventDefault() // Enter in the search box searches now instead of closing
  runDiscover()
})
for (const b of discoverDlg.querySelectorAll('[data-kind]')) {
  b.addEventListener('click', () => {
    if (discover.kind === b.dataset.kind) return
    discover.kind = b.dataset.kind
    store.set('discoverKind', discover.kind)
    renderDiscoverKind()
    runDiscover()
  })
}
$('#discoverMore').addEventListener('click', () => runDiscover(true))
$('#discoverBtn').addEventListener('click', openDiscover)
$('#emptyDiscoverBtn').addEventListener('click', openDiscover)
$('.share-pick').addEventListener('click', async e => {
  const kind = e.target.closest('[data-pick]')?.dataset.pick
  if (!kind) return
  const p = await run(api.call('torrent:pickShare', kind))
  if (p) { sharePathValue = p; renderSharePath() }
})
$('#shareDialog').addEventListener('close', async () => {
  if ($('#shareDialog').returnValue !== 'create' || !sharePathValue) return
  const announce = $('#shareTrackers').value.split('\n').map(s => s.trim()).filter(Boolean)
  const opts = { announce, comment: $('#shareComment').value.trim(), private: $('#sharePrivate').checked }
  toast(t('Preparing torrent. Large folders take a moment to hash.'))
  const r = await run(api.call('torrent:seedPath', sharePathValue, opts))
  if (r) toast(t('Sharing “{name}”. Magnet link copied.', { name: r.name }))
})

// ---------- preferences ----------
const prefsDlg = $('#prefsDialog')
async function openPrefs () {
  prefs = await run(api.call('prefs:get')) || prefs
  showDownloadPath()
  $('#prefDownLimit').value = prefs.downloadLimit || ''
  $('#prefUpLimit').value = prefs.uploadLimit || ''
  $('#prefRatio').value = prefs.seedRatioLimit || ''
  $('#prefMaxActive').value = prefs.maxActiveDownloads || ''
  $('#prefHoldOthers').checked = prefs.pauseOthersWhileWatching !== false
  $('#prefAutoPlay').checked = !!prefs.autoPlay
  $('#prefAskPath').checked = !!prefs.askSavePath
  $('#prefUploads').checked = !!prefs.allowUploads
  syncUploadRows()
  $('#prefPlayer').value = prefs.externalPlayer || 'builtin'
  renderPlayerPath()
  $('#prefTheme').value = prefs.theme || 'system'
  $('#prefLanguage').value = prefs.language || 'system'
  $('#prefNotify').checked = !!prefs.notifyOnComplete
  $('#prefLogin').checked = !!prefs.openAtLogin
  $('#prefTray').checked = !!prefs.closeToTray
  $('#prefTrayRow').hidden = !appInfo.tray
  const isDefault = await run(api.call('prefs:isDefaultHandler'))
  $('#prefHandlerState').textContent = isDefault ? t('Magnetic opens magnet links.') : t('Another app opens magnet links.')
  $('#prefHandlerBtn').hidden = !!isDefault
  const creds = await run(api.call('subs:credentials')) || {}
  $('#prefOsKey').value = creds.apiKey || ''
  $('#prefOsUser').value = creds.username || ''
  $('#prefOsPass').value = ''
  $('#prefOsPass').placeholder = creds.hasPassword ? t('Saved') : t('Not set')
  $('#prefTrackersOn').checked = prefs.trackersForDownloads !== false
  $('#prefTrackers').value = (prefs.trackers || []).join('\n')
  $('#prefTrackersNote').textContent = ''
  $('#prefAbout').textContent = `Magnetic ${appInfo.version || ''}. ${appInfo.webrtc ? t('Connects to peers in web browsers as well as regular BitTorrent apps.') : t('Browser peers are unavailable on this system.')}`
  prefsDlg.showModal()
  prefsDlg.focus()
}
function renderPlayerPath () {
  const p = prefs.externalPlayer
  $('#prefPlayerPath').textContent = p === 'custom' && prefs.externalPlayerPath
    ? prefs.externalPlayerPath
    : p === 'vlc' ? t('VLC plays almost every format. Install it from videolan.org.') : t('Built-in player. You can still open any file in VLC from the player.')
}
async function showDownloadPath () {
  $('#prefPath').textContent = prefs.downloadPath
  const free = await api.call('disk:free', prefs.downloadPath).catch(() => null)
  if (free != null) $('#prefPath').textContent = t('{path} ({size} free)', { path: prefs.downloadPath, size: fmtBytes(free) })
}
const setPref = async patch => { prefs = await run(api.call('prefs:set', patch)) || prefs; return prefs }
const numPref = (id, key) => $(id).addEventListener('change', e => {
  const v = Math.max(0, Number(e.target.value) || 0)
  e.target.value = v || ''
  setPref({ [key]: v })
})
numPref('#prefDownLimit', 'downloadLimit')
numPref('#prefUpLimit', 'uploadLimit')
numPref('#prefRatio', 'seedRatioLimit')
numPref('#prefMaxActive', 'maxActiveDownloads')
$('#prefHoldOthers').addEventListener('change', e => setPref({ pauseOthersWhileWatching: e.target.checked }))
$('#prefsBtn').addEventListener('click', openPrefs)
$('#prefOsKey').addEventListener('change', e => run(api.call('subs:setCredentials', { apiKey: e.target.value })))
$('#prefOsUser').addEventListener('change', e => run(api.call('subs:setCredentials', { username: e.target.value })))
$('#prefOsPass').addEventListener('change', async e => {
  const ok = await run(api.call('subs:setCredentials', { password: e.target.value }))
  if (ok) { e.target.placeholder = e.target.value ? t('Saved') : t('Not set'); e.target.value = '' }
})
$('#osLink').addEventListener('click', e => { e.preventDefault(); run(api.call('app:openSubtitleSite')) })
$('#prefPathBtn').addEventListener('click', async () => {
  prefs = await run(api.call('prefs:chooseDownloadPath')) || prefs
  showDownloadPath()
})
// --- trackers (preferences)
async function saveTrackerPref (text) {
  const r = await run(api.call('prefs:setTrackers', text))
  if (!r) return
  prefs.trackers = r.trackers
  $('#prefTrackers').value = r.trackers.join('\n')
  $('#prefTrackersNote').textContent = r.invalid.length
    ? t(r.invalid.length === 1 ? 'Skipped an address that isn’t a tracker: {list}' : 'Skipped {n} addresses that aren’t trackers: {list}', { n: r.invalid.length, list: r.invalid.join(', ') })
    : t(r.trackers.length === 1 ? 'Saved {n} tracker.' : 'Saved {n} trackers.', { n: r.trackers.length })
}
$('#prefTrackers').addEventListener('change', e => saveTrackerPref(e.target.value))
$('#prefTrackersOn').addEventListener('change', e => setPref({ trackersForDownloads: e.target.checked }))
$('#prefTrackersReset').addEventListener('click', async () => {
  const defaults = await run(api.call('trackers:defaults'))
  if (defaults) saveTrackerPref(defaults.join('\n'))
})

// --- trackers (one torrent)
const trackersDlg = $('#trackersDialog')
const trackerUi = { ih: null, timer: null, key: '' }
const TRACKER_SOURCE = { torrent: () => t('From the torrent'), added: () => t('Added by you'), preferences: () => t('From Preferences') }
function trackerStateText (r) {
  if (r.state === 'working') {
    if (Number.isFinite(r.seeders)) return t(r.seeders === 1 ? 'Working, {n} seeder and {d} downloading' : 'Working, {n} seeders and {d} downloading', { n: r.seeders, d: r.leechers ?? 0 })
    return r.peers ? t(r.peers === 1 ? 'Working, {n} peer found' : 'Working, {n} peers found', { n: r.peers }) : t('Working')
  }
  if (r.state === 'checking') return t('Checking…')
  if (r.state === 'paused') return t('Paused')
  return r.message || t('Not responding')
}
async function openTrackers (ih) {
  trackerUi.ih = ih
  trackerUi.key = ''
  const tor = torrentById(ih)
  $('#trackersTitle').textContent = tor?.name ? t('Trackers for {name}', { name: tor.name }) : t('Trackers')
  $('#trackersAdd').value = ''
  $('#trackersList').innerHTML = ''
  await refreshTrackers()
  trackersDlg.showModal()
  trackersDlg.focus()
  clearInterval(trackerUi.timer)
  trackerUi.timer = setInterval(refreshTrackers, 2000)
}
trackersDlg.addEventListener('close', () => { clearInterval(trackerUi.timer); trackerUi.ih = null })
async function refreshTrackers () {
  if (!trackerUi.ih) return
  const data = await run(api.call('trackers:list', trackerUi.ih))
  if (!data) return trackersDlg.close()
  const rows = data.trackers
  const key = rows.map(r => r.url).join('\n')
  const list = $('#trackersList')
  if (key !== trackerUi.key) {
    trackerUi.key = key
    list.innerHTML = rows.length
      ? rows.map(r => `
        <li class="tracker" data-url="${escapeHtml(r.url)}">
          <span class="tracker-dot" aria-hidden="true"></span>
          <div>
            <div class="tracker-url" title="${escapeHtml(r.url)}">${escapeHtml(r.url)}</div>
            <div class="tracker-meta"><span class="tracker-state"></span><span>${escapeHtml(TRACKER_SOURCE[r.source]?.() || '')}</span></div>
          </div>
          <button type="button" class="btn btn-icon" data-remove title="${escapeHtml(t('Remove'))}" aria-label="${escapeHtml(t('Remove {url}', { url: r.url }))}"><svg class="ic"><use href="#i-plus"/></svg></button>
        </li>`).join('')
      : `<li class="tracker-empty">${escapeHtml(t('No trackers. This torrent finds people through DHT and the peers it’s connected to.'))}</li>`
  }
  for (const r of rows) {
    const li = list.querySelector(`[data-url="${CSS.escape(r.url)}"]`)
    if (!li) continue
    li.dataset.state = r.state
    li.querySelector('.tracker-state').textContent = trackerStateText(r)
  }
  const working = rows.filter(r => r.state === 'working').length
  const dead = rows.filter(r => r.state === 'failing' || r.state === 'invalid').length
  $('#trackersSummary').textContent = data.paused
    ? t('This torrent is paused. Resume it to check which trackers respond.')
    : t(dead ? '{working} of {total} working, {dead} not responding. People are also found through DHT and connected peers.' : '{working} of {total} working. People are also found through DHT and connected peers.', { working, total: rows.length, dead }) +
      (data.private ? ' ' + t('This is a private torrent, so trackers from Preferences aren’t added.') : '')
  const deadBtn = $('#trackersRemoveDead')
  deadBtn.disabled = !dead
  deadBtn.textContent = dead ? t(dead === 1 ? 'Remove {n} dead tracker' : 'Remove {n} dead trackers', { n: dead }) : t('Remove dead trackers')
}
$('#trackersList').addEventListener('click', async e => {
  const b = e.target.closest('[data-remove]')
  if (!b) return
  b.disabled = true
  await run(api.call('trackers:remove', trackerUi.ih, [b.closest('.tracker').dataset.url]))
  refreshTrackers()
})
$('#trackersRemoveDead').addEventListener('click', async () => {
  const n = await run(api.call('trackers:removeDead', trackerUi.ih))
  if (n) toast(t(n === 1 ? 'Removed {n} dead tracker.' : 'Removed {n} dead trackers.', { n }))
  refreshTrackers()
})
async function addTrackersFromBox () {
  const box = $('#trackersAdd')
  if (!box.value.trim()) return box.focus()
  const r = await run(api.call('trackers:add', trackerUi.ih, box.value))
  if (!r) return
  box.value = r.invalid.join('\n')
  if (r.invalid.length) toast(t(r.invalid.length === 1 ? 'That isn’t a tracker address. Trackers start with udp://, http://, https:// or wss://.' : 'Some of those aren’t tracker addresses. Trackers start with udp://, http://, https:// or wss://.'), 'error')
  else if (r.added) toast(t(r.added === 1 ? 'Added {n} tracker.' : 'Added {n} trackers.', { n: r.added }))
  refreshTrackers()
}
$('#trackersAddBtn').addEventListener('click', addTrackersFromBox)
$('#trackersAdd').addEventListener('keydown', e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); addTrackersFromBox() } })
$('#trackersForm').addEventListener('submit', e => { if (e.submitter?.value !== 'close') e.preventDefault() })

$('#prefAutoPlay').addEventListener('change', e => setPref({ autoPlay: e.target.checked }))
$('#prefAskPath').addEventListener('change', e => setPref({ askSavePath: e.target.checked }))
function syncUploadRows () {
  for (const id of ['#prefUpLimit', '#prefRatio']) $(id).closest('.pref-row').hidden = !prefs.allowUploads
}
$('#prefUploads').addEventListener('change', async e => { await setPref({ allowUploads: e.target.checked }); syncUploadRows() })
$('#prefNotify').addEventListener('change', e => setPref({ notifyOnComplete: e.target.checked }))
$('#prefLogin').addEventListener('change', e => setPref({ openAtLogin: e.target.checked }))
$('#prefTray').addEventListener('change', e => setPref({ closeToTray: e.target.checked }))
$('#prefTheme').addEventListener('change', async e => { await setPref({ theme: e.target.value }); applyTheme() })
// main rebuilds its menus; the window reloads in the new language and reopens Preferences
$('#prefLanguage').addEventListener('change', async e => {
  await setPref({ language: e.target.value })
  try { sessionStorage.setItem('reopenPrefs', '1') } catch {}
  location.reload()
})
$('#prefPlayer').addEventListener('change', async e => {
  if (e.target.value === 'custom') {
    prefs = await run(api.call('prefs:chooseExternalPlayer')) || prefs
    if (prefs.externalPlayer !== 'custom') e.target.value = prefs.externalPlayer || 'builtin'
  } else {
    await setPref({ externalPlayer: e.target.value })
  }
  renderPlayerPath()
})
$('#prefHandlerBtn').addEventListener('click', async () => {
  if (await run(api.call('prefs:makeDefaultHandler'))) {
    $('#prefHandlerState').textContent = t('Magnetic opens magnet links.')
    $('#prefHandlerBtn').hidden = true
  }
})

api.onMenu(action => {
  if (action === 'add-magnet') { if (player.active) closePlayer(); $('#magnetInput').focus() }
  if (action === 'open-torrent') run(api.call('torrent:openDialog'))
  if (action === 'share') openShare()
  if (action === 'prefs') openPrefs()
  if (action === 'search' && !player.active) $('#searchInput').focus()
})

// ---------- player ----------
const video = $('#video')
const playerEl = $('#player')
const seekCanvas = $('#seekCanvas')
const player = {
  active: false, ih: null, index: null, kind: 'video', name: '',
  playlist: [], strip: [], subs: [], hover: null, dragging: false, loadToken: 0,
  posterTried: false, artwork: null
}
const cast = { active: false, name: '', time: 0, duration: 0, paused: false, polling: false }

// one source of truth for the transport, whether the video plays here or on a TV
// a converted stream (see startConverted) starts at a keyframe, so its clock needs the offset
const curTime = () => cast.active ? cast.time
  : player.tx ? (player.tx.target ?? player.tx.offset + video.currentTime) : video.currentTime
const curDuration = () => cast.active ? (cast.duration || video.duration)
  : player.tx ? (player.tx.duration || NaN) : video.duration
const isPaused = () => cast.active ? cast.paused : video.paused

function pickDefaultFile (t) {
  const all = t.files.filter(isMedia)
  if (!all.length) return null
  // skip files the person unticked (archive items arrive with duplicate copies unticked)
  const media = all.some(f => f.selected) ? all.filter(f => f.selected) : all
  const videos = media.filter(f => f.kind === 'video')
  const pool = videos.length ? videos : media
  return pool.reduce((a, b) => (b.length > a.length ? b : a)).index
}

async function waitForFiles (ih, token) {
  let t = torrentById(ih)
  if (t?.status === 'paused') await run(api.call('torrent:resume', ih))
  while (!(t = torrentById(ih))?.files.length) {
    if (token !== player.loadToken || !t) return null
    await new Promise(r => setTimeout(r, 400))
  }
  return t
}

async function openPlayer (ih, index) {
  const token = ++player.loadToken
  // the built-in player tells the queue what's being watched, so it gets the bandwidth
  if (!prefs.externalPlayer || prefs.externalPlayer === 'builtin') await api.call('player:watching', ih).catch(() => {})

  // people who prefer VLC (or another app) skip the built-in player entirely
  if (prefs.externalPlayer && prefs.externalPlayer !== 'builtin') {
    if (index == null) {
      toast(t('Fetching torrent details…'))
      const tor = await waitForFiles(ih, token)
      if (!tor) return
      index = pickDefaultFile(tor)
      if (index == null) return toast(t('This torrent has no video or audio files.'), 'error')
    }
    try {
      await api.call('media:external', ih, index)
      toast(t('Opening in your video player.'))
    } catch (err) { toast(err.message, 'error') }
    return
  }

  closeMenus()
  player.active = true
  player.ih = ih
  playerEl.hidden = false
  showStatus(t('Connecting to peers…'))
  $('#playerError').hidden = true
  $('#playlist').hidden = true
  $('#playerTitle').textContent = torrentById(ih)?.name || t('Loading…')
  wake()

  if (index == null) {
    // magnets need metadata before we know which file to play
    const tor = await waitForFiles(ih, token)
    if (token !== player.loadToken) return
    if (!tor) return closePlayer()
    index = pickDefaultFile(tor)
    if (index == null) { closePlayer(); return toast(t('This torrent has no video or audio files.'), 'error') }
  }
  if (token !== player.loadToken) return

  stopEmbedded()
  savePosition()
  const media = await run(api.call('media:stream', ih, index))
  if (!media || token !== player.loadToken) { if (!media) closePlayer(); return }

  player.index = index
  player.url = media.url
  player.pendingSeek = null
  player.pendingAudio = null
  player.tx = null
  player.probe = null
  player.kind = media.kind
  player.name = media.name
  player.mime = media.mime
  player.strip = []
  player.posterTried = false
  player.artwork = torrentById(ih)?.poster || null
  clearSubtitles()
  player.subOffset = Number(store.get(`suboff:${ih}:${index}`)) || 0
  $('#playerTitle').textContent = media.name
  setupAudioCard(media)
  showStatus(t('Fetching the first pieces…'))
  setMediaSession()

  if (cast.active) {
    // keep casting: send the new file to the same device
    $('#video').removeAttribute('src')
    await castTo(cast.deviceId, 0)
  } else {
    video.src = media.url
    video.play().catch(() => {})
  }
  probeAndAdapt(token)
  buildPlaylist()
  loadTorrentSubtitles()
  startEmbedded()
  pollStrip()
}

function closePlayer () {
  player.loadToken++
  api.call('player:watching', null).catch(() => {})
  stopEmbedded()
  savePosition()
  if (cast.active) stopCasting(false)
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {})
  if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {})
  video.pause()
  video.removeAttribute('src')
  video.load() // aborts the HTTP request so WebTorrent stops prioritising those pieces
  player.tx = null
  player.probe = null
  clearSubtitles()
  api.call('player:aspect', 0).catch(() => {})
  api.call('player:playing', false).catch(() => {})
  clearMediaSession()
  player.active = false
  player.ih = null
  player.index = null
  playerEl.hidden = true
  playerEl.classList.remove('idle')
  closeMenus()
}

const posKey = () => `pos:${player.ih}:${player.index}`
function savePosition () {
  if (!player.ih || player.index == null) return
  const t = curTime()
  const d = curDuration()
  if (!d) return
  if (t > 5 && t < d - 15) store.set(posKey(), t)
  else store.del(posKey())
  rememberWatch(t, d)
}

function showStatus (text) {
  $('#playerStatus').hidden = !text || cast.active
  if (text) $('#playerStatusText').textContent = text
}

function updatePlayerFromTorrents () {
  const tor = torrentById(player.ih)
  if (!tor) return closePlayer()
  const f = tor.files[player.index]
  $('#playerStats').innerHTML = tor.status === 'paused'
    ? `<span>${escapeHtml(t('Paused'))}</span>`
    : `<span>${escapeHtml(t('{pct} downloaded', { pct: f ? pct(f.progress) : '' }))}</span><span>${escapeHtml(t('Down {speed}', { speed: fmtSpeed(tor.downloadSpeed) }))}</span><span>${escapeHtml(t(tor.numPeers === 1 ? '{n} peer' : '{n} peers', { n: tor.numPeers }))}</span>`
  if (!$('#playerStatus').hidden && video.readyState < 3 && video.getAttribute('src')) {
    showStatus(tor.numPeers ? t(tor.numPeers === 1 ? 'Buffering from {n} peer, {speed}' : 'Buffering from {n} peers, {speed}', { n: tor.numPeers, speed: fmtSpeed(tor.downloadSpeed) }) : t('Looking for peers…'))
  }
  if (!$('#playlist').hidden) renderPlaylistProgress(tor)
  if (tor.poster && tor.poster !== player.artwork && player.kind === 'video') { player.artwork = tor.poster; setMediaSession() }
}

async function pollStrip () {
  const token = player.loadToken
  while (player.active && token === player.loadToken) {
    const buckets = Math.max(40, Math.floor(seekCanvas.clientWidth / 3))
    const strip = await api.call('media:strip', player.ih, player.index, buckets).catch(() => null)
    if (strip && token === player.loadToken) { player.strip = strip; drawSeek() }
    await new Promise(r => setTimeout(r, 1000))
  }
}

// --- audio: cover art + tags
async function setupAudioCard (media) {
  const isAudio = media.kind === 'audio'
  $('#audioCard').hidden = !isAudio
  $('#audioArt').hidden = true
  if (!isAudio) return
  const fallback = media.name.replace(/\.[^.]+$/, '')
  $('#audioTitle').textContent = fallback
  $('#audioSub').textContent = ''
  const token = player.loadToken
  const meta = await api.call('media:metadata', player.ih, player.index).catch(() => null)
  if (token !== player.loadToken) return
  const art = meta?.picture || torrentById(player.ih)?.poster
  if (art) { $('#audioArt').src = art; $('#audioArt').hidden = false }
  $('#audioTitle').textContent = meta?.title || fallback
  $('#audioSub').textContent = [meta?.artist, meta?.album].filter(Boolean).join(', ')
  player.meta = meta
  player.artwork = art || null
  setMediaSession()
}

// --- system media controls (media keys, Now Playing, lock screen)
function setMediaSession () {
  if (!('mediaSession' in navigator)) return
  const meta = player.meta && player.kind === 'audio' ? player.meta : null
  navigator.mediaSession.metadata = new MediaMetadata({
    title: meta?.title || player.name.replace(/\.[^.]+$/, ''),
    artist: meta?.artist || '',
    album: meta?.album || torrentById(player.ih)?.name || '',
    artwork: player.artwork ? [{ src: player.artwork, sizes: '512x512' }] : []
  })
  const handlers = {
    play: () => isPaused() && togglePlay(),
    pause: () => !isPaused() && togglePlay(),
    previoustrack: () => step(-1),
    nexttrack: () => step(1),
    seekbackward: d => seekTo(curTime() - (d.seekOffset || 10)),
    seekforward: d => seekTo(curTime() + (d.seekOffset || 10)),
    seekto: d => seekTo(d.seekTime)
  }
  for (const [action, fn] of Object.entries(handlers)) {
    try { navigator.mediaSession.setActionHandler(action, fn) } catch {}
  }
}
function clearMediaSession () {
  if (!('mediaSession' in navigator)) return
  navigator.mediaSession.metadata = null
  for (const a of ['play', 'pause', 'previoustrack', 'nexttrack', 'seekbackward', 'seekforward', 'seekto']) {
    try { navigator.mediaSession.setActionHandler(a, null) } catch {}
  }
}

// --- poster from a video frame, for torrents that don't ship cover art
function maybeCapturePoster () {
  if (player.posterTried || player.kind !== 'video' || cast.active || !video.videoWidth) return
  const t = torrentById(player.ih)
  if (!t || t.poster) { player.posterTried = true; return }
  const dur = curDuration()
  if (!Number.isFinite(dur) || curTime() < Math.min(60, dur * 0.1)) return
  try {
    const probe = document.createElement('canvas')
    probe.width = 16; probe.height = 9
    const pctx = probe.getContext('2d')
    pctx.drawImage(video, 0, 0, 16, 9)
    const px = pctx.getImageData(0, 0, 16, 9).data
    let lum = 0
    for (let i = 0; i < px.length; i += 4) lum += 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]
    if (lum / (px.length / 4) < 28) return // mostly black: credits or a fade. try again later
    player.posterTried = true
    const c = document.createElement('canvas')
    c.width = 640
    c.height = Math.round(640 * video.videoHeight / video.videoWidth)
    c.getContext('2d').drawImage(video, 0, 0, c.width, c.height)
    api.call('media:savePoster', player.ih, c.toDataURL('image/jpeg', 0.82)).catch(() => {})
  } catch {
    player.posterTried = true // canvas tainted or decode issue; don't keep trying
  }
}

// --- playlist
function buildPlaylist () {
  const t = torrentById(player.ih)
  const media = t ? t.files.filter(isMedia) : []
  const chosen = media.filter(f => f.selected || f.index === player.index)
  player.playlist = (chosen.length ? chosen : media).sort(naturalSort)
  const multi = player.playlist.length > 1
  $('#prevBtn').hidden = !multi
  $('#nextBtn').hidden = !multi
  $('#playlistBtn').hidden = !multi
  $('#playlistItems').innerHTML = player.playlist.map(f => `
    <li data-index="${f.index}" class="${f.index === player.index ? 'current' : ''}">
      <button><span class="file-name">${escapeHtml(f.name)}</span><span class="pl-pct">${pct(f.progress)}</span></button>
    </li>`).join('')
}
function renderPlaylistProgress (t) {
  for (const li of $('#playlistItems').children) {
    const f = t.files[Number(li.dataset.index)]
    if (f) li.querySelector('.pl-pct').textContent = pct(f.progress)
  }
}
function step (dir) {
  const i = player.playlist.findIndex(f => f.index === player.index)
  const next = player.playlist[i + dir]
  if (next) openPlayer(player.ih, next.index)
  return !!next
}
$('#playlistItems').addEventListener('click', e => {
  const li = e.target.closest('li')
  if (li) openPlayer(player.ih, Number(li.dataset.index))
})
$('#playlistBtn').addEventListener('click', () => { $('#playlist').hidden = !$('#playlist').hidden })
$('#prevBtn').addEventListener('click', () => step(-1))
$('#nextBtn').addEventListener('click', () => step(1))

// --- subtitles
// Every source (a file in the torrent, a track inside an .mkv, a file from disk, a download
// from OpenSubtitles) becomes a cue list we own. Only the active one is loaded into a
// TextTrack, so shifting the timing just reloads that list with an offset.
let ENCODINGS = []
api.call('subs:encodings').then(e => { ENCODINGS = e }).catch(() => {})
const subStyle = { size: 'm', bg: 'shade', ...(store.get('subStyle') || {}) }
function applySubStyle () {
  playerEl.dataset.subSize = subStyle.size
  playerEl.dataset.subBg = subStyle.bg
}
applySubStyle()

const trackPool = []
function acquireTrack () {
  let tr = trackPool.find(t => !t.inUse)
  if (!tr) { tr = video.addTextTrack('subtitles'); trackPool.push(tr) }
  tr.inUse = true
  tr.mode = 'disabled'
  return tr
}
function emptyTrack (tr) {
  const mode = tr.mode
  if (mode === 'disabled') tr.mode = 'hidden' // cues are only readable on an enabled track
  while (tr.cues && tr.cues.length) tr.removeCue(tr.cues[0])
  tr.mode = mode
}
const cueShift = () => player.subOffset - (player.tx?.offset || 0)
function makeCue (c, off) {
  const end = c.end + off
  if (end <= 0) return null
  const cue = new VTTCue(Math.max(0, c.start + off), end, c.text)
  if (c.line === 0) cue.line = 0
  return cue
}
function fillTrack (sub) {
  emptyTrack(sub.track)
  for (const c of sub.cues) {
    const cue = makeCue(c, cueShift())
    if (cue) sub.track.addCue(cue)
  }
}

const pickKey = () => `subpick:${player.ih}:${player.index}`
const offKey = () => `suboff:${player.ih}:${player.index}`
const encKey = sub => `subenc:${player.ih}:${sub.key}`
const activeSubObj = () => player.subs[player.subIndex] || null
const activeSub = () => player.subIndex ?? -1
const baseName = n => String(n || t('Subtitles')).split(/[\\/]/).pop().replace(/\.[^.]+$/, '')
const encLabel = id => (ENCODINGS.find(e => e.id === id)?.label || id || '').replace(/\s*\(.*\)$/, '')
const fmtOffset = v => ltr(`${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(1)} s`)

function clearSubtitles () {
  for (const s of player.subs) { emptyTrack(s.track); s.track.mode = 'disabled'; s.track.inUse = false }
  player.subs = []
  player.subIndex = -1
  player.subManual = false
  player.subRestoring = false
  renderCcMenu()
}

function addSub (spec) {
  const existing = player.subs.find(s => s.key === spec.key)
  if (existing) {
    Object.assign(existing, spec, { track: existing.track })
    if (existing === activeSubObj()) fillTrack(existing)
    renderCcMenu()
    return existing
  }
  const sub = { cues: [], detail: '', ...spec, track: acquireTrack() }
  player.subs.push(sub)
  autoSelectSubtitle()
  renderCcMenu()
  return sub
}

function selectSubtitle (i, manual = false) {
  const prev = activeSubObj()
  if (prev && player.subs.indexOf(prev) !== i) { emptyTrack(prev.track); prev.track.mode = 'disabled' }
  player.subIndex = i
  const sub = activeSubObj()
  if (sub) { fillTrack(sub); sub.track.mode = 'showing' }
  if (manual) {
    player.subManual = true
    store.set(pickKey(), sub ? { key: sub.key, path: sub.kind === 'disk' ? sub.source : null } : { off: true })
    if (sub?.lang) store.set('subLang', sub.lang)
    if (cast.active) recastSoon()
  }
  renderCcMenu()
}

// what you picked for this file wins; then your usual language, your system language, a name match
function autoSelectSubtitle () {
  if (player.subManual || player.kind !== 'video' || !player.subs.length) return
  const remembered = store.get(pickKey())
  if (remembered?.off) { if (player.subIndex !== -1) selectSubtitle(-1); player.subManual = true; return }
  if (remembered?.key) {
    const i = player.subs.findIndex(s => s.key === remembered.key)
    if (i >= 0) { selectSubtitle(i); player.subManual = true; return }
    if (remembered.path && !player.subRestoring) { player.subRestoring = true; loadDiskSubtitle(remembered.path, false) }
  }
  const sys = (navigator.language || 'en').slice(0, 2).toLowerCase()
  const pref = store.get('subLang')
  const base = player.name.replace(/\.[^.]+$/, '').toLowerCase()
  const score = s => (s.lang && s.lang === pref ? 4 : 0) + (s.lang && s.lang === sys ? 2 : 0) + (s.kind === 'file' && s.detail.toLowerCase().startsWith(base) ? 1 : 0)
  let best = 0
  player.subs.forEach((s, i) => { if (score(s) > score(player.subs[best])) best = i })
  const cur = activeSubObj()
  if (!cur || score(player.subs[best]) > score(cur)) selectSubtitle(best)
}

async function loadTorrentSubtitles () {
  const token = player.loadToken
  const t = torrentById(player.ih)
  if (!t || player.kind !== 'video') return
  for (const f of t.files.filter(f => f.kind === 'subtitle')) {
    const key = `t:${f.index}`
    const choice = store.get(`subenc:${player.ih}:${key}`) || 'auto'
    const r = await api.call('media:subtitle', player.ih, f.index, choice).catch(() => null)
    if (token !== player.loadToken) return
    if (!r) continue
    const lang = languageFromName(f.name)
    addSub({ key, lang, label: languageName(lang) || baseName(f.name), detail: f.name, kind: 'file', source: { ih: player.ih, index: f.index }, cues: parseSubtitles(r.text, f.name), encoding: r.encoding, encodingChoice: choice })
  }
}

async function loadDiskSubtitle (p, manual = true) {
  const key = `d:${p}`
  const choice = store.get(`subenc:${player.ih}:${key}`) || 'auto'
  const token = player.loadToken
  const r = await run(api.call('media:subtitleFile', p, choice))
  if (!r || token !== player.loadToken) return
  const lang = languageFromName(r.name)
  const cues = parseSubtitles(r.text, r.name)
  if (!cues.length) return toast(t('No subtitles found in {name}.', { name: r.name }), 'error')
  const sub = addSub({ key, lang, label: languageName(lang) || baseName(r.name), detail: r.name, kind: 'disk', source: p, cues, encoding: r.encoding, encodingChoice: choice })
  if (manual) selectSubtitle(player.subs.indexOf(sub), true)
}

function startEmbedded () {
  if (player.kind !== 'video' || !/\.(mkv|webm)$/i.test(player.name)) return
  player.embeddedFor = `${player.ih}:${player.index}`
  api.call('media:embeddedStart', player.ih, player.index).catch(() => {})
}
function stopEmbedded () {
  if (!player.embeddedFor) return
  const [ih, index] = player.embeddedFor.split(':')
  player.embeddedFor = null
  api.call('media:embeddedStop', ih, Number(index)).catch(() => {})
}
api.onEmbeddedSubs(msg => {
  if (!player.active || msg.ih !== player.ih || msg.index !== player.index) return
  if (msg.type === 'tracks') {
    for (const tr of msg.tracks) {
      const lang = normaliseLang(tr.language) || languageFromName(tr.name || '')
      const label = languageName(lang) || tr.name || t('Track {n}', { n: tr.number })
      const detail = tr.name && tr.name !== label ? t('{name}, in the video', { name: tr.name }) : t('In the video')
      addSub({ key: `e:${tr.number}`, lang, label, detail, kind: 'embedded', format: tr.type, cues: [] })
    }
  }
  if (msg.type === 'cues') {
    const active = activeSubObj()
    for (const c of msg.cues) {
      const sub = player.subs.find(s => s.key === `e:${c.track}`)
      if (!sub) continue
      const conv = sub.format === 'ass' || sub.format === 'ssa' ? assTextToCue(c.text) : { text: cleanCueText(c.text), line: null }
      if (!conv.text) continue
      const cue = { start: c.start, end: c.end, text: conv.text, line: conv.line }
      sub.cues.push(cue)
      if (sub === active) { const vc = makeCue(cue, cueShift()); if (vc) sub.track.addCue(vc) }
    }
  }
})

function setSubOffset (v, announce = false) {
  player.subOffset = Math.abs(v) < 0.05 ? 0 : Math.round(v * 10) / 10
  if (player.subOffset) store.set(offKey(), player.subOffset)
  else store.del(offKey())
  const sub = activeSubObj()
  if (sub) fillTrack(sub)
  if (announce) toast(player.subOffset ? t('Subtitle timing {offset}', { offset: fmtOffset(player.subOffset) }) : t('Subtitle timing reset'))
  renderCcMenu()
  if (cast.active) recastSoon()
}

async function changeEncoding (choice) {
  const sub = activeSubObj()
  if (!sub || (sub.kind !== 'file' && sub.kind !== 'disk')) return
  const r = sub.kind === 'file'
    ? await run(api.call('media:subtitle', sub.source.ih, sub.source.index, choice))
    : await run(api.call('media:subtitleFile', sub.source, choice))
  if (!r) return
  if (choice === 'auto') store.del(encKey(sub)); else store.set(encKey(sub), choice)
  Object.assign(sub, { cues: parseSubtitles(r.text, sub.detail), encoding: r.encoding, encodingChoice: choice })
  fillTrack(sub)
  renderCcMenu()
}

function renderCcMenu () {
  const panel = $('#ccMenu')
  const focused = document.activeElement && panel.contains(document.activeElement) ? focusKey(document.activeElement) : null
  const cur = activeSub()
  const sub = activeSubObj()
  const tracks = [`<button class="cc-track" role="menuitemradio" data-sub="-1" aria-checked="${cur === -1}"><span>${escapeHtml(t('Off'))}</span></button>`]
    .concat(player.subs.map((s, i) => `<button class="cc-track" role="menuitemradio" data-sub="${i}" aria-checked="${cur === i}"><span>${escapeHtml(s.label)}</span><small>${escapeHtml(s.detail || '')}</small></button>`))
    .join('')
  const seg = (items, value, attr, label) => `<div class="segmented" role="radiogroup" aria-label="${escapeHtml(label)}">${items.map(([v, l]) => `<button class="seg" role="radio" data-${attr}="${v}" aria-checked="${value === v}">${escapeHtml(l)}</button>`).join('')}</div>`
  const canEncode = sub && (sub.kind === 'file' || sub.kind === 'disk') && ENCODINGS.length
  const encRow = canEncode
    ? `<div class="cc-row"><label for="subEnc">${escapeHtml(t('Text encoding'))}</label><select id="subEnc" class="select" dir="ltr">${ENCODINGS.map(e => `<option value="${e.id}" ${(sub.encodingChoice || 'auto') === e.id ? 'selected' : ''}>${escapeHtml(e.id === 'auto' ? t('Automatic ({encoding})', { encoding: encLabel(sub.encoding) }) : e.label)}</option>`).join('')}</select></div>`
    : ''
  const audio = player.probe?.audio || []
  const curA = currentAudio()
  const audioBlock = audio.length > 1
    ? `<h4>${escapeHtml(t('Audio'))}</h4>${audio.map((a, i) => `<button class="cc-track" role="menuitemradio" data-audio="${i}" aria-checked="${curA === i}"><span>${escapeHtml(audioLabel(a, i))}</span><small>${escapeHtml(audioDetail(a))}</small></button>`).join('')}<hr>`
    : ''
  panel.innerHTML = `
    ${audioBlock}
    <h4>${escapeHtml(t('Subtitles'))}</h4>
    ${tracks}
    <div class="cc-actions">
      <button class="btn btn-small" data-cc="add">${escapeHtml(t('Add from file…'))}</button>
      <button class="btn btn-small" data-cc="search">${escapeHtml(t('Search online…'))}</button>
    </div>
    <hr>
    <div class="cc-row"><span>${escapeHtml(t('Timing'))}</span>
      <span class="stepper" dir="ltr">
        <button class="btn btn-icon" data-cc="earlier" aria-label="${escapeHtml(t('Show subtitles 0.1 seconds earlier'))}"><svg class="ic"><use href="#i-minus"/></svg></button>
        <output aria-live="polite">${fmtOffset(player.subOffset || 0)}</output>
        <button class="btn btn-icon" data-cc="later" aria-label="${escapeHtml(t('Show subtitles 0.1 seconds later'))}"><svg class="ic"><use href="#i-plus"/></svg></button>
      </span>
    </div>
    <div class="cc-note">${player.subOffset ? `${escapeHtml(t('Saved for this video.'))} <button class="cc-reset" data-cc="reset">${escapeHtml(t('Reset'))}</button>` : escapeHtml(t('Press G or H to shift by a tenth of a second.'))}</div>
    <div class="cc-row"><span>${escapeHtml(t('Size'))}</span>${seg([['s', 'S'], ['m', 'M'], ['l', 'L'], ['xl', 'XL']], subStyle.size, 'size', t('Subtitle size'))}</div>
    <div class="cc-row"><span>${escapeHtml(t('Background'))}</span>${seg([['none', t('None')], ['shade', t('Shaded')], ['solid', t('Solid')]], subStyle.bg, 'bg', t('Subtitle background'))}</div>
    ${encRow}
    ${cast.active && cast.type === 'airplay' && sub ? `<div class="cc-note">${escapeHtml(t('AirPlay can’t show these subtitles on the TV.'))}</div>` : ''}`
  $('#ccBtn').classList.toggle('on', cur >= 0)
  if (focused) panel.querySelector(focused)?.focus({ preventScroll: true })
}
function focusKey (el) {
  for (const a of ['audio', 'sub', 'cc', 'size', 'bg']) if (el.dataset?.[a] != null) return `[data-${a}="${el.dataset[a]}"]`
  return el.id ? `#${el.id}` : null
}

$('#ccBtn').addEventListener('click', e => toggleMenu($('#ccMenu'), e.currentTarget, e, renderCcMenu))
$('#ccMenu').addEventListener('click', async e => {
  const b = e.target.closest('button')
  if (!b) return
  const d = b.dataset
  if (d.audio != null) return selectAudio(Number(d.audio))
  if (d.sub != null) return selectSubtitle(Number(d.sub), true)
  if (d.size) { subStyle.size = d.size; store.set('subStyle', subStyle); applySubStyle(); renderCcMenu() }
  if (d.bg) { subStyle.bg = d.bg; store.set('subStyle', subStyle); applySubStyle(); renderCcMenu() }
  if (d.cc === 'earlier') setSubOffset((player.subOffset || 0) - 0.1)
  if (d.cc === 'later') setSubOffset((player.subOffset || 0) + 0.1)
  if (d.cc === 'reset') setSubOffset(0)
  if (d.cc === 'add') {
    closeMenus()
    const r = await run(api.call('media:subtitleFromDisk'))
    if (r) loadDiskSubtitle(r.path)
  }
  if (d.cc === 'search') { closeMenus(); openSubSearch() }
})
$('#ccMenu').addEventListener('change', e => { if (e.target.id === 'subEnc') changeEncoding(e.target.value) })

// --- online subtitle search
function searchLanguages () {
  return [...new Set([store.get('subLang'), (navigator.language || 'en').slice(0, 2).toLowerCase()].filter(Boolean))]
}
function openSubSearch () {
  video.pause()
  $('#subSearchLangs').value = searchLanguages().join(', ')
  $('#subSearchResults').innerHTML = ''
  $('#subSearchStatus').textContent = ''
  $('#subSearchDialog').showModal()
  runSubSearch()
}
async function runSubSearch () {
  const status = $('#subSearchStatus')
  const list = $('#subSearchResults')
  status.textContent = t('Searching OpenSubtitles…')
  list.innerHTML = ''
  const langs = $('#subSearchLangs').value.split(/[\s,]+/).map(l => l.trim().toLowerCase()).filter(Boolean)
    .map(l => normaliseLang(l) || l)
  try {
    const { results, query } = await api.call('subs:search', player.ih, player.index, langs)
    if (!results.length) { status.textContent = t('Nothing found for “{query}”. Try other languages.', { query }); return }
    const matched = results.filter(r => r.hashMatch).length
    status.textContent = matched
      ? t(matched === 1 ? '{n} found. {matched} is timed for this exact file.' : '{n} found. {matched} are timed for this exact file.', { n: results.length, matched })
      : t('{n} found for “{query}”. None are confirmed for this exact file, so timing may need adjusting.', { n: results.length, query })
    list.innerHTML = results.map(r => `
      <li>
        <div>
          <div class="r-name" title="${escapeHtml(r.fileName)}">${escapeHtml(r.release || r.fileName)}</div>
          <div class="r-meta">
            <span>${escapeHtml(languageName(normaliseLang(r.language)) || r.language)}</span>
            <span>${escapeHtml(t('{n} downloads', { n: r.downloads.toLocaleString('en') }))}</span>
            ${r.hashMatch ? `<span class="r-match">${escapeHtml(t('Matches this file'))}</span>` : ''}
            ${r.hearingImpaired ? `<span>${escapeHtml(t('Includes sound descriptions'))}</span>` : ''}
          </div>
        </div>
        <button type="button" class="btn btn-ghost btn-small" data-file-id="${r.fileId}">${escapeHtml(t('Use'))}</button>
      </li>`).join('')
  } catch (err) {
    // main marks errors that point at Preferences (the text itself may be translated)
    status.innerHTML = `${escapeHtml(err.message)}${/Preferences|الإعدادات/.test(err.message) ? ` <button type="button" class="btn btn-ghost btn-small" data-open-prefs>${escapeHtml(t('Open Preferences'))}</button>` : ''}`
  }
}
$('#subSearchForm').addEventListener('submit', e => {
  if (e.submitter?.value === 'close') return
  e.preventDefault()
  runSubSearch()
})
$('#subSearchGo').addEventListener('click', runSubSearch)
$('#subSearchDialog').addEventListener('click', async e => {
  if (e.target.closest('[data-open-prefs]')) { $('#subSearchDialog').close(); openPrefs(); return }
  const b = e.target.closest('[data-file-id]')
  if (!b) return
  b.disabled = true
  b.textContent = t('Downloading…')
  try {
    const r = await api.call('subs:download', Number(b.dataset.fileId))
    $('#subSearchDialog').close()
    await loadDiskSubtitle(r.path)
    if (r.remaining != null) toast(t('Subtitles added. {n} OpenSubtitles downloads left today.', { n: r.remaining }))
  } catch (err) {
    b.disabled = false
    b.textContent = t('Use')
    $('#subSearchStatus').textContent = err.message
  }
})

// --- speed
const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2]
function renderSpeedMenu () {
  $('#speedMenu').innerHTML = SPEEDS.map(s => `<button role="menuitemradio" data-speed="${s}" aria-checked="${video.playbackRate === s}">${s === 1 ? escapeHtml(t('Normal')) : `${s}×`}</button>`).join('')
  $('#speedBtn').textContent = `${video.playbackRate}×`
}
$('#speedBtn').addEventListener('click', e => toggleMenu($('#speedMenu'), e.currentTarget, e, renderSpeedMenu))
$('#speedMenu').addEventListener('click', e => {
  const s = e.target.closest('[data-speed]')?.dataset.speed
  closeMenus()
  if (s) { video.playbackRate = Number(s); renderSpeedMenu() }
})

// --- casting
let castListTimer = null
async function renderCastMenu () {
  const menu = $('#castMenu')
  if (cast.active) {
    menu.innerHTML = `<div class="menu-note">${escapeHtml(t('Playing on {name}', { name: cast.name }))}</div><button role="menuitem" data-cast="stop">${escapeHtml(t('Stop casting'))}</button>`
    return
  }
  const devices = await api.call('cast:list').catch(() => [])
  if (openMenu?.menu !== menu) return
  const label = { chromecast: 'Chromecast', airplay: 'AirPlay', dlna: 'DLNA' }
  menu.innerHTML = devices.length
    ? devices.map(d => `<button role="menuitem" data-cast="${escapeHtml(d.id)}"><span class="cast-name">${escapeHtml(d.name)}</span><span class="cast-type">${label[d.type]}</span></button>`).join('')
    : `<div class="menu-note">${escapeHtml(t('Looking for TVs and speakers on your network…'))}</div>`
}
$('#castBtn').addEventListener('click', e => {
  if (openMenu?.menu === $('#castMenu')) return closeMenus()
  $('#castMenu').innerHTML = `<div class="menu-note">${escapeHtml(t('Looking for TVs and speakers on your network…'))}</div>`
  showMenu($('#castMenu'), e.currentTarget, e.detail === 0)
  renderCastMenu()
  clearInterval(castListTimer)
  castListTimer = setInterval(() => { if (!cast.active) renderCastMenu() }, 1500)
  openMenu.onClose = () => clearInterval(castListTimer)
})
$('#castMenu').addEventListener('click', e => {
  const id = e.target.closest('[data-cast]')?.dataset.cast
  if (!id) return
  closeMenus()
  if (id === 'stop') stopCasting(true)
  else castTo(id, curTime() || 0)
})
let recastTimer = null
function recastSoon () {
  clearTimeout(recastTimer)
  // TVs reload the video to change subtitles, so wait until you've finished adjusting
  recastTimer = setTimeout(() => { if (cast.active) castTo(cast.deviceId, cast.time) }, 900)
}
async function castTo (deviceId, startTime) {
  try {
    const sub = activeSubObj()
    const vtt = sub && sub.cues.length ? cuesToVtt(sub.cues, player.subOffset || 0) : null
    const r = await api.call('cast:play', deviceId, player.ih, player.index, startTime, vtt)
    if (vtt && !r.subtitles && r.type === 'airplay' && !cast.active) toast(t('AirPlay can’t send subtitles, so the TV shows the video without them.'))
    Object.assign(cast, { active: true, deviceId, type: r.type, name: r.name, time: startTime, paused: false })
    video.pause()
    showStatus(null)
    $('#castOverlay').hidden = false
    $('#castOverlayText').textContent = t('Playing on {name}', { name: r.name })
    $('#castBtn').classList.add('on')
    api.call('player:playing', false).catch(() => {})
    pollCast()
  } catch (err) {
    toast(err.message, 'error')
  }
}
async function pollCast () {
  if (cast.polling) return
  cast.polling = true
  while (cast.active) {
    const s = await api.call('cast:status').catch(() => null)
    if (!cast.active) break
    if (s) {
      cast.time = s.currentTime
      cast.duration = s.duration || cast.duration
      cast.paused = s.paused
      setPlayIcon()
      updateTimeLabel()
      drawSeek()
    }
    await new Promise(r => setTimeout(r, 1000))
  }
  cast.polling = false
}
async function stopCasting (resumeHere) {
  const at = cast.time
  cast.active = false
  $('#castOverlay').hidden = true
  $('#castBtn').classList.remove('on')
  await api.call('cast:stop').catch(() => {})
  if (resumeHere && player.active) {
    const media = await run(api.call('media:stream', player.ih, player.index))
    if (!media) return
    if (!video.getAttribute('src')) video.src = media.url
    if (at) video.currentTime = at
    video.play().catch(() => {})
  }
  setPlayIcon()
}
$('#castStopBtn').addEventListener('click', () => stopCasting(true))

// --- audio conversion: AC3/DTS and similar play silently in Chromium, so ffmpeg converts them
async function probeAndAdapt (token) {
  if (player.kind !== 'video') return
  const info = await api.call('media:probe', player.ih, player.index).catch(() => null)
  if (!info || token !== player.loadToken) return
  player.probe = info
  renderAudioMenu()
  const chosen = preferredAudio(info)
  if (info.audio[chosen]?.needsConversion && !cast.active) {
    const at = curTime() || Number(store.get(posKey())) || 0
    await startConverted(at, chosen)
    const codec = info.audio[chosen].codec.toUpperCase().replace('EAC3', 'E-AC3')
    toast(t('This file’s {codec} sound can’t play directly, so Magnetic converts it while you watch.', { codec }))
  } else if (chosen !== currentAudio()) {
    enableNativeAudio(chosen)
  }
}
function renderAudioMenu () { if (openMenu?.menu === $('#ccMenu')) renderCcMenu() }
const audioLabel = (a, i) => a.title || languageName(normaliseLang(a.language)) || a.language || t('Track {n}', { n: i + 1 })
function audioDetail (a) {
  const lang = languageName(normaliseLang(a.language))
  const parts = []
  if (a.title && lang && !a.title.toLowerCase().includes(lang.toLowerCase())) parts.push(lang)
  if (a.channels && a.channels !== 'stereo' && a.channels !== 'mono') parts.push(a.channels)
  parts.push(a.codec.toUpperCase().replace('EAC3', 'E-AC3'))
  return parts.join(', ')
}
function currentAudio () {
  if (player.tx) return player.tx.audio
  const tr = video.audioTracks
  if (tr?.length) for (let i = 0; i < tr.length; i++) if (tr[i].enabled) return i
  return 0
}
function enableNativeAudio (n) {
  const tr = video.audioTracks
  if (!tr?.length) return
  for (let i = 0; i < tr.length; i++) tr[i].enabled = i === n
}
async function selectAudio (n) {
  const info = player.probe
  const a = info?.audio[n]
  if (!a || n === currentAudio()) return
  store.set(`audio:${player.ih}:${player.index}`, n)
  const lang = normaliseLang(a.language)
  if (lang) store.set('audioLang', lang)
  if (a.needsConversion) {
    await startConverted(curTime(), n)
  } else if (player.tx) {
    // back to playing the file directly, which seeks exactly and needs no ffmpeg
    player.pendingSeek = curTime()
    player.pendingAudio = n
    player.tx = null
    video.src = player.url
    video.play().catch(() => {})
    const sub = activeSubObj()
    if (sub) fillTrack(sub)
  } else {
    enableNativeAudio(n)
  }
  renderCcMenu()
  toast(t('Audio: {name}', { name: audioLabel(a, n) }))
}
function preferredAudio (info) {
  const remembered = store.get(`audio:${player.ih}:${player.index}`)
  if (Number.isInteger(remembered) && info.audio[remembered]) return remembered
  // the language picked last time, so a whole series stays in it
  const lang = store.get('audioLang')
  const byLang = lang ? info.audio.findIndex(a => normaliseLang(a.language) === lang) : -1
  if (byLang >= 0) return byLang
  const def = info.audio.findIndex(a => a.default)
  return def >= 0 ? def : 0
}
async function startConverted (at, audio) {
  const token = player.loadToken
  const keepPaused = !!player.tx && video.paused
  if (player.tx) player.tx.target = at
  else player.tx = { offset: 0, audio, target: at, duration: player.probe?.duration || null }
  showStatus(t('Converting the sound…'))
  let r
  try {
    r = await api.call('media:converted', player.ih, player.index, Math.max(0, at), audio)
  } catch (err) {
    showStatus(null)
    return toast(err.message, 'error')
  }
  if (token !== player.loadToken || !player.tx) return
  // a newer seek arrived while we waited: let that one win
  if (player.tx.target !== at) return
  player.tx = { offset: r.offset, audio, target: null, duration: player.probe?.duration || null }
  video.src = r.url
  if (!keepPaused) video.play().catch(() => {})
  const sub = activeSubObj()
  if (sub) fillTrack(sub)
}

// --- transport
function togglePlay () {
  if (cast.active) {
    cast.paused = !cast.paused
    setPlayIcon()
    api.call(cast.paused ? 'cast:pause' : 'cast:resume').catch(err => toast(err.message, 'error'))
    return
  }
  video.paused ? video.play().catch(() => {}) : video.pause()
}
function setPlayIcon () {
  const paused = isPaused()
  $('#playBtn use').setAttribute('href', paused ? '#i-play' : '#i-pause')
  $('#playBtn').setAttribute('aria-label', paused ? t('Play') : t('Pause'))
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = paused ? 'paused' : 'playing'
}
function seekTo (time) {
  const d = curDuration()
  if (!Number.isFinite(d)) return
  const t = Math.max(0, Math.min(d - 0.1, time))
  if (cast.active) {
    cast.time = t
    api.call('cast:seek', t).catch(err => toast(err.message, 'error'))
  } else if (player.tx) {
    player.tx.target = t
    clearTimeout(player.tx.seekTimer)
    player.tx.seekTimer = setTimeout(() => startConverted(t, player.tx.audio), 250)
  } else {
    video.currentTime = t
  }
  updateTimeLabel()
  drawSeek()
}
function setVolume (v) {
  video.volume = Math.max(0, Math.min(1, v))
  video.muted = video.volume === 0
  store.set('volume', video.volume)
}
function syncVolumeUi () {
  $('#volumeRange').value = video.muted ? 0 : video.volume
  $('#muteBtn use').setAttribute('href', video.muted || video.volume === 0 ? '#i-mute' : '#i-volume')
}
function updateTimeLabel () {
  $('#timeLabel').textContent = `${fmtClock(curTime())} / ${fmtClock(curDuration())}`
}
const savedVol = store.get('volume')
if (typeof savedVol === 'number') video.volume = savedVol

$('#playBtn').addEventListener('click', togglePlay)
$('#backBtn').addEventListener('click', closePlayer)
$('#muteBtn').addEventListener('click', () => { video.muted = !video.muted })
$('#volumeRange').addEventListener('input', e => setVolume(Number(e.target.value)))
$('#fullBtn').addEventListener('click', toggleFullscreen)
$('#pipBtn').addEventListener('click', () => {
  if (player.kind !== 'video' || cast.active) return
  document.pictureInPictureElement ? document.exitPictureInPicture() : video.requestPictureInPicture().catch(err => toast(err.message, 'error'))
})
async function openExternal () {
  video.pause()
  try {
    await api.call('media:external', player.ih, player.index)
    toast(t('Opening in your video player.'))
  } catch (err) { toast(err.message, 'error') }
}
$('#externalBtn').addEventListener('click', openExternal)
$('#errorExternalBtn').addEventListener('click', openExternal)
video.addEventListener('click', togglePlay)
video.addEventListener('dblclick', toggleFullscreen)
function toggleFullscreen () {
  document.fullscreenElement ? document.exitFullscreen() : playerEl.requestFullscreen().catch(() => {})
}

video.addEventListener('play', setPlayIcon)
video.addEventListener('pause', () => { setPlayIcon(); wake(); api.call('player:playing', false).catch(() => {}) })
video.addEventListener('playing', () => { showStatus(null); if (player.kind === 'video') api.call('player:playing', true).catch(() => {}) })
video.addEventListener('volumechange', syncVolumeUi)
video.addEventListener('waiting', () => showStatus(t('Fetching pieces…')))
video.addEventListener('canplay', () => showStatus(null))
video.addEventListener('seeking', () => { if (video.readyState < 3) showStatus(t('Fetching pieces for this point…')) })
video.addEventListener('seeked', () => showStatus(null))
video.addEventListener('loadedmetadata', () => {
  if (player.pendingAudio != null) { enableNativeAudio(player.pendingAudio); player.pendingAudio = null }
  if (player.pendingSeek != null) { video.currentTime = player.pendingSeek; player.pendingSeek = null; return drawSeek() }
  const saved = player.tx ? null : store.get(posKey())
  if (saved && saved < video.duration - 15) {
    video.currentTime = saved
    toast(t('Resumed at {time}.', { time: fmtClock(saved) }))
  }
  const isVideo = player.kind === 'video' && video.videoWidth > 0
  $('#pipBtn').hidden = !isVideo || !document.pictureInPictureEnabled
  if (isVideo && !document.fullscreenElement) api.call('player:aspect', video.videoWidth / video.videoHeight).catch(() => {})
  drawSeek()
})
let lastSave = 0
video.addEventListener('timeupdate', () => {
  if (cast.active) return
  updateTimeLabel()
  if (!player.dragging) drawSeek()
  if (Date.now() - lastSave > 5000) { lastSave = Date.now(); savePosition() }
  maybeCapturePoster()
})
video.addEventListener('ended', () => {
  store.del(posKey())
  rememberWatch(0, 0) // finished: drop it from Continue watching
  api.call('player:playing', false).catch(() => {})
  if (!step(1)) wake()
})
video.addEventListener('error', () => {
  if (!player.active || !video.getAttribute('src') || cast.active) return
  const code = video.error?.code
  showStatus(null)
  $('#playerErrorText').textContent = code === 4 || code === 3
    ? t('This file uses a format or codec the built-in player can’t decode. It keeps downloading, and you can watch it in VLC or another player while it does.')
    : t('Playback stopped because the stream was interrupted. Try again, or open it in another player.')
  $('#playerError').hidden = false
})

// --- seek bar: piece map + watched + playhead
function drawSeek () {
  if (!player.active) return
  const { ctx, w, h, dpr } = sizeCanvas(seekCanvas)
  ctx.clearRect(0, 0, w, h)
  const hot = player.hover != null || player.dragging
  const th = (hot ? 6 : 4) * dpr
  const y = (h - th) / 2
  const dur = curDuration()
  const played = Number.isFinite(dur) && dur > 0 ? Math.min(1, curTime() / dur) : 0
  const gold = '#F0BE4B'

  ctx.fillStyle = 'rgba(255,255,255,.16)'
  ctx.beginPath(); ctx.roundRect(0, y, w, th, th / 2); ctx.fill()

  ctx.save()
  ctx.beginPath(); ctx.roundRect(0, y, w, th, th / 2); ctx.clip()
  // gaps stay visible on both sides of the playhead: gold = on disk, bright = already watched
  const cells = player.strip.length ? player.strip : [0]
  const cw = w / cells.length
  const px = w * played
  for (let i = 0; i < cells.length; i++) {
    const x = i * cw
    const v = cells[i]
    const watched = x + cw / 2 <= px
    if (v > 0) {
      ctx.fillStyle = watched ? '#FFE3A1' : gold
      ctx.globalAlpha = watched ? 1 : 0.35 + 0.4 * v
    } else {
      ctx.fillStyle = '#fff'
      ctx.globalAlpha = watched ? 0.3 : 0
    }
    if (ctx.globalAlpha) ctx.fillRect(x, y, cw + 0.5, th)
  }
  ctx.globalAlpha = 1
  ctx.restore()

  if (player.hover != null) {
    ctx.fillStyle = 'rgba(255,255,255,.55)'
    ctx.fillRect(player.hover * w - dpr / 2, y - 3 * dpr, dpr, th + 6 * dpr)
  }
  ctx.fillStyle = '#fff'
  ctx.beginPath(); ctx.arc(px, h / 2, (hot ? 7 : 5.5) * dpr, 0, Math.PI * 2); ctx.fill()

  const seekEl = $('#seek')
  seekEl.setAttribute('aria-valuemax', String(Math.floor(dur || 0)))
  seekEl.setAttribute('aria-valuenow', String(Math.floor(curTime())))
  seekEl.setAttribute('aria-valuetext', t('{time} of {duration}', { time: fmtClock(curTime()), duration: fmtClock(dur) }))
}

const seekEl = $('#seek')
const ratioAt = e => {
  const r = seekEl.getBoundingClientRect()
  return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width))
}
function showTip (ratio) {
  const tip = $('#seekTip')
  const dur = curDuration()
  if (!Number.isFinite(dur)) { tip.hidden = true; return }
  const cells = player.strip
  const have = cells.length ? cells[Math.min(cells.length - 1, Math.floor(ratio * cells.length))] : 1
  tip.innerHTML = `${fmtClock(ratio * dur)}${have < 1 ? `<span class="tip-missing">${escapeHtml(t('not downloaded yet'))}</span>` : ''}`
  tip.hidden = false
  const w = seekEl.clientWidth
  const half = tip.offsetWidth / 2
  tip.style.left = `${Math.max(half, Math.min(w - half, ratio * w))}px`
}
seekEl.addEventListener('pointermove', e => {
  player.hover = ratioAt(e)
  showTip(player.hover)
  if (player.dragging && !cast.active) seekTo(player.hover * curDuration())
  else drawSeek()
})
seekEl.addEventListener('pointerleave', () => { if (!player.dragging) { player.hover = null; $('#seekTip').hidden = true; drawSeek() } })
seekEl.addEventListener('pointerdown', e => {
  if (player.dragging) return // ignore a second pointer mid-drag
  seekEl.setPointerCapture(e.pointerId)
  player.dragging = true
  if (!cast.active) seekTo(ratioAt(e) * curDuration())
})
seekEl.addEventListener('pointerup', e => {
  player.dragging = false
  seekEl.releasePointerCapture(e.pointerId)
  if (cast.active) seekTo(ratioAt(e) * curDuration()) // TVs get one seek on release, not a stream of them
  if (!seekEl.matches(':hover')) { player.hover = null; $('#seekTip').hidden = true }
  drawSeek()
})
window.addEventListener('resize', redrawStrips)

// --- auto-hide chrome: quick to appear, gentle to leave
let idleTimer = null
function wake (instant = false) {
  playerEl.classList.toggle('instant', instant)
  playerEl.classList.remove('idle')
  clearTimeout(idleTimer)
  idleTimer = setTimeout(() => {
    playerEl.classList.remove('instant')
    const busy = openMenu || isPaused() || player.dragging || cast.active || playerEl.querySelector('.chrome:hover, .playlist:hover')
    if (player.active && !busy) playerEl.classList.add('idle')
  }, 2600)
}
playerEl.addEventListener('pointermove', () => wake())

// ---------- keyboard: no animation on anything triggered from here ----------
document.addEventListener('keydown', e => {
  if (e.target.closest('input[type="text"], input[type="search"], input[type="number"], textarea, select, dialog')) return
  if (e.key === 'Escape' && openMenu) { closeMenus(); return }

  if (!player.active) {
    if (e.key === '/') { e.preventDefault(); $('#searchInput').focus() }
    return
  }
  if (e.metaKey || e.ctrlKey || e.altKey) return
  const k = e.key
  const actions = {
    ' ': togglePlay,
    k: togglePlay,
    ArrowLeft: () => seekTo(curTime() - 5),
    ArrowRight: () => seekTo(curTime() + 5),
    j: () => seekTo(curTime() - 10),
    l: () => seekTo(curTime() + 10),
    ArrowUp: () => setVolume(video.volume + 0.05),
    ArrowDown: () => setVolume(video.volume - 0.05),
    m: () => { video.muted = !video.muted },
    f: toggleFullscreen,
    n: () => step(1),
    p: () => step(-1),
    c: () => {
      if (!player.subs.length) return toast(t('No subtitles yet. Drop a subtitle file onto the player, or search online from the CC menu.'))
      const next = activeSub() + 1
      selectSubtitle(next >= player.subs.length ? -1 : next, true)
      toast(activeSub() >= 0 ? t('Subtitles: {name}', { name: activeSubObj().label }) : t('Subtitles off'))
    },
    g: () => setSubOffset((player.subOffset || 0) - 0.1, true),
    h: () => setSubOffset((player.subOffset || 0) + 0.1, true),
    '>': () => { const i = SPEEDS.indexOf(video.playbackRate); video.playbackRate = SPEEDS[Math.min(SPEEDS.length - 1, i + 1)] ?? 1; renderSpeedMenu() },
    '<': () => { const i = SPEEDS.indexOf(video.playbackRate); video.playbackRate = SPEEDS[Math.max(0, i - 1)] ?? 1; renderSpeedMenu() },
    Escape: () => { document.fullscreenElement ? document.exitFullscreen() : closePlayer() }
  }
  const handled = actions[k.length === 1 ? k.toLowerCase() : k] ||
    (/^[0-9]$/.test(k) ? () => seekTo((Number(k) / 10) * curDuration()) : null)
  if (handled) { e.preventDefault(); handled(); wake(true) }
})
