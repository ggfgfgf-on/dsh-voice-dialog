import assert from 'node:assert/strict'
import test from 'node:test'
import { routeNowPlanLater } from '../lib/routing.js'
import { shouldRunPlanner } from '../lib/planner.js'

function fakeEntry() {
  const state = { dropped: 0, mode: 'queue', started: false }
  return {
    state,
    started: () => state.started,
    drop: () => { state.dropped += 1 },
    setMode: (mode) => { state.mode = mode },
  }
}

test('a late plan never blocks the first block', async () => {
  const entry = fakeEntry()
  const events = []
  let settle
  const plan = new Promise((resolve) => { settle = resolve })
  const returned = routeNowPlanLater({
    enqueue: () => { events.push('enqueue'); return entry },
    plan: () => { events.push('plan'); return plan },
    cut: () => events.push('cut'),
  })
  assert.equal(returned, entry, 'the entry exists before the plan answers')
  assert.deepEqual(events, ['enqueue', 'plan'])
  assert.equal(entry.state.dropped, 0)
  settle({ action: 'drop' })
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(entry.state.dropped, 1, 'a late drop still lands on an unstarted line')
})

test('a verdict that arrives after the model saw the line keeps it', async () => {
  const entry = fakeEntry()
  entry.state.started = true
  routeNowPlanLater({
    enqueue: () => entry,
    plan: () => Promise.resolve({ action: 'drop' }),
    cut: () => undefined,
  })
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(entry.state.dropped, 0)
})

test('an interrupt verdict cuts the playback without waiting for it', async () => {
  const entry = fakeEntry()
  let cuts = 0
  routeNowPlanLater({
    enqueue: () => entry,
    plan: () => Promise.resolve({ action: 'interrupt' }),
    cut: () => { cuts += 1 },
  })
  assert.equal(cuts, 0, 'nothing waits for the verdict')
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(cuts, 1)
  assert.equal(entry.state.mode, 'steer')
})

test('a failing plan leaves the line untouched', async () => {
  const entry = fakeEntry()
  routeNowPlanLater({
    enqueue: () => entry,
    plan: () => Promise.reject(new Error('gate offline')),
    cut: () => undefined,
  })
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(entry.state.dropped, 0)
  assert.equal(entry.state.mode, 'queue')
})

test('the slow planner only runs when a reply has two or more unread blocks', () => {
  assert.equal(shouldRunPlanner({ pendingBlocks: 0, queued: 0 }), false)
  assert.equal(shouldRunPlanner({ pendingBlocks: 1, queued: 0 }), false)
  assert.equal(shouldRunPlanner({ pendingBlocks: 2 }), true)
  assert.equal(shouldRunPlanner({ pendingBlocks: 0, queued: 2 }), true)
  assert.equal(shouldRunPlanner({ pendingBlocks: Number.NaN, queued: Number.NaN }), false)
})
