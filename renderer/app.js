import { MARK } from './mark.js'
import { parseSubtitles, cleanCueText, assTextToCue, cuesToVtt, languageFromName, languageName, normaliseLang } from './subtitles.js'

const api = window.api
document.documentElement.classList.add(`platform-${api.platform}`)

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
  if (!n) return '0 B'
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)))
  const v = n / 1024 ** i
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`
}
const fmtSpeed = n => `${fmtBytes(n)}/s`
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
  if (m < 1) return 'under a minute left'
  if (m < 60) return `${m} min left`
  const h = Math.floor(m / 60)
  return h < 48 ? `${h} h ${m % 60} min left` : `${Math.round(h / 24)} days left`
}
const pct = p => `${Math.floor((p || 0) * 100)}%`
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
  $('#toasts').append(el)
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
      ctx.fillStyle = t.status === 'paused' ? COLORS.faint : color
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
    ? `<span><b>${torrents.length}</b> ${torrents.length === 1 ? 'torrent' : 'torrents'}, ${active} active</span>
       <span>Down <b>${fmtSpeed(lastTotals.down)}</b></span><span>Up <b>${fmtSpeed(lastTotals.up)}</b></span>`
    : ''

  const shown = visibleTorrents()
  $('#noMatches').hidden = !(any && query && !shown.length)
  $('#noMatches').textContent = `No torrents match “${query}”.`
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
function statusParts (t, short) {
  if (t.status === 'metadata') return [['st-downloading', short ? 'Connecting' : `Connecting, ${t.numPeers} ${t.numPeers === 1 ? 'peer' : 'peers'}`]]
  if (t.status === 'downloading') {
    const parts = [['st-downloading', pct(t.progress)]]
    if (short) parts.push(['', fmtSpeed(t.downloadSpeed)])
    else {
      parts.push(['', `of ${fmtBytes(t.length)}`])
      const eta = fmtEta(t.timeRemaining)
      if (eta) parts.push(['', eta])
    }
    return parts
  }
  if (t.status === 'seeding') {
    const parts = [['st-seeding', 'Seeding'], ['', fmtBytes(t.length)]]
    if (!short && t.ratio) parts.push(['', `Ratio ${t.ratio.toFixed(2)}`])
    return parts
  }
  if (t.seedLimitReached) return [['st-seeding', 'Done seeding'], ...(short ? [] : [['', 'Reached your share ratio']])]
  const parts = [['st-paused', 'Paused']]
  if (t.length) parts.push(['', short ? pct(t.progress) : `${pct(t.progress)} of ${fmtBytes(t.length)}`])
  return parts
}
const partsHtml = parts => parts.map(([c, s]) => `<span class="${c}">${escapeHtml(s)}</span>`).join('')
const mediaKind = t => {
  const media = t.files.filter(isMedia)
  return media.some(f => f.kind === 'video') ? 'video' : media.length ? 'audio' : t.files.length ? 'none' : 'unknown'
}

function createCard (t) {
  const el = document.createElement('article')
  el.className = 'card'
  el.dataset.ih = t.infoHash
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
      <button class="btn btn-icon" data-act="more" aria-label="More actions" aria-haspopup="menu"><svg class="ic"><use href="#i-more"/></svg></button>
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

function updateCard (card, t) {
  const name = t.name || 'Fetching torrent details…'
  card.title.textContent = name
  card.title.title = t.name
  card.fallbackTitle.textContent = name
  card.meta.innerHTML = partsHtml(statusParts(t, true))
  const kind = mediaKind(t)
  const playable = kind !== 'none'
  card.art.setAttribute('aria-label', playable ? `Play ${name}` : `Show files in ${name}`)
  card.overlayIcon.setAttribute('href', playable ? '#i-play' : '#i-file')
  card.fallbackIcon.setAttribute('href', kind === 'audio' ? '#i-music' : kind === 'none' ? '#i-file' : '#i-play')
  if (t.poster !== card.poster) {
    card.poster = t.poster
    card.img.classList.remove('loaded')
    if (t.poster) card.img.src = t.poster
    else card.img.removeAttribute('src')
  }
  const paused = t.status === 'paused'
  card.badge.hidden = !paused
  card.badge.textContent = t.seedLimitReached ? 'Done' : 'Paused'
  card.pause.querySelector('use').setAttribute('href', paused ? '#i-resume' : '#i-pause')
  card.pause.title = paused ? 'Resume' : 'Pause'
  card.pause.setAttribute('aria-label', card.pause.title)
  drawStrip(card.canvas, t)
}

function createRow (t) {
  const el = document.createElement('article')
  el.className = 'torrent'
  el.dataset.ih = t.infoHash
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
        <button class="btn btn-primary t-play" data-act="play"><svg class="ic"><use href="#i-play"/></svg>Play</button>
        <button class="btn btn-icon t-pause" data-act="pause"><svg class="ic"><use href="#i-pause"/></svg></button>
        <button class="btn btn-icon" data-act="more" aria-label="More actions" aria-haspopup="menu"><svg class="ic"><use href="#i-more"/></svg></button>
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

function updateRow (row, t) {
  row.name.textContent = t.name || 'Fetching torrent details…'
  row.main.title = t.name

  row.meta.innerHTML = partsHtml(statusParts(t, false))

  row.rates.innerHTML = t.status === 'paused'
    ? ''
    : `<span>Down <b>${fmtSpeed(t.downloadSpeed)}</b></span><span>Up <b>${fmtSpeed(t.uploadSpeed)}</b></span><span><b>${t.numPeers}</b> peers</span>`

  const media = t.files.filter(isMedia)
  row.play.hidden = t.files.length > 0 && !media.length
  const kind = media.some(f => f.kind === 'video') ? 'i-play' : media.length ? 'i-music' : 'i-file'
  row.posterIcon.setAttribute('href', `#${kind}`)
  if (t.poster !== row.poster) {
    row.poster = t.poster
    row.img.classList.remove('loaded')
    if (t.poster) row.img.src = t.poster
    else row.img.removeAttribute('src')
  }

  const paused = t.status === 'paused'
  row.pause.querySelector('use').setAttribute('href', paused ? '#i-resume' : '#i-pause')
  row.pause.title = paused ? 'Resume' : 'Pause'
  row.pause.setAttribute('aria-label', row.pause.title)

  drawStrip(row.canvas, t)

  const isOpen = openRows.has(t.infoHash)
  row.el.classList.toggle('open', isOpen)
  row.main.setAttribute('aria-expanded', String(isOpen))
  row.files.hidden = !isOpen
  if (isOpen) renderFiles(row.files, t, row)
}

