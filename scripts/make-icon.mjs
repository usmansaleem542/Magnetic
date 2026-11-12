// Renders the onlyTorrent app icon to build/icon.png (1024px).
// The mark is a play button built from download pieces, two of them still arriving,
// which is the app in one picture: you can press play before the download is done.
// Run: node scripts/make-icon.mjs
import zlib from 'node:zlib'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { MARK } from '../renderer/mark.js'

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'build', 'icon.png')
const S = 1024
const px = Buffer.alloc(S * S * 4)
const hex = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16))
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t)

// signed distance to a rounded rectangle, for anti-aliased edges
const sdRound = (x, y, x0, y0, w, h, r) => {
  const qx = Math.abs(x - (x0 + w / 2)) - (w / 2 - r)
  const qy = Math.abs(y - (y0 + h / 2)) - (h / 2 - r)
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r
}
const paint = (i, c, a) => {
  if (a <= 0) return
  for (let k = 0; k < 3; k++) px[i + k] = px[i + k] * (1 - a) + c[k] * a
  px[i + 3] = Math.max(px[i + 3], Math.round(a * 255))
}

// background tile, inset to Apple's icon grid, with a faint top-lit gradient for depth
const M = 100
const bgTop = hex('#262626')
const bgBottom = hex('#0E0E0E')
const gold = hex('#F0BE4B')
const goldLight = hex('#F7D37A')

const { rows, cols, cells } = MARK
const cell = 102
const gap = 20
const w = cols * cell + (cols - 1) * gap
const h = rows * cell + (rows - 1) * gap
const ox = (S - w) / 2 + w * 0.07 // nudge right: a play triangle's visual centre sits left of its box centre
const oy = (S - h) / 2

for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    const i = (y * S + x) * 4
    const d = sdRound(x + 0.5, y + 0.5, M, M, S - 2 * M, S - 2 * M, 186)
    paint(i, mix(bgTop, bgBottom, (y - M) / (S - 2 * M)), Math.min(1, Math.max(0, 0.5 - d)))
    for (const [r, c, v] of cells) {
      const cx = ox + c * (cell + gap)
      const cy = oy + r * (cell + gap)
      const a = Math.min(1, Math.max(0, 0.5 - sdRound(x + 0.5, y + 0.5, cx, cy, cell, cell, 24)))
      if (!a) continue
      const shade = mix(goldLight, gold, (y - cy) / cell) // a little light from above on each piece
      paint(i, shade, a * (v === 1 ? 1 : 0.28))
    }
  }
}

const raw = Buffer.alloc((S * 4 + 1) * S)
for (let y = 0; y < S; y++) px.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4)
const table = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
const crc = b => { let c = 0xffffffff; for (const v of b) c = table[(c ^ v) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type), data])
  const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body))
  return Buffer.concat([len, body, sum])
}
const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4); ihdr[8] = 8; ihdr[9] = 6
fs.writeFileSync(out, Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))
]))
console.log('wrote', out)
