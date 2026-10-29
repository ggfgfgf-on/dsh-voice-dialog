import test from 'node:test'
import assert from 'node:assert/strict'
import {
  VolumeRig, CUT_SUPPRESS_MS, GAIN_RAMP_SECONDS, DUCK_MAX_MS,
} from '../lib/volume-gain.js'
import { createVolumeReporter } from '../lib/volume-report.js'
import { sanitizeVolumeSample } from '../lib/volume-log.js'

/**
 * Deterministic gain measurement.
 *
 * FakeParam keeps a timeline and evaluates it; a linear ramp is evaluated at
 * its end time and holds that value afterwards, which is exactly the property
 * that matters here: whichever event is last in time owns the final gain.
 * setTargetAtTime is evaluated exponentially, because that is what the
 * deployed applyGain() used and it never actually reaches its target.
 */
class FakeContext {
  constructor() { this.now = 0 }
  get currentTime() { return this.now }
  advance(seconds) { this.now += seconds }
}

function segment(event, from) {
  if (event.kind === 'set') return { kind: 'hold', start: event.at, from: event.value, to: event.value }
  if (event.kind === 'ramp') return { kind: 'ramp', start: event.at, from, to: event.value }
  return { kind: 'target', start: event.at, from, to: event.value, tau: event.tau }
}

function segmentValue(text, time) {
  if (text.kind === 'hold') return text.to
  if (text.kind === 'ramp') return time >= text.start ? text.to : text.from
  return text.to + (text.from - text.to) * Math.exp(-(time - text.start) / text.tau)
}

class FakeParam {
  constructor(context) {
    this.context = context
    this.events = []
    this.initial = 1
  }
  cancelScheduledValues(time) { this.events = this.events.filter((event) => event.at < time) }
  setValueAtTime(value, at) { this.events.push({ kind: 'set', value, at }) }
  linearRampToValueAtTime(value, at) { this.events.push({ kind: 'ramp', value, at }) }
  setTargetAtTime(value, at, tau) { this.events.push({ kind: 'target', value, at, tau }) }
  get value() { return this.valueOf(this.context.currentTime) }
  valueOf(time) {
    const events = [...this.events].sort((a, b) => a.at - b.at)
    let active = { kind: 'hold', start: 0, from: this.initial, to: this.initial }
    for (const event of events) {
      if (event.at > time) break
      active = segment(event, segmentValue(active, event.at))
    }
    return segmentValue(active, time)
  }
}

/** Manual clock so duck watchdogs and cut fades fire on demand. */
function makeClock() {
  let now = 0
  const timers = []
  return {
    now: () => now,
    setTimer: (run, ms) => {
      const handle = { at: now + ms, run, dead: false }
      timers.push(handle)
      return handle
    },
    clearTimer: (handle) => { if (handle) handle.dead = true },
    advance(ms) {
      const target = now + ms
      for (;;) {
        const due = timers.filter((timer) => !timer.dead && timer.at <= target)
          .sort((a, b) => a.at - b.at)[0]
        if (!due) break
        now = due.at
        due.dead = true
        due.run()
      }
      now = target
    },
    pending: () => timers.filter((timer) => !timer.dead).length,
  }
}

const round = (value) => Math.round(value * 1000) / 1000

function makeRig(options = {}) {
  const volume = options.volume ?? 0.9
  const duckLevel = options.duckLevel ?? 0.5
  const clock = makeClock()
  const audio = new FakeContext()
  const param = new FakeParam(audio)
  const samples = []
  const rig = new VolumeRig({
    context: () => audio,
    param: () => param,
    volume: () => volume,
    duckLevel: () => duckLevel,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    sink: (sample) => samples.push(sample),
  })
  return { rig, clock, audio, param, samples }
}

/** The deployed implementation, kept verbatim to measure what it did. */
function legacyApplyGain(param, audio, ducked, volume = 0.9, duckLevel = 0.5) {
  param.setTargetAtTime(volume * (ducked ? duckLevel : 1), audio.currentTime, 0.08)
}