function renderFiles (container, t, holder) {
  const key = t.infoHash + '\n' + t.files.map(f => f.name).join('\n')
  if (key !== holder.fileKey) {
    holder.fileKey = key
    container.innerHTML = t.files.length
      ? t.files.map(f => `
        <li class="file" data-ih="${t.infoHash}" data-index="${f.index}">
          <input type="checkbox" data-act="select" aria-label="Download ${escapeHtml(f.name)}">
          <span class="file-name" title="${escapeHtml(f.path)}">${escapeHtml(f.name)}</span>
          <span class="file-size">${fmtBytes(f.length)}</span>
          <span class="file-pct"></span>
          <button type="button" class="btn btn-icon" data-act="play-file" aria-label="Play ${escapeHtml(f.name)}" ${isMedia(f) ? '' : 'disabled'}>
            <svg class="ic"><use href="#i-play"/></svg>
          </button>
        </li>`).join('')
      : '<li class="file"><span></span><span class="file-name">The file list appears once peers send the torrent details.</span></li>'
  }
  for (const f of t.files) {
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
  const t = torrentById(ih)
  if (!t) return
  filesDialogIh = ih
  filesHolder.fileKey = ''
  $('#filesTitle').textContent = t.name || 'Files'
  renderFiles($('#filesDialogList'), t, filesHolder)
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
  menu.style.transformOrigin = above ? 'bottom right' : 'top right'
  menu.style.left = `${Math.max(8, Math.min(r.right - mw, innerWidth - mw - 8))}px`
  menu.style.top = `${above ? r.top - mh - 6 : r.bottom + 6}px`
}
$('#rowMenu').addEventListener('click', async e => {
  const act = e.target.closest('[data-act]')?.dataset.act
  const ih = rowMenuIh
  closeMenus()
  if (!act) return
  if (act === 'files') openFiles(ih)
  if (act === 'folder') run(api.call('torrent:showFolder', ih))
  if (act === 'magnet') { await run(api.call('torrent:copyMagnet', ih)); toast('Magnet link copied.') }
  if (act === 'save') { if (await run(api.call('torrent:saveFile', ih))) toast('Torrent file saved.') }
  if (act === 'remove') confirmRemove(ih)
})

function confirmRemove (ih) {
  const t = torrentById(ih)
  const dlg = $('#removeDialog')
  $('#removeTitle').textContent = `Remove “${t?.name || 'this torrent'}”?`
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
  if (!looksLikeTorrentId(value)) return toast('Paste a magnet link (magnet:?xt=…), a 40-character info hash or a link to a .torrent file.', 'error')
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
  $('.advanced').open = false
  renderSharePath()
  $('#shareDialog').returnValue = ''
  $('#shareDialog').showModal()
  $('#shareDialog').focus()
}
function renderSharePath () {
  $('#sharePath').textContent = sharePathValue || 'Nothing chosen yet.'
  $('#sharePath').classList.toggle('chosen', !!sharePathValue)
  $('#shareCreateBtn').disabled = !sharePathValue
}
$('#shareBtn').addEventListener('click', () => openShare())
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
  toast('Preparing torrent. Large folders take a moment to hash.')
  const r = await run(api.call('torrent:seedPath', sharePathValue, opts))
  if (r) toast(`Sharing “${r.name}”. Magnet link copied.`)
})

