/** Local speaker verification and online speaker labeling (CAM++ via sherpa-onnx). */
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { request as httpsRequest } from 'node:https'
import { pipeline } from 'node:stream/promises'
import * as httpsProxyAgent from 'https-proxy-agent'

const require = createRequire(import.meta.url)

export const MODEL_FILE = '3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx'
const MODEL_URLS = [
  'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/' + MODEL_FILE,
  'https://huggingface.co/csukuangfj/speaker-embedding-models/resolve/main/' + MODEL_FILE,
]
const SAMPLE_RATE = 16000
/** A stored enrollment is useful only if it is longer than a click. */
const MIN_ENROLL_SAMPLES = SAMPLE_RATE
/** Segments shorter than this cannot produce a stable speaker embedding. */
const MIN_IDENTIFY_SAMPLES = Math.floor(SAMPLE_RATE * 0.35)
const DEFAULT_THRESHOLD = 0.52
const CLUSTER_THRESHOLD = 0.5
const MAX_CLUSTERS = 4
/** Conservative EWMA weights: one unusual segment cannot dominate the owner template. */
const OWNER_ADAPT_WEIGHT = 0.1
const OWNER_SOFT_ADAPT_WEIGHT = 0.03
/** Soft owner floors, with a small relaxation after a preceding owner turn. */
const OWNER_SOFT_FLOOR = 0.4
const OWNER_SOFT_FLOOR_AFTER_OWNER = 0.35
const OWNER_GUEST_MARGIN = 0.06
const OWNER_HISTORY_FLOOR = 0.45
const MAX_SESSION_LABELS = 128
const NAMED_THRESHOLD_FLOOR = 0.55
const MAX_NAMED_SPEAKERS = 12
const MAX_SPEAKER_NAME = 12

export interface VoiceprintProfile {
  id: string
  name: string
  updatedAt: string
}

export interface VoiceprintStatus {
  addonAvailable: boolean
  modelPresent: boolean
  enrolled: boolean
  ready: boolean
  modelPath: string
  modelBytes: number
  speakers: VoiceprintProfile[]
  speakerCount: number
  embeddingDim?: number
  error?: string
}

export interface IdentifyResult {
  enrolled: boolean
  owner: boolean
  label: string
  similarity: number
}

interface StoredSpeaker {
  id: string
  name: string
  embedding: number[]
  updatedAt: string
}

interface StoredVoiceprint {
  /** The owner template; absent when only named guests are enrolled. */
  embedding?: number[]
  /** Optional for compatibility with files written before adaptive updates. */
  updates?: number
  updatedAt?: string
  /** Persistently enrolled guests. Older files simply omit this field. */
  speakers?: StoredSpeaker[]
}

interface SpeakerCluster {
  label: string
  centroid: Float32Array
  count: number
}

export interface Extractor {
  createStream(): {
    acceptWaveform(input: { sampleRate: number; samples: Float32Array }): void
  }
  compute(stream: unknown): Float32Array
  dim?: number
}

interface SherpaModule {
  SpeakerEmbeddingExtractor: new (config: { model: string; numThreads: number; debug: boolean }) => Extractor
}

function normalize(vector: Float32Array): Float32Array {
  let sum = 0
  for (let i = 0; i < vector.length; i++) sum += vector[i] * vector[i]
  const norm = Math.sqrt(sum)
  if (!Number.isFinite(norm) || norm <= 1e-12) throw new Error('声纹特征为空，请重新录音')
  const out = new Float32Array(vector.length)
  for (let i = 0; i < vector.length; i++) out[i] = vector[i] / norm
  return out
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb)
  return denom > 0 ? dot / denom : 0
}

/** Decode the 16 kHz mono PCM16 WAV encoded by the client. */
export function decodeWavBase64(base64: string): Float32Array {
  const bytes = Buffer.from(base64, 'base64')
  if (bytes.length < 44 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('声纹音频格式不是 WAV')
  }
  let offset = 12
  let format: { channels: number; sampleRate: number; bits: number } | undefined
  let data: Buffer | undefined
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString('ascii', offset, offset + 4)
    const size = bytes.readUInt32LE(offset + 4)
    const start = offset + 8
    const end = Math.min(bytes.length, start + size)
    if (id === 'fmt ' && size >= 16) {
      format = {
        channels: bytes.readUInt16LE(start + 2),
        sampleRate: bytes.readUInt32LE(start + 4),
        bits: bytes.readUInt16LE(start + 14),
      }
    }
    if (id === 'data') data = bytes.subarray(start, end)
    offset = start + size + (size % 2)
  }
  if (!format || !data) throw new Error('声纹音频缺少 fmt/data 块')
  if (format.channels !== 1 || format.sampleRate !== SAMPLE_RATE || format.bits !== 16) {
    throw new Error('声纹音频必须是 16 kHz 单声道 16 位')
  }
  const samples = new Float32Array(Math.floor(data.length / 2))
  for (let i = 0; i < samples.length; i++) samples[i] = data.readInt16LE(i * 2) / 32768
  return samples
}