test('five duck/restore cycles keep exactly one target', () => {
  const { rig, audio, param } = makeRig()
  for (let cycle = 0; cycle < 5; cycle += 1) {
    rig.duck()
    audio.advance(0.1)
    assert.equal(round(param.value), round(0.9 * 0.5), 'duck lands on volume*duckLevel')
    assert.equal(rig.target(), rig.volume() * rig.duckMultiplier())
    rig.restore()
    audio.advance(0.1)
    assert.equal(round(param.value), 0.9, 'restore lands on volume, not below it')
    assert.equal(rig.target(), 0.9)
  }
})

test('a restore inside the cut fade wins over the pending fade to zero', () => {
  const { rig, audio, param } = makeRig()
  rig.cutFade()
  // The fake lands a ramp at its end time, so only the settled value is
  // asserted. The owner stops talking while the sentence is still fading.
  audio.advance(0.1)
  rig.restore()
  audio.advance(0.5)
  assert.equal(round(param.value), 0.9, 'full volume, not zero')
  assert.equal(rig.isDucked(), false)
})

test('cut, suppressed duck, then restore is not a deadlock', () => {
  const { rig, clock, audio, param } = makeRig()
  rig.cutFade()
  const suppressed = rig.duck()
  assert.equal(suppressed.suppressed, true, 'duck inside the suppress window is recorded, not applied')
  assert.equal(rig.isDucked(), false)
  const done = rig.endCut()
  assert.equal(done.event, 'restore')
  audio.advance(0.4)
  assert.equal(round(param.value), 0.9)
  clock.advance(CUT_SUPPRESS_MS + 10)
  assert.equal(round(param.value), 0.9, 'the fade cannot come back later')
})

test('the cut fade heals itself even when nobody calls endCut', () => {
  const { rig, clock, audio, param } = makeRig()
  rig.cutFade()
  audio.advance(0.3)
  assert.equal(round(param.value), 0)
  clock.advance(400)
  audio.advance(0.1)
  assert.equal(round(param.value), 0.9, 'full volume returns without the player cooperating')
  assert.equal(rig.isDucked(), false)
  assert.equal(rig.duck().suppressed, true, 'the post-cut window still stands')
  assert.equal(rig.isDucked(), false)
})

test('a stuck duck cannot outlive the watchdog', () => {
  const { rig, clock, audio, param } = makeRig()
  rig.duck()
  audio.advance(0.1)
  assert.equal(round(param.value), 0.45)
  clock.advance(DUCK_MAX_MS + 10)
  audio.advance(0.1)
  assert.equal(round(param.value), 0.9)
})

test('volumeOverride and duck combine once, never per interruption', () => {
  const { rig, audio, param } = makeRig()
  rig.setOverride(0.6)
  audio.advance(0.1)
  assert.equal(round(param.value), 0.6)
  for (let cycle = 0; cycle < 5; cycle += 1) {
    rig.duck()
    audio.advance(0.1)
    assert.equal(round(param.value), 0.3, 'override * duckLevel, exactly once')
    rig.restore()
    audio.advance(0.1)
    assert.equal(round(param.value), 0.6, 'the override itself never decays')
  }
  rig.clearOverride()
  audio.advance(0.1)
  assert.equal(round(param.value), 0.9)
})

test('samples carry only numbers and enum names', () => {
  const { rig, samples } = makeRig()
  rig.duck()
  rig.restore()
  rig.cutFade()
  rig.endCut()
  assert.ok(samples.length >= 4)
  const allowed = new Set(['apply', 'duck', 'restore', 'cut', 'begin', 'override'])
  for (const sample of samples) {
    assert.deepEqual(Object.keys(sample).sort(), [
      'actual', 'at', 'duckLevel', 'ducked', 'event', 'prefsVolume', 'suppressed', 'target', 'volumeOverride',
    ])
    assert.ok(allowed.has(sample.event))
    assert.equal(typeof sample.at, 'number')
    for (const key of ['target', 'actual', 'prefsVolume', 'duckLevel']) {
      assert.ok(sample[key] >= 0 && sample[key] <= 1, key + ' stays 0..1')
    }
  }
})

