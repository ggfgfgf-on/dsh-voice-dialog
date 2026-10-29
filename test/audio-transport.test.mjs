import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

const ROOT = 'D:/DSHwork/dsh-voice-dialog'
const { encodeAudioFrames, decodeAudioFrames, AUDIO_CONTAINER_HEADER_BYTES } =
  await import(pathToFileURL(join(ROOT, 'lib/audio-transport.js')))
const { encodeWave, audioBase64 } = await import(pathToFileURL(join(ROOT, 'lib/wav.js')))

const sine = (count, freq = 220, rate = 16000) =>
  Float32Array.from({ length: count }, (_, i) => Math.sin((2 * Math.PI * freq * i) / rate) * 0.5)

test('round trip keeps every sample within one PCM16 step', () => {
  const samples = sine(2000)
  const decoded = decodeAudioFrames(encodeAudioFrames(samples))
  assert.equal(decoded.samples.length, samples.length)
  assert.equal(decoded.sampleRate, 16000)
  assert.equal(decoded.droppedFrames, 0)
  assert.equal(decoded.truncated, false)
  let worst = 0
  for (let i = 0; i < samples.length; i++) worst = Math.max(worst, Math.abs(samples[i] - decoded.samples[i]))
  assert.ok(worst <= 1 / 32767 + 1e-6, 'worst error ' + worst)
})

test('the container splits into bounded frames and survives a partial last frame', () => {
  const samples = sine(4800 * 2 + 37) // two full frames plus a short tail
  const bytes = encodeAudioFrames(samples)
  const decoded = decodeAudioFrames(bytes)
  assert.equal(decoded.samples.length, samples.length)
  assert.equal(decoded.truncated, false)
  // header + 3 frames, each with a 2-byte length prefix
  assert.ok(bytes.length > AUDIO_CONTAINER_HEADER_BYTES + samples.length * 2)
})

test('a frame with an impossible length is dropped, never thrown', () => {
  const samples = sine(1200)
  const bytes = encodeAudioFrames(samples)
  // Corrupt the first frame length so it claims more bytes than exist.
  const view = new DataView(bytes.buffer)
  view.setUint16(AUDIO_CONTAINER_HEADER_BYTES, 0xFFFF, true)
  const decoded = decodeAudioFrames(bytes)
  assert.equal(decoded.droppedFrames, 1)
  assert.equal(decoded.truncated, true)
  assert.equal(decoded.samples.length, 0)
})

test('a wrong magic or version is rejected instead of decoded as noise', () => {
  const bytes = encodeAudioFrames(sine(400))
  const badMagic = Uint8Array.from(bytes)
  badMagic[0] = 0
  assert.throws(() => decodeAudioFrames(badMagic), /标识/)
  const badVersion = Uint8Array.from(bytes)
  badVersion[4] = 99
  assert.throws(() => decodeAudioFrames(badVersion), /版本/)
  assert.throws(() => decodeAudioFrames(new Uint8Array(4)), /过短/)
})

test('out of range and NaN samples are clamped, not wrapped', () => {
  const samples = Float32Array.from([2, -2, Number.NaN, 0.5])
  const decoded = decodeAudioFrames(encodeAudioFrames(samples))
  // PCM16 positive full scale is 32767, so +1 lands one step short of 1.
  assert.ok(Math.abs(decoded.samples[0] - 1) < 1e-4, 'positive clip ' + decoded.samples[0])
  assert.equal(decoded.samples[1], -1)
  assert.equal(decoded.samples[2], 0)
  assert.ok(Math.abs(decoded.samples[3] - 0.5) < 1e-3)
})

test('two concurrent streams stay independent', () => {
  const a = sine(700, 220)
  const b = sine(700, 440)
  const bytesA = encodeAudioFrames(a)
  const bytesB = encodeAudioFrames(b)
  const decodedA = decodeAudioFrames(bytesA)
  const decodedB = decodeAudioFrames(bytesB)
  assert.equal(decodedA.samples.length, a.length)
  assert.equal(decodedB.samples.length, b.length)
  assert.notDeepEqual(Array.from(decodedA.samples.slice(0, 32)), Array.from(decodedB.samples.slice(0, 32)))
})

test('the binary container is smaller than base64 WAV for the same audio', () => {
  const samples = sine(64000)
  const binary = encodeAudioFrames(samples).length
  const json = audioBase64(encodeWave(samples)).length
  assert.ok(binary < json, binary + ' vs ' + json)
  assert.ok(json / binary > 1.2, 'expected a large payload cut, got ' + (json / binary))
})

test('the host route is registered and falls back cleanly in the client', () => {
  const host = readFileSync(join(ROOT, 'src/index.ts'), 'utf8')
  const client = readFileSync(join(ROOT, 'src/client.tsx'), 'utf8')
  assert.match(host, /\['\/separation\/separate-binary', separationRunBinary\]/)
  assert.match(host, /decodeAudioFrames\(bytes\)/)
  assert.match(host, /const completeSeparation = async/)
  // The old JSON route must survive: it is the fallback when the binary one fails.
  assert.match(host, /\['\/separation\/separate', separationRun\]/)
  // The client shares one fallback state with the uploaded container.
  assert.match(client, /postAudioFrames\(/)
  assert.match(client, /apiUrl\('\/separation\/separate'\)/)
})
