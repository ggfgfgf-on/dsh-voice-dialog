import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
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

function pcmOf(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset + 44, bytes.byteLength - 44)
  return Float32Array.from({ length: view.byteLength / 2 }, (_, i) => view.getInt16(i * 2, true) / 32768)
}

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
  let buf = ''
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('ASR worker startup timeout')), 120000)
    child.stderr.on('data', b => process.stderr.write('[asr stderr] ' + b))
    child.once('exit', code => { clearTimeout(timer); reject(new Error('ASR worker exited ' + code)) })
    child.stdout.on('data', b => {
      buf += b
      const end = buf.indexOf('\n')
      if (end < 0) return
      clearTimeout(timer)
      resolve(JSON.parse(buf.slice(0, end)).port)
    })
  })
  return { child, url: 'http://127.0.0.1:' + port, token, startupMs: performance.now() - started }
}

async function run() {
  const { encodeWave } = await import(pathToFileURL(join(ROOT, 'lib/wav.js')))
  const raw = await readFile(join(ROOT, 'test/.latency/speech1.wav'))
  const samples = pcmOf(new Uint8Array(raw))
  const wav = Buffer.from(encodeWave(samples))
  const asr = await startAsr()
  console.log('ASR startup ms', asr.startupMs.toFixed(1), 'port', asr.url)
  for (let i = 0; i < 3; i++) {
    const t = performance.now()
    const res = await fetch(asr.url + '/transcribe?language=en', {
      method: 'POST', headers: { authorization: 'Bearer ' + asr.token, 'content-type': 'audio/wav' },
      body: wav,
    })
    const body = await res.json()
    console.log('ASR', i, 'status', res.status, 'wall', (performance.now() - t).toFixed(1), 'infer', (body.inferenceSeconds * 1000).toFixed(1), 'body', JSON.stringify(body).slice(0,300))
  }
  asr.child.kill()

  const { SeparationService } = await import(pathToFileURL(join(ROOT, 'lib/separation.js')))
  const sep = new SeparationService({ dataDir: HOME, modelPath: SEP_MODEL })
  let t = performance.now()
  await sep.warm()
  console.log('SEP warm', (performance.now() - t).toFixed(1), 'backend', sep.status().backend)
  const window = new Float32Array(64000)
  window.set(samples.subarray(0, Math.min(samples.length, window.length)))
  for (let i = 0; i < 3; i++) {
    t = performance.now()
    const result = await sep.separate(window)
    console.log('SEP', i, 'wall', (performance.now() - t).toFixed(1), 'reported', result.elapsedMs, 'sources', result.sources.length)
  }
  await sep.close()

  const { VoiceprintService } = await import(pathToFileURL(join(ROOT, 'lib/voiceprint.js')))
  const vp = new VoiceprintService({ dataDir: join(ROOT, 'test/.latency/vp'), modelPath: VP_MODEL })
  vp.warm()
  for (let i = 0; i < 3; i++) {
    t = performance.now()
    const r = await vp.identify(samples, { sessionId: 'bench', threshold: 0.52, adapt: false })
    console.log('VP', i, 'wall', (performance.now() - t).toFixed(1), 'label', r.label)
  }

  t = performance.now()
  const b64 = Buffer.from(encodeWave(samples)).toString('base64')
  JSON.stringify({ audioBase64: b64, sessionId: 'bench', threshold: 0.52 })
  console.log('PACK ms', (performance.now() - t).toFixed(1), 'base64 bytes', b64.length)
}
await run()