test('measured: the deployed ramp could hold the gain at zero after a cut', (t) => {
  const audio = new FakeContext()
  const param = new FakeParam(audio)
  // cut(): pin, then fade to zero over 250 ms (client.tsx before this fix).
  param.cancelScheduledValues(audio.currentTime)
  param.setValueAtTime(param.value, audio.currentTime)
  param.linearRampToValueAtTime(0, audio.currentTime + 0.25)
  audio.advance(0.1)
  // The owner stops talking while the sentence fades: restore -> applyGain().
  legacyApplyGain(param, audio, false)
  audio.advance(30)
  t.diagnostic('deployed cut+restore: gain=' + round(param.value) + ' prefs.volume=0.9')
  assert.equal(round(param.value), 0, 'the fade stayed the last scheduled event')

  // Three interruptions in a row: the value never returns to 0.9.
  for (let cycle = 0; cycle < 3; cycle += 1) {
    param.cancelScheduledValues(audio.currentTime)
    param.setValueAtTime(param.value, audio.currentTime)
    param.linearRampToValueAtTime(0, audio.currentTime + 0.25)
    audio.advance(0.1)
    legacyApplyGain(param, audio, false)
    audio.advance(30)
  }
  t.diagnostic('deployed after three interruptions: gain=' + round(param.value))
  assert.ok(param.value < 0.9, 'the interruption path did not recover')
})

test('measured: the deployed exponential never reached volume while talking', (t) => {
  const audio = new FakeContext()
  const param = new FakeParam(audio)
  let sum = 0
  let count = 0
  // 200 ms duck / restore alternation, the rate real speech chunks arrive at.
  for (let step = 0; step < 30; step += 1) {
    legacyApplyGain(param, audio, step % 2 === 0)
    for (let slice = 0; slice < 4; slice += 1) {
      audio.advance(0.05)
      sum += param.value
      count += 1
    }
  }
  const mean = sum / count
  t.diagnostic('deployed mean gain while talking: ' + round(mean) + ' (volume 0.9, duckLevel 0.5)')
  assert.ok(mean < 0.9, 'the mean sits below the chosen volume')
  // The same alternation on the new single-writer path recovers exactly.
  const { rig, audio: fixedAudio, param: fixedParam } = makeRig()
  for (let step = 0; step < 30; step += 1) {
    if (step % 2 === 0) rig.duck()
    else rig.restore()
    fixedAudio.advance(0.2)
  }
  rig.restore()
  fixedAudio.advance(GAIN_RAMP_SECONDS + 0.01)
  t.diagnostic('fixed gain after the same talking burst: ' + round(fixedParam.value))
  assert.equal(round(fixedParam.value), 0.9)
})

test('host sanitizer keeps bounds and drops unknown payloads', () => {
  assert.equal(sanitizeVolumeSample(null), null)
  assert.equal(sanitizeVolumeSample({ target: 'loud', actual: 1 }), null)
  const clean = sanitizeVolumeSample({
    at: 1, event: 'duck', ducked: true, target: 3, actual: -1,
    volumeOverride: 2, prefsVolume: 0.9, duckLevel: 0.5, suppressed: false,
    text: 'secret audio transcript', audio: 'AAAA',
  })
  assert.deepEqual(clean, {
    at: 1, event: 'duck', ducked: true, target: 1, actual: 0,
    volumeOverride: 1, prefsVolume: 0.9, duckLevel: 0.5, suppressed: false,
  })
  assert.equal('text' in clean, false)
  assert.equal(sanitizeVolumeSample({ target: 0.5, actual: 0.5, event: 'bogus' }).event, 'apply')
})

test('reporter batches, flushes once, and keeps the newest samples', () => {
  const posted = []
  let now = 0
  const timers = []
  const reporter = createVolumeReporter({
    post: (payload) => posted.push(payload),
    batchMs: 300,
    maxBuffered: 3,
    setTimer: (run, ms) => { const handle = { at: now + ms, run, dead: false }; timers.push(handle); return handle },
    clearTimer: (handle) => { if (handle) handle.dead = true },
  })
  reporter.report({ event: 'duck' })
  reporter.report({ event: 'restore' })
  assert.equal(posted.length, 0)
  assert.equal(reporter.pending(), 2)
  reporter.report({ event: 'cut' })
  reporter.report({ event: 'apply' })
  assert.equal(reporter.dropped(), 1, 'the oldest sample goes first')
  reporter.report({ event: 'apply' })
  reporter.flush()
  assert.equal(posted.length, 1)
  assert.deepEqual(posted[0].samples.map((sample) => sample.event), ['cut', 'apply', 'apply'])
  assert.equal(reporter.pending(), 0)
  reporter.flush()
  assert.equal(posted.length, 1, 'an empty buffer posts nothing')
})
