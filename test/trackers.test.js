import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { parseTrackerList, planTrackers, normaliseTracker, instrumentTrackers, noteEvent, isDead, tidyError } from '../lib/trackers.js'

test('parseTrackerList: accepts tracker protocols, rejects the rest, de-duplicates', () => {
  const { valid, invalid } = parseTrackerList(`udp://a.org:1337/announce
    udp://a.org:1337/announce/  https://b.org/announce, wss://c.org
    ftp://nope.org  udp://noport.org  hello`)
  assert.deepEqual(valid, ['udp://a.org:1337/announce', 'https://b.org/announce', 'wss://c.org'])
  assert.deepEqual(invalid, ['ftp://nope.org', 'udp://noport.org', 'hello'])
})

test('planTrackers: removed trackers go, extras skip duplicates of the torrent’s own', () => {
  const plan = planTrackers({
    own: ['udp://own.org:1/announce', 'udp://dead.org:1/announce'],
    added: ['wss://mine.org'],
    removed: ['udp://dead.org:1/announce'],
    global: ['udp://own.org:1/announce', 'udp://global.org:1/announce']
  })
  assert.deepEqual(plan.own, ['udp://own.org:1/announce'])
  assert.deepEqual(plan.extra, ['wss://mine.org', 'udp://global.org:1/announce'])
})

test('planTrackers: private torrents and the off switch skip the Preferences list', () => {
  const base = { own: ['https://private.org/announce?pk=1'], added: ['wss://mine.org'], global: ['udp://global.org:1/announce'] }
  assert.deepEqual(planTrackers({ ...base, isPrivate: true }).extra, ['wss://mine.org'])
  assert.deepEqual(planTrackers({ ...base, useGlobal: false }).extra, ['wss://mine.org'])
})

test('instrumentTrackers: attributes events to the tracker that sent them', () => {
  const shared = new EventEmitter()
  shared.peerId = 'abc'
  const seen = []
  shared.on('warning', e => seen.push(e.message))
  const a = { announceUrl: 'udp://a.org:1', client: shared }
  const b = { announceUrl: 'udp://b.org:1/', client: shared }
  const status = new Map()
  instrumentTrackers({ _trackers: [a, b] }, status)
  instrumentTrackers({ _trackers: [a, b] }, status) // second call must not double-wrap
  a.client.emit('update', { complete: 4, incomplete: 2 })
  b.client.emit('warning', new Error('tracker request timed out (announce)'))
  assert.equal(a.client.peerId, 'abc') // reads still reach the real client
  assert.deepEqual(seen, ['tracker request timed out (announce)']) // events still reach it too
  assert.equal(status.get('udp://a.org:1').state, 'working')
  assert.equal(status.get('udp://a.org:1').seeders, 4)
  assert.equal(status.get('udp://b.org:1').state, 'failing')
  assert.equal(status.get('udp://b.org:1').message, 'Not responding')
  assert.ok(isDead(status.get('udp://b.org:1')) && !isDead(status.get('udp://a.org:1')))
})

test('noteEvent: a tracker that answers again is no longer dead', () => {
  const s = new Map()
  noteEvent(s, 'u', 'warning', new Error('getaddrinfo ENOTFOUND x'))
  assert.equal(s.get('u').message, 'Address not found')
  noteEvent(s, 'u', 'update', { complete: 1, incomplete: 0 })
  assert.ok(!isDead(s.get('u')))
})

test('normaliseTracker and tidyError', () => {
  assert.equal(normaliseTracker(' wss://x.org/ '), 'wss://x.org')
  assert.equal(tidyError(new Error('connect ECONNREFUSED 1.2.3.4:80')), 'Connection refused')
})

test('UDP trackers with and without /announce count as one', () => {
  const plan = planTrackers({ own: ['udp://t.org:1337'], global: ['udp://t.org:1337/announce', 'https://h.org/announce'] })
  assert.deepEqual(plan.extra, ['https://h.org/announce'])
  assert.deepEqual(parseTrackerList('udp://t.org:1337 udp://T.org:1337/announce').valid, ['udp://t.org:1337'])
  assert.equal(tidyError(new Error('Error connecting to wss://x.org')), 'Couldn’t connect')
})
