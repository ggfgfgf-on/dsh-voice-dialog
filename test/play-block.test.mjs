import { test } from 'node:test'
import assert from 'node:assert/strict'
import { playBlockReason, shouldPlayFrame } from '../lib/frame-order.js'

const base = { active: true, muted: false, autoRead: true, tabSession: 'a', frameSession: 'a' }

test('a frame with the microphone open here is playable', () => {
  assert.equal(shouldPlayFrame(base), true)
  assert.equal(playBlockReason(base), undefined)
})

test('every rejection names the condition that failed', () => {
  assert.equal(playBlockReason({ ...base, muted: true }), 'muted')
  assert.equal(playBlockReason({ ...base, autoRead: false }), 'autoread-off')
  assert.equal(playBlockReason({ ...base, active: false }), 'inactive')
  assert.equal(playBlockReason({ ...base, tabSession: 'b' }), 'other-session:b!=a')
  assert.equal(shouldPlayFrame({ ...base, active: false }), false)
})

test('the host election decides who speaks, not the local flag', () => {
  const mine = { ...base, frameOwner: 'me', clientId: 'me' }
  assert.equal(shouldPlayFrame(mine), true)
  // A stale local stop flag must not mute the tab the host elected.
  assert.equal(shouldPlayFrame({ ...mine, active: false }), true)
  // Another tab of the same session stays silent even with its mic open.
  assert.equal(shouldPlayFrame({ ...base, frameOwner: 'other' }), false)
  assert.equal(playBlockReason({ ...base, frameOwner: 'other' }), 'not-owner')
})

test('without an election the local rule still applies', () => {
  assert.equal(shouldPlayFrame({ ...base, clientId: 'me' }), true)
  assert.equal(shouldPlayFrame({ ...base, active: false, clientId: 'me' }), false)
})
