/**
 * Transport benchmark: base64+JSON+WAV (old) vs binary PCM frames (new).
 * Run: node test/transport-benchmark.mjs
 * Both variants are served by a real local HTTP server so the request path
 * (headers, body copy, keep-alive) is exercised, not just the codec.
 */
import { createServer } from 'node:http'
import { readFile, writeFile } from 'node:fs/promises'
import { Agent, request } from 'node:http'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = 'D:/DSHwork/dsh-voice-dialog'
const WAV = join(ROOT, 'test/.latency/speech3.wav')
const ROUNDS = 3
const SAMPLE_RATE = 16000

const { encodeWave, audioBase64 } = await import(pathToFileURL(join(ROOT, 'src/wav.ts')))
const { decodeWavBase64 } = await import(pathToFileURL(join(ROOT, 'src/voiceprint.ts')))
const { encodeAudioFrames, decodeAudioFrames } = await import(pathToFileURL(join(ROOT, 'src/audio-transport.ts')))

const median = values => {
  const xs = [...values].sort((a, b) => a - b)
  const m = Math.floor(xs.length / 2)
  return xs.length % 2 ? xs[m] : (xs[m - 1] + xs[m]) / 2
}
const round = value => Math.round(value * 100) / 100
const kb = value => Math.round(value / 1024)

function pcmFromWav(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let offset = 12
  while (offset + 8 <= bytes.length) {
    const id = String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3])
    const size = view.getUint32(offset + 4, true)
    const body = offset + 8
    if (id === 'data') {
      const count = Math.min(size, bytes.length - body) / 2
      return Float32Array.from({ length: count }, (_, i) => view.getInt16(body + i * 2, true) / 32768)
    }
    offset = body + size + (size % 2)
  }
  throw new Error('no data chunk')
}

async function readBody(req, limit = 8 * 1024 * 1024) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > limit) throw new Error('body too large')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

const server = createServer(async (req, res) => {
  try {
    const started = performance.now()
    const body = await readBody(req)
    let samples
    let decodeMs
    if (req.url === '/old') {
      const t0 = performance.now()
      const text = body.toString('utf8')
      const parsed = JSON.parse(text)
      samples = decodeWavBase64(parsed.audioBase64)
      decodeMs = performance.now() - t0
    } else if (req.url === '/new') {
      const t0 = performance.now()
      const decoded = decodeAudioFrames(new Uint8Array(body.buffer, body.byteOffset, body.byteLength))
      samples = decoded.samples
      decodeMs = performance.now() - t0
      if (decoded.droppedFrames) throw new Error('dropped frames ' + decoded.droppedFrames)
    } else {
      res.writeHead(404).end('no')
      return
    }
    res.writeHead(200, { 'content-type': 'application/json', 'x-decode-ms': decodeMs.toFixed(2) })
    res.end(JSON.stringify({ ok: true, samples: samples.length, serverTotalMs: round(performance.now() - started) }))
  } catch (error) {
    res.writeHead(400, { 'content-type': 'text/plain' }).end(String(error && error.message || error))
  }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const agent = new Agent({ keepAlive: true, maxSockets: 2 })

function post(path, body, headers) {
  return new Promise((resolve, reject) => {
    const started = performance.now()
    const req = request({
      host: '127.0.0.1', port, path, method: 'POST', agent,
      headers: { 'content-length': body.length, ...headers },
    }, res => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => resolve({
        rttMs: performance.now() - started,
        decodeMs: Number(res.headers['x-decode-ms']),
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      }))
    })
    req.on('error', reject)
    req.end(body)
  })
}

const wavBytes = await readFile(WAV)
const all = pcmFromWav(wavBytes)
const samples = all.subarray(0, SAMPLE_RATE * 4) // 4 s window, same as the pipeline
console.log('samples=' + samples.length + ' (' + (samples.length / SAMPLE_RATE).toFixed(2) + ' s)')

const result = { rounds: ROUNDS, samples: samples.length, old: null, new: null, payload: null }

// warm up both paths once
{
  const bytes = encodeWave(samples)
  await post('/old', Buffer.from(JSON.stringify({ audioBase64: audioBase64(bytes) })), { 'content-type': 'application/json' })
  await post('/new', Buffer.from(encodeAudioFrames(samples)), { 'content-type': 'application/octet-stream' })
}

const measure = async kind => {
  const encodeMs = []
  const rttMs = []
  const decodeMs = []
  const totalMs = []
  let size = 0
  for (let round = 0; round < ROUNDS; round++) {
    const t0 = performance.now()
    let body
    let headers
    if (kind === 'old') {
      const bytes = encodeWave(samples)
      body = Buffer.from(JSON.stringify({ audioBase64: audioBase64(bytes) }))
      headers = { 'content-type': 'application/json' }
    } else {
      body = Buffer.from(encodeAudioFrames(samples))
      headers = { 'content-type': 'application/octet-stream' }
    }
    const encodeSpent = performance.now() - t0
    size = body.length
    const res = await post(kind === 'old' ? '/old' : '/new', body, headers)
    encodeMs.push(encodeSpent)
    rttMs.push(res.rttMs)
    decodeMs.push(res.decodeMs)
    totalMs.push(encodeSpent + res.rttMs)
    if (res.body.samples !== samples.length) throw new Error('sample count mismatch ' + res.body.samples)
  }
  return {
    encodeMs: round(median(encodeMs)),
    rttMs: round(median(rttMs)),
    decodeMs: round(median(decodeMs)),
    totalMs: round(median(totalMs)),
    bytes: size,
    samples: [encodeMs.map(round), rttMs.map(round), decodeMs.map(round)],
  }
}

result.old = await measure('old')
result['new'] = await measure('new')
result.payload = {
  oldBytes: result.old.bytes,
  newBytes: result['new'].bytes,
  shrinkPct: round((1 - result['new'].bytes / result.old.bytes) * 100),
}
result.delta = {
  encodeMs: round(result.old.encodeMs - result['new'].encodeMs),
  decodeMs: round(result.old.decodeMs - result['new'].decodeMs),
  totalMs: round(result.old.totalMs - result['new'].totalMs),
}

server.close()
agent.destroy()
await writeFile(join(ROOT, 'test/.latency/transport-results.json'), JSON.stringify(result, null, 2))
console.log(JSON.stringify(result, null, 2))
