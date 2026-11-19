// One interface over Chromecast, AirPlay and DLNA so the UI doesn't care which kind of device it is.
import chromecasts from 'chromecasts'
import dlnacasts from 'dlnacasts'
import airplayer from 'airplayer'
import os from 'node:os'

const p = fn => new Promise((resolve, reject) => fn((err, v) => err ? reject(err) : resolve(v)))

export function lanAddress () {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) return a.address
  }
  return null
}

// Chromecasts are announced by service name ("Brand-Model-<32 hex>") before their friendly name
// arrives, and the library never updates it, so tidy the raw form for display.
export function displayName (name, type) {
  if (type !== 'chromecast') return name
  return String(name).replace(/-[a-f0-9]{32}$/i, '').replace(/-/g, ' ').trim() || name
}

export function createCaster () {
  const devices = new Map() // id -> { id, name, type, player }
  let lists = null
  let active = null // { device, startedAt }

  function start () {
    if (lists) return
    lists = []
    const add = (type, list) => {
      lists.push(list)
      list.on('update', player => {
        const id = `${type}:${player.host || ''}:${player.name}`
        if (!devices.has(id)) devices.set(id, { id, raw: player.name, name: displayName(player.name, type), type, player })
      })
      list.on?.('error', () => {})
      for (const player of list.players || []) list.emit('update', player)
    }
    // each discovery library can throw on networks without multicast; one failing shouldn't stop the others
    try { add('chromecast', chromecasts()) } catch {}
    try { add('dlna', dlnacasts()) } catch {}
    try { add('airplay', airplayer()) } catch {}
  }

  function list () {
    start()
    for (const l of lists) { try { l.update() } catch {} }
    // TVs first, then AirPlay receivers (which on an office network includes every Mac)
    const order = { chromecast: 0, dlna: 1, airplay: 2 }
    const seen = {}
    for (const d of devices.values()) seen[d.name] = (seen[d.name] || 0) + 1
    // two TVs of the same model get the same name; a short id tells them apart
    const label = d => seen[d.name] > 1 ? `${d.name} (${String(d.raw).replace(/[^a-z0-9]/gi, '').slice(-4)})` : d.name
    return [...devices.values()]
      .map(d => ({ id: d.id, name: label(d), type: d.type }))
      .sort((a, b) => order[a.type] - order[b.type] || a.name.localeCompare(b.name))
  }

  async function play (id, url, { title, mime, startTime = 0, subtitlesUrl = null } = {}) {
    const device = devices.get(id)
    if (!device) throw new Error('That device is no longer available. Open the cast menu to search again.')
    if (active) await stop().catch(() => {})
    const { player, type } = device
    if (type === 'airplay') {
      // AirPlay's start position is a fraction of the duration, which we don't know yet, so start then scrub
      await p(cb => player.play(url, 0, cb))
      if (startTime > 0) await p(cb => player.scrub(startTime, cb)).catch(() => {})
    } else {
      const subs = subtitlesUrl
        ? {
            subtitles: [subtitlesUrl],
            autoSubtitles: true,
            textTrackStyle: { backgroundColor: '#00000099', foregroundColor: '#FFFFFFFF', edgeType: 'NONE', fontScale: 1.1 }
          }
        : {}
      await p(cb => player.play(url, { title, type: mime, seek: startTime, ...subs }, cb))
    }
    active = { device }
    // AirPlay's video protocol has no way to send separate subtitle files
    return { id, name: device.name, type, subtitles: !!subtitlesUrl && type !== 'airplay' }
  }

  function requireActive () {
    if (!active) throw new Error('Nothing is casting.')
    return active.device
  }

  async function status () {
    if (!active) return null
    const { player, type, name } = active.device
    try {
      if (type === 'airplay') {
        const info = await p(cb => player.playbackInfo((err, res, body) => cb(err, body || res)))
        return { name, currentTime: info?.position || 0, duration: info?.duration || 0, paused: info?.rate === 0 }
      }
      const s = await p(cb => player.status(cb))
      return {
        name,
        currentTime: s?.currentTime || 0,
        duration: s?.media?.duration || 0,
        paused: s?.playerState ? s.playerState !== 'PLAYING' && s.playerState !== 'BUFFERING' : false
      }
    } catch {
      return { name, currentTime: 0, duration: 0, paused: false }
    }
  }

  async function pause () { const d = requireActive(); await p(cb => d.player.pause(cb)) }
  async function resume () { const d = requireActive(); await p(cb => d.player.resume(cb)) }
  async function seek (seconds) {
    const d = requireActive()
    if (d.type === 'airplay') await p(cb => d.player.scrub(seconds, cb))
    else await p(cb => d.player.seek(seconds, cb))
  }
  async function stop () {
    if (!active) return
    const d = active.device
    active = null
    await p(cb => d.player.stop(cb)).catch(() => {})
  }

  function destroy () {
    for (const l of lists || []) { try { l.destroy() } catch {} }
    lists = null
    devices.clear()
  }

  return { list, play, pause, resume, seek, stop, status, destroy, get active () { return active && { id: active.device.id, name: active.device.name } } }
}
