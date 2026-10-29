/**
 * Reproducible local latency benchmark for the continuous voice pipeline.
 * Run: node test/latency-benchmark.mjs --label baseline
 * It uses the real local SenseVoice worker, CAM++ voiceprint, and MossFormer2
 * DML worker. Endpoint timing uses the real ContinuousSeparation class with a
 * deterministic two-source stub whose callback delay equals measured MossFormer2.
 */
import { spawn } from 'node:child_process'
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = 'D:/DSHwork/dsh-voice-dialog'
const HOME = 'C:/Users/chesand/.dsh/voice-dialog'
const DSH_HOME = 'D:/deepseek-harness-dsh-v0.2.1rc2/.dsh-home'
const ASR_PKG = 'D:/deepseek-harness-dsh-v0.2.1rc2/packages/experimental/speech-to-text-sensevoice'
const MODEL = join(DSH_HOME, 'speech-to-text/sensevoice/models/sensevoice-onnx/model.int8.onnx')
const TOKENS = join(DSH_HOME, 'speech-to-text/sensevoice/models/sensevoice-onnx/tokens.txt')
const VAD = join(DSH_HOME, 'speech-to-text/sensevoice/models/silero/silero_vad.onnx')
const SEP_MODEL = join(HOME, 'models/mossformer2_ss_16k.onnx')
const VP_MODEL = join(HOME, 'models/3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx')
const LABEL = process.argv.includes('--label') ? process.argv[process.argv.indexOf('--label') + 1] : 'run'
const ROUNDS = 3
const SAMPLE_RATE = 16000

const { encodeWave, audioBase64 } = await import(pathToFileURL(join(ROOT, 'src/wav.ts')))
const { default: assert } = await import('node:assert/strict')
const { SeparationService } = await import(pathToFileURL(join(ROOT, 'lib/separation.js')))
const { VoiceprintService } = await import(pathToFileURL(join(ROOT, 'lib/voiceprint.js')))
const { ContinuousSeparation } = await import(pathToFileURL(join(ROOT, 'src/continuous-separation.ts')))

function pcmOf(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset + 44, bytes.byteLength - 44)
  return Float32Array.from({ length: view.byteLength / 2 }, (_, i) => view.getInt16(i * 2, true) / 32768)
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
const median = values => {
  const xs = [...values].sort((a, b) => a - b)
  const m = Math.floor(xs.length / 2)
  return xs.length % 2 ? xs[m] : (xs[m - 1] + xs[m]) / 2
}
const avg = values => values.reduce((a, b) => a + b, 0) / Math.max(1, values.length)
const round = value => Math.round(value * 10) / 10

async function startAsr() {
  const token = randomBytes(32).toString('hex')
  const config = {
    providerId: 'sensevoice-local',
    dataRoot: join(DSH_HOME, 'speech-to-text/sensevoice'),
    modelDirectory: join(DSH_HOME, 'speech-to-text/sensevoice/models/sensevoice-onnx'),
    vadModelPath: VAD,
    precision: 'int8',
    threads: 2,
    model: MODEL, tokens: TOKENS, vad: VAD,
  }
  const started = performance.now()
  const child = spawn(process.execPath, [join(ASR_PKG, 'lib/worker.js'), JSON.stringify(config)], {
    cwd: join(DSH_HOME, 'speech-to-text/sensevoice'),
    env: { ...process.env, DSH_SPEECH_TOKEN: token, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  })
  let buffer = ''
  let stderr = ''
  child.stderr.on('data', chunk => { stderr += chunk.toString() })
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('ASR worker startup timeout')), 120000)
    child.once('exit', code => { clearTimeout(timer); reject(new Error('ASR worker exited ' + code + ': ' + stderr.slice(-500))) })
    child.stdout.on('data', chunk => {
      buffer += chunk.toString()
      const end = buffer.indexOf('\n')
      if (end < 0) return
      clearTimeout(timer)
      resolve(JSON.parse(buffer.slice(0, end)).port)
    })
  })
  return { child, url: 'http://127.0.0.1:' + port, token, startupMs: performance.now() - started }
}

