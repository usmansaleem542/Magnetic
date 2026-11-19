// Subtitle parsing shared by the player (and unit tests). Every format becomes the same
// cue list: { start, end, text, line }, times in seconds, text in WebVTT cue markup.

const LANGS = {
  ar: 'Arabic', en: 'English', fr: 'French', de: 'German', es: 'Spanish', it: 'Italian', pt: 'Portuguese',
  ru: 'Russian', tr: 'Turkish', fa: 'Persian', ur: 'Urdu', hi: 'Hindi', bn: 'Bengali', zh: 'Chinese',
  ja: 'Japanese', ko: 'Korean', nl: 'Dutch', pl: 'Polish', sv: 'Swedish', no: 'Norwegian', da: 'Danish',
  fi: 'Finnish', el: 'Greek', he: 'Hebrew', id: 'Indonesian', ms: 'Malay', th: 'Thai', vi: 'Vietnamese',
  uk: 'Ukrainian', cs: 'Czech', hu: 'Hungarian', ro: 'Romanian', bg: 'Bulgarian', hr: 'Croatian', sr: 'Serbian',
  sk: 'Slovak', sl: 'Slovenian', tl: 'Filipino'
}
// three-letter codes (MKV tracks, some file names) and spelled-out names
const ALIASES = {
  ara: 'ar', eng: 'en', fre: 'fr', fra: 'fr', ger: 'de', deu: 'de', spa: 'es', ita: 'it', por: 'pt', rus: 'ru',
  tur: 'tr', per: 'fa', fas: 'fa', urd: 'ur', hin: 'hi', ben: 'bn', chi: 'zh', zho: 'zh', jpn: 'ja', kor: 'ko',
  dut: 'nl', nld: 'nl', pol: 'pl', swe: 'sv', nor: 'no', dan: 'da', fin: 'fi', gre: 'el', ell: 'el', heb: 'he',
  ind: 'id', may: 'ms', msa: 'ms', tha: 'th', vie: 'vi', ukr: 'uk', cze: 'cs', ces: 'cs', hun: 'hu', rum: 'ro',
  ron: 'ro', bul: 'bg', hrv: 'hr', srp: 'sr', slo: 'sk', slk: 'sk', slv: 'sl', fil: 'tl', tgl: 'tl',
  pob: 'pt', 'pt-br': 'pt', 'es-419': 'es', 'zh-cn': 'zh', 'zh-tw': 'zh', 'zh-hans': 'zh', 'zh-hant': 'zh'
}
for (const [code, name] of Object.entries(LANGS)) ALIASES[name.toLowerCase()] = code

export const languageName = code => LANGS[code] || null

/** Normalise any language tag ("ara", "Arabic", "pt-BR") to a two-letter code, or null. */
export function normaliseLang (tag) {
  if (!tag) return null
  const t = String(tag).trim().toLowerCase()
  if (LANGS[t]) return t
  if (ALIASES[t]) return ALIASES[t]
  const base = t.split(/[-_]/)[0]
  return LANGS[base] ? base : (ALIASES[base] || null)
}

/** Find the language in a subtitle file name such as "Movie.2010.ar.srt" or "Arabic.srt". */
export function languageFromName (name) {
  const base = String(name).split(/[\\/]/).pop().replace(/\.[^.]+$/, '').toLowerCase()
  const parts = base.split(/[\s._\-[\]()]+/).filter(Boolean)
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i]
    if (ALIASES[p] || (LANGS[p] && (i > 0 || parts.length === 1))) return normaliseLang(p)
  }
  return null
}

// ---------- time ----------
function parseTime (s) {
  const m = /(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.,:](\d{1,3}))?/.exec(s.trim())
  if (!m) return NaN
  const frac = m[4] ? Number(m[4].padEnd(3, '0')) / 1000 : 0
  return Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + frac
}

export function formatVttTime (t) {
  t = Math.max(0, t)
  const h = Math.floor(t / 3600)
  const m = Math.floor((t % 3600) / 60)
  const s = Math.floor(t % 60)
  const ms = Math.round((t - Math.floor(t)) * 1000)
  const p = (n, w = 2) => String(n).padStart(w, '0')
  return `${p(h)}:${p(m)}:${p(s)}.${p(ms === 1000 ? 999 : ms, 3)}`
}

// ---------- cue text ----------
const escapeText = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** Keep italic/bold/underline from SRT/VTT markup, drop anything else (fonts, colours, voices). */
export function cleanCueText (raw) {
  const kept = []
  const marked = String(raw).replace(/<\s*(\/?)\s*([ibu])\s*>/gi, (_, close, tag) => {
    kept.push(`<${close}${tag.toLowerCase()}>`)
    return `\u0000${kept.length - 1}\u0000`
  })
  const stripped = marked.replace(/<[^>]*>/g, '').replace(/\{\\[^}]*\}/g, '')
  return escapeText(stripped.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'))
    .replace(/\u0000(\d+)\u0000/g, (_, i) => kept[Number(i)])
    .trim()
}

