import assert from 'node:assert/strict'
import test from 'node:test'
import {
  canReuseSpeculativeAsr, firstDelivery, isSingleActiveSource, resolveOptimisticVerdict,
  shouldCallGate, shouldUseOptimisticFastPath,
} from '../lib/routing.js'

test('the interrupt gate is never called while nothing is playing', () => {
  assert.equal(shouldCallGate({ playing: false, queued: 0 }, false), false)
  assert.equal(shouldCallGate({ playing: false, queued: 5 }, false), false)
  assert.equal(shouldCallGate({ playing: false, queued: 5 }, true), false)
  assert.equal(shouldCallGate({ playing: true, queued: 0 }, false), true)
})

test('fast path only when idle', () => {
  const idle = { playing: false, queued: 0, active: 0 }
  assert.equal(shouldUseOptimisticFastPath(idle), true)
  assert.equal(shouldUseOptimisticFastPath({ ...idle, playing: true }), false)
  assert.equal(shouldUseOptimisticFastPath({ ...idle, queued: 1 }), false)
  assert.equal(shouldUseOptimisticFastPath({ ...idle, active: 1 }), false)
  assert.equal(shouldUseOptimisticFastPath(idle, false), false)
})

test('drop retracts only before the model received the line', () => {
  assert.equal(resolveOptimisticVerdict({ action: 'drop', started: false }), 'retract')
  assert.equal(resolveOptimisticVerdict({ action: 'ignore', started: false }), 'retract')
  assert.equal(resolveOptimisticVerdict({ action: 'drop', started: true }), 'keep')
  assert.equal(resolveOptimisticVerdict({ action: 'queue', started: false }), 'keep')
  assert.equal(resolveOptimisticVerdict({ action: 'interrupt', started: false }), 'steer')
  assert.equal(resolveOptimisticVerdict({ action: 'interrupt', started: true }), 'steer')
  assert.equal(resolveOptimisticVerdict({ action: null, started: false }), 'keep')
})

test('single-source detection is conservative', () => {
  assert.equal(isSingleActiveSource([0.05, 0]), true)
  assert.equal(isSingleActiveSource([0.05, 0.002]), true)
  assert.equal(isSingleActiveSource([0.05, 0.03]), false)
  assert.equal(isSingleActiveSource([0]), true)
})

test('speculative ASR is reusable only for the same amount of audio', () => {
  assert.equal(canReuseSpeculativeAsr(32000, 32000), true)
  assert.equal(canReuseSpeculativeAsr(32000, 31000), true)
  assert.equal(canReuseSpeculativeAsr(32000, 12000), false)
  assert.equal(canReuseSpeculativeAsr(32000, 0), false)
})

test('one utterance id reaches the model once', () => {
  const seen = new Set()
  assert.equal(firstDelivery(seen, 'cont-1-0'), true)
  assert.equal(firstDelivery(seen, 'cont-1-0'), false)
  assert.equal(firstDelivery(seen, 'cont-2-0'), true)
})
