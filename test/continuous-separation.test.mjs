import test from 'node:test'
import assert from 'node:assert/strict'
import { ContinuousSeparation, dedupeTranscript } from '../lib/continuous-separation.js'

const SR = 1000
const WINDOW = 1000
const A_FROM = 0
const A_TO = 1000
const B_FROM = 600
const B_TO = 1600

function source(startSample, from, to, frequency) {
  const out = new Float32Array(WINDOW)
  for (let i = 0; i < out.length; i++) {
    const at = startSample + i
    if (at >= from && at < to) out[i] = 0.2 * Math.sin(2 * Math.PI * frequency * at / SR)
  }
  return out
}

function rms(samples) {
  let sum = 0
  for (const value of samples) sum += value * value
  return Math.sqrt(sum / Math.max(1, samples.length))
}

test('per-source VAD closes the owner while the guest keeps talking', async () => {
  const events = []
  const separation = new ContinuousSeparation({
    sampleRate: SR,
    windowMs: WINDOW,
    hopMs: 250,
    silenceMs: 300,
    minSpeechMs: 100,
    threshold: 0.01,
    separate: async (_window, startSample) => {
      const a = source(startSample, A_FROM, A_TO, 100)
      const b = source(startSample, B_FROM, B_TO, 300)
      return { sources: [{ samples: a, rms: rms(a) }, { samples: b, rms: rms(b) }] }
    },
    onSegment: (segment) => events.push(segment),
  })

  for (let at = 0; at < 2600; at += 50) {
    separation.push(new Float32Array(50).fill(0.1))
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  await separation.flush()

  assert.deepEqual(events.map((event) => event.slot), [0, 1])
  assert.ok(events[0].samples.length >= 900)
  assert.ok(events[1].samples.length >= 900)
  assert.ok(events[0].onsetMs <= 50)
  assert.ok(events[1].onsetMs >= 200 && events[1].onsetMs <= 650)
})


test('a single separated source still closes on its own silence', async () => {
  const events = []
  const separation = new ContinuousSeparation({
    sampleRate: SR,
    windowMs: WINDOW,
    hopMs: 250,
    silenceMs: 1600,
    minSpeechMs: 100,
    threshold: 0.01,
    separate: async (_window, startSample) => {
      const a = source(startSample, 0, 500, 100)
      return { sources: [{ samples: a, rms: rms(a) }] }
    },
    onSegment: (segment) => events.push(segment),
  })
  for (let at = 0; at < 3000; at += 50) {
    separation.push(new Float32Array(50).fill(0.1))
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  await separation.flush()
  assert.equal(events.length, 1)
  assert.equal(events[0].slot, 0)
  assert.ok(events[0].samples.length >= 500)
})

test('default silence remains 1.6 s per source', async () => {
  let now = 0
  const events = []
  const separation = new ContinuousSeparation({
    sampleRate: SR,
    windowMs: WINDOW,
    hopMs: 250,
    minSpeechMs: 100,
    threshold: 0.01,
    separate: async (_window, startSample) => {
      const a = source(startSample, 0, 500, 100)
      return { sources: [{ samples: a, rms: rms(a) }] }
    },
    onSegment: (segment) => events.push({ segment, at: now }),
  })
  for (now = 0; now < 3500; now += 50) {
    separation.push(new Float32Array(50).fill(0.1))
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  await separation.flush()
  assert.equal(events.length, 1)
  assert.ok(events[0].at >= 1900, 'must wait for the per-source 1.6 s silence')
})


test('a later lane waits for an earlier active lane (FIFO by onset)', async () => {
  const events = []
  const separation = new ContinuousSeparation({
    sampleRate: SR,
    windowMs: WINDOW,
    hopMs: 250,
    silenceMs: 300,
    minSpeechMs: 100,
    threshold: 0.01,
    separate: async (_window, startSample) => {
      const a = source(startSample, 0, 2000, 100)
      const b = source(startSample, 500, 1000, 300)
      return { sources: [{ samples: a, rms: rms(a) }, { samples: b, rms: rms(b) }] }
    },
    onSegment: (segment) => events.push(segment),
  })
  for (let at = 0; at < 3000; at += 50) {
    separation.push(new Float32Array(50).fill(0.1))
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  await separation.flush()
  assert.deepEqual(events.map((event) => event.slot), [0, 1])
  assert.ok(events[0].onsetMs <= 50)
  assert.ok(events[1].onsetMs >= 180 && events[1].onsetMs <= 650)
})


test('an idle room does not call the separation model', async () => {
  let calls = 0
  const separation = new ContinuousSeparation({
    sampleRate: SR,
    windowMs: WINDOW,
    hopMs: 250,
    silenceMs: 300,
    minSpeechMs: 100,
    threshold: 0.01,
    separate: async () => {
      calls += 1
      return { sources: [] }
    },
    onSegment: () => undefined,
  })
  for (let at = 0; at < 8000; at += 50) {
    separation.push(new Float32Array(50))
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  await separation.flush()
  assert.equal(calls, 0)
})


test('speech after an idle gap still reaches the model', async () => {
  let calls = 0
  const separation = new ContinuousSeparation({
    sampleRate: SR,
    windowMs: WINDOW,
    hopMs: 250,
    silenceMs: 300,
    minSpeechMs: 100,
    threshold: 0.01,
    separate: async () => {
      calls += 1
      return { sources: [{ samples: new Float32Array(WINDOW).fill(0.1), rms: 0.1 }] }
    },
    onSegment: () => undefined,
  })
  for (let at = 0; at < 5000; at += 50) {
    separation.push(new Float32Array(50))
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  assert.equal(calls, 0)
  for (let at = 0; at < 4000; at += 50) {
    separation.push(new Float32Array(50).fill(0.1))
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  assert.ok(calls > 0, 'speech after silence must not be skipped')
})

test('dedupeTranscript removes only long exact overlap', () => {
  assert.equal(dedupeTranscript('今天天气不错', '今天天气不错我们出去走走吧'), '我们出去走走吧')
  assert.equal(dedupeTranscript('今天天气不错', '今天天气不错'), '')
  assert.equal(dedupeTranscript('第一句话', '第二句话'), '第二句话')
})