async function endpointRuns(separationDelayMs) {
  const ownerEndMs = 5000
  const guestStartMs = 500
  const guestEndMs = 1500
  const feedEndMs = 7000
  const sr = 1000
  const windowMs = 4000
  const events = []
  const nowByEnd = new Map()

  const separation = new ContinuousSeparation({
    sampleRate: sr,
    separate: async (window, startSample) => {
      await sleep(separationDelayMs)
      const a = new Float32Array(window.length)
      const b = new Float32Array(window.length)
      for (let i = 0; i < window.length; i++) {
        const at = startSample + i
        if (at < ownerEndMs) a[i] = 0.2 * Math.sin(2 * Math.PI * 0.1 * at)
        if (at >= guestStartMs && at < guestEndMs) b[i] = 0.2 * Math.sin(2 * Math.PI * 0.3 * at)
      }
      const rms = x => Math.sqrt(x.reduce((sum, v) => sum + v * v, 0) / Math.max(1, x.length))
      return { sources: [{ samples: a, rms: rms(a) }, { samples: b, rms: rms(b) }] }
    },
    onSegment: segment => events.push({ ...segment, at: performance.now() }),
  })

  for (let at = 0; at < feedEndMs; at += 100) {
    const chunk = new Float32Array(100)
    if (at < ownerEndMs) chunk.fill(0.1)
    separation.push(chunk)
    if (at + 100 >= guestEndMs) nowByEnd.set('guest', performance.now())
    if (at + 100 >= ownerEndMs) nowByEnd.set('owner', performance.now())
    await sleep(100)
  }
  await sleep(separationDelayMs + 100)
  await separation.flush()
  await separation.close()
  const wait = slot => {
    const event = events.find(item => item.slot === slot)
    const end = nowByEnd.get(slot === 0 ? 'owner' : 'guest')
    return event && end ? event.at - end : null
  }
  return {
    ownerWaitMs: wait(0), guestWaitMs: wait(1),
    ownerSamples: events.find(x => x.slot === 0)?.samples.length ?? 0,
    guestSamples: events.find(x => x.slot === 1)?.samples.length ?? 0,
    eventCount: events.length,
    windowMs,
  }
}

await mkdir(join(ROOT, 'test/.latency'), { recursive: true })
const files = ['speech1.wav', 'speech2.wav', 'speech3.wav']
const inputs = []
for (const file of files) {
  const raw = await readFile(join(ROOT, 'test/.latency', file))
  inputs.push({ file, samples: pcmOf(new Uint8Array(raw)) })
}

const rows = []
const asr = await startAsr()
const separationService = new SeparationService({ dataDir: HOME, modelPath: SEP_MODEL })
await separationService.warm()
const voiceprint = new VoiceprintService({ dataDir: join(ROOT, 'test/.latency/vp'), modelPath: VP_MODEL })
voiceprint.warm()

