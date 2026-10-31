import assert from 'node:assert/strict'
import test from 'node:test'
import {
  IMMEDIATE_PARTIAL_MS, PARTIAL_MIN_SPEECH_MS, PARTIAL_WINDOW_MS,
  clampPartialMs, dedupePartial, partialIntervalFor, shouldFirePartial, trimPartialWindow,
} from '../lib/partial-asr.js'
import { PARTIAL_ASR_MAX_MS, clampPartialAsr, clampPause } from '../lib/preferences.js'
import { sanitizeLatencyRecord } from '../lib/latency.js'

const ready = {
  enabled: true,
  intervalMs: 300,
  sinceLastMs: 300,
  inFlight: false,
  speechMs: 900,
}

test('partial asr: off by default, and every reason to stay quiet wins', () => {
  assert.equal(shouldFirePartial(ready), true)
  assert.equal(shouldFirePartial({ ...ready, enabled: false }), false, '0 ms means no request at all')
  assert.equal(shouldFirePartial({ ...ready, intervalMs: 0 }), false)
  assert.equal(shouldFirePartial({ ...ready, sinceLastMs: 299 }), false, 'not before the interval')
  assert.equal(shouldFirePartial({ ...ready, inFlight: true }), false, 'one call at a time')
  assert.equal(shouldFirePartial({ ...ready, finalizing: true }), false, 'the closing recognition owns it')
  assert.equal(shouldFirePartial({ ...ready, speechMs: PARTIAL_MIN_SPEECH_MS - 1 }), false)
  assert.equal(shouldFirePartial({ ...ready, speechMs: PARTIAL_MIN_SPEECH_MS }), true)
  assert.equal(shouldFirePartial({ ...ready, speechMs: 0, minSpeechMs: 0, sinceLastMs: 0, intervalMs: 0 }), false)
})

test('partial asr: a shorter or repeated hypothesis does not replace a longer one', () => {
  assert.equal(dedupePartial('', '帮我把'), '帮我把')
  assert.equal(dedupePartial('帮我把', '帮我把'), null)
  assert.equal(dedupePartial('帮我把报告', '帮我把'), null, 'shorter means truncated, not new')
  assert.equal(dedupePartial('帮我把', '帮我把报告打开'), '帮我把报告打开')
  assert.equal(dedupePartial('帮我把', '   '), null)
  assert.equal(dedupePartial('帮我把', '帮我把  报告'), '帮我把 报告', 'whitespace is collapsed, never speech added')
})

test('partial asr: the audio window keeps only the tail', () => {
  const chunks = Array.from({ length: 10 }, () => ({ length: 16_000 }))
  const oneSecond = trimPartialWindow(chunks, 16_000, 1000)
  assert.equal(oneSecond.length, 1)
  const whole = trimPartialWindow(chunks, 16_000, PARTIAL_WINDOW_MS)
  assert.equal(whole.length, 10, 'ten seconds of audio fits the default window')
  assert.equal(trimPartialWindow([], 16_000, 1000).length, 0)
  assert.equal(trimPartialWindow(chunks, 16_000, 0).length, 0)
  const tail = trimPartialWindow([{ length: 4000 }, { length: 4000 }], 16_000, 200)
  assert.equal(tail.length, 1)
  assert.equal(tail[0].length, 4000, 'the newest chunk survives even if it alone exceeds the budget')
})

test('settings: the wait may be zero, the clamp still bounds it', () => {
  assert.equal(clampPause(0, 900), 0, '0 is allowed: immediate close')
  assert.equal(clampPause(4000, 900), 4000)
  assert.equal(clampPause(-10, 900), 0)
  assert.equal(clampPause(9999, 900), 4000)
  assert.equal(clampPause('oops', 900), 900)
})

test('settings: "即时" is one switch that also turns partial recognition on', () => {
  assert.equal(partialIntervalFor(0), IMMEDIATE_PARTIAL_MS, 'a zero wait derives the interval on its own')
  assert.equal(partialIntervalFor(0, 250), 250, 'an internal value may refine it')
  assert.equal(partialIntervalFor(900), 0, 'a real wait keeps partial recognition off')
  assert.equal(partialIntervalFor(100), 0)
  assert.equal(partialIntervalFor(-5), IMMEDIATE_PARTIAL_MS)
  assert.equal(partialIntervalFor(Number.NaN), 0)
  assert.equal(clampPartialMs(400), 400)
  assert.equal(clampPartialMs(-1), 0)
  assert.equal(clampPartialMs(9999), 2000)
  assert.equal(clampPartialMs('x'), 0)
})

test('settings: partial recognition is off by default and bounded', () => {
  assert.equal(clampPartialAsr(undefined, 0), 0)
  assert.equal(clampPartialAsr(0, 300), 0)
  assert.equal(clampPartialAsr(300, 0), 300)
  assert.equal(clampPartialAsr(-5, 0), 0)
  assert.equal(clampPartialAsr(PARTIAL_ASR_MAX_MS + 1000, 0), PARTIAL_ASR_MAX_MS)
  assert.equal(clampPartialAsr('x', 120), 120)
})

test('latency: the partial cost is kept, junk is not', () => {
  const kept = sanitizeLatencyRecord({
    kind: 'utterance', sessionId: 's', partialAsrCalls: 3, partialAsrMs: 512,
    audioBase64: 'AAAA', transcript: '不该落盘',
  })
  assert.equal(kept.partialAsrCalls, 3)
  assert.equal(kept.partialAsrMs, 512)
  assert.equal('audioBase64' in kept, false)
  assert.equal('transcript' in kept, false)
  const junk = sanitizeLatencyRecord({ kind: 'utterance', partialAsrCalls: 'many', partialAsrMs: Number.NaN })
  assert.equal('partialAsrCalls' in junk, false)
  assert.equal('partialAsrMs' in junk, false)
})
