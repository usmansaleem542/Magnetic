// Audio Chromium can't decode (AC3, E-AC3, DTS, TrueHD…) plays as silence with no error.
// For those files we run ffmpeg: video is copied untouched, audio becomes stereo AAC, and
// the result streams as fragmented MP4. Seeking restarts ffmpeg at the new position.
import { spawn } from 'node:child_process'

// Chromium decodes AAC, MP3, Opus, Vorbis, FLAC and PCM; these need converting.
const UNSUPPORTED_AUDIO = new Set(['ac3', 'eac3', 'dts', 'truehd', 'mlp', 'mp2', 'mp1', 'wmav1', 'wmav2', 'wmapro', 'cook', 'ra_144', 'ra_288', 'atrac3', 'amr_nb', 'amr_wb'])
export const needsAudioConversion = codec => UNSUPPORTED_AUDIO.has(String(codec).toLowerCase())

const parseClock = s => {
  const m = /(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(s || '')
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null
}

/** Parse the stream summary ffmpeg prints for `ffmpeg -i <input>`. */
export function parseProbe (stderr) {
  const out = { duration: null, video: null, audio: [] }
  let current = null
  for (const line of String(stderr).split(/\r?\n/)) {
    const dur = /^\s*Duration:\s*([\d:.]+)/.exec(line)
    if (dur) { out.duration = parseClock(dur[1]); continue }
    const st = /^\s*Stream #\d+:(\d+)(?:\[[^\]]*\])?(?:\(([^)]*)\))?:\s*(Video|Audio|Subtitle|Data|Attachment):\s*([^\s,(]+)(.*)$/.exec(line)
    if (st) {
      const [, index, lang, type, codec, rest] = st
      current = null
      if (type === 'Video' && !out.video && !/attached pic/.test(rest)) out.video = { index: Number(index), codec }
      if (type === 'Audio') {
        const ch = /,\s*(mono|stereo|[\d.]+(?:\([^)]*\))?|\d+ channels)\s*,/.exec(rest)
        current = {
          order: out.audio.length,
          index: Number(index),
          codec,
          language: lang && lang !== 'und' ? lang : '',
          title: '',
          channels: ch ? ch[1].replace(/\(.*\)/, '') : '',
          default: /\(default\)/.test(rest)
        }
        out.audio.push(current)
      }
      continue
    }
    const title = /^\s+title\s*:\s*(.+)$/.exec(line)
    if (title && current && !current.title) current.title = title[1].trim()
  }
  return out
}

/** Arguments for a converted stream starting at `start` seconds, using audio track `audio`. */
export function transcodeArgs ({ input, start = 0, audio = 0, videoCodec = '' }) {
  return [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    // keyframe seek for both streams, so audio and video start together at `start`'s keyframe
    ...(start > 0 ? ['-ss', start.toFixed(3), '-noaccurate_seek'] : []),
    '-i', input,
    '-map', '0:v:0?', '-map', `0:a:${audio}`,
    '-c:v', 'copy', ...(/^(hevc|h265)$/i.test(videoCodec) ? ['-tag:v', 'hvc1'] : []),
    '-c:a', 'aac', '-b:a', '192k', '-ac', '2',
    '-sn', '-dn', '-map_metadata', '-1',
    '-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
    'pipe:1'
  ]
}

/** Arguments that print the first video packet ffmpeg would output when seeking to `start`. */
export function keyframeArgs ({ input, start }) {
  return ['-hide_banner', '-loglevel', 'error', '-nostdin', '-ss', start.toFixed(3), '-noaccurate_seek', '-copyts',
    '-i', input, '-map', '0:v:0', '-c', 'copy', '-frames:v', '1', '-f', 'framemd5', '-']
}

/** Presentation time (seconds) of the first packet in framemd5 output, or null. */
export function parseKeyframe (text) {
  const tb = /#tb 0:\s*(\d+)\/(\d+)/.exec(text)
  const pkt = /^0,\s*(-?\d+),/m.exec(text)
  if (!tb || !pkt) return null
  return (Number(pkt[1]) * Number(tb[1])) / Number(tb[2])
}

function run (bin, args, { timeout = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { windowsHide: true })
    let out = ''
    let err = ''
    p.stdout.on('data', d => { out += d })
    p.stderr.on('data', d => { err += d })
    const timer = setTimeout(() => { p.kill('SIGKILL'); reject(new Error('ffmpeg took too long reading the file.')) }, timeout)
    p.on('error', e => { clearTimeout(timer); reject(e) })
    p.on('close', () => { clearTimeout(timer); resolve({ out, err }) })
  })
}

export async function probeMedia (bin, input) {
  const { err } = await run(bin, ['-hide_banner', '-nostdin', '-i', input])
  return parseProbe(err) // ffmpeg exits non-zero without an output file; the summary is still there
}

export async function findKeyframe (bin, input, start) {
  if (!(start > 0)) return 0
  const { out } = await run(bin, keyframeArgs({ input, start }))
  const t = parseKeyframe(out)
  return t == null ? start : Math.max(0, t)
}
