/**
 * Real-model benchmark for the MossFormer2 separation worker on Windows.
 *
 * Measures, with three independent samples each:
 *   - CPU worker warm inference (4 s / 16 kHz window)
 *   - DirectML worker warm inference (4 s / 16 kHz window)
 *   - cold start: fork + onnxruntime-node + model session load
 *
 * Run: node test/gpu-benchmark.mjs
 * Optional env: DSH_SEPARATION_MODEL, DSH_GPU_BENCH_AUDIO
 */
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SeparationService } from '../lib/separation.js'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const DATA_DIR = join(homedir(), '.dsh', 'voice-dialog')
const MODEL = process.env.DSH_SEPARATION_MODEL
  ?? join(DATA_DIR, 'models', 'mossformer2_ss_16k.onnx')
const AUDIO = process.env.DSH_GPU_BENCH_AUDIO
  ?? join(ROOT, 'test', '.latency', 'speech3.wav')
const RUNS = 3
const WINDOW = 64_000
const SAMPLE_RATE = 16_000

function readWav(bytes) {
  let offset = 12
  let format
  let dataOffset
  let dataBytes
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString('ascii', offset, offset + 4)
    const size = bytes.readUInt32LE(offset + 4)
    const body = offset + 8
    if (id === 'fmt ') {
      format = {
        channels: bytes.readUInt16LE(body + 2),
        sampleRate: bytes.readUInt32LE(body + 4),
        bits: bytes.readUInt16LE(body + 14),
      }
    }
    if (id === 'data') {
      dataOffset = body
      dataBytes = Math.min(size, bytes.length - body)
      break
    }
    offset = body + size + (size & 1)
  }
  assert.ok(format && dataOffset !== undefined && dataBytes !== undefined, 'WAV fmt/data chunk missing')
  assert.equal(format.channels, 1, 'benchmark audio must be mono')
  assert.equal(format.sampleRate, SAMPLE_RATE, 'benchmark audio must be 16 kHz')
  assert.equal(format.bits, 16, 'benchmark audio must be 16-bit PCM')
  const samples = new Float32Array(Math.floor(dataBytes / 2))
  for (let i = 0; i < samples.length; i++) {
    samples[i] = bytes.readInt16LE(dataOffset + i * 2) / 32768
  }
  return samples
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2
}

const round = (value) => Math.round(value * 10) / 10

async function loadWindows(path) {
  const samples = readWav(await readFile(path))
  assert.ok(samples.length >= WINDOW, 'audio must contain at least one 4 s window')
  const starts = [
    0,
    Math.floor((samples.length - WINDOW) / 2),
    samples.length - WINDOW,
  ]
  assert.equal(new Set(starts).size, RUNS, 'audio must contain three distinct 4 s windows')
  return {
    totalSamples: samples.length,
    durationSeconds: round(samples.length / SAMPLE_RATE),
    windows: starts.map((start, index) => ({
      index: index + 1,
      startSample: start,
      startSeconds: round(start / SAMPLE_RATE),
      samples: samples.slice(start, start + WINDOW),
    })),
  }
}

function serviceFor(provider) {
  return new SeparationService({
    dataDir: DATA_DIR,
    modelPath: MODEL,
    executionProviders: [provider],
    dmlDeviceId: 0,
  })
}

async function measureColdStart(provider) {
  const samples = []
  for (let index = 0; index < RUNS; index++) {
    const service = serviceFor(provider)
    try {
      const started = performance.now()
      await service.warm()
      samples.push(performance.now() - started)
      const actual = service.status().backend
      assert.equal(actual, provider, provider + ' cold start selected ' + actual)
    } finally {
      await service.close()
    }
  }
  return {
    sampleMs: samples.map(round),
    medianMs: round(median(samples)),
  }
}