function cleanSpeakerName(value: unknown): string {
  if (typeof value !== 'string') throw new Error('声纹名字必须是文字')
  const name = value.trim()
  if (!name) throw new Error('请给这个声纹起个名字')
  if ([...name].length > MAX_SPEAKER_NAME) throw new Error('声纹名字最多 ' + MAX_SPEAKER_NAME + ' 个字')
  if (name === '我' || name === '*') throw new Error('这个名字不能用作其他人的声纹')
  if (/[\[\]\r\n:：]/u.test(name)) throw new Error('声纹名字不能包含括号、冒号或换行')
  if (/^(?:客人|说话人)\d+$/u.test(name)) throw new Error('这个名字容易和临时声纹编号混淆')
  return name
}

function proxyUrl(): string | undefined {
  const raw = process.env.DSH_VOICE_MODEL_PROXY ?? process.env.HTTPS_PROXY ?? process.env.https_proxy
    ?? process.env.HTTP_PROXY ?? process.env.http_proxy
  if (!raw || !/^https?:\/\//i.test(raw.trim())) return undefined
  return raw.trim()
}

function download(url: string, dest: string, redirects = 0): Promise<void> {
  return new Promise((resolve, reject) => {
    if (redirects > 6) { reject(new Error('声纹模型下载重定向过多')); return }
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
        reject(new Error('下载声纹模型失败（HTTP ' + status + '）'))
        return
      }
      const out = createWriteStream(dest)
      pipeline(res, out).then(() => resolve(), reject)
    })
    req.on('error', reject)
    req.setTimeout(180_000, () => { req.destroy(new Error('声纹模型下载超时')) })
  })
}

export class VoiceprintService {
  private readonly dataDir: string
  private readonly modelPath: string
  private extractor: Extractor | undefined
  private extractorError: string | undefined
  private owner: Float32Array | null | undefined
  private ownerUpdates = 0
  private speakersCache: StoredSpeaker[] | undefined
  private readonly clusters = new Map<string, SpeakerCluster[]>()
  private readonly lastSpeakerLabels = new Map<string, string>()
  private chain: Promise<unknown> = Promise.resolve()
  private readonly injectedExtractor: Extractor | undefined

  constructor(options: { dataDir?: string; modelPath?: string; extractor?: Extractor } = {}) {
    this.dataDir = options.dataDir ?? join(homedir(), '.dsh', 'voice-dialog')
    this.modelPath = options.modelPath
      ?? process.env.DSH_VOICE_MODEL
      ?? join(this.dataDir, 'models', MODEL_FILE)
    this.injectedExtractor = options.extractor
  }

  private get storePath(): string { return join(this.dataDir, 'voiceprint.json') }

  private readStore(): StoredVoiceprint {
    try {
      const raw = JSON.parse(readFileSync(this.storePath, 'utf8')) as StoredVoiceprint
      return raw && typeof raw === 'object' ? raw : {}
    } catch {
      return {}
    }
  }

  private writeStore(store: StoredVoiceprint): void {
    mkdirSync(this.dataDir, { recursive: true })
    writeFileSync(this.storePath, JSON.stringify(store), 'utf8')
    this.speakersCache = undefined
  }

  /** Named guests are persisted; embeddings never leave this machine. */
  private loadSpeakers(): StoredSpeaker[] {
    if (this.speakersCache) return this.speakersCache
    const raw = this.readStore()
    const list = Array.isArray(raw.speakers) ? raw.speakers : []
    this.speakersCache = list.filter((item): item is StoredSpeaker => Boolean(
      item
      && typeof item.id === 'string' && item.id
      && typeof item.name === 'string' && item.name.trim()
      && Array.isArray(item.embedding) && item.embedding.length >= 64
      && typeof item.updatedAt === 'string'
    ))
    return this.speakersCache
  }

  private speakerProfiles(): VoiceprintProfile[] {
    return this.loadSpeakers().map((item) => ({ id: item.id, name: item.name, updatedAt: item.updatedAt }))
  }

