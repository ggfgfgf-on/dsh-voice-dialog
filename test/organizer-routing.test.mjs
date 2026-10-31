import assert from 'node:assert/strict'
import test from 'node:test'
import {
  normalizeOrganizerPriority,
  parseOrganizerResponse,
  shouldDeliverOrganizerAction,
} from '../lib/organizer.js'
import { SpeechScheduler } from '../lib/scheduler.js'

const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms))

function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
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

test('drop is the only kind of explicit discard accepted by routing', () => {
  assert.equal(shouldDeliverOrganizerAction('drop'), false)
  assert.equal(shouldDeliverOrganizerAction('ignore'), false)
  assert.equal(shouldDeliverOrganizerAction('queue'), true)
  assert.equal(shouldDeliverOrganizerAction('interrupt'), true)
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

test('a line without a priority still gets delivered in arrival order', async () => {
  const deliveries = []
  const scheduler = new SpeechScheduler({
    deliver: async (text) => { deliveries.push(text) },
    ownerMode: () => 'queue',
    guestMode: () => 'queue',
  })
  scheduler.enqueue('owner', '我', Promise.resolve('没有优先级也不能丢'), {
    priority: undefined,
    order: 1,
  })
  await tick(40)
  assert.deepEqual(deliveries, ['没有优先级也不能丢'])
})
