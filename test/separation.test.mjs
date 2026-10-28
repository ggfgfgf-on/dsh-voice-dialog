import test from 'node:test'
import assert from 'node:assert/strict'
import { planWindows, separateWithRunner, SeparationService, shouldSwap } from '../lib/separation.js'

const WINDOW = 64000

function constant(value) {
  return new Float32Array(WINDOW).fill(value)
}

function wave(sign) {
  return Float32Array.from({ length: WINDOW }, (_, i) => sign * Math.sin(i * 0.06) * 0.2)
}

test('planWindows covers short, medium, and long audio', () => {
  assert.deepEqual(planWindows(1000), [0])
  assert.deepEqual(planWindows(WINDOW), [0])
  assert.deepEqual(planWindows(WINDOW + 16000), [0, 16000])
  assert.deepEqual(planWindows(WINDOW * 2), [0, 56000, 64000])
})

test('shouldSwap follows the waveform across window overlap', () => {
  const previousA = wave(1)
  const previousB = wave(-1)
  assert.equal(shouldSwap(previousA, previousB, wave(-1), wave(1), 8000), true)
  assert.equal(shouldSwap(previousA, previousB, wave(1), wave(-1), 8000), false)
})

test('separateWithRunner preserves length and keeps both streams', async () => {
  const samples = new Float32Array(WINDOW + 16000)
  for (let i = 0; i < samples.length; i++) samples[i] = 0.05
  const result = await separateWithRunner(samples, async (input) => {
    const a = Float32Array.from(input)
    const b = Float32Array.from(input, (value) => value * 0.5)
    return [a, b]
  })
  assert.equal(result.sources.length, 2)
  assert.equal(result.sources[0].samples.length, samples.length)
  assert.ok(Math.abs(result.sources[0].samples[1000] - 0.05) < 1e-5)
  assert.ok(Math.abs(result.sources[1].samples[1000] - 0.025) < 1e-5)
  assert.ok(result.sources[0].rms > result.sources[1].rms)
})

test('injected service reports ready and separates without a native addon', async () => {
  const service = new SeparationService({
    dataDir: 'unused',
    modelPath: 'unused',
    run: async (input) => [Float32Array.from(input), new Float32Array(WINDOW)],
  })
  assert.equal(service.status().ready, true)
  const result = await service.separate(new Float32Array(8000).fill(0.05))
  assert.equal(result.sources.length, 1)
  assert.equal(result.sources[0].samples.length, 8000)
})
