import assert from 'node:assert/strict'
import test from 'node:test'
import { AdaptiveNoiseFloor, resolveMicThresholds } from '../src/mic.ts'

function close(actual, expected) {
  assert.ok(Math.abs(actual - expected) < 1e-12, `expected ${expected}, got ${actual}`)
}

test('quiet room clamps onset to the minimum and keeps hysteresis', () => {
  const floor = new AdaptiveNoiseFloor()
  for (let i = 0; i < 20; i++) floor.push(0.001, 80)
  const { onset, hold } = resolveMicThresholds(floor.value)
  close(onset, 0.004)
  close(hold, 0.0026)
  assert.ok(hold < onset)
})

test('steady background noise raises the onset above the noise', () => {
  const floor = new AdaptiveNoiseFloor()
  for (let i = 0; i < 20; i++) floor.push(0.01, 80)
  const { onset, hold } = resolveMicThresholds(floor.value)
  close(floor.value, 0.01)
  close(onset, 0.03)
  close(hold, 0.0195)
  assert.ok(onset > floor.value)
})

test('echo-adaptive gate rises with loud playback and rejects a faint onset', () => {
  const base = resolveMicThresholds(0.01)
  const playing = resolveMicThresholds(0.01, undefined, { playing: true, level: 0.95 })
  assert.ok(playing.onset > base.onset)
  // A faint blip that would pass the quiet-room gate cannot open the loud one.
  assert.ok(0.008 < playing.onset)
  assert.ok(playing.hold < playing.onset)
})

test('unknown playback level degrades to a conservative echo gate', () => {
  const unknown = resolveMicThresholds(0.01, undefined, { playing: true })
  const quiet = resolveMicThresholds(0.01)
  assert.ok(unknown.onset > quiet.onset)
  assert.ok(unknown.onset >= 0.035)
})

test('manual threshold overrides adaptation but retains the lower hold gate', () => {
  const { onset, hold } = resolveMicThresholds(0.05, 0.022)
  close(onset, 0.022)
  close(hold, 0.0143)
})

test('low percentile ignores short noise spikes', () => {
  const floor = new AdaptiveNoiseFloor()
  for (let i = 0; i < 20; i++) floor.push(0.002, 80)
  for (let i = 0; i < 3; i++) floor.push(0.08, 80)
  close(floor.value, 0.002)
})

test('rolling window eventually follows a quieter room', () => {
  const floor = new AdaptiveNoiseFloor(200, 0.2)
  for (let i = 0; i < 4; i++) floor.push(0.02, 50)
  close(floor.value, 0.02)
  for (let i = 0; i < 4; i++) floor.push(0.002, 50)
  close(floor.value, 0.002)
})