// ---------- preferences ----------
const prefsDlg = $('#prefsDialog')
async function openPrefs () {
  prefs = await run(api.call('prefs:get')) || prefs
  $('#prefPath').textContent = prefs.downloadPath
  $('#prefDownLimit').value = prefs.downloadLimit || ''
  $('#prefUpLimit').value = prefs.uploadLimit || ''
  $('#prefRatio').value = prefs.seedRatioLimit || ''
  $('#prefAutoPlay').checked = !!prefs.autoPlay
  $('#prefPlayer').value = prefs.externalPlayer || 'builtin'
  renderPlayerPath()
  $('#prefTheme').value = prefs.theme || 'system'
  $('#prefNotify').checked = !!prefs.notifyOnComplete
  $('#prefLogin').checked = !!prefs.openAtLogin
  $('#prefTray').checked = !!prefs.closeToTray
  $('#prefTrayRow').hidden = !appInfo.tray
  const isDefault = await run(api.call('prefs:isDefaultHandler'))
  $('#prefHandlerState').textContent = isDefault ? 'onlyTorrent opens magnet links.' : 'Another app opens magnet links.'
  $('#prefHandlerBtn').hidden = !!isDefault
  const creds = await run(api.call('subs:credentials')) || {}
  $('#prefOsKey').value = creds.apiKey || ''
  $('#prefOsUser').value = creds.username || ''
  $('#prefOsPass').value = ''
  $('#prefOsPass').placeholder = creds.hasPassword ? 'Saved' : 'Not set'
  $('#prefAbout').textContent = `onlyTorrent ${appInfo.version || ''}. ${appInfo.webrtc ? 'Connects to peers in web browsers as well as regular BitTorrent apps.' : 'Browser peers are unavailable on this system.'}`
  prefsDlg.showModal()
  prefsDlg.focus()
}
function renderPlayerPath () {
  const p = prefs.externalPlayer
  $('#prefPlayerPath').textContent = p === 'custom' && prefs.externalPlayerPath
    ? prefs.externalPlayerPath
    : p === 'vlc' ? 'VLC plays almost every format. Install it from videolan.org.' : 'Built-in player. You can still open any file in VLC from the player.'
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
$('#prefsBtn').addEventListener('click', openPrefs)
$('#prefOsKey').addEventListener('change', e => run(api.call('subs:setCredentials', { apiKey: e.target.value })))
$('#prefOsUser').addEventListener('change', e => run(api.call('subs:setCredentials', { username: e.target.value })))
$('#prefOsPass').addEventListener('change', async e => {
  const ok = await run(api.call('subs:setCredentials', { password: e.target.value }))
  if (ok) { e.target.placeholder = e.target.value ? 'Saved' : 'Not set'; e.target.value = '' }
})
$('#osLink').addEventListener('click', e => { e.preventDefault(); run(api.call('app:openSubtitleSite')) })
$('#prefPathBtn').addEventListener('click', async () => {
  prefs = await run(api.call('prefs:chooseDownloadPath')) || prefs
  $('#prefPath').textContent = prefs.downloadPath
})
$('#prefAutoPlay').addEventListener('change', e => setPref({ autoPlay: e.target.checked }))
$('#prefNotify').addEventListener('change', e => setPref({ notifyOnComplete: e.target.checked }))
$('#prefLogin').addEventListener('change', e => setPref({ openAtLogin: e.target.checked }))
$('#prefTray').addEventListener('change', e => setPref({ closeToTray: e.target.checked }))
$('#prefTheme').addEventListener('change', async e => { await setPref({ theme: e.target.value }); applyTheme() })
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
    $('#prefHandlerState').textContent = 'onlyTorrent opens magnet links.'
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
const curTime = () => cast.active ? cast.time : video.currentTime
const curDuration = () => cast.active ? (cast.duration || video.duration) : video.duration
const isPaused = () => cast.active ? cast.paused : video.paused

function pickDefaultFile (t) {
  const media = t.files.filter(isMedia)
  if (!media.length) return null
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

  // people who prefer VLC (or another app) skip the built-in player entirely
  if (prefs.externalPlayer && prefs.externalPlayer !== 'builtin') {
    if (index == null) {
      toast('Fetching torrent details…')
      const t = await waitForFiles(ih, token)
      if (!t) return
      index = pickDefaultFile(t)
      if (index == null) return toast('This torrent has no video or audio files.', 'error')
    }
    try {
      await api.call('media:external', ih, index)
      toast('Opening in your video player.')
    } catch (err) { toast(err.message, 'error') }
    return
  }

  closeMenus()
  player.active = true
  player.ih = ih
  playerEl.hidden = false
  showStatus('Connecting to peers…')
  $('#playerError').hidden = true
  $('#playlist').hidden = true
  $('#playerTitle').textContent = torrentById(ih)?.name || 'Loading…'
  wake()

  if (index == null) {
    // magnets need metadata before we know which file to play
    const t = await waitForFiles(ih, token)
    if (token !== player.loadToken) return
    if (!t) return closePlayer()
    index = pickDefaultFile(t)
    if (index == null) { closePlayer(); return toast('This torrent has no video or audio files.', 'error') }
  }
  if (token !== player.loadToken) return

  stopEmbedded()
  savePosition()
  const media = await run(api.call('media:stream', ih, index))
  if (!media || token !== player.loadToken) { if (!media) closePlayer(); return }

  player.index = index
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
  showStatus('Fetching the first pieces…')
  setMediaSession()

  if (cast.active) {
    // keep casting: send the new file to the same device
    $('#video').removeAttribute('src')
    await castTo(cast.deviceId, 0)
  } else {
    video.src = media.url
    video.play().catch(() => {})
  }
  buildPlaylist()
  loadTorrentSubtitles()
  startEmbedded()
  pollStrip()
}

function closePlayer () {
  player.loadToken++
  stopEmbedded()
  savePosition()
  if (cast.active) stopCasting(false)
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {})
  if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {})
  video.pause()
  video.removeAttribute('src')
  video.load() // aborts the HTTP request so WebTorrent stops prioritising those pieces
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
}