for (let roundIndex = 0; roundIndex < ROUNDS; roundIndex++) {
  for (const input of inputs) {
    const encoded = encodeWave(input.samples)
    let started = performance.now()
    const b64 = audioBase64(encoded)
    const payload = JSON.stringify({ audioBase64: b64, sessionId: 'latency-bench', threshold: 0.52 })
    const packMs = performance.now() - started

    started = performance.now()
    const identity = await voiceprint.identify(input.samples, { sessionId: 'latency-bench', threshold: 0.52, adapt: false })
    const voiceprintMs = performance.now() - started

    started = performance.now()
    const overlap = await voiceprint.overlap(input.samples)
    const voiceprintOverlapMs = performance.now() - started

    started = performance.now()
    const response = await fetch(asr.url + '/transcribe?language=en', {
      method: 'POST', headers: { authorization: 'Bearer ' + asr.token, 'content-type': 'audio/wav' }, body: encoded,
    })
    const asrWallMs = performance.now() - started
    const asrBody = await response.json()
    if (!response.ok) throw new Error('ASR failed: ' + JSON.stringify(asrBody))
    const asrInferenceMs = Number(asrBody.inferenceSeconds) * 1000
    const asrTransportMs = asrWallMs - asrInferenceMs

    const window = new Float32Array(64000)
    window.set(input.samples.subarray(0, Math.min(input.samples.length, window.length)))
    started = performance.now()
    const split = await separationService.separate(window)
    const separationMs = performance.now() - started
    assert.ok(split.sources.length >= 1)

    rows.push({
      round: roundIndex + 1, file: input.file, samples: input.samples.length,
      payloadBytes: Buffer.byteLength(payload), packMs, voiceprintMs,
      voiceprintOverlapMs, overlapSingle: overlap.singleSpeaker, overlapReason: overlap.reason,
      overlapSimilarity: overlap.minSimilarity ?? null,
      asrWallMs, asrInferenceMs, asrTransportMs, separationMs,
      fastGateAndRouteMs: voiceprintOverlapMs + voiceprintMs,
      fastEnqueueMs: Math.max(voiceprintOverlapMs + voiceprintMs, asrWallMs),
      fastTotalMs: 900 + Math.max(voiceprintOverlapMs + voiceprintMs, asrWallMs),
      text: String(asrBody.text ?? ''), label: identity.label,
    })
  }
}

asr.child.kill()
await separationService.close()
const sepMedian = median(rows.map(x => x.separationMs))
const endpoint = []
for (let i = 0; i < ROUNDS; i++) endpoint.push(await endpointRuns(sepMedian))

const result = {
  label: LABEL,
  measuredAt: new Date().toISOString(),
  rounds: ROUNDS,
  environment: {
    asr: 'SenseVoice int8 native worker, threads=2',
    asrStartupMs: round(asr.startupMs),
    separation: 'MossFormer2 ONNX backend=' + separationService.status().backend,
    voiceprint: 'CAM++ sherpa-onnx native',
    endpoint: 'real ContinuousSeparation + deterministic two-source stub, sep delay = measured median',
  },
  medians: {
    packMs: round(median(rows.map(x => x.packMs))),
    asrInferenceMs: round(median(rows.map(x => x.asrInferenceMs))),
    asrTransportMs: round(median(rows.map(x => x.asrTransportMs))),
    asrWallMs: round(median(rows.map(x => x.asrWallMs))),
    voiceprintMs: round(median(rows.map(x => x.voiceprintMs))),
    voiceprintOverlapMs: round(median(rows.map(x => x.voiceprintOverlapMs))),
    fastGateAndRouteMs: round(median(rows.map(x => x.fastGateAndRouteMs))),
    fastEnqueueMs: round(median(rows.map(x => x.fastEnqueueMs))),
    fastTotalMs: round(median(rows.map(x => x.fastTotalMs))),
    separationMs: round(sepMedian),
    sepWindowMs: 4000,
    guestEndpointWaitMs: round(median(endpoint.map(x => x.guestWaitMs).filter(x => x !== null))),
    ownerEndpointWaitMs: round(median(endpoint.map(x => x.ownerWaitMs).filter(x => x !== null))),
  },
  means: {
    packMs: round(avg(rows.map(x => x.packMs))),
    asrInferenceMs: round(avg(rows.map(x => x.asrInferenceMs))),
    voiceprintMs: round(avg(rows.map(x => x.voiceprintMs))),
    separationMs: round(avg(rows.map(x => x.separationMs))),
  },
  endpointRuns: endpoint.map(run => ({ guestWaitMs: round(run.guestWaitMs), ownerWaitMs: round(run.ownerWaitMs), events: run.eventCount, guestSamples: run.guestSamples, ownerSamples: run.ownerSamples })),
  rows,
}
await writeFile(join(ROOT, 'test/.latency', 'results-' + LABEL + '.json'), JSON.stringify(result, null, 2), 'utf8')
console.log(JSON.stringify(result, null, 2))
