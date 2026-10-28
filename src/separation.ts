/** Two-speaker separation on a single mixed microphone signal (MossFormer2, ONNX). */
import { createRequire } from 'node:module'
import { fork, type ChildProcess } from 'node:child_process'
import { createWriteStream, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { request as httpsRequest } from 'node:https'
import { pipeline } from 'node:stream/promises'
import * as httpsProxyAgent from 'https-proxy-agent'
import {
  SEPARATION_FADE as FADE,
  SEPARATION_HOP as HOP,
  SEPARATION_WINDOW as WINDOW,
  shouldSwap,
} from './separation-align.js'

export { shouldSwap } from './separation-align.js'

const require = createRequire(import.meta.url)

export const SEPARATION_MODEL_FILE = 'mossformer2_ss_16k.onnx'
export const SEPARATION_MODEL_BYTES = 245_120_037
const MODEL_URL = 'https://huggingface.co/mhavo/mossformer2-ss-16k-onnx/resolve/main/' + SEPARATION_MODEL_FILE
const SAMPLE_RATE = 16_000
/** A second stream below this share of the louder one is leakage, not a person. */
const SOURCE_FLOOR = 0.1

export interface SeparationStatus {
  addonAvailable: boolean
  modelPresent: boolean
  ready: boolean
  modelPath: string
  modelBytes: number
  backend?: string
  error?: string
}

export interface RawSeparation {
  sources: Array<{ samples: Float32Array; rms: number; onsetMs: number }>
  elapsedMs: number
}

type RunWindow = (input: Float32Array) => Promise<[Float32Array, Float32Array]>

function proxyUrl(): string | undefined {
  const raw = process.env.DSH_VOICE_MODEL_PROXY ?? process.env.HTTPS_PROXY ?? process.env.https_proxy
    ?? process.env.HTTP_PROXY ?? process.env.http_proxy
  if (!raw || !/^https?:\/\//i.test(raw.trim())) return undefined
  return raw.trim()
}

function download(url: string, dest: string, redirects = 0): Promise<void> {
  return new Promise((resolve, reject) => {
    if (redirects > 6) { reject(new Error('分离模型下载重定向过多')); return }
    const proxy = proxyUrl()
    const Agent = (httpsProxyAgent as unknown as { HttpsProxyAgent: new (url: string) => object }).HttpsProxyAgent
    const agent = proxy ? new Agent(proxy) : undefined
    const req = httpsRequest(url, { agent, headers: { 'user-agent': 'dsh-voice-dialog' } }, (res) => {
      const status = res.statusCode ?? 0
      const location = res.headers.location
      if (status >= 300 && status < 400 && location) {
        res.resume()
        download(new URL(location, url).toString(), dest, redirects + 1).then(resolve, reject)
        return
      }
      if (status !== 200) {
        res.resume()
        reject(new Error('下载分离模型失败（HTTP ' + status + '）'))
        return
      }
      const out = createWriteStream(dest)
      pipeline(res, out).then(() => resolve(), reject)
    })
    req.on('error', reject)
    req.setTimeout(300_000, () => { req.destroy(new Error('分离模型下载超时')) })
  })
}

function rms(samples: Float32Array): number {
  let sum = 0
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i]
  return Math.sqrt(sum / Math.max(1, samples.length))
}

function peak(samples: Float32Array): number {
  let value = 0
  for (let i = 0; i < samples.length; i++) value = Math.max(value, Math.abs(samples[i]))
  return value
}

/** Keep the model's very large output inside a normal PCM range. */
function tame(samples: Float32Array): Float32Array {
  const high = peak(samples)
  if (!Number.isFinite(high) || high <= 0.98) return samples
  const gain = 0.95 / high
  const out = new Float32Array(samples.length)
  for (let i = 0; i < samples.length; i++) out[i] = samples[i] * gain
  return out
}

function onsetMs(samples: Float32Array): number {
  const high = peak(samples)
  const floor = Math.max(0.01, high * 0.04)
  for (let i = 0; i < samples.length; i++) {
    if (Math.abs(samples[i]) >= floor) return Math.round(i * 1000 / SAMPLE_RATE)
  }
  return 0
}

export function planWindows(length: number): number[] {
  if (length <= WINDOW) return [0]
  const starts = [0]
  for (;;) {
    const previous = starts[starts.length - 1]
    const next = previous + HOP
    if (next + WINDOW >= length) {
      const last = Math.max(0, length - WINDOW)
      if (last > previous) starts.push(last)
      break
    }
    starts.push(next)
  }
  return starts
}

function edgeWeight(index: number, first: boolean, last: boolean): number {
  let weight = 1
  if (!first) weight = Math.min(weight, index / FADE)
  if (!last) weight = Math.min(weight, (WINDOW - 1 - index) / FADE)
  return Math.max(0, weight)
}

/**
 * Run fixed 4 s windows with overlap-add. Exposed with an injected runner so the
 * window/alignment logic can be tested without the 245 MB model.
 */
export async function separateWithRunner(samples: Float32Array, run: RunWindow): Promise<RawSeparation> {
  const started = Date.now()
  const starts = planWindows(samples.length)
  const outA = new Float32Array(samples.length)
  const outB = new Float32Array(samples.length)
  const weights = new Float32Array(samples.length)
  let previous: { a: Float32Array; b: Float32Array; start: number } | undefined

  for (const start of starts) {
    const input = new Float32Array(WINDOW)
    input.set(samples.subarray(start, Math.min(samples.length, start + WINDOW)))
    const [rawA, rawB] = await run(input)
    if (rawA.length !== WINDOW || rawB.length !== WINDOW) throw new Error('分离模型输出长度不正确')
    const overlap = previous ? previous.start + WINDOW - start : 0
    const swap = previous !== undefined && overlap > 0
      ? shouldSwap(previous.a, previous.b, rawA, rawB, overlap)
      : false
    const a = swap ? rawB : rawA
    const b = swap ? rawA : rawB
    const first = start === 0
    const last = start + WINDOW >= samples.length
    for (let i = 0; i < WINDOW; i++) {
      const at = start + i
      if (at >= samples.length) break
      const weight = edgeWeight(i, first, last)
      if (weight === 0) continue
      outA[at] += a[i] * weight
      outB[at] += b[i] * weight
      weights[at] += weight
    }
    previous = { a, b, start }
  }

  for (let i = 0; i < samples.length; i++) {
    const weight = weights[i]
    if (weight > 1e-6) { outA[i] /= weight; outB[i] /= weight }
  }
  const sources = [tame(outA), tame(outB)].map((track) => ({
    samples: track,
    rms: rms(track),
    onsetMs: onsetMs(track),
  }))
  const loud = Math.max(sources[0].rms, sources[1].rms)
  return {
    sources: sources.filter((source) => source.rms >= loud * SOURCE_FLOOR),
    elapsedMs: Date.now() - started,
  }
}

export class SeparationService {
  private readonly dataDir: string
  private readonly modelPath: string
  private backend: string | undefined
  private worker: ChildProcess | undefined
  private ready: Promise<void> | undefined
  private chain: Promise<unknown> = Promise.resolve()
  private workerStderr = ''
  private workerSeq = 0
  private readonly pending = new Map<number, {
    resolve: (value: RawSeparation) => void
    reject: (error: Error) => void
  }>()
  private readonly injectedRun: RunWindow | undefined

  constructor(options: { dataDir?: string; modelPath?: string; run?: RunWindow } = {}) {
    this.dataDir = options.dataDir ?? join(homedir(), '.dsh', 'voice-dialog')
    this.modelPath = options.modelPath
      ?? process.env.DSH_SEPARATION_MODEL
      ?? join(this.dataDir, 'models', SEPARATION_MODEL_FILE)
    this.injectedRun = options.run
  }

  status(): SeparationStatus {
    let addonAvailable = false
    try { require.resolve('onnxruntime-node'); addonAvailable = true } catch { /* optional */ }
    let modelBytes = 0
    try { modelBytes = statSync(this.modelPath).size } catch { /* missing */ }
    const modelPresent = modelBytes > 200_000_000
    const ready = this.injectedRun !== undefined || (addonAvailable && modelPresent)
    return {
      addonAvailable,
      modelPresent,
      ready,
      modelPath: this.modelPath,
      modelBytes,
      ...(this.backend ? { backend: this.backend } : {}),
      ...(ready ? {} : { error: addonAvailable ? '分离模型未安装，请在设置页下载' : '缺少本地分离组件 onnxruntime-node' }),
    }
  }

  /** Load the model before the first overlapping utterance. */
  async warm(): Promise<void> {
    if (this.injectedRun) return
    await this.ensureWorker()
  }

  async prepare(): Promise<SeparationStatus> {
    const current = statSync(this.modelPath, { throwIfNoEntry: false })?.size ?? 0
    if (current > 200_000_000) return this.status()
    mkdirSync(dirname(this.modelPath), { recursive: true })
    const part = this.modelPath + '.part'
    try {
      await download(MODEL_URL, part)
      const size = statSync(part).size
      if (size !== SEPARATION_MODEL_BYTES) throw new Error('分离模型大小不正确（' + size + ' 字节）')
      renameSync(part, this.modelPath)
      return this.status()
    } catch (error) {
      try { unlinkSync(part) } catch { /* already gone */ }
      throw error
    }
  }

  private failPending(error: Error): void {
    for (const item of this.pending.values()) item.reject(error)
    this.pending.clear()
  }

  private lastWorkerError(): string {
    return this.workerStderr.trim().split(/\r?\n/).slice(-3).join(' ')
  }

  /** The host already has sherpa-onnx's onnxruntime.dll loaded; a child keeps DLLs apart. */
  private ensureWorker(): Promise<void> {
    if (this.ready) return this.ready
    if (!statSync(this.modelPath, { throwIfNoEntry: false })?.size) {
      return Promise.reject(new Error('分离模型未安装，请在设置页下载'))
    }
    const promise = new Promise<void>((resolve, reject) => {
      const workerPath = fileURLToPath(new URL('./separation-worker.js', import.meta.url))
      let settled = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const fail = (error: Error): void => {
        if (timer) clearTimeout(timer)
        if (!settled) { settled = true; reject(error) }
        this.failPending(error)
        this.worker = undefined
      }
      let worker: ChildProcess
      try {
        worker = fork(workerPath, [], {
          serialization: 'advanced',
          windowsHide: true,
          execArgv: [],
          stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        })
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)))
        return
      }
      this.worker = worker
      this.workerStderr = ''
      worker.stderr?.on('data', (chunk: Buffer) => {
        this.workerStderr = (this.workerStderr + chunk.toString()).slice(-4000)
      })
      worker.on('message', (message: any) => {
        if (!message || typeof message !== 'object') return
        if (message.type === 'ready') {
          this.backend = typeof message.backend === 'string' ? message.backend : undefined
          if (timer) clearTimeout(timer)
          if (!settled) { settled = true; resolve() }
          return
        }
        if (message.type === 'result') {
          const item = this.pending.get(message.id)
          if (!item) return
          this.pending.delete(message.id)
          item.resolve({
            sources: (message.sources ?? []).map((source: any) => ({
              samples: Float32Array.from(source.samples as Float32Array),
              rms: Number(source.rms) || 0,
              onsetMs: Number(source.onsetMs) || 0,
            })),
            elapsedMs: Number(message.elapsedMs) || 0,
          })
          return
        }
        if (message.type === 'error') {
          const item = this.pending.get(message.id)
          if (!item) return
          this.pending.delete(message.id)
          item.reject(new Error(String(message.error ?? '分离失败')))
          return
        }
        if (message.type === 'fatal') {
          const detail = String(message.error ?? '分离进程启动失败')
          fail(new Error(detail + (this.workerStderr ? '：' + this.lastWorkerError() : '')))
        }
      })
      worker.on('error', (error) => {
        fail(error instanceof Error ? error : new Error(String(error)))
      })
      worker.on('exit', (code, signal) => {
        const detail = '分离进程已退出（' + (signal ?? code ?? 'unknown') + '）'
        if (!settled) fail(new Error(detail + (this.workerStderr ? '：' + this.lastWorkerError() : '')))
        else {
          this.worker = undefined
          this.ready = undefined
          this.failPending(new Error(detail))
        }
      })
      timer = setTimeout(() => {
        fail(new Error('分离进程启动超时'))
      }, 30_000)
      try {
        worker.send({ type: 'init', modelPath: this.modelPath })
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)))
      }
    })
    this.ready = promise
    void promise.catch(() => {
      if (this.ready === promise) this.ready = undefined
    })
    return promise
  }

  private request(samples: Float32Array): Promise<RawSeparation> {
    return this.ensureWorker().then(() => new Promise<RawSeparation>((resolve, reject) => {
      const worker = this.worker
      if (!worker || !worker.connected) {
        reject(new Error('分离进程不可用'))
        return
      }
      const id = ++this.workerSeq
      this.pending.set(id, { resolve, reject })
      worker.send({ type: 'separate', id, samples }, (error) => {
        if (!error) return
        const item = this.pending.get(id)
        if (!item) return
        this.pending.delete(id)
        item.reject(error)
      })
    }))
  }

  async separate(samples: Float32Array): Promise<RawSeparation> {
    if (samples.length === 0) throw new Error('没有可分离的语音')
    if (this.injectedRun) return separateWithRunner(samples, this.injectedRun)
    const run = this.chain.then(() => this.request(samples))
    this.chain = run.then(() => undefined, () => undefined)
    return run
  }

  async close(): Promise<void> {
    const worker = this.worker
    this.worker = undefined
    this.ready = undefined
    this.failPending(new Error('分离服务已关闭'))
    if (!worker) return
    try { worker.kill() } catch { /* already gone */ }
  }
}

/** Host-side WAV encoding for a separated stream. */
export function encodeWavBase64(samples: Float32Array): string {
  const bytes = Buffer.alloc(44 + samples.length * 2)
  bytes.write('RIFF', 0, 'ascii')
  bytes.writeUInt32LE(36 + samples.length * 2, 4)
  bytes.write('WAVE', 8, 'ascii')
  bytes.write('fmt ', 12, 'ascii')
  bytes.writeUInt32LE(16, 16)
  bytes.writeUInt16LE(1, 20)
  bytes.writeUInt16LE(1, 22)
  bytes.writeUInt32LE(SAMPLE_RATE, 24)
  bytes.writeUInt32LE(SAMPLE_RATE * 2, 28)
  bytes.writeUInt16LE(2, 32)
  bytes.writeUInt16LE(16, 34)
  bytes.write('data', 36, 'ascii')
  bytes.writeUInt32LE(samples.length * 2, 40)
  for (let i = 0; i < samples.length; i++) {
    const value = Math.max(-1, Math.min(1, samples[i]))
    bytes.writeInt16LE(Math.round(value * (value < 0 ? 32768 : 32767)), 44 + i * 2)
  }
  return bytes.toString('base64')
}
