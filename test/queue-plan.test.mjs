import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeQueuePlan } from '../lib/organizer.js'
import { SpeechScheduler } from '../lib/scheduler.js'

function makeScheduler() {
  const delivered = []
  const scheduler = new SpeechScheduler({
    deliver: (text) => { delivered.push(text); return Promise.resolve() },
    guestMode: () => 'queue',
  })
  return { scheduler, delivered }
}

const never = new Promise(() => undefined)

function seed(scheduler) {
  const entries = []
  for (let index = 0; index < 3; index += 1) {
    entries.push(scheduler.enqueue('owner', '我', Promise.resolve('第' + index + '句'), { order: index, hold: never }))
  }
  return entries
}

test('raise moves a waiting entry to the front', () => {
  const { scheduler } = makeScheduler()
  seed(scheduler)
  const ids = scheduler.snapshot().map((item) => item.id)
  assert.deepEqual(ids, [0, 1, 2])
  const outcome = scheduler.applyQueuePlan([{ id: 2, action: 'raise', priority: 0 }])
  assert.equal(outcome.applied.length, 1)
  assert.equal(scheduler.snapshot()[0].id, 2)
})

test('drop removes only the addressed waiting entry', () => {
  const { scheduler } = makeScheduler()
  seed(scheduler)
  const outcome = scheduler.applyQueuePlan([{ id: 1, action: 'drop' }])
  assert.deepEqual(outcome.applied, [{ id: 1, action: 'drop' }])
  assert.deepEqual(scheduler.snapshot().map((item) => item.id), [0, 2])
})

test('unknown, duplicate and malformed ids are ignored, never guessed', () => {
  const { scheduler } = makeScheduler()
  seed(scheduler)
  const outcome = scheduler.applyQueuePlan([
    { id: 99, action: 'drop' },
    { id: 0, action: 'keep' },
    { id: 0, action: 'drop' },
    { id: -1, action: 'drop' },
    { id: 2, action: 'raise' },
  ])
  assert.deepEqual(outcome.applied.map((item) => item.action), ['keep'])
  assert.deepEqual(outcome.ignored.map((item) => item.reason), ['unknown-id', 'duplicate', 'invalid-id', 'invalid-priority'])
  // The raise carried no priority, so it was ignored and the order is untouched.
  assert.deepEqual(scheduler.snapshot().map((item) => item.id), [0, 1, 2])
})

test('an empty plan changes nothing', () => {
  const { scheduler } = makeScheduler()
  seed(scheduler)
  const before = scheduler.snapshot().map((item) => item.id)
  const outcome = scheduler.applyQueuePlan([])
  assert.deepEqual(outcome.applied, [])
  assert.deepEqual(scheduler.snapshot().map((item) => item.id), before)
})

test('normalizeQueuePlan keeps known actions and drops junk', () => {
  const plan = normalizeQueuePlan([
    { id: 1, action: 'DROP' },
    { id: '2', action: 'raise', priority: 5 },
    { id: 3, action: 'raise' },
    { id: 1, action: 'keep' },
    { id: -4, action: 'drop' },
    { id: 5, action: 'delete' },
    'junk',
  ])
  assert.deepEqual(plan, [
    { id: 1, action: 'drop' },
    { id: 2, action: 'raise', priority: 5 },
    { id: 3, action: 'keep' },
  ])
  assert.deepEqual(normalizeQueuePlan(null), [])
  assert.deepEqual(normalizeQueuePlan('nope'), [])
})