function showStatus (text) {
  $('#playerStatus').hidden = !text || cast.active
  if (text) $('#playerStatusText').textContent = text
}

function updatePlayerFromTorrents () {
  const t = torrentById(player.ih)
  if (!t) return closePlayer()
  const f = t.files[player.index]
  $('#playerStats').innerHTML = t.status === 'paused'
    ? '<span>Paused</span>'
    : `<span>${f ? pct(f.progress) : ''} downloaded</span><span>Down ${fmtSpeed(t.downloadSpeed)}</span><span>${t.numPeers} peers</span>`
  if (!$('#playerStatus').hidden && video.readyState < 3 && video.getAttribute('src')) {
    showStatus(t.numPeers ? `Buffering from ${t.numPeers} ${t.numPeers === 1 ? 'peer' : 'peers'}, ${fmtSpeed(t.downloadSpeed)}` : 'Looking for peers…')
  }
  if (!$('#playlist').hidden) renderPlaylistProgress(t)
  if (t.poster && t.poster !== player.artwork && player.kind === 'video') { player.artwork = t.poster; setMediaSession() }
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
  const dur = video.duration
  if (!Number.isFinite(dur) || video.currentTime < Math.min(60, dur * 0.1)) return
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
  player.playlist = t ? t.files.filter(isMedia).sort(naturalSort) : []
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
    const cue = makeCue(c, player.subOffset)
    if (cue) sub.track.addCue(cue)
  }
}

