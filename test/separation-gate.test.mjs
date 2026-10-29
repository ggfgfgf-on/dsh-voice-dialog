import assert from 'node:assert/strict'
import test from 'node:test'
import { decideSpeakerGate, selectSpeechWindows } from '../lib/separation-gate.js'

const SR = 16_000
function speech(seconds, amplitude = 0.2) {
  const out = new Float32Array(Math.round(SR * seconds))
  for (let i = 0; i < out.length; i++) out[i] = Math.sin(i / 7) * amplitude
  return out
}
function silence(seconds) {
  return new Float32Array(Math.round(SR * seconds))
}
function concat(parts) {
  const out = new Float32Array(parts.reduce((sum, part) => sum + part.length, 0))
  let offset = 0
  for (const part of parts) { out.set(part, offset); offset += part.length }
  return out
}

test('speech window selector trims silence and returns two separated chunks', () => {
  const result = selectSpeechWindows(concat([silence(0.4), speech(2.4), silence(0.4)]))
  assert.equal(result.reason, 'ok')
  assert.equal(result.windows.length, 2)
  assert.ok(result.windows[0].samples.length >= 5600)
  assert.ok(result.windows[1].samples.length >= 5600)
  assert.ok(result.windows[0].endSample <= result.windows[1].startSample)
})

test('too-short or silent audio is never fast-pathed', () => {
  assert.equal(selectSpeechWindows(silence(2)).reason, 'no-speech')
  assert.equal(selectSpeechWindows(concat([silence(0.2), speech(0.3), silence(0.2)])).reason, 'too-short')
})

test('same voice and confirmed owner is the only single-speaker decision', () => {
  const same = decideSpeakerGate({ selfSimilarities: [0.81], ownerSimilarity: 0.77 })
  assert.equal(same.singleSpeaker, true)
  assert.equal(same.confident, true)
  assert.equal(same.reason, 'same-voice')

  const changing = decideSpeakerGate({ selfSimilarities: [0.32], ownerSimilarity: 0.78 })
  assert.equal(changing.singleSpeaker, false)
  assert.equal(changing.suspected, true)
  assert.equal(changing.reason, 'voice-changed')

  const ownerMismatch = decideSpeakerGate({ selfSimilarities: [0.83], ownerSimilarity: 0.21 })
  assert.equal(ownerMismatch.singleSpeaker, false)
  assert.equal(ownerMismatch.suspected, true)
  assert.equal(ownerMismatch.reason, 'owner-mismatch')

  const uncertain = decideSpeakerGate({ selfSimilarities: [0.55] })
  assert.equal(uncertain.singleSpeaker, false)
  assert.equal(uncertain.confident, false)
  assert.equal(uncertain.reason, 'uncertain')
})

test('insufficient audio always falls back to separation', () => {
  const decision = decideSpeakerGate({ selfSimilarities: [] })
  assert.equal(decision.singleSpeaker, false)
  assert.equal(decision.suspected, true)
  assert.equal(decision.confident, false)
})
