import assert from 'node:assert/strict'
import test from 'node:test'
import { ContinuousSeparation } from '../lib/continuous-separation.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Deterministic harness for the speculative separation window.
 *
 * window 1000 ms / hop 1000 ms keeps the arithmetic exact: the first 1.2 s of
 * speech closes window [0,16k), and everything after that stays in the ring
 * buffer until the utterance closes, which is exactly the window chance the
 * microphone's tail timer prewarms.
 */
function harness(options = {}) {
  const segments = []
  let calls = 0
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const separation = new ContinuousSeparation({
    sampleRate: 16_000,
    windowMs: 1000,
    hopMs: 1000,
    silenceMs: 300,
    separate: async (window, windowStart) => {
      calls += 1
      if (options.holdFrom !== undefined && calls >= options.holdFrom) await gate
      if (options.twoSpeakers) {
        return {
          sources: [
            { samples: window, rms: 0.2 },
            { samples: window.map((value) => value * 0.6), rms: 0.12 },
          ],
          windowStart,
        }
      }
      return { sources: [{ samples: window, rms: 0.2 }, { samples: new Float32Array(window.length), rms: 0 }] }
    },
    onSegment: (segment) => segments.push(segment),
    onError: () => undefined,
  })
  return { separation, segments, calls: () => calls, release }
}

function speech(seconds) {
  const samples = new Float32Array(Math.round(16_000 * seconds))
  for (let i = 0; i < samples.length; i += 1) samples[i] = Math.sin(i / 8) * 0.2
  return samples
}

test('a prewarmed window is reused once instead of inferring twice', async () => {
  const h = harness({ holdFrom: 2 })
  h.separation.push(speech(1.2))
  await sleep(30)
  assert.equal(h.calls(), 1, 'the first hop was separated once')
  h.separation.push(speech(0.2))
  assert.equal(h.calls(), 1, 'the tail fits in the ring buffer, no window yet')

  h.separation.prewarm()
  assert.equal(h.calls(), 2, 'prewarm starts exactly one inference')
  h.separation.prewarm()
  assert.equal(h.calls(), 2, 'a second prewarm call while in flight is a no-op')

  h.release()
  await sleep(10)
  await h.separation.flush()
  assert.equal(h.calls(), 2, 'closing the utterance reused the speculative result')
  const report = h.separation.prewarmReport()
  assert.equal(report.started, 1)
  assert.equal(report.reused, 1, 'the closed window reused the speculative result')
  assert.equal(report.discarded, 0)
  assert.equal(h.separation.consumeLastReused(), true)
  assert.equal(h.separation.consumeLastReused(), false, 'the reuse flag is consumed once')
  assert.ok(h.segments.length >= 1)
  const segment = h.segments[0]
  assert.match(segment.utteranceId, /^cont-\d+-[01]$/)
  assert.equal(segment.siblingActive, false, 'the silent lane is not a second speaker')
})

test('trailing silence after prewarm still reuses the same window', async () => {
  const h = harness({ holdFrom: 2 })
  h.separation.push(speech(1.2))
  await sleep(30)
  assert.equal(h.calls(), 1)
  h.separation.push(speech(0.2))
  h.separation.prewarm()
  assert.equal(h.calls(), 2, 'prewarm starts one inference during the tail hint')
  // The microphone keeps delivering silence until the endpoint fires. Before
  // this regression test the extra samples changed `received` and the final
  // window launched a second 700 ms inference instead of reusing the first.
  h.separation.push(new Float32Array(4_000))
  h.release()
  await sleep(10)
  await h.separation.flush()
  assert.equal(h.calls(), 2, 'trailing silence must not trigger a duplicate inference')
  const report = h.separation.prewarmReport()
  assert.equal(report.reused, 1)
  assert.equal(report.missed, 0)
  assert.ok(h.segments.length >= 1)
  assert.equal(h.segments[0].separation?.prewarm, 'hit')
  assert.equal(h.segments[0].separation?.modelCalls, 1)
})

test('new speech before the endpoint discards the prewarmed window', async () => {
  const h = harness({ holdFrom: 2 })
  h.separation.push(speech(1.2))
  await sleep(30)
  assert.equal(h.calls(), 1)
  h.separation.push(speech(0.1))
  h.separation.prewarm()
  assert.equal(h.calls(), 2)
  h.separation.push(speech(0.1))
  h.release()
  await sleep(10)
  await h.separation.flush()
  const report = h.separation.prewarmReport()
  assert.equal(report.reused, 0, 'a polluted window must not be reused')
  assert.ok(report.discarded >= 1)
  assert.ok(report.missed >= 1, 'the closed window was recomputed after invalidation')
  assert.ok(h.calls() >= 3, 'the window was recomputed after invalidation')
  assert.equal(h.separation.consumeLastReused(), false)
})

test('two overlapping lanes are reported as a sibling', async () => {
  const h = harness({ twoSpeakers: true })
  h.separation.push(speech(1.2))
  await sleep(30)
  await h.separation.flush()
  assert.ok(h.segments.length >= 1)
  assert.equal(h.segments[0].siblingActive, true, 'both lanes overlapped in time')
})

test('prewarm is a no-op when no lane is active', async () => {
  const h = harness()
  h.separation.push(new Float32Array(16_000))
  h.separation.push(new Float32Array(16_000))
  await sleep(10)
  h.separation.prewarm()
  assert.equal(h.calls(), 0)
  assert.equal(h.separation.prewarmReport().started, 0)
})