const pickKey = () => `subpick:${player.ih}:${player.index}`
const offKey = () => `suboff:${player.ih}:${player.index}`
const encKey = sub => `subenc:${player.ih}:${sub.key}`
const activeSubObj = () => player.subs[player.subIndex] || null
const activeSub = () => player.subIndex ?? -1
const baseName = n => String(n || 'Subtitles').split(/[\\/]/).pop().replace(/\.[^.]+$/, '')
const encLabel = id => (ENCODINGS.find(e => e.id === id)?.label || id || '').replace(/\s*\(.*\)$/, '')
const fmtOffset = v => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(1)} s`

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
  if (!cues.length) return toast(`No subtitles found in ${r.name}.`, 'error')
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
      const label = languageName(lang) || tr.name || `Track ${tr.number}`
      const detail = tr.name && tr.name !== label ? `${tr.name}, in the video` : 'In the video'
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
      if (sub === active) { const vc = makeCue(cue, player.subOffset); if (vc) sub.track.addCue(vc) }
    }
  }
})

function setSubOffset (v, announce = false) {
  player.subOffset = Math.abs(v) < 0.05 ? 0 : Math.round(v * 10) / 10
  if (player.subOffset) store.set(offKey(), player.subOffset)
  else store.del(offKey())
  const sub = activeSubObj()
  if (sub) fillTrack(sub)
  if (announce) toast(player.subOffset ? `Subtitle timing ${fmtOffset(player.subOffset)}` : 'Subtitle timing reset')
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
  const tracks = [`<button class="cc-track" role="menuitemradio" data-sub="-1" aria-checked="${cur === -1}"><span>Off</span></button>`]
    .concat(player.subs.map((s, i) => `<button class="cc-track" role="menuitemradio" data-sub="${i}" aria-checked="${cur === i}"><span>${escapeHtml(s.label)}</span><small>${escapeHtml(s.detail || '')}</small></button>`))
    .join('')
  const seg = (items, value, attr, label) => `<div class="segmented" role="radiogroup" aria-label="${label}">${items.map(([v, l]) => `<button class="seg" role="radio" data-${attr}="${v}" aria-checked="${value === v}">${l}</button>`).join('')}</div>`
  const canEncode = sub && (sub.kind === 'file' || sub.kind === 'disk') && ENCODINGS.length
  const encRow = canEncode
    ? `<div class="cc-row"><label for="subEnc">Text encoding</label><select id="subEnc" class="select">${ENCODINGS.map(e => `<option value="${e.id}" ${(sub.encodingChoice || 'auto') === e.id ? 'selected' : ''}>${escapeHtml(e.id === 'auto' ? `Automatic (${encLabel(sub.encoding)})` : e.label)}</option>`).join('')}</select></div>`
    : ''
  panel.innerHTML = `
    <h4>Subtitles</h4>
    ${tracks}
    <div class="cc-actions">
      <button class="btn btn-small" data-cc="add">Add from file…</button>
      <button class="btn btn-small" data-cc="search">Search online…</button>
    </div>
    <hr>
    <div class="cc-row"><span>Timing</span>
      <span class="stepper">
        <button class="btn btn-icon" data-cc="earlier" aria-label="Show subtitles 0.1 seconds earlier"><svg class="ic"><use href="#i-minus"/></svg></button>
        <output aria-live="polite">${fmtOffset(player.subOffset || 0)}</output>
        <button class="btn btn-icon" data-cc="later" aria-label="Show subtitles 0.1 seconds later"><svg class="ic"><use href="#i-plus"/></svg></button>
      </span>
    </div>
    <div class="cc-note">${player.subOffset ? 'Saved for this video. <button class="cc-reset" data-cc="reset">Reset</button>' : 'Press G or H to shift by a tenth of a second.'}</div>
    <div class="cc-row"><span>Size</span>${seg([['s', 'S'], ['m', 'M'], ['l', 'L'], ['xl', 'XL']], subStyle.size, 'size', 'Subtitle size')}</div>
    <div class="cc-row"><span>Background</span>${seg([['none', 'None'], ['shade', 'Shaded'], ['solid', 'Solid']], subStyle.bg, 'bg', 'Subtitle background')}</div>
    ${encRow}
    ${cast.active && cast.type === 'airplay' && sub ? '<div class="cc-note">AirPlay can’t show these subtitles on the TV.</div>' : ''}`
  $('#ccBtn').classList.toggle('on', cur >= 0)
  if (focused) panel.querySelector(focused)?.focus({ preventScroll: true })
}
function focusKey (el) {
  for (const a of ['sub', 'cc', 'size', 'bg']) if (el.dataset?.[a] != null) return `[data-${a}="${el.dataset[a]}"]`
  return el.id ? `#${el.id}` : null
}