  private bestNamed(speakers: StoredSpeaker[], embedding: Float32Array): { speaker?: StoredSpeaker; similarity: number } {
    let best: StoredSpeaker | undefined
    let bestSimilarity = -1
    for (const speaker of speakers) {
      const vector = Float32Array.from(speaker.embedding)
      if (vector.length !== embedding.length) continue
      const similarity = cosineSimilarity(embedding, vector)
      if (similarity > bestSimilarity) {
        best = speaker
        bestSimilarity = similarity
      }
    }
    return { speaker: best, similarity: bestSimilarity }
  }

  status(): VoiceprintStatus {
    let addonAvailable = false
    try {
      require.resolve('sherpa-onnx-node')
      addonAvailable = true
    } catch {
      // The optional native package is not installed.
    }
    let modelBytes = 0
    try { modelBytes = statSync(this.modelPath).size } catch { /* missing */ }
    let enrolled = false
    try { enrolled = this.ownerEmbedding() !== null } catch { /* invalid JSON */ }
    const speakers = this.speakerProfiles()
    const ready = this.injectedExtractor !== undefined || (addonAvailable && modelBytes > 1_000_000)
    return {
      addonAvailable,
      modelPresent: modelBytes > 1_000_000,
      enrolled,
      ready,
      modelPath: this.modelPath,
      modelBytes,
      speakers,
      speakerCount: speakers.length,
      ...(this.extractor?.dim ? { embeddingDim: this.extractor.dim } : {}),
      ...(addonAvailable ? {} : { error: '缺少本地声纹组件 sherpa-onnx-node' }),
    }
  }

  private loadSherpa(): SherpaModule {
    try {
      return require('sherpa-onnx-node') as SherpaModule
    } catch (error) {
      throw new Error('无法加载本地声纹组件：' + (error instanceof Error ? error.message : String(error)))
    }
  }

  private ensureExtractor(): Extractor {
    if (this.injectedExtractor) return this.injectedExtractor
    if (this.extractor) return this.extractor
    if (this.extractorError) throw new Error(this.extractorError)
    if (!existsSync(this.modelPath) || statSync(this.modelPath).size < 1_000_000) {
      throw new Error('声纹模型未安装，请在设置页下载')
    }
    try {
      const sherpa = this.loadSherpa()
      this.extractor = new sherpa.SpeakerEmbeddingExtractor({
        model: this.modelPath,
        numThreads: 1,
        debug: false,
      })
      return this.extractor
    } catch (error) {
      this.extractorError = error instanceof Error ? error.message : String(error)
      throw error
    }
  }

  /** Load the native model before the first utterance, without blocking startup. */
  warm(): void {
    if (this.status().ready) this.ensureExtractor()
  }

  async prepare(): Promise<VoiceprintStatus> {
    if (existsSync(this.modelPath) && statSync(this.modelPath).size > 1_000_000) return this.status()
    mkdirSync(dirname(this.modelPath), { recursive: true })
    let lastError: unknown
    for (const url of MODEL_URLS) {
      const part = this.modelPath + '.part'
      try {
        await download(url, part)
        if (statSync(part).size < 1_000_000) throw new Error('下载的声纹模型不完整')
        renameSync(part, this.modelPath)
        this.extractorError = undefined
        return this.status()
      } catch (error) {
        lastError = error
        try { unlinkSync(part) } catch { /* already gone */ }
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError))
  }

  private ownerEmbedding(): Float32Array | null {
    if (this.owner !== undefined) return this.owner
    try {
      const raw = this.readStore()
      if (!Array.isArray(raw.embedding) || raw.embedding.length < 64) {
        this.owner = null
        this.ownerUpdates = 0
        return null
      }
      this.ownerUpdates = typeof raw.updates === 'number' && Number.isInteger(raw.updates) && raw.updates >= 0
        ? raw.updates
        : 0
      this.owner = normalize(Float32Array.from(raw.embedding))
      return this.owner
    } catch {
      this.owner = null
      this.ownerUpdates = 0
      return null
    }
  }

  private saveOwner(): void {
    const owner = this.owner
    if (!owner) return
    try {
      const stored = this.readStore()
      stored.embedding = Array.from(owner)
      stored.updates = this.ownerUpdates
      stored.updatedAt = new Date().toISOString()
      this.writeStore(stored)
    } catch {
      // Identification should remain usable if the data directory is temporarily unwritable.
    }
  }

