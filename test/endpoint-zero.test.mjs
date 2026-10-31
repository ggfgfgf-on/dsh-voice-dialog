import assert from 'node:assert/strict'
import test from 'node:test'
import { endpointReached } from '../lib/mic.js'
import { normalizeSpeechProfile } from '../lib/speech-profile.js'

const base = {
  totalMs: 2000,
  maxSegmentMs: 25_000,
  silenceMs: 900,
  silence: 0,
  speechMs: 800,
  minSpeechMs: 260,
}

test('endpoint: a zero wait never cuts while someone is still talking', () => {
  assert.equal(endpointReached({ ...base, silenceMs: 0, silence: 0 }), false, 'a voiced frame resets silence to 0')
  assert.equal(endpointReached({ ...base, silenceMs: 0, silence: 21 }), true, 'the first unvoiced frame closes it')
  assert.equal(endpointReached({ ...base, silenceMs: 0, silence: 21, speechMs: 100 }), false, 'the existing minSpeech guard still refuses fragments')
  assert.equal(endpointReached({ ...base, silenceMs: 0, silence: 21, speechMs: 0 }), false, 'no empty utterance')
})

test('endpoint: positive waits keep their old meaning, the hard cap still applies', () => {
  assert.equal(endpointReached({ ...base, silence: 899 }), false)
  assert.equal(endpointReached({ ...base, silence: 900 }), true)
  assert.equal(endpointReached({ ...base, silence: 0, totalMs: 25_000 }), true)
  assert.equal(endpointReached({ ...base, silence: 0, speechMs: 0, totalMs: 25_000 }), false)
})

test('profile: micSilenceMs accepts 0 and still clamps its ends', () => {
  assert.equal(normalizeSpeechProfile({ micSilenceMs: 0 }).micSilenceMs, 0)
  assert.equal(normalizeSpeechProfile({ micSilenceMs: -5 }).micSilenceMs, 0)
  assert.equal(normalizeSpeechProfile({ micSilenceMs: 9999 }).micSilenceMs, 4000)
  assert.equal(normalizeSpeechProfile({ micSilenceMs: 900 }).micSilenceMs, 900)
})
