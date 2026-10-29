/**
 * Route-level check of the binary transport and its fallback, using real local
 * HTTP servers: one that only knows the old JSON route (a host that predates
 * this change) and one that implements both.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

const ROOT = 'D:/DSHwork/dsh-voice-dialog'
const { encodeAudioFrames, decodeAudioFrames, postAudioFrames } =
  await import(pathToFileURL(join(ROOT, 'lib/audio-transport.js')))
const { encodeWave, audioBase64 } = await import(pathToFileURL(join(ROOT, 'lib/wav.js')))
const { decodeWavBase64 } = await import(pathToFileURL(join(ROOT, 'lib/voiceprint.js')))

const sine = (count, freq = 220, rate = 16000) =>
  Float32Array.from({ length: count }, (_, i) => Math.sin((2 * Math.PI * freq * i) / rate) * 0.5)

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  return Buffer.concat(chunks)
}

/** mode: 'both' | 'json-only' | 'reject-binary' */
async function startServer(mode) {
  const counters = { binary: 0, json: 0 }
  const server = createServer(async (req, res) => {
    const body = await readBody(req)
    if (req.url === '/separation/separate-binary') {
      counters.binary += 1
      if (mode === 'json-only') { res.writeHead(404).end('no'); return }
      if (mode === 'reject-binary') { res.writeHead(400).end('bad'); return }
      const decoded = decodeAudioFrames(new Uint8Array(body.buffer, body.byteOffset, body.byteLength))
      if (decoded.droppedFrames > 0) { res.writeHead(400).end('dropped'); return }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ transport: 'binary', samples: decoded.samples.length, separated: false }))
      return
    }
    if (req.url === '/separation/separate') {
      counters.json += 1
      const parsed = JSON.parse(body.toString('utf8'))
      const samples = decodeWavBase64(parsed.audioBase64)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ transport: 'json', samples: samples.length, separated: false }))
      return
    }
    res.writeHead(404).end('no')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { url: 'http://127.0.0.1:' + server.address().port, counters, close: () => server.close() }
}

const jsonFallback = async (url, samples) => {
  const response = await fetch(url + '/separation/separate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ audioBase64: audioBase64(encodeWave(samples)) }),
  })
  return await response.json()
}

test('a host with the binary route is used, and the fallback is never touched', async () => {
  const server = await startServer('both')
  try {
    const samples = sine(1600)
    const state = { broken: false }
    const result = await postAudioFrames(fetch, server.url + '/separation/separate-binary', samples, {}, state)
    assert.equal(result.transport, 'binary')
    assert.equal(result.samples, samples.length)
    assert.equal(state.broken, false)
    assert.deepEqual(server.counters, { binary: 1, json: 0 })
  } finally { server.close() }
})

test('a host without the route costs one request, then falls back for good', async () => {
  const server = await startServer('json-only')
  try {
    const samples = sine(1600)
    const state = { broken: false }
    const first = await postAudioFrames(fetch, server.url + '/separation/separate-binary', samples, {}, state)
    assert.equal(first, null)
    assert.equal(state.broken, true)
    const second = await postAudioFrames(fetch, server.url + '/separation/separate-binary', samples, {}, state)
    assert.equal(second, null)
    // The broken flag must short-circuit: still exactly one binary attempt.
    assert.deepEqual(server.counters, { binary: 1, json: 0 })
    // And the old JSON path still works against the same host.
    const fallback = await jsonFallback(server.url, samples)
    assert.equal(fallback.transport, 'json')
    assert.equal(fallback.samples, samples.length)
    assert.deepEqual(server.counters, { binary: 1, json: 1 })
  } finally { server.close() }
})

test('a rejected binary body also falls back instead of losing the utterance', async () => {
  const server = await startServer('reject-binary')
  try {
    const samples = sine(800)
    const state = { broken: false }
    assert.equal(await postAudioFrames(fetch, server.url + '/separation/separate-binary', samples, {}, state), null)
    assert.equal(state.broken, true)
    const fallback = await jsonFallback(server.url, samples)
    assert.equal(fallback.samples, samples.length)
  } finally { server.close() }
})

test('a connection that cannot be made falls back too', async () => {
  const state = { broken: false }
  const result = await postAudioFrames(fetch, 'http://127.0.0.1:9/separation/separate-binary', sine(400), {}, state)
  assert.equal(result, null)
  assert.equal(state.broken, true)
})
