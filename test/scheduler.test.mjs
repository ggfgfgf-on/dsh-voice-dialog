import test from 'node:test'
import assert from 'node:assert/strict'
import { SpeechScheduler } from '../lib/scheduler.js'

const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms))

function deferred() {
  let resolve
  let reject
  const promise = new Promise((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

test('owner steers immediately while guests batch into one queued prompt', async () => {
  const deliveries = []
  const scheduler = new SpeechScheduler({
    deliver: async (text, mode) => { deliveries.push({ text, mode }) },
    guestMode: () => 'queue',
    batchMs: 5,
  })
  scheduler.enqueue('owner', '我', Promise.resolve('[声纹：我] 开始'))
  scheduler.enqueue('guest', '客人1', Promise.resolve('[声纹：客人1] 你好'))
  scheduler.enqueue('guest', '客人2', Promise.resolve('[声纹：客人2] 我也在'))
  await tick(40)
  assert.deepEqual(deliveries, [
    { text: '[声纹：我] 开始', mode: 'steer' },
    { text: '[声纹：客人1] 你好\n[声纹：客人2] 我也在', mode: 'queue' },
  ])
  assert.deepEqual(scheduler.status(), { active: 0, queued: 0 })
})

test('owner lane preserves utterance order even when later ASR finishes first', async () => {
  const first = deferred()
  const second = deferred()
  const deliveries = []
  const scheduler = new SpeechScheduler({
    deliver: async (text) => { deliveries.push(text) },
    guestMode: () => 'queue',
  })
  scheduler.enqueue('owner', '我', first.promise)
  scheduler.enqueue('owner', '我', second.promise)
  second.resolve('第二句')
  await tick()
  assert.deepEqual(deliveries, [])
  first.resolve('第一句')
  await tick()
  assert.deepEqual(deliveries, ['第一句', '第二句'])
})

test('guest direct mode steers without batching', async () => {
  const deliveries = []
  const scheduler = new SpeechScheduler({
    deliver: async (text, mode) => { deliveries.push({ text, mode }) },
    guestMode: () => 'steer',
    batchMs: 500,
  })
  scheduler.enqueue('guest', '客人1', Promise.resolve('直接插话'))
  await tick(30)
  assert.deepEqual(deliveries, [{ text: '直接插话', mode: 'steer' }])
})

test('guest ignore mode never delivers', async () => {
  const deliveries = []
  const scheduler = new SpeechScheduler({
    deliver: async (text) => { deliveries.push(text) },
    guestMode: () => 'ignore',
  })
  scheduler.enqueue('guest', '客人1', Promise.resolve('不要'))
  await tick(30)
  assert.deepEqual(deliveries, [])
  assert.deepEqual(scheduler.status(), { active: 0, queued: 0 })
})

test('dispose flushes guest lines already waiting', async () => {
  const deliveries = []
  const scheduler = new SpeechScheduler({
    deliver: async (text, mode) => { deliveries.push({ text, mode }) },
    guestMode: () => 'queue',
    batchMs: 500,
  })
  scheduler.enqueue('guest', '客人1', Promise.resolve('排队的话'))
  await tick(10)
  scheduler.dispose()
  await tick(30)
  assert.deepEqual(deliveries, [{ text: '排队的话', mode: 'queue' }])
})

test('a failed transcript is reported without breaking the lane', async () => {
  const errors = []
  const deliveries = []
  const scheduler = new SpeechScheduler({
    deliver: async (text) => { deliveries.push(text) },
    guestMode: () => 'queue',
    onError: (error) => { errors.push(error.message) },
  })
  scheduler.enqueue('owner', '我', Promise.reject(new Error('识别失败')))
  scheduler.enqueue('owner', '我', Promise.resolve('下一句'))
  await tick()
  assert.deepEqual(deliveries, ['下一句'])
  assert.deepEqual(errors, ['识别失败'])
})
