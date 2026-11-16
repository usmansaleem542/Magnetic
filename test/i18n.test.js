import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { t, tHtml, setLanguage, getLanguage, isRtl, resolveLanguage, AR } from '../renderer/i18n.js'

const read = f => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')

// ---------- pulling translatable text out of the sources ----------
const unescape = s => s.replace(/\\(u\{[0-9a-f]+\}|u[0-9a-f]{4}|x[0-9a-f]{2}|.)/gi, (_, e) =>
  /^u\{/i.test(e) ? String.fromCodePoint(parseInt(e.slice(2, -1), 16))
    : /^[ux]/i.test(e) && e.length > 1 ? String.fromCharCode(parseInt(e.slice(1), 16))
      : ({ n: '\n', t: '\t', r: '\r' }[e] ?? e))

/** The source text of the first argument of the call whose "(" is at `open`. */
function firstArg (src, open) {
  let depth = 0
  for (let i = open + 1; i < src.length; i++) {
    const c = src[i]
    if (c === '\'' || c === '"' || c === '`') { i = skipString(src, i); continue }
    if ('([{'.includes(c)) depth++
    else if (')]}'.includes(c)) { if (depth === 0) return src.slice(open + 1, i); depth-- }
    else if (c === ',' && depth === 0) return src.slice(open + 1, i)
  }
  throw new Error('unterminated call')
}
function skipString (src, i) {
  const q = src[i]
  for (let j = i + 1; j < src.length; j++) {
    if (src[j] === '\\') { j++; continue }
    if (q === '`' && src[j] === '$' && src[j + 1] === '{') {
      let depth = 0
      for (j += 1; j < src.length; j++) {
        if (src[j] === '{') depth++
        else if (src[j] === '}' && --depth === 0) break
        else if ('\'"`'.includes(src[j])) j = skipString(src, j)
      }
      continue
    }
    if (src[j] === q) return j
  }
  throw new Error('unterminated string')
}
/** Every string literal in a piece of code (template literals reported raw, with a flag). */
function literals (code) {
  const out = []
  for (let i = 0; i < code.length; i++) {
    const c = code[i]
    if (c !== '\'' && c !== '"' && c !== '`') continue
    const end = skipString(code, i)
    const body = code.slice(i + 1, end)
    out.push({ text: unescape(body), interpolated: c === '`' && body.includes('${') })
    i = end
  }
  return out
}
/** Keys passed to t() / tHtml() in a source file, with line numbers. */
function keysIn (file) {
  const src = read(file)
  const keys = []
  for (const m of src.matchAll(/(?<![\w$.])(?:t|tHtml)\(/g)) {
    const open = m.index + m[0].length - 1
    const line = src.slice(0, open).split('\n').length
    for (const lit of literals(firstArg(src, open))) keys.push({ ...lit, file, line })
  }
  return keys
}

const SOURCES = ['renderer/app.js', 'main.js']
const sourceKeys = SOURCES.flatMap(keysIn)

// ---------- t() ----------
test('t() fills placeholders in English and Arabic, and falls back to English', () => {
  try {
    setLanguage('en')
    assert.equal(getLanguage(), 'en')
    assert.equal(isRtl(), false)
    assert.equal(t('Removed {n} dead trackers.', { n: 3 }), 'Removed 3 dead trackers.')
    assert.equal(t('Not a real key {x}', { x: 'y' }), 'Not a real key y')
    assert.equal(t('{a} and {missing}', { a: 1 }), '1 and {missing}')

    setLanguage('ar')
    assert.equal(getLanguage(), 'ar')
    assert.equal(isRtl(), true)
    const ar = t('Removed {n} dead trackers.', { n: 3 })
    assert.ok(ar.includes('3') && /[؀-ۿ]/.test(ar), ar)
    assert.equal(t('Not a real key {x}', { x: 'y' }), 'Not a real key y') // no translation: English
    assert.equal(t('Paused'), AR.Paused)

    setLanguage('fr') // anything unknown is English
    assert.equal(getLanguage(), 'en')
  } finally {
    setLanguage('en')
  }
})

test('tHtml() escapes the text but keeps the inserted markup', () => {
  assert.equal(tHtml('Down {speed}', { speed: '<b>1 MB/s</b>' }), 'Down <b>1 MB/s</b>')
  assert.equal(tHtml('<i>{x}</i>', { x: '<b>y</b>' }), '&lt;i&gt;<b>y</b>&lt;/i&gt;')
})

test('resolveLanguage follows the preference, or the system locale for "system"', () => {
  assert.equal(resolveLanguage('ar', 'en-US'), 'ar')
  assert.equal(resolveLanguage('en', 'ar-AE'), 'en')
  assert.equal(resolveLanguage('system', 'ar'), 'ar')
  assert.equal(resolveLanguage('system', 'ar-AE'), 'ar')
  assert.equal(resolveLanguage('system', 'ar_SA'), 'ar')
  assert.equal(resolveLanguage('system', 'en-GB'), 'en')
  assert.equal(resolveLanguage('system', 'fr'), 'en')
  assert.equal(resolveLanguage('system', ''), 'en')
  assert.equal(resolveLanguage(undefined, 'ar-EG'), 'ar')
  assert.equal(resolveLanguage('system', undefined), 'en')
})

// ---------- coverage ----------
test('the source scan finds the translated strings', () => {
  assert.ok(sourceKeys.length > 150, `only ${sourceKeys.length} keys found`)
  assert.ok(sourceKeys.some(k => k.text === 'Removed {n} dead tracker.'))
  assert.ok(sourceKeys.some(k => k.file === 'main.js' && k.text === 'Pause all'))
})

test('t() keys are plain strings: use {placeholders}, not ${} inside the key', () => {
  const bad = sourceKeys.filter(k => k.interpolated).map(k => `${k.file}:${k.line} ${k.text}`)
  assert.deepEqual(bad, [])
})

test('every t() key in app.js and main.js has an Arabic translation', () => {
  const missing = [...new Set(sourceKeys.filter(k => !Object.hasOwn(AR, k.text)).map(k => `${k.file}:${k.line} ${k.text}`))]
  assert.deepEqual(missing, [])
})

test('every static text in index.html has an Arabic translation', () => {
  // brand names, units and examples that read the same in Arabic
  const SAME = new Set(['Magnetic', 'VLC', 'KB/s', '1×', '0:00 / 0:00', 'ar, en', 'udp://tracker.example.org:1337/announce'])
  let html = read('renderer/index.html')
  html = html.slice(html.indexOf('<body>'))
  html = html.replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/<script[\s\S]*?<\/script>/g, '')
  html = html.replace(/<(\w+)[^>]*\btranslate="no"[^>]*>[\s\S]*?<\/\1>/g, '')
  const keys = []
  html = html.replace(/<(\w+)([^>]*\bdata-i18n-html\b[^>]*)>([\s\S]*?)<\/\1>/g, (_, tag, attrs, inner) => {
    keys.push(inner.replace(/\s+/g, ' ').trim())
    return `<${tag}${attrs}></${tag}>`
  })
  for (const m of html.matchAll(/\b(?:placeholder|title|aria-label)="([^"]*)"/g)) keys.push(m[1].trim())
  for (const m of html.matchAll(/>([^<]+)</g)) keys.push(m[1].trim())
  const missing = [...new Set(keys.filter(k => k && !SAME.has(k) && !Object.hasOwn(AR, k)))]
  assert.deepEqual(missing, [])
})

test('fixed error messages from lib/ have Arabic translations (main translates them)', () => {
  const missing = []
  for (const f of fs.readdirSync(new URL('../lib/', import.meta.url)).filter(f => f.endsWith('.js'))) {
    const src = read(`lib/${f}`)
    for (const m of src.matchAll(/new \w*Error\(/g)) {
      for (const lit of literals(firstArg(src, m.index + m[0].length - 1))) {
        if (!lit.interpolated && !Object.hasOwn(AR, lit.text)) missing.push(`lib/${f}: ${lit.text}`)
      }
    }
  }
  assert.deepEqual(missing, [])
})

test('Arabic translations keep every {placeholder}, and add none', () => {
  const names = s => [...s.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort()
  const bad = Object.entries(AR).filter(([en, ar]) => names(en).join() !== [...new Set(names(ar))].sort().join())
  assert.deepEqual(bad, [])
})

test('Arabic translations of HTML snippets keep the same tags', () => {
  const tags = s => [...s.matchAll(/<[^>]+>/g)].map(m => m[0]).sort()
  const bad = Object.entries(AR).filter(([en, ar]) => /</.test(en) && tags(en).join() !== tags(ar).join())
  assert.deepEqual(bad, [])
})

test('Arabic translations are Arabic, with Western digits', () => {
  const bad = Object.entries(AR).filter(([, ar]) => !/[؀-ۿ]/.test(ar) || /[٠-٩۰-۹]/.test(ar))
  assert.deepEqual(bad, [])
})

test('no translation keys go unused', () => {
  const used = new Set(sourceKeys.map(k => k.text))
  const html = read('renderer/index.html')
  const lib = fs.readdirSync(new URL('../lib/', import.meta.url)).map(f => read(`lib/${f}`)).join('\n')
  // keys from index.html or lib/ appear verbatim (allowing for HTML whitespace and escaped quotes)
  const flat = (html + lib).replace(/\s+/g, ' ')
  const unused = Object.keys(AR).filter(k => !used.has(k) && !flat.includes(k) && !flat.includes(k.replace(/'/g, '\\\'')))
  assert.deepEqual(unused, [])
})
