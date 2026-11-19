// Turn subtitle bytes into text. Many .srt files predate UTF-8: Arabic ones are usually
// Windows-1256, Russian ones Windows-1251, and reading them as UTF-8 shows gibberish.
import iconv from 'iconv-lite'
import chardet from 'chardet'

export const ENCODINGS = [
  { id: 'auto', label: 'Automatic' },
  { id: 'utf-8', label: 'Unicode (UTF-8)' },
  { id: 'utf-16le', label: 'Unicode (UTF-16)' },
  { id: 'windows-1256', label: 'Arabic (Windows-1256)' },
  { id: 'iso-8859-6', label: 'Arabic (ISO-8859-6)' },
  { id: 'windows-1251', label: 'Cyrillic (Windows-1251)' },
  { id: 'windows-1252', label: 'Western (Windows-1252)' },
  { id: 'windows-1250', label: 'Central European (Windows-1250)' },
  { id: 'windows-1253', label: 'Greek (Windows-1253)' },
  { id: 'windows-1254', label: 'Turkish (Windows-1254)' },
  { id: 'windows-1255', label: 'Hebrew (Windows-1255)' },
  { id: 'windows-874', label: 'Thai (Windows-874)' },
  { id: 'gb18030', label: 'Chinese Simplified (GB18030)' },
  { id: 'big5', label: 'Chinese Traditional (Big5)' },
  { id: 'shift_jis', label: 'Japanese (Shift JIS)' },
  { id: 'euc-kr', label: 'Korean (EUC-KR)' }
]

// The legacy encoding most subtitle files in a language were written in.
const LANGUAGE_ENCODING = {
  ar: 'windows-1256', fa: 'windows-1256', ur: 'windows-1256',
  ru: 'windows-1251', uk: 'windows-1251', bg: 'windows-1251', sr: 'windows-1251', mk: 'windows-1251',
  pl: 'windows-1250', cs: 'windows-1250', sk: 'windows-1250', hu: 'windows-1250', ro: 'windows-1250', hr: 'windows-1250', sl: 'windows-1250',
  el: 'windows-1253', tr: 'windows-1254', he: 'windows-1255', th: 'windows-874',
  zh: 'gb18030', ja: 'shift_jis', ko: 'euc-kr'
}

// chardet sometimes names the ISO sibling of the Windows code page subtitle files actually use
const NORMALISE = {
  'iso-8859-1': 'windows-1252',
  'iso-8859-2': 'windows-1250',
  'iso-8859-5': 'windows-1251',
  'iso-8859-7': 'windows-1253',
  'iso-8859-8': 'windows-1255',
  'iso-8859-9': 'windows-1254',
  'iso-8859-6': 'windows-1256',
  'koi8-r': 'koi8-r',
  'utf-16le': 'utf-16le',
  'utf-16be': 'utf-16be'
}

function validUtf8 (buf) {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf)
    return true
  } catch {
    return false
  }
}

function fromBom (buf) {
  if (buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) return 'utf-8'
  if (buf[0] === 0xFF && buf[1] === 0xFE) return 'utf-16le'
  if (buf[0] === 0xFE && buf[1] === 0xFF) return 'utf-16be'
  return null
}

export function detectEncoding (buf, langHint) {
  const bom = fromBom(buf)
  if (bom) return bom
  if (validUtf8(buf)) return 'utf-8'
  if (langHint && LANGUAGE_ENCODING[langHint]) return LANGUAGE_ENCODING[langHint]
  const guesses = chardet.analyse(buf) || []
  for (const g of guesses) {
    const name = String(g.name).toLowerCase()
    const enc = NORMALISE[name] || name
    if (iconv.encodingExists(enc) && enc !== 'utf-8' && enc !== 'ascii') return enc
  }
  return 'windows-1252'
}

/** Decode subtitle bytes. `encoding` is 'auto' or an id from ENCODINGS. */
export function decodeSubtitle (buffer, { encoding = 'auto', lang = null } = {}) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer)
  const used = encoding === 'auto' ? detectEncoding(buf, lang) : encoding
  const text = iconv.decode(buf, iconv.encodingExists(used) ? used : 'utf-8').replace(/^﻿/, '')
  return { text, encoding: used }
}
