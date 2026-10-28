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

test('global FIFO keeps speaking order when later ASR finishes first', async () => {
  const first = deferred()
  const deliveries = []
  const scheduler = new SpeechScheduler({
    deliver: async (text, mode) => { deliveries.push({ text, mode }) },
    ownerMode: () => 'queue',
    guestMode: () => 'queue',
  })
  scheduler.enqueue('owner', '我', first.promise)
  scheduler.enqueue('guest', '客人1', Promise.resolve('[声纹：客人1] 第二句'))
  scheduler.enqueue('owner', '我', Promise.resolve('[声纹：我] 第三句'))
  await tick()
  assert.deepEqual(deliveries, [])
  first.resolve('[声纹：我] 第一句')
  await tick()
  assert.deepEqual(deliveries, [
    { text: '[声纹：我] 第一句', mode: 'queue' },
    { text: '[声纹：客人1] 第二句', mode: 'queue' },
    { text: '[声纹：我] 第三句', mode: 'queue' },
  ])
  assert.deepEqual(scheduler.status(), { active: 0, queued: 0 })
})

test('owner queue mode appends without interrupting the running reply', async () => {
  const deliveries = []
  let ownerMode = 'queue'
  const scheduler = new SpeechScheduler({
    deliver: async (text, mode) => { deliveries.push({ text, mode }) },
    ownerMode: () => ownerMode,
    guestMode: () => 'queue',
  })
  scheduler.enqueue('owner', '我', Promise.resolve('[声纹：我] 我说一句'))
  await tick()
  assert.deepEqual(deliveries, [{ text: '[声纹：我] 我说一句', mode: 'queue' }])

  ownerMode = 'steer'
  scheduler.enqueue('owner', '我', Promise.resolve('[声纹：我] 急事'))
  await tick()
  assert.deepEqual(deliveries.at(-1), { text: '[声纹：我] 急事', mode: 'steer' })
})

test('guest direct mode steers while keeping its queue position', async () => {
  const deliveries = []
  const scheduler = new SpeechScheduler({
    deliver: async (text, mode) => { deliveries.push({ text, mode }) },
    guestMode: () => 'steer',
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

test('per-speaker policy only drops the ignored label', async () => {
  const deliveries = []
  const modes = new Map([['客人1', 'ignore'], ['客人2', 'queue']])
  const scheduler = new SpeechScheduler({
    deliver: async (text, mode) => { deliveries.push({ text, mode }) },
    guestMode: (label) => modes.get(label) ?? 'queue',
  })
  scheduler.enqueue('guest', '客人1', Promise.resolve('[声纹：客人1] 不要'))
  scheduler.enqueue('guest', '客人2', Promise.resolve('[声纹：客人2] 要'))
  await tick(40)
  assert.deepEqual(deliveries, [{ text: '[声纹：客人2] 要', mode: 'queue' }])
})

test('ignore command drops a guest still waiting behind a slow line', async () => {
  const slow = deferred()
  const deliveries = []
  const controls = []
  const scheduler = new SpeechScheduler({
    deliver: async (text, mode) => { deliveries.push({ text, mode }) },
    ownerMode: () => 'queue',
    guestMode: () => 'queue',
    onControl: (control) => { controls.push(control) },
  })
  scheduler.enqueue('owner', '我', slow.promise)
  scheduler.enqueue('guest', '客人1', Promise.resolve('[声纹：客人1] 这句话不要'))
  scheduler.enqueue('owner', '我', Promise.resolve('[声纹：我] 忽略客人1'))
  await tick()
  assert.deepEqual(controls, [{ action: 'speaker', target: '客人1', policy: 'ignore' }])
  slow.resolve('[声纹：我] 先说完')
  await tick()
  assert.deepEqual(deliveries, [{ text: '[声纹：我] 先说完', mode: 'queue' }])
  assert.deepEqual(scheduler.status(), { active: 0, queued: 0 })
})

test('ignore can resolve a display name back to the voiceprint label', async () => {
  const slow = deferred()
  const controls = []
  const deliveries = []
  const scheduler = new SpeechScheduler({
    deliver: async (text) => { deliveries.push(text) },
    ownerMode: () => 'queue',
    guestMode: () => 'queue',
    resolveSpeaker: (name) => name === '老婆' ? '客人1' : name,
    onControl: (control) => { controls.push(control) },
  })
  scheduler.enqueue('owner', '我', slow.promise)
  scheduler.enqueue('guest', '客人1', Promise.resolve('老婆的话'))
  scheduler.enqueue('owner', '我', Promise.resolve('别理老婆'))
  await tick()
  assert.deepEqual(controls, [{ action: 'speaker', target: '客人1', policy: 'ignore' }])
  slow.resolve('先说完')
  await tick()
  assert.deepEqual(deliveries, ['先说完'])
})

test('interrupt clears the waiting queue and sends the rest immediately', async () => {
  const slow = deferred()
  const deliveries = []
  const controls = []
  const scheduler = new SpeechScheduler({
    deliver: async (text, mode) => { deliveries.push({ text, mode }) },
    ownerMode: () => 'queue',
    guestMode: () => 'queue',
    onControl: (control) => { controls.push(control) },
  })
  scheduler.enqueue('owner', '我', slow.promise)
  scheduler.enqueue('guest', '客人1', Promise.resolve('还在排的客人'))
  scheduler.enqueue('owner', '我', Promise.resolve('[声纹：我] 打断，先看这个'))
  await tick()
  assert.deepEqual(controls, [{ action: 'interrupt', rest: '先看这个' }])
  assert.deepEqual(deliveries, [{ text: '[声纹：我] 先看这个', mode: 'steer' }])
  slow.resolve('那条旧话')
  await tick()
  assert.deepEqual(deliveries, [{ text: '[声纹：我] 先看这个', mode: 'steer' }])
  assert.deepEqual(scheduler.status(), { active: 0, queued: 0 })
})

test('a failed transcript is reported without breaking the queue', async () => {
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

test('dispose still delivers captured lines', async () => {
  const deliveries = []
  const scheduler = new SpeechScheduler({
    deliver: async (text, mode) => { deliveries.push({ text, mode }) },
    guestMode: () => 'queue',
  })
  scheduler.enqueue('guest', '客人1', Promise.resolve('排队的话'))
  scheduler.dispose()
  await tick(30)
  assert.deepEqual(deliveries, [{ text: '排队的话', mode: 'queue' }])
})
