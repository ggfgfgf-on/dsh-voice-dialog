import assert from 'node:assert/strict'
import test from 'node:test'
import { audioBase64, encodeWave } from '../lib/wav.js'

test('encodes a canonical PCM16 mono WAV header', () => {
  const wav = encodeWave(new Float32Array([0, 1, -1]))
  assert.equal(String.fromCharCode(...wav.slice(0, 4)), 'RIFF')
  assert.equal(String.fromCharCode(...wav.slice(8, 12)), 'WAVE')
  assert.equal(String.fromCharCode(...wav.slice(36, 40)), 'data')
  assert.equal(wav.length, 44 + 3 * 2)
  assert.equal(audioBase64(wav).length > 0, true)
})
