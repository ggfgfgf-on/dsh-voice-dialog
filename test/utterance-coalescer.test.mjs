import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createUtteranceCoalescer, UTTERANCE_COALESCE_WINDOW_MS,
} from '../lib/utterance-coalescer.js'
import { dedupeTranscript } from '../lib/continuous-separation.js'

function fakeTime() {
  let clock = 0
  let nextId = 1
  const timers = new Map()
  return {
    now: () => clock,
    setTimer(callback, delayMs) {
      const id = nextId++
      timers.set(id, { at: clock + delayMs, callback })
      return id
    },
    clearTimer(id) { timers.delete(id) },
    advance(ms) {
      clock += ms
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= clock)
          .sort((left, right) => left[1].at - right[1].at)[0]
        if (!due) break
        timers.delete(due[0])
        due[1].callback()
      }
    },
    pendingTimers: () => timers.size,
  }
}

test('coalesces same speaker within 1500 ms and preserves piece order', async () => {
  const clock = fakeTime()
  const batches = []
  const coalescer = createUtteranceCoalescer({
    windowMs: UTTERANCE_COALESCE_WINDOW_MS,
    dedupeTranscript,
    submit: (batch) => batches.push(batch),
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  })

  coalescer.append({ lane: 'owner', canonical: '我', text: Promise.resolve('你好'), meta: 1, at: 0 })
  clock.advance(1200)
  coalescer.append({ lane: 'owner', canonical: '我', text: Promise.resolve('世界'), meta: 2, at: 1200 })
  clock.advance(1499)
  assert.equal(batches.length, 0)
  clock.advance(1)
  assert.equal(batches.length, 1)
  assert.equal(await batches[0].text, '你好世界')
  assert.deepEqual(batches[0].entries.map((entry) => entry.meta), [1, 2])
})

test('a speaker change flushes immediately and never reorders lanes', async () => {
  const clock = fakeTime()
  const batches = []
  const coalescer = createUtteranceCoalescer({
    windowMs: UTTERANCE_COALESCE_WINDOW_MS,
    dedupeTranscript,
    submit: (batch) => batches.push(batch),
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  })

  coalescer.append({ lane: 'owner', canonical: '我', text: '先说话', meta: 'owner', at: 0 })
  coalescer.append({ lane: 'guest', canonical: '客人1', text: '后说话', meta: 'guest', at: 100 })
  assert.deepEqual(batches.map((batch) => batch.lane), ['owner'])
  coalescer.flushAll()
  assert.deepEqual(batches.map((batch) => batch.lane), ['owner', 'guest'])
  assert.equal(await batches[0].text, '先说话')
  assert.equal(await batches[1].text, '后说话')
})

test('a gap over 1500 ms flushes the previous batch before starting another', async () => {
  const clock = fakeTime()
  const batches = []
  const coalescer = createUtteranceCoalescer({
    windowMs: UTTERANCE_COALESCE_WINDOW_MS,
    dedupeTranscript,
    submit: (batch) => batches.push(batch),
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  })

  coalescer.append({ lane: 'owner', canonical: '我', text: '第一段', meta: 1, at: 0 })
  clock.advance(1499)
  coalescer.append({ lane: 'owner', canonical: '我', text: '第二段', meta: 2, at: 1501 })
  assert.equal(batches.length, 1)
  assert.equal(await batches[0].text, '第一段')
  coalescer.flushAll()
  assert.equal(batches.length, 2)
  assert.equal(await batches[1].text, '第二段')
})

test('dedupeTranscript still trims overlapping continuations across flushes', async () => {
  const clock = fakeTime()
  const batches = []
  const coalescer = createUtteranceCoalescer({
    windowMs: UTTERANCE_COALESCE_WINDOW_MS,
    dedupeTranscript,
    submit: (batch) => batches.push(batch),
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  })

  coalescer.append({ lane: 'owner', canonical: '我', text: '你好世界', meta: 1, at: 0 })
  coalescer.flushAll()
  coalescer.append({ lane: 'owner', canonical: '我', text: '你好世界再见', meta: 2, at: 2000 })
  coalescer.flushAll()
  assert.equal(await batches[0].text, '你好世界')
  assert.equal(await batches[1].text, '再见')
})