  /** Update the normalized owner template with a deliberately small EWMA step. */
  private adaptOwner(embedding: Float32Array, weight: number): void {
    const owner = this.ownerEmbedding()
    if (!owner || owner.length !== embedding.length) return
    const merged = new Float32Array(owner.length)
    for (let i = 0; i < owner.length; i++) {
      merged[i] = owner[i] * (1 - weight) + embedding[i] * weight
    }
    this.owner = normalize(merged)
    this.ownerUpdates += 1
    this.saveOwner()
  }

  private bestGuest(sessionId: string, embedding: Float32Array): { cluster?: SpeakerCluster; similarity: number } {
    let best: SpeakerCluster | undefined
    let bestSimilarity = -1
    for (const cluster of this.clusters.get(sessionId) ?? []) {
      const similarity = cosineSimilarity(embedding, cluster.centroid)
      if (similarity > bestSimilarity) {
        best = cluster
        bestSimilarity = similarity
      }
    }
    return { cluster: best, similarity: bestSimilarity }
  }

  private sessionClusters(sessionId: string): SpeakerCluster[] {
    let list = this.clusters.get(sessionId)
    if (!list) {
      list = []
      this.clusters.set(sessionId, list)
      if (this.clusters.size > 64) {
        const oldest = this.clusters.keys().next().value
        if (oldest !== undefined) this.clusters.delete(oldest)
      }
    }
    return list
  }

  private rememberLabel(sessionId: string, label: string): void {
    this.lastSpeakerLabels.delete(sessionId)
    this.lastSpeakerLabels.set(sessionId, label)
    if (this.lastSpeakerLabels.size > MAX_SESSION_LABELS) {
      const oldest = this.lastSpeakerLabels.keys().next().value
      if (oldest !== undefined) this.lastSpeakerLabels.delete(oldest)
    }
  }

