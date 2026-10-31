import assert from 'node:assert/strict'
import test from 'node:test'
import { createLanes, orderPlan } from '../lib/lanes.js'

const item = (kind, lane, extra = {}) => ({ kind, lane, reason: 'test', source: 'rule', ...extra })

test('lanes: lower priority runs first, ties keep arrival order', () => {
  const ordered = orderPlan([
    item('reply', 'slow', { head: 'b' }),
    item('reply', 'fast', { priority: -1, head: 'a' }),
    item('reply', 'slow', { head: 'c' }),
  ])
  assert.deepEqual(ordered.map((entry) => entry.head), ['a', 'b', 'c'])
})

test('lanes: ignored and held items never reach the speaking layer', () => {
  const spoken = []
  const queued = []
  const held = []
  const lanes = createLanes({
    speak: (text) => spoken.push(text),
    enqueue: (plan) => queued.push(plan.reason),
    hold: (plan) => held.push(plan.reason),
  })
  const result = lanes.execute([
    item('ignore', 'slow'),
    item('hold', 'slow', { reason: 'supplement' }),
    item('reply', 'slow', { reason: 'owner-floor' }),
  ])
  assert.deepEqual(spoken, [], 'the slow lane speaks nothing directly')
  assert.deepEqual(queued, ['owner-floor'])
  assert.deepEqual(held, ['supplement'])
  assert.equal(result.ignored, 1)
  assert.equal(result.held, 1)
  assert.equal(result.executed, 1)
})

test('lanes: the fast lane speaks a written line, or starts the generator', () => {
  const spoken = []
  let started = 0
  const lanes = createLanes({
    speak: (text) => spoken.push(text),
    enqueue: () => undefined,
    startFast: () => { started += 1 },
  })
  lanes.execute([
    item('ack', 'fast', { text: '我在听' }),
    item('reply', 'fast'),
  ])
  assert.deepEqual(spoken, ['我在听'])
  assert.equal(started, 1)
})

test('lanes: an acknowledgement with a delay can still be cancelled', async () => {
  const spoken = []
  const lanes = createLanes({
    speak: (text) => spoken.push(text),
    enqueue: () => undefined,
  })
  lanes.execute([item('ack', 'fast', { text: '嗯', delayMs: 30 })])
  assert.equal(lanes.pending(), 1)
  lanes.dispose()
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.deepEqual(spoken, [], 'dispose cancels the pending acknowledgement')
})
