import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  resumeDelayForUtterance, YIELD_CONFIRM_MS, YIELD_RESUME_AFTER_SPEECH_MS, YIELD_SHORT_RESUME_MS,
  YIELD_SHORT_UTTERANCE_MS,
} from '../lib/yield.js'

test('a real sentence holds the floor while it is routed', () => {
  assert.equal(resumeDelayForUtterance(900), YIELD_RESUME_AFTER_SPEECH_MS)
  assert.equal(resumeDelayForUtterance(YIELD_SHORT_UTTERANCE_MS), YIELD_RESUME_AFTER_SPEECH_MS)
  assert.equal(resumeDelayForUtterance(20_000), YIELD_RESUME_AFTER_SPEECH_MS)
})

test('a cough or backchannel gives the floor straight back', () => {
  assert.equal(resumeDelayForUtterance(120), YIELD_SHORT_RESUME_MS)
  assert.equal(resumeDelayForUtterance(0), YIELD_SHORT_RESUME_MS)
  assert.equal(resumeDelayForUtterance(YIELD_SHORT_UTTERANCE_MS - 1), YIELD_SHORT_RESUME_MS)
})

test('an unmeasured onset never waits longer than the full decision window', () => {
  assert.equal(resumeDelayForUtterance(Number.NaN), YIELD_RESUME_AFTER_SPEECH_MS)
  assert.equal(resumeDelayForUtterance(-5), YIELD_RESUME_AFTER_SPEECH_MS)
  assert.ok(YIELD_SHORT_RESUME_MS < YIELD_RESUME_AFTER_SPEECH_MS)
})

test('a sound alone never holds the sentence, only speech that lasts', () => {
  // Longer than a click, shorter than a word: the volume ducks, reading goes on.
  assert.ok(YIELD_CONFIRM_MS >= 250, 'too twitchy')
  assert.ok(YIELD_CONFIRM_MS <= 600, 'a real interruption would wait too long')
})
