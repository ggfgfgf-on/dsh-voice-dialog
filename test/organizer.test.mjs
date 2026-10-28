import test from 'node:test'
import assert from 'node:assert/strict'
import {
  SpeechOrganizer,
  parseOrganizerResponse,
  normalizeOrganizerAction,
} from '../lib/organizer.js'
import { SpeechScheduler } from '../lib/scheduler.js'

const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms))

function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

const request = {
  sessionId: 'session-test',
  text: '等一下，先说这个',
  lane: 'owner',
  playing: true,
  queued: 1,
}

test('parses the three actions, fences, and rejects junk', () => {
  const fence = String.fromCharCode(96).repeat(3)
  assert.equal(normalizeOrganizerAction('INTERRUPT'), 'interrupt')
  assert.equal(normalizeOrganizerAction('drop'), null)
  assert.deepEqual(parseOrganizerResponse(fence + 'json\n{"action":"interrupt"}\n' + fence), {
    action: 'interrupt', reason: '',
  })
  assert.deepEqual(parseOrganizerResponse('{"action":"ignore","reason":"噪音"}'), {
    action: 'ignore', reason: '噪音',
  })
  assert.equal(parseOrganizerResponse('{"action":"steer"}'), null)
  assert.equal(parseOrganizerResponse('not json'), null)
})

test('a stale plan cannot resolve after a newer plan starts', async () => {
  const first = deferred()
  let calls = 0
  const organizer = new SpeechOrganizer(async () => {
    calls += 1
    return calls === 1 ? first.promise : { action: 'queue', reason: 'newer' }
  }, { timeoutMs: 200 })
  const older = organizer.plan(request)
  const newer = await organizer.plan(request)
  first.resolve('{"action":"interrupt"}')
  assert.equal(await older, null)
  assert.equal(newer.action, 'queue')
  assert.equal(newer.version, 2)
})

test('a timeout falls back to queue and aborts the planner', async () => {
  let aborted = false
  const organizer = new SpeechOrganizer((_request, signal) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => {
      aborted = true
      reject(new Error('aborted'))
    })
  }), { timeoutMs: 20 })
  const plan = await organizer.plan(request)
  assert.equal(plan.action, 'queue')
  assert.equal(plan.reason, 'timeout')
  assert.equal(aborted, true)
})

test('cancel makes an in-flight plan stale', async () => {
  const pending = deferred()
  const organizer = new SpeechOrganizer(async () => pending.promise, { timeoutMs: 200 })
  const plan = organizer.plan(request)
  organizer.cancel()
  pending.resolve('{"action":"interrupt"}')
  assert.equal(await plan, null)
})

test('interrupt mode override is honored without reordering FIFO', async () => {
  const deliveries = []
  const firstHold = deferred()
  const secondHold = deferred()
  const scheduler = new SpeechScheduler({
    deliver: async (text, mode) => { deliveries.push({ text, mode }) },
    ownerMode: () => 'queue',
    guestMode: () => 'queue',
  })
  scheduler.enqueue('owner', '我', Promise.resolve('第一句'), { hold: firstHold.promise })
  const second = scheduler.enqueue('owner', '我', Promise.resolve('第二句'), { hold: secondHold.promise })
  scheduler.enqueue('owner', '我', Promise.resolve('第三句'))
  second.setMode('steer')
  firstHold.resolve()
  secondHold.resolve()
  await tick(40)
  assert.deepEqual(deliveries, [
    { text: '第一句', mode: 'queue' },
    { text: '第二句', mode: 'steer' },
    { text: '第三句', mode: 'queue' },
  ])
})

test('queue override leaves the existing policy alone', async () => {
  const deliveries = []
  const hold = deferred()
  const scheduler = new SpeechScheduler({
    deliver: async (text, mode) => { deliveries.push({ text, mode }) },
    ownerMode: () => 'steer',
    guestMode: () => 'queue',
  })
  const entry = scheduler.enqueue('owner', '我', Promise.resolve('普通一句'), { hold: hold.promise })
  entry.setMode('queue')
  hold.resolve()
  await tick()
  assert.deepEqual(deliveries, [{ text: '普通一句', mode: 'queue' }])
})

test('ignore drops only that entry', async () => {
  const deliveries = []
  const hold = deferred()
  const scheduler = new SpeechScheduler({
    deliver: async (text, mode) => { deliveries.push({ text, mode }) },
    ownerMode: () => 'queue',
    guestMode: () => 'queue',
  })
  const entry = scheduler.enqueue('owner', '我', Promise.resolve('噪音'), { hold: hold.promise })
  scheduler.enqueue('owner', '我', Promise.resolve('保留'))
  entry.drop()
  hold.resolve()
  await tick(40)
  assert.deepEqual(deliveries, [{ text: '保留', mode: 'queue' }])
})