$('#ccBtn').addEventListener('click', e => toggleMenu($('#ccMenu'), e.currentTarget, e, renderCcMenu))
$('#ccMenu').addEventListener('click', async e => {
  const b = e.target.closest('button')
  if (!b) return
  const d = b.dataset
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
  status.textContent = 'Searching OpenSubtitles…'
  list.innerHTML = ''
  const langs = $('#subSearchLangs').value.split(/[\s,]+/).map(l => l.trim().toLowerCase()).filter(Boolean)
    .map(l => normaliseLang(l) || l)
  try {
    const { results, query } = await api.call('subs:search', player.ih, player.index, langs)
    if (!results.length) { status.textContent = `Nothing found for “${query}”. Try other languages.`; return }
    const matched = results.filter(r => r.hashMatch).length
    status.textContent = matched
      ? `${results.length} found. ${matched} ${matched === 1 ? 'is' : 'are'} timed for this exact file.`
      : `${results.length} found for “${query}”. None are confirmed for this exact file, so timing may need adjusting.`
    list.innerHTML = results.map(r => `
      <li>
        <div>
          <div class="r-name" title="${escapeHtml(r.fileName)}">${escapeHtml(r.release || r.fileName)}</div>
          <div class="r-meta">
            <span>${escapeHtml(languageName(normaliseLang(r.language)) || r.language)}</span>
            <span>${r.downloads.toLocaleString()} downloads</span>
            ${r.hashMatch ? '<span class="r-match">Matches this file</span>' : ''}
            ${r.hearingImpaired ? '<span>Includes sound descriptions</span>' : ''}
          </div>
        </div>
        <button type="button" class="btn btn-ghost btn-small" data-file-id="${r.fileId}">Use</button>
      </li>`).join('')
  } catch (err) {
    status.innerHTML = `${escapeHtml(err.message)}${/Preferences/.test(err.message) ? ' <button type="button" class="btn btn-ghost btn-small" data-open-prefs>Open Preferences</button>' : ''}`
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
  b.textContent = 'Downloading…'
  try {
    const r = await api.call('subs:download', Number(b.dataset.fileId))
    $('#subSearchDialog').close()
    await loadDiskSubtitle(r.path)
    if (r.remaining != null) toast(`Subtitles added. ${r.remaining} OpenSubtitles downloads left today.`)
  } catch (err) {
    b.disabled = false
    b.textContent = 'Use'
    $('#subSearchStatus').textContent = err.message
  }
})

// --- speed
const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2]
function renderSpeedMenu () {
  $('#speedMenu').innerHTML = SPEEDS.map(s => `<button role="menuitemradio" data-speed="${s}" aria-checked="${video.playbackRate === s}">${s === 1 ? 'Normal' : `${s}×`}</button>`).join('')
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
    menu.innerHTML = `<div class="menu-note">Playing on ${escapeHtml(cast.name)}</div><button role="menuitem" data-cast="stop">Stop casting</button>`
    return
  }
  const devices = await api.call('cast:list').catch(() => [])
  if (openMenu?.menu !== menu) return
  const label = { chromecast: 'Chromecast', airplay: 'AirPlay', dlna: 'DLNA' }
  menu.innerHTML = devices.length
    ? devices.map(d => `<button role="menuitem" data-cast="${escapeHtml(d.id)}"><span class="cast-name">${escapeHtml(d.name)}</span><span class="cast-type">${label[d.type]}</span></button>`).join('')
    : '<div class="menu-note">Looking for TVs and speakers on your network…</div>'
}
$('#castBtn').addEventListener('click', e => {
  if (openMenu?.menu === $('#castMenu')) return closeMenus()
  $('#castMenu').innerHTML = '<div class="menu-note">Looking for TVs and speakers on your network…</div>'
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
  else castTo(id, video.currentTime || 0)
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
    if (vtt && !r.subtitles && r.type === 'airplay' && !cast.active) toast('AirPlay can’t send subtitles, so the TV shows the video without them.')
    Object.assign(cast, { active: true, deviceId, type: r.type, name: r.name, time: startTime, paused: false })
    video.pause()
    showStatus(null)
    $('#castOverlay').hidden = false
    $('#castOverlayText').textContent = `Playing on ${r.name}`
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
  $('#playBtn').setAttribute('aria-label', paused ? 'Play' : 'Pause')
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = paused ? 'paused' : 'playing'
}
function seekTo (time) {
  const d = curDuration()
  if (!Number.isFinite(d)) return
  const t = Math.max(0, Math.min(d - 0.1, time))
  if (cast.active) {
    cast.time = t
    api.call('cast:seek', t).catch(err => toast(err.message, 'error'))
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
    toast('Opening in your video player.')
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
video.addEventListener('waiting', () => showStatus('Fetching pieces…'))
video.addEventListener('canplay', () => showStatus(null))
video.addEventListener('seeking', () => { if (video.readyState < 3) showStatus('Fetching pieces for this point…') })
video.addEventListener('seeked', () => showStatus(null))
video.addEventListener('loadedmetadata', () => {
  const saved = store.get(posKey())
  if (saved && saved < video.duration - 15) {
    video.currentTime = saved
    toast(`Resumed at ${fmtClock(saved)}.`)
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
  api.call('player:playing', false).catch(() => {})
  if (!step(1)) wake()
})
video.addEventListener('error', () => {
  if (!player.active || !video.getAttribute('src') || cast.active) return
  const code = video.error?.code
  showStatus(null)
  $('#playerErrorText').textContent = code === 4 || code === 3
    ? 'This file uses a format or codec the built-in player can’t decode. It keeps downloading, and you can watch it in VLC or another player while it does.'
    : 'Playback stopped because the stream was interrupted. Try again, or open it in another player.'
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
  seekEl.setAttribute('aria-valuetext', `${fmtClock(curTime())} of ${fmtClock(dur)}`)
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
  tip.innerHTML = `${fmtClock(ratio * dur)}${have < 1 ? '<span class="tip-missing">not downloaded yet</span>' : ''}`
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
      if (!player.subs.length) return toast('No subtitles yet. Drop a subtitle file onto the player, or search online from the CC menu.')
      const next = activeSub() + 1
      selectSubtitle(next >= player.subs.length ? -1 : next, true)
      toast(activeSub() >= 0 ? `Subtitles: ${activeSubObj().label}` : 'Subtitles off')
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
