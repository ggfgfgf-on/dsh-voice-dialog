import test from 'node:test'
import assert from 'node:assert/strict'
import { cosineSimilarity, decodeWavBase64 } from '../lib/voiceprint.js'
import { encodeWave } from '../lib/wav.js'

test('cosine similarity is 1 for the same direction and 0 for orthogonal vectors', () => {
  const a = Float32Array.from([1, 0, 0])
  assert.equal(cosineSimilarity(a, a), 1)
  assert.equal(cosineSimilarity(a, Float32Array.from([0, 1, 0])), 0)
  assert.equal(cosineSimilarity(Float32Array.from([0, 0, 0]), a), 0)
})

test('decodes the client WAV back into the same samples', () => {
  const samples = Float32Array.from([0, 0.25, -0.5, 0.75])
  const base64 = Buffer.from(encodeWave(samples)).toString('base64')
  const decoded = decodeWavBase64(base64)
  assert.equal(decoded.length, samples.length)
  for (let i = 0; i < samples.length; i++) {
    assert.ok(Math.abs(decoded[i] - samples[i]) <= 1 / 32768)
  }
})

test('rejects a WAV that is not 16 kHz mono PCM16', () => {
  const bytes = encodeWave(Float32Array.from([0, 0.1]))
  const wrongRate = new Uint8Array(bytes)
  new DataView(wrongRate.buffer).setUint32(24, 8000, true)
  assert.throws(
    () => decodeWavBase64(Buffer.from(wrongRate).toString('base64')),
    /16 kHz/,
  )
})
