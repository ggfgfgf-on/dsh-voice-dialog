import assert from 'node:assert/strict'
import test from 'node:test'
import {
  normalizeOrganizerPriority,
  parseOrganizerResponse,
  shouldDeliverOrganizerAction,
  SpeechOrganizer,
} from '../lib/organizer.js'
import { SpeechScheduler } from '../lib/scheduler.js'

const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms))

function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

const request = {
  sessionId: 'session-test',
  text: '等一下先说这个',
  lane: 'owner',
  playing: true,
  queued: 1,
}

test('parses drop and integer priority, keeping old responses compatible', () => {
  assert.deepEqual(parseOrganizerResponse('{"action":"drop","priority":3,"reason":"碎片"}'), {
    action: 'drop', priority: 3, reason: '碎片',
  })
  assert.deepEqual(parseOrganizerResponse('{"action":"queue"}'), {
    action: 'queue', reason: '',
  })
  assert.deepEqual(parseOrganizerResponse('{"action":"drop","reason":"碎片"'), {
    action: 'drop', reason: 'keyword',
  })
  assert.equal(normalizeOrganizerPriority(2.9), 2)
  assert.equal(normalizeOrganizerPriority(-1), undefined)
  assert.equal(normalizeOrganizerPriority('4'), 4)
})

test('drop is the only kind of explicit discard accepted by routing', async () => {
  assert.equal(shouldDeliverOrganizerAction('drop'), false)
  assert.equal(shouldDeliverOrganizerAction('ignore'), false)
  assert.equal(shouldDeliverOrganizerAction('queue'), true)
  assert.equal(shouldDeliverOrganizerAction('interrupt'), true)

  const organizer = new SpeechOrganizer(async () => '{"action":"drop","reason":"碎片"}')
  const plan = await organizer.plan(request)
  assert.equal(plan.action, 'drop')
  assert.equal(shouldDeliverOrganizerAction(plan.action), false)
})

test('priority sorting is stable and lower numbers speak first', async () => {
  const gate = deferred()
  const deliveries = []
  const scheduler = new SpeechScheduler({
    deliver: async (text, mode) => { deliveries.push({ text, mode }) },
    ownerMode: () => 'queue',
    guestMode: () => 'queue',
  })
  scheduler.enqueue('owner', '我', Promise.resolve('低'), { priority: 10, order: 1, hold: gate.promise })
  scheduler.enqueue('guest', '客人1', Promise.resolve('高先'), { priority: 0, order: 2, hold: gate.promise })
  scheduler.enqueue('owner', '我', Promise.resolve('高后'), { priority: 0, order: 3, hold: gate.promise })
  await tick()
  assert.deepEqual(deliveries, [])
  gate.resolve()
  await tick(60)
  assert.deepEqual(deliveries.map((item) => item.text), ['高先', '高后', '低'])
})

test('omitted priority falls back to arrival order', async () => {
  const gate = deferred()
  const deliveries = []
  const scheduler = new SpeechScheduler({
    deliver: async (text) => { deliveries.push(text) },
    ownerMode: () => 'queue',
    guestMode: () => 'queue',
  })
  scheduler.enqueue('owner', '我', Promise.resolve('第三到达'), { order: 30, hold: gate.promise })
  scheduler.enqueue('owner', '我', Promise.resolve('第一到达'), { order: 10, hold: gate.promise })
  scheduler.enqueue('owner', '我', Promise.resolve('第二到达'), { order: 20, hold: gate.promise })
  gate.resolve()
  await tick(60)
  assert.deepEqual(deliveries, ['第一到达', '第二到达', '第三到达'])
})

test('a timeout falls back to queue and never drops the line', async () => {
  const organizer = new SpeechOrganizer((_request, signal) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('aborted')))
  }), { timeoutMs: 20 })
  const plan = await organizer.plan(request)
  assert.equal(plan.action, 'queue')
  assert.equal(plan.priority, undefined)
  assert.equal(shouldDeliverOrganizerAction(plan.action), true)

  const deliveries = []
  const scheduler = new SpeechScheduler({
    deliver: async (text) => { deliveries.push(text) },
    ownerMode: () => 'queue',
    guestMode: () => 'queue',
  })
  scheduler.enqueue('owner', '我', Promise.resolve('超时也不能丢'), {
    priority: plan.priority,
    order: 1,
  })
  await tick(40)
  assert.deepEqual(deliveries, ['超时也不能丢'])
})