  private compute(samples: Float32Array): Promise<Float32Array> {
    const run = this.chain.then(() => {
      const extractor = this.ensureExtractor()
      const stream = extractor.createStream()
      stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples })
      return normalize(extractor.compute(stream))
    })
    this.chain = run.then(() => undefined, () => undefined)
    return run
  }

  async enroll(samples: Float32Array): Promise<{ dim: number }> {
    if (samples.length < MIN_ENROLL_SAMPLES) throw new Error('录音太短，请说满两秒再试')
    const embedding = await this.compute(samples)
    const stored = this.readStore()
    stored.embedding = Array.from(embedding)
    stored.updates = 0
    stored.updatedAt = new Date().toISOString()
    this.writeStore(stored)
    this.owner = embedding
    this.ownerUpdates = 0
    this.clusters.clear()
    this.lastSpeakerLabels.clear()
    return { dim: embedding.length }
  }

  /** Enroll one named guest. The owner template and other guests are preserved. */
  async enrollSpeaker(samples: Float32Array, name: string): Promise<{ id: string; name: string; dim: number }> {
    if (samples.length < MIN_ENROLL_SAMPLES) throw new Error('录音太短，请说满两秒再试')
    const clean = cleanSpeakerName(name)
    const speakers = this.loadSpeakers()
    if (speakers.length >= MAX_NAMED_SPEAKERS) throw new Error('最多只能录入 ' + MAX_NAMED_SPEAKERS + ' 个其他人的声纹')
    if (speakers.some((item) => item.name.toLocaleLowerCase() === clean.toLocaleLowerCase())) {
      throw new Error('这个声纹名字已经存在')
    }
    const embedding = await this.compute(samples)
    const stored = this.readStore()
    const list = this.loadSpeakers().slice()
    const id = randomUUID()
    list.push({ id, name: clean, embedding: Array.from(embedding), updatedAt: new Date().toISOString() })
    stored.speakers = list
    this.writeStore(stored)
    return { id, name: clean, dim: embedding.length }
  }

  renameSpeaker(id: string, name: string): VoiceprintProfile {
    const clean = cleanSpeakerName(name)
    if (!id) throw new Error('缺少声纹编号')
    const speakers = this.loadSpeakers()
    if (!speakers.some((item) => item.id === id)) throw new Error('找不到这个声纹')
    if (speakers.some((item) => item.id !== id && item.name.toLocaleLowerCase() === clean.toLocaleLowerCase())) {
      throw new Error('这个声纹名字已经存在')
    }
    const stored = this.readStore()
    const updatedAt = new Date().toISOString()
    stored.speakers = speakers.map((item) => item.id === id ? { ...item, name: clean, updatedAt } : item)
    this.writeStore(stored)
    return { id, name: clean, updatedAt }
  }

  removeSpeaker(id: string): void {
    if (!id) throw new Error('缺少声纹编号')
    const speakers = this.loadSpeakers()
    if (!speakers.some((item) => item.id === id)) throw new Error('找不到这个声纹')
    const stored = this.readStore()
    stored.speakers = speakers.filter((item) => item.id !== id)
    this.writeStore(stored)
  }

  forget(): void {
    this.owner = null
    this.ownerUpdates = 0
    this.clusters.clear()
    this.lastSpeakerLabels.clear()
    const stored = this.readStore()
    delete stored.embedding
    delete stored.updates
    stored.updatedAt = new Date().toISOString()
    if (stored.speakers && stored.speakers.length > 0) this.writeStore(stored)
    else {
      try { unlinkSync(this.storePath) } catch { /* already absent */ }
    }
  }

  async identify(
    samples: Float32Array,
    options: { sessionId?: string; threshold?: number } = {},
  ): Promise<IdentifyResult> {
    if (samples.length < MIN_IDENTIFY_SAMPLES) throw new Error('这段话太短，无法判断声纹')
    const embedding = await this.compute(samples)
    const owner = this.ownerEmbedding()
    const threshold = Math.min(0.85, Math.max(0.3, options.threshold ?? DEFAULT_THRESHOLD))
    const sessionId = (options.sessionId ?? '').trim() || 'default'
    const previousLabel = this.lastSpeakerLabels.get(sessionId)
    const guest = this.bestGuest(sessionId, embedding)
    const namedSpeakers = this.loadSpeakers()
    const named = this.bestNamed(namedSpeakers, embedding)
    const namedThreshold = Math.max(NAMED_THRESHOLD_FLOOR, threshold)
    const namedIsClearlyStronger = owner !== null && named.speaker !== undefined
      && named.similarity >= namedThreshold
      && named.similarity > cosineSimilarity(embedding, owner) + OWNER_GUEST_MARGIN

    if (owner) {
      const similarity = cosineSimilarity(embedding, owner)
      if (similarity >= threshold && !namedIsClearlyStronger) {
        this.adaptOwner(embedding, OWNER_ADAPT_WEIGHT)
        this.rememberLabel(sessionId, '我')
        return { enrolled: true, owner: true, label: '我', similarity }
      }

      // A lower match can still be the owner when no guest cluster is clearly
      // closer. A preceding owner turn lowers the floor slightly because
      // dialogue continuity is useful evidence for short utterances.
      const softFloor = previousLabel === '我'
        ? OWNER_SOFT_FLOOR_AFTER_OWNER
        : OWNER_SOFT_FLOOR
      const guestIsClearlyStronger = (guest.cluster !== undefined
        && guest.similarity > similarity + OWNER_GUEST_MARGIN) || namedIsClearlyStronger
      const priorOwnerException = previousLabel === '我' && similarity >= OWNER_HISTORY_FLOOR
        && !namedIsClearlyStronger
      if (similarity >= softFloor && (!guestIsClearlyStronger || priorOwnerException)) {
        this.adaptOwner(embedding, OWNER_SOFT_ADAPT_WEIGHT)
        this.rememberLabel(sessionId, '我')
        return { enrolled: true, owner: true, label: '我', similarity }
      }
    }

    if (named.speaker && named.similarity >= namedThreshold) {
      this.rememberLabel(sessionId, named.speaker.name)
      return { enrolled: true, owner: false, label: named.speaker.name, similarity: named.similarity }
    }

    const hasEnrollment = owner !== null || namedSpeakers.length > 0
    const list = this.sessionClusters(sessionId)
    if (guest.cluster && guest.similarity >= CLUSTER_THRESHOLD) {
      const best = guest.cluster
      const count = best.count + 1
      const merged = new Float32Array(embedding.length)
      for (let i = 0; i < embedding.length; i++) {
        merged[i] = (best.centroid[i] * best.count + embedding[i]) / count
      }
      best.centroid = normalize(merged)
      best.count = count
      this.rememberLabel(sessionId, best.label)
      return { enrolled: hasEnrollment, owner: false, label: best.label, similarity: guest.similarity }
    }
    const prefix = owner ? '客人' : '说话人'
    if (list.length < MAX_CLUSTERS) {
      const label = prefix + (list.length + 1)
      list.push({ label, centroid: embedding, count: 1 })
      this.rememberLabel(sessionId, label)
      return { enrolled: hasEnrollment, owner: false, label, similarity: Math.max(0, guest.similarity) }
    }
    const label = owner ? '其他客人' : '其他说话人'
    this.rememberLabel(sessionId, label)
    return { enrolled: hasEnrollment, owner: false, label, similarity: guest.similarity }
  }
}
