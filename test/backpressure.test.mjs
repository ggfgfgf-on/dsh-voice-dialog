// Backpressure: a separation model slower than one hop must never accumulate
// delay across utterances. These tests use a deliberately slow injected runner.
import test from 'node:test'
import assert from 'node:assert/strict'
import { ContinuousSeparation } from '../lib/continuous-separation.js'

const SR = 1000
const WINDOW_MS = 300
const HOP_MS = 60

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function speechChunk(n, amplitude = 0.2) {
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = amplitude
  return out
}

function makeSeparator({ delayMs, flushBudgetMs = 300, skipWhileBehind = true, onSegment }) {
  return new ContinuousSeparation({
    sampleRate: SR,
    windowMs: WINDOW_MS,
    hopMs: HOP_MS,
    silenceMs: 120,
    minSpeechMs: 40,
    threshold: 0.01,
    hopBudgetMs: HOP_MS,
    flushBudgetMs,
    skipWhileBehind,
    separate: async (window) => {
      await sleep(delayMs)
      const a = Float32Array.from(window)
      const b = new Float32Array(window.length)
      return { sources: [{ samples: a, rms: 0.2 }, { samples: b, rms: 0.19 }] }
    },
    onSegment: onSegment ?? (() => {}),
  })
}

async function feed(separation, chunks, size = 30, pauseMs = 2) {
  for (let i = 0; i < chunks; i++) {
    separation.push(speechChunk(size))
    await sleep(pauseMs)
  }
}

test('a model slower than one hop skips windows instead of queueing them', async () => {
  const events = []
  const separation = makeSeparator({ delayMs: 90, onSegment: (event) => events.push(event) })

  await feed(separation, 60)
  const beforeFlush = separation.pressureReport()
  await separation.flush()
  const after = separation.pressureReport()

  assert.ok(after.skippedWindows > 0, 'expected skipped windows while behind')
  assert.ok(after.lastModelMs >= HOP_MS, 'slow model window should be measured')
  assert.ok(after.flushMs <= 300 + 200, `flush must stay near its budget, got ${after.flushMs}`)
  assert.ok(beforeFlush.hopBudgetMs === HOP_MS)
  assert.ok(events.length >= 1, 'the utterance must still be transcribed')
})

test('ten consecutive utterances do not make flush slower over time', async () => {
  const events = []
  const separation = makeSeparator({ delayMs: 90, onSegment: (event) => events.push(event) })
  const flushes = []

  for (let round = 0; round < 10; round++) {
    await feed(separation, 12)
    for (let i = 0; i < 12; i++) {
      separation.push(new Float32Array(30))
      await sleep(2)
    }
    await separation.flush()
    flushes.push(separation.pressureReport().flushMs)
  }

  const lastThree = flushes.slice(-3).reduce((a, b) => a + b, 0) / 3
  // Bounded delay, not monotone growth: the ceiling is the budget plus the one
  // window that was already in flight when flush() started.
  assert.ok(lastThree <= 300 + 200, `late flushes exceeded the cap: ${lastThree.toFixed(0)}`)
  assert.ok(separation.pressureReport().skippedWindows > 0, 'backpressure must be engaged by the tenth round')
  // The cap allows one already-running window to finish, so the ceiling is the
  // budget plus a single model call.
  for (const value of flushes) assert.ok(value <= 300 + 200, `flush over budget: ${value}`)
  // Some rounds merge into the previous lane; the contract is bounded delay,
  // not one segment per round.
  assert.ok(events.length >= 5, `expected segments, got ${events.length}`)
})

test('prewarm is skipped while the model is behind', async () => {
  const separation = makeSeparator({ delayMs: 120 })
  await feed(separation, 20, 30, 4)
  // Let the first slow window finish so the lag is measurable.
  await sleep(200)
  separation.prewarm()
  await sleep(20)
  assert.equal(separation.prewarmReport().started, 0, 'no speculative inference while behind')
})

test('prewarm still runs when the model keeps up', async () => {
  const separation = makeSeparator({ delayMs: 1 })
  await feed(separation, 20, 30, 4)
  await sleep(60)
  separation.prewarm()
  await sleep(30)
  assert.ok(separation.prewarmReport().started >= 1, 'fast pipeline may speculate')
})

test('flush reports truncation when its budget cannot cover the tail', async () => {
  const separation = makeSeparator({ delayMs: 150, flushBudgetMs: 100 })
  await feed(separation, 30, 30, 2)
  const startedAt = Date.now()
  await separation.flush()
  const elapsed = Date.now() - startedAt
  const report = separation.pressureReport()
  assert.ok(report.flushTruncated, 'expected a truncated flush')
  assert.ok(elapsed < 700, `truncated flush returned too late: ${elapsed}`)
})

test('a truncated flush still keeps the tail audio instead of dropping words', async () => {
  const emitted = []
  const separation = makeSeparator({
    delayMs: 150,
    flushBudgetMs: 100,
    onSegment: (event) => emitted.push(event),
  })
  await feed(separation, 30, 30, 2)
  await separation.flush()
  const report = separation.pressureReport()
  assert.ok(report.flushTruncated, 'expected the flush to be truncated')
  const covered = emitted.reduce((sum, event) => sum + event.samples.length, 0)
  assert.ok(covered >= 600, `tail audio was dropped: got ${covered} of 900 samples`)
})

test('skipping can be switched off for diagnostics', async () => {
  const separation = makeSeparator({ delayMs: 90, skipWhileBehind: false })
  await feed(separation, 30)
  await separation.flush()
  assert.equal(separation.pressureReport().skippedWindows, 0)
})
