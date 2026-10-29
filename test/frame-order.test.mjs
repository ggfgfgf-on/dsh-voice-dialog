import test from 'node:test'
import assert from 'node:assert/strict'
import { FrameWindow, orderOf, shouldPlayFrame } from '../lib/frame-order.js'

const frame = (epoch, seq, extra = {}) => ({ sessionId: 's1', epoch, seq, text: 'x', audio: 'YQ==', ...extra })

test('a late frame from the previous reply is dropped (旧轮迟到帧被丢弃)', () => {
  const window = new FrameWindow()
  window.accept(orderOf(frame(2, 40)))
  assert.equal(window.classify(orderOf(frame(1, 41))), 'stale-epoch')
  assert.equal(window.classify(orderOf(frame(2, 39))), 'stale-seq')
})

test('frames of the new reply are accepted (新轮帧不会被误丢)', () => {
  const window = new FrameWindow()
  window.accept(orderOf(frame(2, 40)))
  assert.equal(window.classify(orderOf(frame(3, 0))), 'accept')
  window.accept(orderOf(frame(3, 0)))
  assert.deepEqual(window.current(), { epoch: 3, seq: 0 })
  assert.equal(window.classify(orderOf(frame(3, 1))), 'accept')
})

test('reorder/redelivery of an already played frame never plays twice', () => {
  const window = new FrameWindow()
  for (const seq of [0, 1, 2]) window.accept(orderOf(frame(1, seq)))
  // Same frame arrives again after the organizer reordered the queue.
  assert.equal(window.classify(orderOf(frame(1, 2))), 'duplicate')
  assert.equal(window.classify(orderOf(frame(1, 1))), 'stale-seq')
  // A genuine gap is still playable.
  assert.equal(window.classify(orderOf(frame(1, 3))), 'accept')
})

test('stop/cut keep the watermark, so stopped words cannot revive (stop 后不复活)', () => {
  const window = new FrameWindow()
  window.accept(orderOf(frame(4, 7)))
  // halt()/stopAll() only clear the queue; the window is untouched.
  assert.equal(window.classify(orderOf(frame(4, 7))), 'duplicate')
  assert.equal(window.classify(orderOf(frame(3, 99))), 'stale-epoch')
  // Only a session change or an explicit reset starts over.
  window.reset()
  assert.equal(window.classify(orderOf(frame(1, 0))), 'accept')
})

test('two tabs on one session: only the tab with the open microphone plays', () => {
  const base = { active: true, muted: false, autoRead: true, tabSession: 's1', frameSession: 's1' }
  assert.equal(shouldPlayFrame(base), true)
  assert.equal(shouldPlayFrame({ ...base, tabSession: 's2' }), false)
  assert.equal(shouldPlayFrame({ ...base, active: false }), false)
  assert.equal(shouldPlayFrame({ ...base, muted: true }), false)
  assert.equal(shouldPlayFrame({ ...base, autoRead: false }), false)
})

test('a legacy frame without ordering keys is not rejected', () => {
  const window = new FrameWindow()
  assert.equal(orderOf({}), null)
  assert.equal(window.classify(orderOf({})), 'accept')
  window.accept(orderOf({}))
  assert.equal(window.current(), null)
})