async function measureInference(provider, windows) {
  const service = serviceFor(provider)
  try {
    await service.warm()
    assert.equal(service.status().backend, provider, provider + ' warmup selected the wrong backend')

    // Exclude shader/thread-pool compilation from the steady-state samples.
    const warmStarted = performance.now()
    const warm = await service.separate(windows[0].samples)
    const warmupMs = performance.now() - warmStarted
    assert.ok(warm.sources.length >= 1)

    const rows = []
    for (const window of windows) {
      const started = performance.now()
      const result = await service.separate(window.samples)
      const wallMs = performance.now() - started
      assert.ok(result.sources.length >= 1)
      rows.push({
        window: window.index,
        inferenceMs: result.elapsedMs,
        wallMs,
        sources: result.sources.length,
      })
    }
    return {
      backend: service.status().backend,
      warmupMs: round(warmupMs),
      inferenceSampleMs: rows.map((row) => round(row.inferenceMs)),
      inferenceMedianMs: round(median(rows.map((row) => row.inferenceMs))),
      wallSampleMs: rows.map((row) => round(row.wallMs)),
      wallMedianMs: round(median(rows.map((row) => row.wallMs))),
      rows,
    }
  } finally {
    await service.close()
  }
}

async function benchmarkProvider(provider, windows) {
  const cold = await measureColdStart(provider)
  const inference = await measureInference(provider, windows)
  return { ...inference, coldStartSampleMs: cold.sampleMs, coldStartMedianMs: cold.medianMs }
}

async function verifyFallback(windows) {
  const service = new SeparationService({
    dataDir: DATA_DIR,
    modelPath: MODEL,
    executionProviders: ['dml'],
    // An impossible adapter forces the GPU session to fail, exercising CPU fallback.
    dmlDeviceId: 999,
  })
  try {
    await service.warm()
    const backend = service.status().backend
    const result = await service.separate(windows[0].samples)
    return {
      requested: 'dml',
      selectedBackend: backend,
      inferenceOk: result.sources.length >= 1,
      inferenceMs: round(result.elapsedMs),
    }
  } finally {
    await service.close()
  }
}

const audio = await loadWindows(AUDIO)
const results = {
  measuredAt: new Date().toISOString(),
  rounds: RUNS,
  targetMs: 300,
  model: MODEL,
  audio: {
    file: AUDIO,
    sampleRate: SAMPLE_RATE,
    windowSamples: WINDOW,
    windowSeconds: WINDOW / SAMPLE_RATE,
    sourceDurationSeconds: audio.durationSeconds,
    windows: audio.windows.map(({ samples, ...rest }) => rest),
  },
}

let dmlError
try {
  results.dml = await benchmarkProvider('dml', audio.windows)
  results.dml.available = true
} catch (error) {
  dmlError = error instanceof Error ? error : new Error(String(error))
  results.dml = { available: false, error: String(dmlError.message) }
}

results.cpu = await benchmarkProvider('cpu', audio.windows)
results.cpu.available = true
results.coldStart = {
  dmlMedianMs: results.dml.available ? results.dml.coldStartMedianMs : null,
  cpuMedianMs: results.cpu.coldStartMedianMs,
}
results.target = {
  maxMs: 300,
  dmlMedianMs: results.dml.available ? results.dml.inferenceMedianMs : null,
  met: results.dml.available ? results.dml.inferenceMedianMs < 300 : false,
}
results.fallback = await verifyFallback(audio.windows)
assert.equal(results.fallback.selectedBackend, 'cpu', 'invalid DML device did not fall back to CPU')
assert.equal(results.fallback.inferenceOk, true, 'CPU fallback could not separate audio')

await mkdir(join(ROOT, 'test', '.latency'), { recursive: true })
const output = join(ROOT, 'test', '.latency', 'gpu-results.json')
await writeFile(output, JSON.stringify(results, null, 2), 'utf8')
console.log(JSON.stringify({
  model: results.model,
  audio: results.audio,
  dml: results.dml,
  cpu: results.cpu,
  coldStart: results.coldStart,
  target: results.target,
  fallback: results.fallback,
  output,
}, null, 2))
if (!results.dml.available) {
  console.error('DML unavailable: ' + dmlError?.message)
}