/** Convert an ASS/SSA event's text: override tags to markup, \N to line breaks. */
export function assTextToCue (raw) {
  let line = null
  let open = { i: false, b: false, u: false }
  let out = ''
  const text = String(raw)
  const re = /\{([^}]*)\}/g
  let last = 0
  let m
  const closeAll = () => ['u', 'b', 'i'].map(t => (open[t] ? `</${t}>` : '')).join('')
  while ((m = re.exec(text))) {
    out += escapeText(text.slice(last, m.index))
    last = re.lastIndex
    for (const tag of m[1].split('\\').filter(Boolean)) {
      const an = /^an?(\d)/.exec(tag)
      if (an) {
        const n = Number(an[1])
        // \an7-9 (and legacy \a5-7,9-11) place the line at the top of the picture
        if (tag.startsWith('an') ? n >= 7 : n >= 5) line = 0
      }
      const st = /^([ibu])(\d)$/.exec(tag)
      if (st) {
        const [, t, v] = st
        const on = v !== '0'
        if (on && !open[t]) { out += `<${t}>`; open[t] = true } else if (!on && open[t]) { out += `</${t}>`; open[t] = false }
      }
    }
  }
  out += escapeText(text.slice(last))
  out += closeAll()
  out = out.replace(/\\N/g, '\n').replace(/\\n/g, '\n').replace(/\\h/g, ' ')
  return { text: out.trim(), line }
}

// ---------- parsers ----------
function parseSrtLike (text) {
  const cues = []
  const blocks = text.replace(/\r\n?/g, '\n').split(/\n{2,}/)
  for (const block of blocks) {
    const lines = block.split('\n')
    const i = lines.findIndex(l => l.includes('-->'))
    if (i < 0) continue
    const [a, rest] = lines[i].split('-->')
    const b = rest.trim().split(/\s+/)[0]
    const start = parseTime(a)
    const end = parseTime(b)
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue
    const body = cleanCueText(lines.slice(i + 1).join('\n'))
    if (body) cues.push({ start, end: Math.max(end, start + 0.1), text: body, line: null })
  }
  return cues
}

export function parseAss (text) {
  const cues = []
  let format = null
  let inEvents = false
  for (const rawLine of text.replace(/\r\n?/g, '\n').split('\n')) {
    const line = rawLine.trim()
    if (/^\[.*\]$/.test(line)) { inEvents = /^\[events\]$/i.test(line); continue }
    if (!inEvents) continue
    if (/^format\s*:/i.test(line)) {
      format = line.replace(/^format\s*:/i, '').split(',').map(s => s.trim().toLowerCase())
      continue
    }
    if (!/^dialogue\s*:/i.test(line) || !format) continue
    const values = line.replace(/^dialogue\s*:/i, '').split(',')
    // the text field is last and may itself contain commas
    const fields = values.slice(0, format.length - 1).concat(values.slice(format.length - 1).join(','))
    const get = k => fields[format.indexOf(k)]
    const start = parseTime(get('start') || '')
    const end = parseTime(get('end') || '')
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue
    const { text: body, line: pos } = assTextToCue(get('text') || '')
    if (body) cues.push({ start, end, text: body, line: pos })
  }
  return cues.sort((a, b) => a.start - b.start)
}

/** Parse subtitle text. `hint` is a file name or format ("srt", "vtt", "ass", "ssa"). */
export function parseSubtitles (text, hint = '') {
  const clean = String(text).replace(/^﻿/, '')
  const fmt = String(hint).toLowerCase().split('.').pop()
  if (fmt === 'ass' || fmt === 'ssa' || /^\s*\[script info\]/i.test(clean)) return parseAss(clean)
  return parseSrtLike(clean) // also handles WebVTT: header, NOTE and STYLE blocks have no "-->"
}

/** Serialise cues back to WebVTT, shifted by `offset` seconds (used for casting). */
export function cuesToVtt (cues, offset = 0) {
  const body = cues
    .map(c => ({ ...c, start: c.start + offset, end: c.end + offset }))
    .filter(c => c.end > 0)
    .map(c => `${formatVttTime(c.start)} --> ${formatVttTime(c.end)}${c.line === 0 ? ' line:0' : ''}\n${c.text}`)
  return `WEBVTT\n\n${body.join('\n\n')}\n`
}
