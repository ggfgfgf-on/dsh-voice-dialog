/** dsh-voice-dialog client half: one microphone, continuous ASR steering, auto-read. */
import * as React from 'react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  Button, IconCloseOutlineRegular, IconMicrophoneOutlineRegular, IconSettingsOutlineRegular,
  IconStopFillRegular, Modal, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import speechRemote from './speech-remote.js'
import { MicrophoneLoop, recordVoiceSample, type MicPlaybackSnapshot } from './mic.ts'
import { ContinuousSeparation, dedupeTranscript, type ContinuousSegment } from './continuous-separation.ts'
import {
  createUtteranceCoalescer, UTTERANCE_COALESCE_WINDOW_MS, type UtteranceCoalescer,
} from './utterance-coalescer.ts'
import {
  decideBoundaryHold,
  decideInterruption,
  decideSpeechOnsetYield,
  DEFAULT_INTERRUPTION_MODE,
  isInterruptionMode,
  type InterruptionMode,
} from './interruption.ts'
import {
  normalizeSpeechProfile,
  resolveSpeechProfile,
  type SpeechProfile,
} from './speech-profile.ts'
import {
  getPreferences, setPreferences, subscribePreferences,
  SPEAKER_THRESHOLD_MAX, SPEAKER_THRESHOLD_MIN, type VoiceDialogPreferences,
} from './preferences.ts'
import { VolumeRig } from './volume-gain.ts'
import { createVolumeReporter } from './volume-report.ts'
import { SpeechScheduler, type GuestMode } from './scheduler.ts'
import {
  applyReorganization, ORGANIZER_PENDING_ITEM_CHARS, ORGANIZER_PENDING_LIMIT,
  ORGANIZER_PENDING_TOTAL_CHARS, shouldDeliverOrganizerAction, SpeechOrganizer,
  type OrganizerRequest,
} from './organizer.ts'
import { parseQueueControl } from './queue-control.ts'
import {
  decideBargeIn, isSameSentence, orderBargeInFrames, splitAtSentenceBoundary,
} from './barge-in.ts'
import { decideInput, inputGateTraceFields, ruleInputDecision, type InputGateDecision } from './input-gate.ts'
import { resumeDelayForUtterance, YIELD_RESUME_AFTER_SPEECH_MS } from './yield.ts'
import { echoGate, noiseGate, type SpokenSample } from './gates.ts'
import { FrameWindow, orderOf, playBlockReason, shouldPlayFrame } from './frame-order.ts'
import { PlanLedger, shouldApplyPlan, shouldRunPlanner, SpeechPlanner, type PlannerRequest } from './planner.ts'
import { SpeakerPolicyStore } from './speaker-policy.ts'
import { audioBase64, decodeWaveBase64, encodeWave } from './wav.ts'
import { encodeAudioFrames, postAudioFrames, type BinaryTransportState } from './audio-transport.ts'
import {
  buildUtteranceRecord, createUtteranceTrace, markUtteranceStage, noteUtteranceText,
  type SeparationLatencyDetail, type TraceInput, type UtteranceTrace, type UtteranceTiming,
} from './latency.ts'
import {
  canReuseSpeculativeAsr, firstDelivery, shouldCallGate,
} from './routing.ts'

/** Gain telemetry: batched samples to the host JSONL log; never audio or transcript. */
const volumeReporter = createVolumeReporter({
  post: (payload) => {
    try {
      void fetch(apiUrl('/volume-log'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        keepalive: true,
      }).catch(() => undefined)
    } catch { /* telemetry must never break playback */ }
  },
  batchMs: 300,
})

export const inject = ['remote']

/** Edge TTS speech is mixed quiet; this brings it to normal media loudness. */
const BOOTSTRAP_BASE = '/dsh-voice-dialog-api'
const BUNDLE_ID = 'dsh-voice-dialog'
/** Ducking, cut fades and volume live in volume-gain.ts: one writer, one target. */
/** Tail-silence presets; any other value may be typed into the custom field. */
const PAUSE_PRESETS: ReadonlyArray<readonly [number, string]> = [
  [600, '0.6 秒（极快，容易截话）'],
  [900, '0.9 秒（默认）'],
  [1200, '1.2 秒（快）'],
  [1600, '1.6 秒（稳）'],
  [2000, '2.0 秒（少截话）'],
  [2500, '2.5 秒（慢，适合思考）'],
  [3000, '3.0 秒（很慢）'],
  [4000, '4.0 秒（最长）'],
]

interface VoiceFrame {
  sessionId: string
  /** Host-elected playback client; absent when no client claimed the session. */
  owner?: string
  /** Monotonic within the session; the client uses it to discard replays. */
  seq: number
  /** Reply round, incremented once per assistant answer by the host. */
  epoch: number
  replyId?: string
  /** Same-sentence read-aloud blocks share this id. */
  sentenceId?: number
  /** Zero-based position inside the sentence. */
  chunkIndex?: number
  /** Silence this block asked for before the next one, in ms. */
  gapAfterMs?: number
  text: string
  audio: string
  error?: string
}

interface VoiceControl {
  action: 'volume' | 'rate' | 'stop' | 'repeat' | 'speaker' | 'yield' | 'speech'
  /** Model-declared interruption contract for its own speech. */
  mode?: InterruptionMode
  /** Model-declared speech profile (action speech). */
  profile?: SpeechProfile
  level?: number
  rate?: number
  delta?: number
  speaker?: string
  policy?: GuestMode | 'default'
  name?: string
}

interface HostConfig {
  basePath: string
  voice: string
  rate: number
  enabled: boolean
}

interface VoiceprintProfile {
  id: string
  name: string
  updatedAt: string
}

interface VoiceprintStatus {
  ready: boolean
  addonAvailable: boolean
  modelPresent: boolean
  enrolled: boolean
  modelPath: string
  modelBytes: number
  speakers: VoiceprintProfile[]
  speakerCount: number
  embeddingDim?: number
  error?: string
}

interface SpeakerIdentity {
  enrolled: boolean
  owner: boolean
  label: string
  similarity: number
}

type SpeakerLane = 'owner' | 'guest'

/** Metadata carried while one lane's adjacent short segments are coalesced. */
interface CoalescedVoiceSegment {
  scheduler: SpeechScheduler
  utteranceEnd: number
  timing: UtteranceTiming
  fastPath: boolean
  prefix: string
}

interface SeparationStatus {
  addonAvailable: boolean
  modelPresent: boolean
  ready: boolean
  modelPath: string
  modelBytes: number
  backend?: string
  error?: string
}

interface SeparatedSource {
  audioBase64: string
  rms: number
  onsetMs: number
  identity: SpeakerIdentity | null
}

interface SeparationResult {
  ok: boolean
  separated: boolean
  elapsedMs: number
  queueMs?: number
  workerMs?: number
  wallMs?: number
  sources: SeparatedSource[]
}

interface OverlapProbe {
  ok?: boolean
  ready: boolean
  singleSpeaker: boolean
  suspected: boolean
  confident: boolean
  reason: string
  windows: Array<{ startMs: number; endMs: number }>
  activeMs: number
  minSimilarity?: number
  ownerSimilarity?: number
  threshold: number
}

/** Edge TTS voices exposed by the settings page. */
const VOICES: ReadonlyArray<readonly [string, string]> = [
  ['zh-CN-XiaoxiaoNeural', '晓晓（女声，默认）'],
  ['zh-CN-XiaoyiNeural', '晓伊（女声）'],
  ['zh-CN-XiaoxuanNeural', '晓萱（女声）'],
  ['zh-CN-YunxiNeural', '云希（男声）'],
  ['zh-CN-YunyangNeural', '云扬（男声，新闻）'],
  ['zh-CN-YunjianNeural', '云健（男声，解说）'],
  ['zh-CN-YunxiaNeural', '云夏（男声，少年）'],
  ['zh-CN-liaoning-XiaobeiNeural', '晓北（东北话）'],
  ['zh-CN-shaanxi-XiaoniNeural', '晓妮（陕西话）'],
  ['zh-TW-HsiaoChenNeural', '曉臻（台湾女声）'],
  ['zh-TW-YunJheNeural', '雲哲（台湾男声）'],
  ['zh-HK-HiuGaaiNeural', '曉佳（粤语女声）'],
  ['zh-HK-WanLungNeural', '雲龍（粤语男声）'],
  ['en-US-AriaNeural', 'Aria（英语女声）'],
  ['en-US-GuyNeural', 'Guy（英语男声）'],
  ['ja-JP-NanamiNeural', '七海（日语女声）'],
]

let apiBase = BOOTSTRAP_BASE
let configPromise: Promise<HostConfig> | null = null

function apiUrl(path: string): string {
  return `${apiBase}${path}`
}

/**
 * Tell the host whether this session's microphone is open. Background
 * subagent results are spoken only for sessions that report active.
 */
function reportVoiceState(sessionId: string, active: boolean, unloading = false): void {
  const body = JSON.stringify({ sessionId, active, clientId: CLIENT_ID })
  try {
    if (unloading && typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
      navigator.sendBeacon(apiUrl('/voice-state'), new Blob([body], { type: 'application/json' }))
      return
    }
  } catch {
    // Fall through to fetch when Beacon is unavailable.
  }
  void fetch(apiUrl('/voice-state'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
    keepalive: !active,
  }).catch(() => undefined)
}

/**
 * Tell the host when someone starts and stops talking, so the model can sense
 * the floor instead of being told about it by a separate judge.
 */
function reportSpeech(sessionId: string, speech: 'start' | 'end' | 'speaker', speaker?: string): void {
  void fetch(apiUrl('/voice-state'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, clientId: CLIENT_ID, speech, speaker }),
    keepalive: true,
  }).catch(() => undefined)
}

/** Whether the assistant's own mouth is open right now. */
function reportPlayback(sessionId: string, playing: boolean): void {
  void fetch(apiUrl('/voice-state'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, clientId: CLIENT_ID, playback: playing }),
    keepalive: true,
  }).catch(() => undefined)
}

/** Tell the host to stop synthesizing old sentences nobody will hear. */
function cancelHostTts(sessionId: string, replyId?: string): void {
  void fetch(apiUrl('/tts-cancel'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      sessionId,
      clientId: CLIENT_ID,
      ...(replyId === undefined ? {} : { replyId }),
    }),
    keepalive: true,
  }).catch(() => undefined)
}

function loadConfig(): Promise<HostConfig> {
  if (configPromise === null) {
    configPromise = fetch(`${BOOTSTRAP_BASE}/config`)
      .then((response) => {
        if (!response.ok) throw new Error(`config http ${response.status}`)
        return response.json() as Promise<HostConfig>
      })
      .then((config) => {
        const base = typeof config.basePath === 'string' ? config.basePath.replace(/\/+$/, '') : ''
        if (base) apiBase = base
        return config
      })
      .catch((error: unknown) => {
        configPromise = null
        throw error
      })
  }
  return configPromise
}

/** An empty failure must still read as a sentence, never as the word undefined. */
function failureText(failure: unknown): string {
  if (failure instanceof Error) {
    const message = failure.message.trim()
    if (message) return message
  }
  if (typeof failure === 'string' && failure.trim()) return failure.trim()
  return '连接断了：刷新这个页面，声音和识别都会回来。'
}

async function errorFrom(response: Response, fallback: string): Promise<Error> {
  const detail = await response.json().catch(() => null) as { error?: string } | null
  return new Error(detail?.error ?? fallback + '（HTTP ' + response.status + '）')
}

async function fetchVoiceprintStatus(): Promise<VoiceprintStatus> {
  const response = await fetch(apiUrl('/voiceprint/status'))
  if (!response.ok) throw await errorFrom(response, '声纹状态读取失败')
  return await response.json() as VoiceprintStatus
}

async function prepareVoiceprint(): Promise<VoiceprintStatus> {
  const response = await fetch(apiUrl('/voiceprint/prepare'), { method: 'POST' })
  if (!response.ok) throw await errorFrom(response, '声纹模型下载失败')
  return await response.json() as VoiceprintStatus
}

async function fetchSeparationStatus(): Promise<SeparationStatus> {
  const response = await fetch(apiUrl('/separation/status'))
  if (!response.ok) throw await errorFrom(response, '分离模型状态读取失败')
  return await response.json() as SeparationStatus
}

async function prepareSeparation(): Promise<SeparationStatus> {
  const response = await fetch(apiUrl('/separation/prepare'), { method: 'POST' })
  if (!response.ok) throw await errorFrom(response, '分离模型下载失败')
  return await response.json() as SeparationStatus
}

async function warmSeparation(): Promise<void> {
  const response = await fetch(apiUrl('/separation/warm'), { method: 'POST' })
  if (!response.ok) throw await errorFrom(response, '分离模型预热失败')
}

/** Fire-and-forget latency sample; a lost sample must never break speech. */
async function postLatency(record: unknown): Promise<void> {
  try {
    await fetch(apiUrl('/latency'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(record),
      keepalive: true,
    })
  } catch { /* logging is best-effort */ }
}

async function organizeSpeech(request: OrganizerRequest, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(apiUrl('/organize'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
    signal,
  })
  if (!response.ok) throw await errorFrom(response, '并行组织失败')
  return await response.json()
}

/** Slow planner layer: never awaited on the reply path. */
async function planSpeech(request: PlannerRequest, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(apiUrl('/plan'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
    signal,
  })
  if (!response.ok) throw await errorFrom(response, '规划层失败')
  return await response.json()
}

/**
 * Raw PCM16 frames instead of base64 WAV inside JSON: one Int16 pass on this
 * side, one pass back to Float32 on the host, and 25% less to upload.
 * A host that predates the route (404/400) or a dropped connection flips the
 * flag for the rest of the page load and every later call uses the JSON path.
 */
const binaryTransport: BinaryTransportState = { broken: false }

async function separateSegment(
  samples: Float32Array, sessionId: string, threshold: number, identify = true, margin = 0.12,
): Promise<SeparationResult> {
  const binary = await postAudioFrames(
    fetch as any,
    apiUrl('/separation/separate-binary'),
    samples,
    {
      'x-voice-session': sessionId,
      'x-voice-threshold': String(threshold),
      'x-voice-margin': String(margin),
      'x-voice-identify': identify ? '1' : '0',
    },
    binaryTransport,
  )
  if (binary) return binary as SeparationResult
  const response = await fetch(apiUrl('/separation/separate'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      audioBase64: audioBase64(encodeWave(samples)),
      sessionId,
      threshold,
      margin,
      identify,
    }),
  })
  if (!response.ok) throw await errorFrom(response, '同时说话分离失败')
  return await response.json() as SeparationResult
}

async function enrollVoiceprint(samples: Float32Array): Promise<void> {
  const response = await fetch(apiUrl('/voiceprint/enroll'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ audioBase64: audioBase64(encodeWave(samples)) }),
  })
  if (!response.ok) throw await errorFrom(response, '声纹保存失败')
}

async function identifySpeaker(
  samples: Float32Array, sessionId: string, threshold: number, margin = 0.12,
): Promise<SpeakerIdentity> {
  const response = await fetch(apiUrl('/voiceprint/identify'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      audioBase64: audioBase64(encodeWave(samples)),
      sessionId,
      threshold,
      margin,
    }),
  })
  if (!response.ok) throw await errorFrom(response, '声纹识别失败')
  return await response.json() as SpeakerIdentity
}

const VOICEPRINT_SAMPLE_RATE = 16_000
const VOICEPRINT_MIN_VOICE_MS = 700

/** Estimate the non-silent part with cheap 20 ms RMS frames. */
function estimateActiveVoiceMs(samples: Float32Array): number {
  if (samples.length === 0) return 0
  const frameSamples = Math.max(1, Math.round(VOICEPRINT_SAMPLE_RATE * 0.02))
  const levels: number[] = []
  let peak = 0
  for (let start = 0; start < samples.length; start += frameSamples) {
    const end = Math.min(samples.length, start + frameSamples)
    let sum = 0
    for (let index = start; index < end; index++) {
      const value = samples[index] ?? 0
      sum += value * value
    }
    const level = Math.sqrt(sum / Math.max(1, end - start))
    levels.push(level)
    if (level > peak) peak = level
  }
  // A relative floor ignores room noise while keeping quiet speech eligible.
  const floor = Math.max(0.0025, peak * 0.12)
  let activeSamples = 0
  for (const level of levels) if (level >= floor) activeSamples += frameSamples
  return Math.min(samples.length, activeSamples) * 1000 / VOICEPRINT_SAMPLE_RATE
}

/** Voiceprint needs a stable embedding, so very short lanes use cached history. */
function hasEnoughVoiceprintAudio(samples: Float32Array): boolean {
  return samples.length * 1000 / VOICEPRINT_SAMPLE_RATE >= VOICEPRINT_MIN_VOICE_MS
    && estimateActiveVoiceMs(samples) >= VOICEPRINT_MIN_VOICE_MS
}

function laneForIdentity(identity: SpeakerIdentity): SpeakerLane {
  return identity.owner === true ? 'owner' : 'guest'
}

async function probeSpeakerOverlap(samples: Float32Array): Promise<OverlapProbe> {
  const response = await fetch(apiUrl('/voiceprint/overlap'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ audioBase64: audioBase64(encodeWave(samples)) }),
  })
  if (!response.ok) throw await errorFrom(response, '声纹重叠检测失败')
  return await response.json() as OverlapProbe
}

async function forgetVoiceprint(): Promise<void> {
  const response = await fetch(apiUrl('/voiceprint/forget'), { method: 'POST' })
  if (!response.ok) throw await errorFrom(response, '声纹删除失败')
}

async function enrollOtherVoiceprint(samples: Float32Array, name: string): Promise<void> {
  const response = await fetch(apiUrl('/voiceprint/speakers/enroll'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ audioBase64: audioBase64(encodeWave(samples)), name }),
  })
  if (!response.ok) throw await errorFrom(response, '其他人声纹保存失败')
}

async function renameOtherVoiceprint(id: string, name: string): Promise<void> {
  const response = await fetch(apiUrl('/voiceprint/speakers/rename'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id, name }),
  })
  if (!response.ok) throw await errorFrom(response, '声纹重命名失败')
}

async function removeOtherVoiceprint(id: string): Promise<void> {
  const response = await fetch(apiUrl('/voiceprint/speakers/remove'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id }),
  })
  if (!response.ok) throw await errorFrom(response, '声纹删除失败')
}

function base64ToAudioUrl(base64: string): string {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return URL.createObjectURL(new Blob([bytes], { type: 'audio/mpeg' }))
}

/**
 * Page-level player. A barge-in holds the sentence where it is: the microphone
 * onset pauses the audio before any transcript exists, then the routing
 * decision either resumes the same spot or abandons the sentence for the new
 * answer. Nothing is ever re-read from the top after an interruption.
 */
class TtsPlayer {
  private readonly audio = new Audio()
  private context: AudioContext | undefined
  private gain: GainNode | undefined
  /** Fixed makeup gain: Edge TTS arrives noticeably quieter than other media. */
  private boost: GainNode | undefined
  /** Limiter after the boost, so a louder voice still cannot clip. */
  private limiter: DynamicsCompressorNode | undefined
  private source: MediaElementAudioSourceNode | undefined
  private readonly queue: VoiceFrame[] = []
  private prefs: VoiceDialogPreferences = getPreferences()
  private url: string | undefined
  private playing = false
  private blocked = false
  private active = false
  private muted = false
  private cutting = false
  private afterCut: VoiceFrame[] = []
  /** How the model declared its own speech may be interrupted; default finishes the sentence. */
  private interruptionMode: InterruptionMode = DEFAULT_INTERRUPTION_MODE
  /** What the model declared; empty means today's behaviour. */
  private declaredSpeech: SpeechProfile = {}
  /** Resolved profile: declaration first, defaults fill the gaps. */
  private speechProfile: Required<SpeechProfile> = resolveSpeechProfile(null)
  /** Pending gap between two spoken blocks. */
  private gapTimer: ReturnType<typeof setTimeout> | null = null

  /** The raw declaration, for layers that must keep the user's own setting. */
  declaredSpeechSettings(): SpeechProfile {
    return this.declaredSpeech
  }

  /** Cancel a pending between-blocks gap so a stop cannot resume audio. */
  private clearGap(): void {
    if (this.gapTimer === null) return
    clearTimeout(this.gapTimer)
    this.gapTimer = null
  }
  /** A 'sentence' contract asked to hold; it fires at the next boundary, never mid-sentence. */
  private pendingBoundaryYield = false
  private cutReplyId: string | undefined
  /** Owner barge-in is waiting for the current sentence to finish. */
  private bargeInActive = false
  private bargeInOldReplyId: string | undefined
  private bargeInNewReplyId: string | undefined
  /** Unread tail of the old answer, held for playback after the new answer. */
  private deferred: VoiceFrame[] = []
  private deferredTimer: ReturnType<typeof setTimeout> | null = null
  private cutToken = 0
  /** Microphone onset holds the audible sentence; the decision releases it. */
  private yielded = false
  private yieldFrame: VoiceFrame | undefined
  private yieldTimer: ReturnType<typeof setTimeout> | null = null
  private currentFrame: VoiceFrame | undefined
  private sessionId: string | undefined
  /**
   * The single writer of playback gain. Ducking, cut fades and volume commands
   * all go through it, so no interruption can multiply the attenuation: the
   * target is always recomputed as volume or volume*duckLevel.
   */
  private readonly gainRig = new VolumeRig({
    context: () => this.context,
    param: () => this.gain?.gain,
    volume: () => this.prefs.volume,
    duckLevel: () => this.prefs.duckLevel,
    sink: (sample) => volumeReporter.report(sample),
  })
  /** Latency hook: called when a frame actually starts playing. */
  onPlay: ((frame: VoiceFrame) => void) | undefined
  /** Perception hook: the mouth opening and closing, as the host sees it. */
  onPlayback: ((playing: boolean, sessionId: string | undefined) => void) | undefined
  /** Host-side cleanup when part or all of the spoken queue is discarded. */
  onCancelTts: ((sessionId: string, replyId?: string) => void) | undefined
  private lastReplyId: string | undefined
  /** Reply id of the most recently queued frame, to detect a superseded answer. */
  private lastQueuedReplyId: string | undefined
  private lastTexts: string[] = []
  private lastFrames: VoiceFrame[] = []
  /** Recently spoken sentences, for self-echo detection. */
  private readonly spoken: SpokenSample[] = []
  /** Start of the current TTS frame; every frame resets the echo guard. */
  private playbackStartedAt = 0
  /** Monotonic frame watermark; a stale frame can never resurrect here. */
  private readonly frameWindow = new FrameWindow()
  private frameStats = { received: 0, dropped: 0, played: 0 }
  private readonly unsubscribe = subscribePreferences((value) => {
    this.prefs = value
    if (this.boost) this.boost.gain.value = value.speechBoost
    if (!value.autoRead) this.clear()
    else this.applyGain()
  })

  /** Live state for the microphone's self-echo gate. */
  playbackState(): MicPlaybackSnapshot {
    if (!this.playing || !this.active) return { playing: false }
    const target = this.gainRig.target()
    return {
      playing: true,
      startedAt: this.playbackStartedAt,
      // Output estimate before ad-hoc loudness; 2.5x is the preference maximum.
      level: Math.min(1, Math.max(0, target * this.prefs.speechBoost / 2.5)),
    }
  }

  async enable(): Promise<void> {
    this.ensureContext()
    await this.context?.resume().catch(() => undefined)
    if (this.blocked && this.queue.length > 0) {
      this.blocked = false
      this.playNext()
    }
  }

  /** Read-aloud is only live while the microphone is listening. */
  beginSession(sessionId: string): void {
    this.abandonYield()
    this.pendingBoundaryYield = false
    // A different conversation starts a new frame sequence; the same session
    // must keep its watermark, otherwise a stopped/cut reply could revive.
    if (this.sessionId !== undefined && this.sessionId !== sessionId) this.frameWindow.reset()
    this.sessionId = sessionId
    this.active = true
    this.muted = false
    this.resetBargeIn(true)
    // A duck left over from a previous session must not follow the mic into
    // the new one, otherwise the first reply opens already quiet.
    this.gainRig.beginSession()
    void this.enable()
  }

  /** A new user utterance ends a previous "stop talking" mute. */
  unmute(): void { this.muted = false }

  /** Stop accepting new sentences; already queued audio keeps playing. */
  endSession(): void {
    this.active = false
    this.abandonYield()
    this.pendingBoundaryYield = false
    this.resetBargeIn(true)
  }

  /** True while a reply is audible or waiting to be read. */
  busy(): boolean {
    return this.active && (this.playing || this.queue.length > 0 || this.cutting || this.deferred.length > 0)
  }

  /**
   * What the assistant still owes the listener, in speaking order. Index 0 is
   * the sentence playing right now; the organizer may drop or reorder the rest.
   */
  pendingFrames(
    limit = ORGANIZER_PENDING_LIMIT,
    itemChars = ORGANIZER_PENDING_ITEM_CHARS,
    totalChars = ORGANIZER_PENDING_TOTAL_CHARS,
  ): VoiceFrame[] {
    const rows = [
      ...(this.playing && this.currentFrame ? [this.currentFrame] : []),
      // New-answer frames first, then the preserved tail: this is the actual
      // order the player will use, not a cosmetic display order.
      ...orderBargeInFrames<VoiceFrame>(this.queue, this.deferred),
      ...this.afterCut,
    ]
    const frames: VoiceFrame[] = []
    let chars = 0
    for (const frame of rows) {
      if (frames.length >= limit) break
      if (!frame || typeof frame.text !== 'string') continue
      const clean = Array.from(frame.text.replace(/\s+/gu, ' ').trim())
      if (clean.length === 0) continue
      const text = clean.slice(0, itemChars).join('')
      const length = Array.from(text).length
      if (chars + length > totalChars) break
      chars += length
      frames.push(frame)
    }
    return frames
  }

  /**
   * The listener started speaking while the assistant was being read aloud.
   * What this costs the audio is the contract the model declared through
   * voice_dialog action yield: 'sentence' finishes the sentence already
   * audible and drops the rest, 'immediate' cuts at once, 'never' keeps
   * playing to the end.
   */
  beginOwnerBargeIn(): boolean {
    const decision = decideInterruption(this.interruptionMode, {
      playing: this.playing && this.currentFrame !== undefined,
      cutting: this.cutting,
      muted: this.muted,
      active: this.active,
    })
    // 'keep' is either the declared contract or a guard: only a 'never'
    // declaration counts as a handled barge-in when nothing is touched.
    if (decision === 'keep') return this.interruptionMode === 'never'
    if (!this.currentFrame) return false
    if (this.bargeInActive) {
      this.abandonYield()
      return true
    }
    const current = this.currentFrame
    this.bargeInActive = true
    this.bargeInOldReplyId = current.replyId
    this.bargeInNewReplyId = undefined
    this.clearDeferredTimer()
    // The owner took the floor: no part of the old answer follows the new one.
    this.abandonYield()
    this.queue.length = 0
    this.deferred.length = 0
    this.afterCut = []
    // 'drain' lets the sentence that is already audible reach its own end.
    if (decision === 'cut') this.dropCurrent()
    return true
  }

  /**
   * Apply an organizer rewrite to sentences that have not started yet. Only
   * frames captured by pendingFrames and still queued/deferred are touched, so
   * a stale answer can never resurrect, duplicate or silently lose a sentence.
   */
  restructure(
    snapshot: readonly VoiceFrame[],
    fields: { dropSentences?: number[]; reorder?: number[] },
  ): { dropped: number; reordered: boolean } {
    const untouched = { dropped: 0, reordered: false }
    if (!this.active || this.muted || this.cutting || snapshot.length === 0) return untouched
    const plan = applyReorganization(snapshot.length, fields, {
      chunkGroups: snapshot.map((frame) => frame.sentenceId),
    })
    const current = this.playing ? this.currentFrame : undefined
    const queued = [...this.queue, ...this.deferred]
    const droppedFrames = plan.dropped
      .map((index) => snapshot[index])
      .filter((frame): frame is VoiceFrame => frame !== undefined && frame !== current && queued.includes(frame))
    // The sentence already being spoken always finishes first, regardless of a
    // late plan. Forcing that prefix is what guarantees no mid-sentence cut.
    const boundary = this.bargeInActive
      ? splitAtSentenceBoundary(current, queued).finish
      : []
    const boundarySet = new Set(boundary)
    const desired: VoiceFrame[] = [...boundary]
    for (const index of plan.order) {
      const frame = snapshot[index]
      if (!frame || frame === current || !queued.includes(frame) || desired.includes(frame)) continue
      desired.push(frame)
    }
    for (const frame of queued) if (!desired.includes(frame)) desired.push(frame)
    const dropped = droppedFrames.length
    const reordered = desired.some((frame, index) => queued[index] !== frame)
    if (dropped === 0 && !reordered) return untouched
    if (this.bargeInActive) {
      const oldReplyId = this.bargeInOldReplyId
      const playable = desired.filter((frame) => boundarySet.has(frame) || frame.replyId !== oldReplyId)
      const held = desired.filter((frame) => !playable.includes(frame))
      this.queue.splice(0, this.queue.length, ...playable)
      this.deferred.splice(0, this.deferred.length, ...held)
    } else {
      this.queue.splice(0, this.queue.length, ...desired)
      this.deferred.length = 0
    }
    if (!this.playing && this.queue.length > 0 && !this.blocked) this.playNext()
    return { dropped, reordered }
  }

  /**
   * Organizer-driven cut: fade the current sentence, drop unread old frames,
   * then let frames that arrived during the fade start the new answer.
   */
  cutNow(): boolean {
    if (!this.active || this.muted || !this.sessionId) return false
    if (!this.playing && this.queue.length === 0) return false
    const token = ++this.cutToken
    this.cutting = true
    this.cutReplyId = this.currentFrame?.replyId
    // Only the audible reply is invalidated. A new answer already in flight
    // must keep synthesizing, so this never becomes a full-session cancel.
    if (this.cutReplyId !== undefined) this.onCancelTts?.(this.sessionId, this.cutReplyId)
    // One writer fades the sentence out and schedules its own recovery, so a
    // fade to zero can never outlive the interruption.
    this.gainRig.cutFade()
    setTimeout(() => {
      if (token !== this.cutToken) return
      if (!this.active) {
        const pending = this.afterCut
        this.afterCut = []
        this.cutting = false
        this.applyGain()
        if (this.active) for (const frame of pending) this.enqueue(frame)
        return
      }
      this.queue.length = 0
      this.resetBargeIn(true)
      this.audio.pause()
      this.audio.onended = null
      this.audio.onerror = null
      this.cleanupUrl()
      try { window.speechSynthesis?.cancel() } catch { /* unsupported */ }
      this.playing = false
      this.restore()
      this.blocked = false
      this.cutting = false
      const pending = this.afterCut
      this.afterCut = []
      for (const frame of pending) this.enqueue(frame)
    }, 260)
    return true
  }

  /** Apply a control broadcast from the model-facing voice_dialog tool. */
  control(control: VoiceControl): void {
    if (control.action === 'speech') {
      this.declaredSpeech = normalizeSpeechProfile(control.profile)
      this.speechProfile = resolveSpeechProfile(this.declaredSpeech)
      // One owner for the interruption contract, whichever action declared it.
      if (isInterruptionMode(this.speechProfile.interruption)) {
        this.interruptionMode = this.speechProfile.interruption
      }
      return
    }
    if (control.action === 'yield') {
      if (isInterruptionMode(control.mode)) this.interruptionMode = control.mode
      return
    }
    if (control.action === 'stop') { this.stopAll(); return }
    if (control.action === 'repeat') { this.repeatLast(); return }
    if (control.action === 'volume') {
      // The rig stores one absolute level, so a command can never compound with
      // a duck that happened to be active when it arrived.
      if (typeof control.level === 'number') this.gainRig.setOverride(control.level)
      else this.gainRig.adjust(control.delta ?? 0)
    }
    // Rate is applied by the host TTS queue for subsequent sentences; the
    // player only needs to ignore the broadcast.
    if (control.action === 'rate') return
  }

  /** Remember one frame for "repeat that" even when it used the system voice. */
  note(frame: VoiceFrame): void {
    if (frame.replyId !== this.lastReplyId) {
      this.lastReplyId = frame.replyId
      this.lastTexts = []
      this.lastFrames = []
    }
    this.lastTexts.push(frame.text)
    this.spoken.push({ text: frame.text, at: Date.now() })
    if (this.spoken.length > 40) this.spoken.shift()
    if (frame.audio.length > 0 && !frame.error) this.lastFrames.push(frame)
    if (this.lastTexts.length > 80) this.lastTexts.shift()
    if (this.lastFrames.length > 80) this.lastFrames.shift()
  }

  /** Sentences spoken within the echo window; used by the echo gate. */
  recentSpoken(): readonly SpokenSample[] {
    const cutoff = Date.now() - 10_000
    return this.spoken.filter((sample) => sample.at >= cutoff)
  }

  private currentVolume(): number {
    return this.gainRig.volume()
  }

  private halt(): void {
    this.clearGap()
    this.abandonYield()
    this.pendingBoundaryYield = false
    this.queue.length = 0
    this.afterCut = []
    this.resetBargeIn(true)
    this.cutting = false
    this.cutToken += 1
    this.cutReplyId = undefined
    this.audio.pause()
    this.cleanupUrl()
    try { window.speechSynthesis?.cancel() } catch { /* unsupported */ }
    this.playing = false
    this.lastQueuedReplyId = undefined
    this.restore()
    this.blocked = false
  }

  private stopAll(): void {
    // The host queue continues synthesizing independently of playback. Cancel
    // it too, or old sentences arrive later and look like a ghost repeat.
    if (this.sessionId) this.onCancelTts?.(this.sessionId)
    // Keep the last reply in memory: "闭嘴" followed by "重复一遍" is valid.
    this.halt()
    this.muted = true
  }

  private repeatLast(): void {
    this.muted = false
    const frames = [...this.lastFrames]
    const text = this.lastTexts.join('')
    this.halt()
    if (frames.length > 0) {
      this.queue.push(...frames)
      this.playNext()
    } else if (text.trim()) {
      this.speakFallback(text)
    }
  }

  duck(): void {
    // Suppression after a cut, the duck watchdog and the single gain write all
    // live in the rig, so speech can never stack attenuation.
    this.gainRig.duck()
    // The system-voice fallback has no Web Audio gain; pause it softly instead.
    try { window.speechSynthesis?.pause() } catch { /* unsupported */ }
  }

  restore(): void {
    this.gainRig.restore()
    try { window.speechSynthesis?.resume() } catch { /* unsupported */ }
  }

  /**
   * Owner voice onset: hold the sentence in place. This runs on the microphone
   * VAD, before any transcript exists - waiting for recognition is what let the
   * assistant read over the first words of every new sentence.
   */
  yieldToOwner(): boolean {
    if (!this.prefs.autoRead) return false
    const decision = decideSpeechOnsetYield(this.interruptionMode, {
      playing: this.playing && this.currentFrame !== undefined,
      muted: this.muted,
      active: this.active,
      cutting: this.cutting,
    })
    // 'never' leaves the audio alone; the guards mean there is nothing to hold.
    if (decision === 'ignore') return false
    if (decision === 'atBoundary') {
      // The audible sentence keeps playing; the hold lands when it ends.
      if (this.yielded) return true
      this.pendingBoundaryYield = true
      return true
    }
    if (!this.canHold()) return false
    if (this.yielded) return true
    if (this.audio.paused) return false
    this.yielded = true
    this.yieldFrame = this.currentFrame
    this.clearYieldTimer()
    this.audio.pause()
    this.gainRig.duck()
    try { window.speechSynthesis?.pause() } catch { /* unsupported */ }
    return true
  }

  /** The utterance did not take the floor: carry on exactly where it stopped. */
  resumeFromYield(): void {
    if (!this.yielded) return
    this.clearYieldTimer()
    this.yielded = false
    const frame = this.yieldFrame
    this.yieldFrame = undefined
    if (!frame || !this.active || this.muted || this.cutting || this.blocked || !this.playing) return
    this.gainRig.restore()
    try { window.speechSynthesis?.resume() } catch { /* unsupported */ }
    const played = this.audio.play()
    if (played && typeof played.catch === 'function') {
      played.catch(() => {
        this.yielded = false
        this.playing = false
        this.playNext()
      })
    }
  }

  /**
   * The speaker stopped. Recognition still needs a moment, so hold the silence
   * and only resume if no routing decision lands before the delay.
   */
  resumeAfterSpeech(delayMs = YIELD_RESUME_AFTER_SPEECH_MS): void {
    if (!this.yielded) return
    this.clearYieldTimer()
    this.yieldTimer = setTimeout(() => {
      this.yieldTimer = null
      this.resumeFromYield()
    }, Math.max(0, delayMs))
  }

  /** True while a sentence is held waiting for the routing decision. */
  holdsYield(): boolean { return this.yielded }

  /** Could a hold be honoured right now? Checked before one is scheduled. */
  canHold(): boolean {
    return this.active && !this.muted && !this.cutting && !this.blocked
      && this.prefs.autoRead && this.playing && this.currentFrame !== undefined
  }

  private clearYieldTimer(): void {
    if (this.yieldTimer !== null) {
      clearTimeout(this.yieldTimer)
      this.yieldTimer = null
    }
  }

  /** Drop a held sentence for good: the owner is taking the floor. */
  private abandonYield(): void {
    this.clearYieldTimer()
    this.yielded = false
    this.yieldFrame = undefined
  }

  /** Hard stop of the audible sentence, without touching the queue logic. */
  private dropCurrent(): void {
    this.audio.pause()
    this.audio.onended = null
    this.audio.onerror = null
    this.cleanupUrl()
    this.playing = false
    this.currentFrame = undefined
    this.restore()
  }

  /** Read one sentence with the platform voice when Edge TTS is unavailable. */
  speakFallback(text: string, frame?: VoiceFrame): void {
    if (!this.active || this.muted || !this.prefs.autoRead || !text.trim() || typeof SpeechSynthesisUtterance === 'undefined') return
    if (frame) {
      this.frameStats.received += 1
      this.reportFrame('received', frame)
      if (!shouldPlayFrame(this.eligibility(frame))) {
        this.frameStats.dropped += 1
        this.reportFrame('dropped', frame, this.blockReason(frame))
        return
      }
      const order = orderOf(frame)
      const verdict = this.frameWindow.classify(order)
      if (verdict !== 'accept') {
        this.frameStats.dropped += 1
        this.reportFrame('dropped', frame, verdict)
        return
      }
      this.frameWindow.accept(order)
      this.note(frame)
    }
    try {
      const utterance = new SpeechSynthesisUtterance(text)
      utterance.volume = this.currentVolume()
      utterance.lang = /[\u3400-\u9fff]/.test(text) ? 'zh-CN' : 'en-US'
      window.speechSynthesis.speak(utterance)
    } catch {
      // A missing/blocked system voice must not break the audio player.
    }
  }

  enqueue(frame: VoiceFrame): void {
    this.frameStats.received += 1
    this.reportFrame('received', frame)
    if (!shouldPlayFrame(this.eligibility(frame))) {
      this.reportFrame('dropped', frame, this.blockReason(frame))
      this.frameStats.dropped += 1
      return
    }
    // Ordering guard: a frame older than the newest one already consumed is a
    // late delivery/replay, never something the listener still waits for.
    const order = orderOf(frame)
    const verdict = this.frameWindow.classify(order)
    if (verdict !== 'accept') {
      this.reportFrame('dropped', frame, verdict)
      this.frameStats.dropped += 1
      return
    }
    this.frameWindow.accept(order)
    this.note(frame)
    if (this.bargeInActive) {
      // Late blocks from the old answer are retained, never played ahead of
      // the answer to the owner's new question. A late continuation of the
      // sentence already being spoken still gets to finish that sentence.
      if (frame.replyId === this.bargeInOldReplyId) {
        if (this.currentFrame && isSameSentence(this.currentFrame, frame)) {
          // A late continuation still belongs before the replacement answer,
          // otherwise the current sentence would be split by the new reply.
          const firstNew = this.queue.findIndex((item) => item.replyId !== this.bargeInOldReplyId)
          if (firstNew < 0) this.queue.push(frame)
          else this.queue.splice(firstNew, 0, frame)
          if (!this.playing) this.playNext()
        } else {
          // Old answer, unrelated sentence: the owner already moved on.
          this.reportFrame('dropped', frame, 'barge-in-superseded')
          this.frameStats.dropped += 1
        }
        return
      }
      // First frame of the replacement answer: it plays after the current
      // sentence's remaining blocks and before the deferred old tail.
      this.bargeInNewReplyId = frame.replyId
      this.lastQueuedReplyId = frame.replyId
      this.clearDeferredTimer()
      this.queue.push(frame)
      if (!this.playing) this.playNext()
      return
    }
    // A new answer supersedes whatever is still unspoken from the previous one.
    // Without this the listener hears the old report continue inside the new
    // reply, which is the "it repeats the last thing it said" complaint.
    if (this.lastQueuedReplyId !== undefined && frame.replyId !== this.lastQueuedReplyId) {
      this.queue.length = 0
      this.cutReplyId = undefined
    }
    this.lastQueuedReplyId = frame.replyId
    if (this.cutReplyId !== undefined && frame.replyId !== this.cutReplyId) this.cutReplyId = undefined
    if (this.cutReplyId !== undefined && frame.replyId === this.cutReplyId) return
    if (this.cutting) { this.afterCut.push(frame); return }
    this.queue.push(frame)
    if (!this.playing) this.playNext()
  }

  /** Everything the playback decision needs, including the host's election. */
  private eligibility(frame: VoiceFrame) {
    return {
      active: this.active,
      muted: this.muted,
      autoRead: this.prefs.autoRead,
      tabSession: this.sessionId,
      frameSession: frame.sessionId,
      ...(frame.owner === undefined ? {} : { frameOwner: frame.owner }),
      clientId: CLIENT_ID,
    }
  }

  /** Which eligibility condition rejected a frame, for the telemetry log. */
  private blockReason(frame: VoiceFrame): string {
    return playBlockReason(this.eligibility(frame)) ?? 'ineligible'
  }

  /**
   * Heal a stale stop: another mounted instance can end this session while the
   * microphone here is still open, which leaves the tab silent forever. The
   * page re-asserts the session it is actually listening on.
   */
  assertActive(sessionId: string): void {
    if (this.active || this.sessionId !== sessionId) return
    this.active = true
    this.muted = false
    void this.enable()
  }

  /** Counters for the settings panel and for verification runs. */
  frameCounters(): { received: number; dropped: number; played: number } {
    return { ...this.frameStats }
  }

  /** JSONL telemetry: received / dropped (with reason) / played per frame. */
  private reportFrame(phase: 'received' | 'dropped' | 'played', frame: VoiceFrame, reason?: string): void {
    try {
      void postLatency({
        kind: 'frame',
        phase,
        sessionId: frame.sessionId,
        replyId: frame.replyId,
        epoch: typeof frame.epoch === 'number' ? frame.epoch : -1,
        seq: typeof frame.seq === 'number' ? frame.seq : -1,
        ...(reason === undefined ? {} : { reason }),
      })
    } catch { /* telemetry must never break speech */ }
  }

  private clear(): void {
    if (this.sessionId) this.onCancelTts?.(this.sessionId)
    this.abandonYield()
    this.queue.length = 0
    this.afterCut = []
    this.resetBargeIn(true)
    this.cutting = false
    this.cutToken += 1
    this.cutReplyId = undefined
    this.audio.pause()
    try { window.speechSynthesis?.cancel() } catch { /* unsupported */ }
    this.cleanupUrl()
    this.playing = false
    this.restore()
    this.blocked = false
    this.lastTexts = []
    this.lastFrames = []
    this.lastReplyId = undefined
    this.lastQueuedReplyId = undefined
  }

  private ensureContext(): void {
    if (this.context) return
    const Ctor = window.AudioContext
    if (!Ctor) return
    this.context = new Ctor()
    this.source = this.context.createMediaElementSource(this.audio)
    this.gain = this.context.createGain()
    // The duck/cut logic owns this.gain (0..1). Loudness comes after it: a fixed
    // makeup gain and a limiter, so speech reaches laptop speakers at a normal
    // level while ducks and fades keep working exactly as before.
    this.boost = this.context.createGain()
    this.boost.gain.value = this.prefs.speechBoost
    this.limiter = this.context.createDynamicsCompressor()
    this.limiter.threshold.value = -12
    this.limiter.knee.value = 6
    this.limiter.ratio.value = 12
    this.limiter.attack.value = 0.003
    this.limiter.release.value = 0.25
    this.source.connect(this.gain)
    this.gain.connect(this.boost)
    this.boost.connect(this.limiter)
    this.limiter.connect(this.context.destination)
    this.applyGain()
  }

  /** Every gain change goes through the rig: cancel, pin, then one target. */
  private applyGain(): void {
    this.gainRig.apply('apply')
  }

  private clearDeferredTimer(): void {
    if (this.deferredTimer !== null) {
      clearTimeout(this.deferredTimer)
      this.deferredTimer = null
    }
  }

  private resetBargeIn(clearFrames: boolean): void {
    this.clearDeferredTimer()
    this.bargeInActive = false
    this.bargeInOldReplyId = undefined
    this.bargeInNewReplyId = undefined
    if (clearFrames) this.deferred.length = 0
  }

  /**
   * The replacement answer has drained. Wait a short quiet window so late
   * TTS frames still join that answer, then resume the preserved old tail.
   */
  private scheduleDeferredResume(): void {
    if (!this.bargeInActive || this.bargeInNewReplyId === undefined) return
    // Nothing held back: the interruption dropped the old tail, so the flag
    // must clear here or every later frame would be treated as a barge-in.
    if (this.deferred.length === 0) { this.resetBargeIn(false); return }
    this.clearDeferredTimer()
    this.deferredTimer = setTimeout(() => {
      this.deferredTimer = null
      if (!this.active || this.muted || this.cutting || this.playing) return
      if (this.queue.length > 0 || !this.bargeInActive || this.bargeInNewReplyId === undefined) return
      const held = this.deferred.splice(0)
      if (held.length === 0) return
      this.bargeInActive = false
      this.bargeInOldReplyId = undefined
      this.bargeInNewReplyId = undefined
      this.queue.push(...orderBargeInFrames<VoiceFrame>([], held))
      this.playNext()
    }, 800)
  }

  private playNext(): void {
    // The sentence that was audible just ended: this is the boundary the
    // model's 'sentence' contract named. Hold here and drop the rest.
    if (decideBoundaryHold(this.pendingBoundaryYield, 'sentence') === 'hold') {
      this.pendingBoundaryYield = false
      this.settleBoundaryYield()
      return
    }
    const frame = this.queue.shift()
    if (!frame) {
      this.playing = false
      this.currentFrame = undefined
      if (this.onPlayback) { try { this.onPlayback(false, this.sessionId) } catch { /* logging only */ } }
      if (this.bargeInActive && this.queue.length === 0) this.scheduleDeferredResume()
      return
    }
    this.ensureContext()
    this.playbackStartedAt = Date.now()
    this.cleanupUrl()
    this.currentFrame = frame
    this.url = base64ToAudioUrl(frame.audio)
    this.audio.src = this.url
    this.playing = true
    if (this.onPlayback) { try { this.onPlayback(true, frame.sessionId || this.sessionId) } catch { /* logging only */ } }
    this.frameStats.played += 1
    this.reportFrame('played', frame)
    if (this.onPlay) { try { this.onPlay(frame) } catch { /* logging only */ } }
    this.audio.onended = () => {
      this.cleanupUrl()
      // A per-block gap wins over the profile gap; nothing is inserted otherwise.
      const gapMs = typeof frame.gapAfterMs === 'number' ? frame.gapAfterMs : this.speechProfile.betweenBlocksMs
      if (gapMs > 0 && this.queue.length > 0) {
        this.gapTimer = setTimeout(() => {
          this.gapTimer = null
          if (!this.active || this.muted) return
          this.playNext()
        }, gapMs)
        return
      }
      this.playNext()
    }
    this.audio.onerror = () => { this.cleanupUrl(); this.playNext() }
    void this.audio.play().catch(() => {
      // Autoplay was blocked: keep the frame so the first gesture can replay it.
      this.queue.unshift(frame)
      this.playing = false
      this.blocked = true
    })
  }

  /**
   * The 'sentence' hold reached a boundary: stop there and make sure no part of
   * the abandoned reply can resume after the owner's turn starts.
   */
  private settleBoundaryYield(): void {
    this.bargeInActive = true
    this.bargeInOldReplyId = this.currentFrame?.replyId ?? this.bargeInOldReplyId
    this.bargeInNewReplyId = undefined
    this.clearDeferredTimer()
    this.abandonYield()
    this.queue.length = 0
    this.deferred.length = 0
    this.afterCut = []
    this.playing = false
    this.currentFrame = undefined
    this.cleanupUrl()
    if (this.onPlayback) { try { this.onPlayback(false, this.sessionId) } catch { /* logging only */ } }
  }

  private cleanupUrl(): void {
    if (this.url) URL.revokeObjectURL(this.url)
    this.url = undefined
  }
}

const sharedPlayer = new TtsPlayer()
/** This page's identity in the host's playback election. */
const CLIENT_ID = Math.random().toString(36).slice(2) + Date.now().toString(36)
/** Local VAD onset of the utterance being recorded, in ms; 0 when idle. */
let speechOnsetAt = 0
/** Pending hold: set once speech started, cancelled if it was only a blip. */
let holdTimer: ReturnType<typeof setTimeout> | null = null

/** Names and guest policies are model-issued and kept in memory per session. */
const speakerPolicy = new SpeakerPolicyStore()

function applySpeakerPolicy(sessionId: string, control: VoiceControl): void {
  if (control.action !== 'speaker') return
  speakerPolicy.apply(sessionId, control)
}

function effectiveGuestMode(sessionId: string, label: string): GuestMode {
  return speakerPolicy.effective(sessionId, label, getPreferences().guestMode)
}

function displaySpeaker(sessionId: string, label: string): string {
  return speakerPolicy.display(sessionId, label)
}

function useAutoRead(sessionId: string): void {
  useEffect(() => {
    let closed = false
    let source: EventSource | null = null
    const unlock = (): void => { void sharedPlayer.enable() }
    // The first gesture unlocks Web Audio for every later auto-read frame.
    window.addEventListener('pointerdown', unlock, true)
    void loadConfig()
      .then(() => {
        if (closed) return
        source = new EventSource(apiUrl('/stream'))
        source.addEventListener('audio', (event) => {
          try {
            const frame = JSON.parse((event as MessageEvent<string>).data) as VoiceFrame
            if (frame.sessionId !== sessionId) return
            if (frame.error || !frame.audio) sharedPlayer.speakFallback(frame.text, frame)
            else sharedPlayer.enqueue(frame)
          } catch {
            // A malformed frame must not tear down the stream.
          }
        })
        source.addEventListener('control', (event) => {
          try {
            const control = JSON.parse((event as MessageEvent<string>).data) as VoiceControl
            applySpeakerPolicy(sessionId, control)
            sharedPlayer.control(control)
          } catch {
            // A malformed control frame must not tear down the stream.
          }
        })
      })
      .catch((error: unknown) => { console.warn('[dsh-voice-dialog] read-aloud unavailable', error) })
    return () => {
      closed = true
      source?.close()
      window.removeEventListener('pointerdown', unlock, true)
    }
  }, [sessionId])
}

/** The speech Remote can be unavailable (slow mount, disabled bundle, phone). */
function requireSpeech(ctx: any): any {
  // Reading a service the ctx did not inject throws in DSH ("cannot get
  // property ... without inject"); it does not return undefined. Catch it so the
  // settings page shows a readable line instead of a raw runtime error.
  let speech: any
  try { speech = ctx?.remote?.speech } catch { speech = undefined }
  if (!speech) {
    throw new Error('语音服务还没就绪：确认插件已启用后刷新这个页面，再试一次。')
  }
  return speech
}

export async function apply(ctx: any): Promise<() => Promise<void>> {
  // The settings form is registered first, on its own injection: the Plugins
  // page only renders a config section once `plugins.bundle.config` holds an
  // entry for the bundle, so a slow or unavailable speech Remote must never
  // keep the settings hidden. That ordering is what made a phone show an
  // empty plugin page.
  // 'remote' must be injected on this scope: the settings form reads
  // ctx.remote (speech catalog) and an un-injected read throws.
  const settingsUi = ctx.inject(['slots', 'remote.speech'], (scope: any) => {
    scope.slots.inject('plugins.bundle.config', () =>
      scope.slots.register({
        name: 'plugins.bundle.config',
        key: BUNDLE_ID,
        inject: () => ({ ctx: scope }),
      }, VoiceSettings),
    )
  })
  let disposeRemote: (() => Promise<void>) | undefined
  let micUi: { dispose: () => Promise<void> } | undefined
  try {
    await settingsUi
    // Mount the speech Remote contribution here instead of relying on the
    // built-in voice-input client plugin to mount it for us. The contribution
    // must be mounted before a nested inject can wait for remote.speech.
    disposeRemote = await ctx.remote.$mount(speechRemote)
    micUi = ctx.inject(['remote.speech', 'slots', 'sessions', 'pluginNavigation'], (scope: any) => {
      scope.slots.inject('conversation.input.activity', () =>
        scope.slots.register({
          name: 'conversation.input.activity',
          // Shadow the official one-shot mic at the same seat. Only one
          // microphone remains: no toolbar button and no floating panel.
          priority: -100,
          inject: () => ({ ctx: scope }),
        }, VoiceMic),
      )
    })
    await micUi
  } catch (error) {
    // A failed microphone seat must not take the settings page down with it.
    console.error('[dsh-voice-dialog] client mount failed', error)
  }
  return async () => {
    if (micUi) { try { await micUi.dispose() } catch { /* already gone */ } }
    try { await settingsUi.dispose() } catch { /* already gone */ }
    if (disposeRemote) { try { await disposeRemote() } catch { /* already gone */ } }
  }
}

/** Capture survives a transient composer remount; only a real navigation stops it. */
let retainedMic: MicrophoneLoop | null = null
let retainedSession: string | null = null
let retainedStopTimer: ReturnType<typeof setTimeout> | null = null

function cancelRetainedStop(): void {
  if (retainedStopTimer !== null) {
    clearTimeout(retainedStopTimer)
    retainedStopTimer = null
  }
}

interface VoiceMicProps {
  ctx: any
  sessionId: string
  /** Composer expansion hook used by the built-in voice input row. */
  onActiveChange?: (active: boolean) => void
}

/** Compact live amplitude history in the built-in capture-row style. */
function LiveWave({ level }: { level: number }) {
  const [levels, setLevels] = useState<number[]>(() => Array(48).fill(0))
  useEffect(() => { setLevels((previous) => [...previous.slice(1), level]) }, [level])
  return <svg className="dsh-vd-wave" viewBox="0 0 640 40" preserveAspectRatio="none" role="img" aria-label="麦克风音量">
    {levels.map((value, index) => {
      const height = 1 + Math.min(1, value * 5) * 17
      return <line key={index} x1={index * 13.2 + 6} x2={index * 13.2 + 6}
        y1={20 - height} y2={20 + height} stroke="currentColor" strokeWidth="6"
        strokeLinecap="round" opacity={0.25 + index / 96} />
    })}
  </svg>
}

/** Keep at most `limit` ASR requests in flight without losing order. */
function createLimit(limit: number): <T>(task: () => Promise<T>) => Promise<T> {
  const width = Math.max(1, Math.floor(limit))
  let active = 0
  const waiting: Array<() => void> = []
  return async <T,>(task: () => Promise<T>): Promise<T> => {
    if (active >= width) await new Promise<void>((resolve) => { waiting.push(resolve) })
    else active += 1
    try {
      return await task()
    } finally {
      const next = waiting.shift()
      // Transfer the slot to the next waiter instead of freeing it and racing.
      if (next) next()
      else active = Math.max(0, active - 1)
    }
  }
}

function VoiceMic({ ctx, sessionId, onActiveChange }: VoiceMicProps) {
  const [active, setActive] = useState(false)
  const [level, setLevel] = useState(0)
  const [phase, setPhase] = useState<'idle' | 'starting' | 'listening'>('idle')
  const [pending, setPending] = useState(0)
  const [queued, setQueued] = useState(0)
  const [error, setError] = useState('')
  const [speaker, setSpeaker] = useState('')
  /** A failure must be readable without hovering: phones have no tooltips. */
  const [banner, setBanner] = useState('')
  const micRef = useRef<MicrophoneLoop | null>(null)
  const schedulerRef = useRef<SpeechScheduler | null>(null)
  const classifyRef = useRef<Promise<void>>(Promise.resolve())
  const separationReadyRef = useRef(false)
  const separationRetryAtRef = useRef(0)
  const separatorRef = useRef<ContinuousSeparation | null>(null)
  const organizerRef = useRef<SpeechOrganizer | null>(null)
  const plannerRef = useRef<SpeechPlanner | null>(null)
  const planLedgerRef = useRef(new PlanLedger())
  const organizerOrderRef = useRef(0)
  const lastLaneTextRef = useRef<Map<string, string>>(new Map())
  /** One coalescer per capture; continuous and fast-single both append to it. */
  const utteranceCoalescerRef = useRef<UtteranceCoalescer<CoalescedVoiceSegment> | null>(null)
  /** Successful identities are remembered per lane only for this capture. */
  const identityCacheRef = useRef<Map<SpeakerLane, SpeakerIdentity>>(new Map())
  const lastIdentityLaneRef = useRef<SpeakerLane | null>(null)
  /** Last accepted owner transcript, for the input gate's duplicate rule. */
  const lastOwnerInputRef = useRef('')
  /** Mixed tail kept from the moment speech ended, for a single-speaker ASR. */
  const mixedTailRef = useRef<{ samples: number; at: number; text: Promise<string>; timing: UtteranceTiming } | null>(null)
  /** Wall clock of the last speech sample the mic heard; the honest latency base. */
  const lastSpeechEndRef = useRef<number>(0)
  /** VAD close (utterance end) of the latest utterance. */
  const lastUtteranceEndRef = useRef<number>(0)
  /** Cached speech selection: the catalog round trip does not belong on every lane. */
  const speechSelectionRef = useRef<{ at: number; value: { providerId: string; language: string } } | null>(null)
  /** Idempotency gate: one continuously separated segment reaches the model once. */
  const deliveredIdsRef = useRef<Set<string>>(new Set())
  const rememberSpeakerIdentity = (
    identity: SpeakerIdentity | null | undefined,
  ): SpeakerIdentity | null => {
    if (!identity || !identity.label) return identity ?? null
    identityCacheRef.current.set(laneForIdentity(identity), identity)
    lastIdentityLaneRef.current = laneForIdentity(identity)
    return identity
  }
  const identifySpeakerForLane = async (
    samples: Float32Array,
    laneHint: SpeakerLane,
    prefs: VoiceDialogPreferences,
  ): Promise<SpeakerIdentity | null> => {
    // Below 700 ms of voiced audio an embedding is unstable; reuse the last
    // successful identity for this lane instead of inventing an owner.
    if (!hasEnoughVoiceprintAudio(samples)) {
      return identityCacheRef.current.get(laneHint) ?? null
    }
    const identity = await identifySpeaker(
      samples, sessionId, prefs.speakerThreshold, prefs.ownerMargin,
    )
    return rememberSpeakerIdentity(identity)
  }
  useAutoRead(sessionId)
  useLayoutEffect(() => {
    onActiveChange?.(active)
    return () => { onActiveChange?.(false) }
  }, [active, onActiveChange])

  useEffect(() => {
    if (!active) return
    reportVoiceState(sessionId, true)
    const heartbeat = setInterval(() => { reportVoiceState(sessionId, true) }, 45_000)
    // While this tab hears the microphone it must also be the tab that speaks.
    const heal = setInterval(() => { sharedPlayer.assertActive(sessionId) }, 2_500)
    sharedPlayer.assertActive(sessionId)
    return () => { clearInterval(heartbeat); clearInterval(heal) }
  }, [active, sessionId])

  useEffect(() => subscribePreferences((value) => {
    micRef.current?.tune({
      silenceMs: value.pauseMs,
      threshold: value.micThreshold > 0 ? value.micThreshold : null,
    })
  }), [])

  // Surface every failure as a visible banner; a phone cannot hover a tooltip.
  useEffect(() => {
    if (!error) return
    setBanner(error)
    const timer = setTimeout(() => setBanner(''), 10_000)
    return () => { clearTimeout(timer) }
  }, [error])

  useEffect(() => {
    sharedPlayer.onPlay = (frame) => {
      void postLatency({
        kind: 'play_start', sessionId: frame.sessionId, replyId: frame.replyId,
        at: new Date().toISOString(),
      })
    }
    sharedPlayer.onPlayback = (playing, sessionId) => {
      if (sessionId) reportPlayback(sessionId, playing)
    }
    sharedPlayer.onCancelTts = (sessionId, replyId) => cancelHostTts(sessionId, replyId)
    return () => {
      sharedPlayer.onPlay = undefined
      sharedPlayer.onPlayback = undefined
      sharedPlayer.onCancelTts = undefined
    }
  }, [])

  useEffect(() => {
    const onPageHide = (): void => { reportVoiceState(sessionId, false, true) }
    window.addEventListener('pagehide', onPageHide)
    return () => { window.removeEventListener('pagehide', onPageHide) }
  }, [sessionId])

  /** Backpressure counters: proves that a slow model never builds a backlog. */
  const reportSeparationPressure = (separator: ContinuousSeparation): void => {
    try {
      void postLatency({
        kind: 'separation-pressure',
        sessionId,
        at: new Date().toISOString(),
        ...separator.pressureReport(),
      })
    } catch { /* counters are diagnostics only */ }
  }

  const flushSeparator = async (): Promise<void> => {
    const separator = separatorRef.current
    separatorRef.current = null
    try {
      if (separator) {
        await separator.flush()
        reportSeparationPressure(separator)
      }
      // Let the voiceprint/ASR chain append its final lanes before flushing.
      await classifyRef.current
    } catch (failure) {
      console.warn('[dsh-voice-dialog] continuous flush failed', failure)
    } finally {
      // stop/endSession must submit pending text immediately, including the
      // fast path that has no ContinuousSeparation instance.
      utteranceCoalescerRef.current?.flushAll()
      separator?.close()
    }
  }

  const stop = async (): Promise<void> => {
    cancelRetainedStop()
    retainedMic = null
    retainedSession = null
    await micRef.current?.stop()
    micRef.current = null
    // Continuous separation owns its own source buffers; flush them before
    // closing the scheduler, or the last 1.6 s of speech would be lost.
    await flushSeparator()
    utteranceCoalescerRef.current?.dispose()
    utteranceCoalescerRef.current = null
    identityCacheRef.current = new Map()
    lastIdentityLaneRef.current = null
    // An explicit later command must not be overridden by a plan still in
    // flight. Pending holds are released by the organizer's finally block.
    organizerRef.current?.cancel()
    organizerRef.current = null
    // Keep already captured segments: stopping the microphone must not lose
    // the last sentence the user just spoke. The scheduler flushes guest lines
    // that are already waiting, then refuses new work.
    schedulerRef.current?.dispose()
    schedulerRef.current = null
    setPending(0)
    setQueued(0)
    reportVoiceState(sessionId, false)
    setActive(false)
    setPhase('idle')
    setLevel(0)
    setSpeaker('')
    sharedPlayer.endSession()
    sharedPlayer.restore()
  }

  useEffect(() => {
    if (retainedMic && retainedSession === sessionId) {
      // The composer remounted while listening. Reattach instead of stopping.
      cancelRetainedStop()
      micRef.current = retainedMic
      sharedPlayer.beginSession(sessionId)
      setActive(true)
      setPhase('listening')
      return
    }
    if (retainedMic) {
      cancelRetainedStop()
      void retainedMic.stop()
      retainedMic = null
      retainedSession = null
    }
    setActive(false)
    setPhase('idle')
    setError('')
    setSpeaker('')
    return () => {
      const mic = micRef.current
      if (!mic) return
      // A slot remount must not kill an active conversation. Hold the capture
      // for a moment; if this was real navigation, stop it after the grace.
      retainedMic = mic
      retainedSession = sessionId
      cancelRetainedStop()
      retainedStopTimer = setTimeout(() => {
        if (retainedMic !== mic) return
        retainedMic = null
        retainedSession = null
        retainedStopTimer = null
        void (async () => {
          await mic.stop()
          await flushSeparator()
          reportVoiceState(sessionId, false)
          sharedPlayer.endSession()
          sharedPlayer.restore()
        })()
      }, 1200)
    }
  }, [sessionId])

  /**
   * Resolve the recognizer selection once instead of once per lane: the catalog
   * round trip used to sit in front of every single transcription.
   */
  const speechSelection = async (): Promise<{ providerId: string; language: string }> => {
    const cached = speechSelectionRef.current
    if (cached && Date.now() - cached.at < 15_000) return cached.value
    const catalog = await ctx.remote.speech.catalog()
    if (!catalog.ok) throw new Error(catalog.error?.message ?? '语音识别服务不可用')
    const provider = catalog.value.providers.find((item: any) => item.id === catalog.value.selection.providerId)
    if (!provider || !['ready', 'standby', 'waking'].includes(provider.preparation.phase)) {
      speechSelectionRef.current = null
      throw new Error('语音模型未就绪，请在插件设置中准备')
    }
    speechSelectionRef.current = { at: Date.now(), value: catalog.value.selection }
    return catalog.value.selection
  }

  interface TimedTranscript {
    text: string
    /** Wall clock when the call acquired its slot. */
    startedAt: number
    /** Wall clock when the transcript arrived. */
    doneAt: number
    /** Model-only time reported by the provider, when it reports one. */
    inferMs?: number
  }

  const transcribeTimed = async (audioBase64Value: string): Promise<TimedTranscript> => {
    const startedAt = Date.now()
    const selection = await speechSelection()
    const result = await ctx.remote.speech.transcribe({
      audioBase64: audioBase64Value,
      ...selection,
    }, new AbortController().signal)
    if (!result.ok) {
      speechSelectionRef.current = null
      throw new Error(result.error?.message ?? '识别失败')
    }
    const doneAt = Date.now()
    const value = result.value as { text?: unknown; inferenceSeconds?: unknown } | undefined
    const inferMs = typeof value?.inferenceSeconds === 'number' && Number.isFinite(value.inferenceSeconds)
      ? Math.round(value.inferenceSeconds * 1000)
      : undefined
    return {
      text: String(value?.text ?? '').trim(),
      startedAt, doneAt,
      ...(inferMs === undefined ? {} : { inferMs }),
    }
  }

  const transcribeAudio = async (audioBase64Value: string): Promise<string> =>
    (await transcribeTimed(audioBase64Value)).text

  const transcribeSamples = (samples: Float32Array): Promise<string> =>
    transcribeAudio(audioBase64(encodeWave(samples)))

  /** One ASR call that records its own timings on the way through. */
  /** One ASR call that records its own timings on the way through. */
  const timedSamples = (
    samples: Float32Array,
    runLimited: <T>(task: () => Promise<T>) => Promise<T>,
    timing: UtteranceTiming = {},
  ): { text: Promise<string>; timing: UtteranceTiming } => {
    const text = runLimited(async () => {
      const call = await transcribeTimed(audioBase64(encodeWave(samples)))
      timing.asrStartAt = call.startedAt
      timing.asrDoneAt = call.doneAt
      if (call.inferMs !== undefined) timing.asrInferMs = call.inferMs
      return call.text
    })
    void text.catch(() => undefined)
    return { text, timing }
  }

  /**
   * The organizer is the single routing gate: every transcript (owner and
   * guest) is classified before it enters the scheduler. A model failure
   * always falls back to queueing in arrival order; only an explicit drop /
   * ignore result discards speech.
   */
  const enqueueWithOrganizer = (
    lane: 'owner' | 'guest',
    canonical: string,
    work: Promise<string | null>,
    scheduler: SpeechScheduler,
    closedAt?: number,
    separated = false,
    timing: UtteranceTiming = {},
    fastPath = false,
  ): void => {
    const prefs = getPreferences()
    const arrivalOrder = organizerOrderRef.current++
    const trace = createUtteranceTrace({
      sessionId,
      lane,
      // The honest base is when the speaker stopped, not when the segment arrived.
      startedAt: timing.speechEndAt ?? closedAt ?? Date.now(),
    } as TraceInput)
    markUtteranceStage(trace, 'utterance_end', () => closedAt ?? Date.now())
    if (separated) {
      // Real arrival of the separation result, not the moment the utterance closed.
      markUtteranceStage(trace, 'separation_done', () => timing.separationDoneAt ?? closedAt ?? Date.now())
    }
    if (timing.asrStartAt !== undefined) trace.marks.asr_start = timing.asrStartAt
    if (timing.asrDoneAt !== undefined) trace.marks.asr_done = timing.asrDoneAt
    const finish = (
      options: Parameters<typeof buildUtteranceRecord>[1],
      gateDecision?: InputGateDecision,
    ): void => {
      if (!trace) return
      const record = buildUtteranceRecord(trace, { fastPath, ...options, timing })
      if (gateDecision) Object.assign(record, inputGateTraceFields(gateDecision))
      void postLatency(record)
    }
    // A sentence held by the microphone onset is released unless this utterance
    // takes the floor; the owner steer path abandons it instead of resuming.
    const release = (): void => sharedPlayer.resumeFromYield()
    if (!prefs.organizerEnabled && lane === 'guest') {
      release()
      scheduler.enqueue(lane, canonical, work, { order: arrivalOrder })
      return
    }
    let organizer = organizerRef.current
    if (!organizer) {
      organizer = new SpeechOrganizer((request, signal) => organizeSpeech(request, signal), { timeoutMs: 1400 })
      organizerRef.current = organizer
    }
    const enqueue = (text: string, priority?: number) => {
      const entry = scheduler.enqueue(lane, canonical, Promise.resolve(text), {
        order: arrivalOrder,
        priority,
      })
      entry.setMode(priority === -1 ? 'steer' : 'queue')
      return entry
    }
    void work.then(async (text) => {
      if (!text) { release(); return }
      // Explicit "打断" / stop commands are hard commands, not model input.
      if (parseQueueControl(text)) {
        // Hard commands jump model-assigned priorities but still keep arrival order.
        scheduler.enqueue(lane, canonical, Promise.resolve(text), { order: arrivalOrder, priority: -1 })
        release()
        markUtteranceStage(trace, 'enqueue')
        finish({ organizerAction: 'hard-command' })
        return
      }
      const spoken = text.replace(/^\s*\[声纹：[^\]]*\]\s*/u, '')
      // Cheap gates before the 860 ms organizer request: guest noise and the
      // microphone hearing its own playback. Both are conservative and leave
      // anything a person would consider a sentence alone.
      const noise = noiseGate(lane, spoken)
      if (noise.drop) {
        noteUtteranceText(trace, spoken)
        release()
        markUtteranceStage(trace, 'enqueue')
        finish({ organizerAction: 'noise-gate:' + (noise.reason ?? 'noise') })
        return
      }
      const echo = echoGate(spoken, sharedPlayer.recentSpoken())
      if (echo.drop) {
        noteUtteranceText(trace, spoken)
        release()
        markUtteranceStage(trace, 'enqueue')
        finish({ organizerAction: 'echo-gate:' + (echo.reason ?? 'echo') })
        return
      }
      const status = scheduler.status()
      const imperative = /打断|停下|停一下|别说|闭嘴|不用念|先停|换一个|换个话题/u.test(spoken)
      const schedulePlan = (allowInterrupt: boolean): void => {
        const pending = sharedPlayer.pendingFrames()
        // Fewer than two unread blocks means there is no order to change: the
        // call could only rearrange what has already been spoken.
        if (!shouldRunPlanner({ pendingBlocks: pending.length, queued: scheduler.status().queued })) return
        let planner = plannerRef.current
        if (!planner) {
          planner = new SpeechPlanner((request, signal) => planSpeech(request, signal), { timeoutMs: 900 })
          plannerRef.current = planner
        }
        const turnId = sessionId + ':' + arrivalOrder
        const queued = scheduler.snapshot().flatMap((item) => item.text
          ? [{ id: item.id, lane: item.lane, text: item.text }] : [])
        void planner.plan({
          sessionId, turnId, text: spoken, lane,
          playing: sharedPlayer.busy(), queued: queued.length, queue: queued,
          assistantPending: pending.map((frame) => ({
            text: frame.text,
            ...(typeof frame.sentenceId === 'number' ? { sentenceId: frame.sentenceId } : {}),
            ...(typeof frame.chunkIndex === 'number' ? { chunkIndex: frame.chunkIndex } : {}),
          })),
        }).then((plan) => {
          if (!plan) return
          const ids = scheduler.snapshot().map((item) => item.id)
          // A plan for a turn that already ended (queue empty, nothing playing)
          // is discarded whole: it may only correct, never revive.
          if (!shouldApplyPlan(plan, { playing: sharedPlayer.busy(), queued: ids.length, ids })) return
          if (!planLedgerRef.current.tryClaim(plan)) return
          if (plan.queuePlan && plan.queuePlan.length > 0) scheduler.applyQueuePlan(plan.queuePlan)
          if (plan.dropSentences !== undefined || plan.reorder !== undefined) {
            try { sharedPlayer.restructure(pending, plan) } catch { /* keep original order */ }
          }
          // Perception first: owner speech is reported to the host/model and
          // never cut here. Only an explicitly steered guest still cuts.
          if (plan.interrupt && allowInterrupt && lane !== 'owner') {
            sharedPlayer.cutNow()
          }
        }).catch(() => undefined)
      }
      noteUtteranceText(trace, spoken)
      if (lane === 'owner') {
        // The owner's line is never held back by a judgment round trip. Rules
        // that are certain (noise, an exact repeat, a spoken "stop") answer
        // synchronously; everything else enters the FIFO at once. The meaning
        // layer then decides — with what is being read right now, what the
        // assistant still owes, and what is already waiting — whether this line
        // should take the floor. Its verdict only ever corrects an entry that
        // has not started, so a slow or failed judgment costs nothing.
        const previousOwnerLine = lastOwnerInputRef.current
        const gateInput = {
          text: spoken,
          lane,
          playing: sharedPlayer.busy(),
          queued: status.queued,
          ...(previousOwnerLine ? { previousText: previousOwnerLine } : {}),
        }
        const ruled = ruleInputDecision(gateInput)
        if (ruled?.verdict === 'drop') {
          release()
          markUtteranceStage(trace, 'enqueue')
          finish({ organizerAction: 'input-gate:drop:' + ruled.reason }, ruled)
          return
        }
        lastOwnerInputRef.current = spoken
        let entry: ReturnType<typeof enqueue>
        if (ruled?.verdict === 'steer') {
          // A spoken stop still steers delivery, but the page does not cut:
          // the host/model sees the line and decides how to stop the mouth.
          organizerRef.current?.cancel()
          release()
          entry = enqueue(text, -1)
          entry.setMode('steer')
          markUtteranceStage(trace, 'enqueue')
          finish({ organizerAction: 'input-gate:steer:' + ruled.source }, ruled)
          schedulePlan(true)
          return
        }
        release()
        // No meaning judge on the owner lane. What the owner says is the
        // floor: the model reads the line in its own turn and answers, so a
        // second model scoring it can only add latency and get it wrong.
        // Only the deterministic rules above may reject a line outright.
        const bargeIn = decideBargeIn({ lane: 'owner', playing: sharedPlayer.busy() })
        // Report-only: queue the owner's words; keep the current audio playing.
        entry = enqueue(text)
        entry.setMode('queue')
        markUtteranceStage(trace, 'enqueue')
        finish({ organizerAction: 'owner-floor:' + bargeIn.action })
        return
      }

      // Guests keep the existing organizer strategy, but queueing is the
      // default and a guest verdict can never cut the owner's playback unless
      // that speaker was explicitly switched to steer.
      const guestMode = effectiveGuestMode(sessionId, canonical)
      // A guest speaking pauses the owner's answer for a moment; it resumes as
      // soon as the guest is routed, because guest speech only queues.
      release()
      const entry = enqueue(text, guestMode === 'steer' ? -1 : undefined)
      entry.setMode(guestMode === 'steer' ? 'steer' : 'queue')
      if (shouldCallGate({ playing: sharedPlayer.busy(), queued: status.queued }, imperative)) {
        let current = organizerRef.current
        if (!current) {
          current = new SpeechOrganizer((request, signal) => organizeSpeech(request, signal), { timeoutMs: 1400 })
          organizerRef.current = current
        }
        const selected = current
        void selected.plan({
          sessionId,
          text: spoken,
          lane,
          playing: true,
          queued: status.queued,
          ownerWeight: 0.3,
        }).then((plan) => {
          if (!plan || !selected.isCurrent(plan)) return
          if (!entry.started() && (plan.action === 'drop' || plan.action === 'ignore')) {
            entry.drop()
            return
          }
          if (guestMode === 'steer' && plan.action === 'interrupt') {
            sharedPlayer.cutNow()
            entry.setMode('steer')
          }
        }).catch(() => undefined)
      }
      markUtteranceStage(trace, 'enqueue')
      finish({ organizerAction: guestMode === 'steer' ? 'guest-steer-fastpath' : 'guest-queue-fastpath' })
      schedulePlan(guestMode === 'steer')
    }).catch((failure: unknown) => {
      release()
      console.warn('[dsh-voice-dialog] organizer routing failed', failure)
    })
  }

  /** Turn the two separated streams into two independently labelled lanes. */
  const enqueueSeparated = (
    result: SeparationResult,
    scheduler: SpeechScheduler,
    runLimited: <T>(task: () => Promise<T>) => Promise<T>,
    separation?: SeparationLatencyDetail,
  ): void => {
    const prefs = getPreferences()
    const tasks: Array<{
      lane: 'owner' | 'guest'
      canonical: string
      onsetMs: number
      work: Promise<string | null>
      timing: UtteranceTiming
    }> = []
    result.sources.forEach((source, index) => {
      const identity = rememberSpeakerIdentity(source.identity)
      const canonical = identity?.label || '说话人' + (index + 1)
      const lane: SpeakerLane = identity ? laneForIdentity(identity) : 'guest'
      const display = displaySpeaker(sessionId, canonical)
      if (prefs.speakerGate && identity?.owner !== true) {
        setSpeaker('已忽略其他人的声音')
        return
      }
      if (lane === 'guest' && effectiveGuestMode(sessionId, canonical) === 'ignore') {
        setSpeaker('已忽略' + (display || '其他人'))
        return
      }
      if (lane === 'guest') setSpeaker(display || '其他人')
      const prefix = prefs.speakerPrefix && display ? '[声纹：' + display + '] ' : ''
      const timing: UtteranceTiming = {}
      const work = runLimited(async () => {
        const call = await transcribeTimed(source.audioBase64)
        timing.asrStartAt = call.startedAt
        timing.asrDoneAt = call.doneAt
        if (call.inferMs !== undefined) timing.asrInferMs = call.inferMs
        return call.text ? prefix + call.text : null
      })
      tasks.push({ lane, canonical, onsetMs: source.onsetMs, work, timing })
    })
    // Keep the earlier speaker first; if they started together, the owner goes first.
    tasks.sort((a, b) => a.onsetMs - b.onsetMs
      || (a.lane === b.lane ? 0 : a.lane === 'owner' ? -1 : 1))
    const arrivedAt = Date.now()
    const utteranceEnd = lastUtteranceEndRef.current || arrivedAt
    for (const task of tasks) {
      const timing: UtteranceTiming = {
        separationDoneAt: arrivedAt,
        ...(separation === undefined ? {} : { separation }),
        ...task.timing,
      }
      if (lastSpeechEndRef.current > 0) timing.speechEndAt = lastSpeechEndRef.current
      enqueueWithOrganizer(task.lane, task.canonical, task.work, scheduler, utteranceEnd, true, timing)
    }
  }

  /** Identify a continuously separated lane, then queue its new text. */
  const enqueueContinuous = (
    segment: ContinuousSegment,
    scheduler: SpeechScheduler,
    runLimited: <T>(task: () => Promise<T>) => Promise<T>,
  ): void => {
    // One utterance id, one delivery. Separation and the speculative path may
    // both complete for the same audio, so the second completion is a no-op.
    if (segment.utteranceId !== undefined
      && !firstDelivery(deliveredIdsRef.current, segment.utteranceId)) return
    const arrivedAt = Date.now()
    const utteranceEnd = lastUtteranceEndRef.current || arrivedAt
    const diagnostics = segment.separation
    const timing: UtteranceTiming = {
      separationDoneAt: arrivedAt,
      separation: {
        mode: 'continuous',
        ...(diagnostics?.prewarm === undefined ? {} : { prewarm: diagnostics.prewarm }),
        ...(diagnostics?.queueMs === undefined ? {} : { queueMs: diagnostics.queueMs }),
        ...(diagnostics?.modelMs === undefined ? {} : { modelMs: diagnostics.modelMs }),
        ...(diagnostics?.wallMs === undefined ? {} : { wallMs: diagnostics.wallMs }),
        ...(diagnostics?.prewarmWaitMs === undefined ? {} : { prewarmWaitMs: diagnostics.prewarmWaitMs }),
        ...(diagnostics?.windowMs === undefined ? {} : { windowMs: diagnostics.windowMs }),
        ...(diagnostics?.modelCalls === undefined ? {} : { modelCalls: diagnostics.modelCalls }),
        gateReason: diagnostics?.mixed ? 'mixed-fallback' : 'separation',
      },
    }
    if (lastSpeechEndRef.current > 0) timing.speechEndAt = lastSpeechEndRef.current
    // Single speaker: the mixed tail covers the same audio, so its transcript
    // replaces the separated lane's recognition and one ASR call is saved.
    const mixed = mixedTailRef.current
    const useMixed = segment.siblingActive === false && mixed !== null
      && arrivedAt - mixed.at < 8000
      && canReuseSpeculativeAsr(segment.samples.length, mixed.samples)
    let transcription: Promise<string>
    if (useMixed && mixed) {
      mixedTailRef.current = null
      Object.assign(timing, mixed.timing)
      transcription = mixed.text
    } else {
      // Recognition starts the moment the segment closes; its timings land on
      // the same object the trace reads a moment later.
      transcription = timedSamples(segment.samples, runLimited, timing).text
    }
    void transcription.catch(() => undefined)
    classifyRef.current = classifyRef.current.then(async () => {
      const prefs = getPreferences()
      const slotLane: SpeakerLane = segment.slot === 0 ? 'owner' : 'guest'
      let identity: SpeakerIdentity | null = null
      try {
        identity = await identifySpeakerForLane(segment.samples, slotLane, prefs)
      } catch {
        // A failed/noisy lane can still be transcribed; reuse its last identity.
        identity = identityCacheRef.current.get(slotLane) ?? null
      }
      if (!identity) identity = identityCacheRef.current.get(slotLane) ?? null
      const fallback = '说话人' + (segment.slot + 1)
      const canonical = identity?.label || fallback
      // No history is never an owner: only an explicit owner match (or slot 0
      // with a cached owner identity) can take the owner lane.
      const lane: SpeakerLane = identity ? laneForIdentity(identity) : 'guest'
      const display = displaySpeaker(sessionId, canonical)
      if (prefs.speakerGate && identity?.owner !== true) {
        setSpeaker('已忽略其他人的声音')
        return
      }
      if (lane === 'guest' && effectiveGuestMode(sessionId, canonical) === 'ignore') {
        setSpeaker('已忽略' + (display || '其他人'))
        return
      }
      if (lane === 'guest') setSpeaker(display || '其他人')
      const prefix = prefs.speakerPrefix && display ? '[声纹：' + display + '] ' : ''
      const coalescer = utteranceCoalescerRef.current
      if (coalescer) {
        coalescer.append({
          lane,
          canonical,
          text: transcription,
          at: arrivedAt,
          meta: { scheduler, utteranceEnd, timing, fastPath: false, prefix },
        })
        return
      }
      // Defensive fallback for an unexpected call outside a capture.
      const key = lane + ':' + canonical
      const work = runLimited(async () => {
        const text = await transcription
        const fresh = dedupeTranscript(lastLaneTextRef.current.get(key) ?? '', text)
        lastLaneTextRef.current.set(key, text)
        if (!fresh) return null
        return prefix + fresh
      })
      enqueueWithOrganizer(lane, canonical, work, scheduler, utteranceEnd, true, timing)
    }).catch((failure: unknown) => {
      console.warn('[dsh-voice-dialog] continuous speaker routing failed', failure)
    })
  }

  /** Route one already-recognized mixed utterance after the speaker gate. */
  const enqueueFastSingle = (
    identity: SpeakerIdentity | null,
    transcription: Promise<string>,
    timing: UtteranceTiming,
    scheduler: SpeechScheduler,
    utteranceEnd: number,
    fastPath: boolean,
    prefs: VoiceDialogPreferences,
  ): void => {
    const cachedIdentity = identity
      ?? identityCacheRef.current.get(lastIdentityLaneRef.current ?? 'guest')
      ?? null
    const knownIdentity = rememberSpeakerIdentity(cachedIdentity)
    if (prefs.speakerGate && knownIdentity?.owner !== true) {
      setSpeaker('已忽略其他人的声音')
      return
    }
    // A missing identity is an unknown guest, never an implicit owner.
    const lane: SpeakerLane = knownIdentity ? laneForIdentity(knownIdentity) : 'guest'
    const canonical = knownIdentity?.label || '说话人1'
    const display = displaySpeaker(sessionId, canonical)
    if (lane === 'guest' && effectiveGuestMode(sessionId, canonical) === 'ignore') {
      setSpeaker('已忽略' + (display || '其他人'))
      return
    }
    if (lane === 'guest') setSpeaker(display || '其他人')
    const prefix = prefs.speakerPrefix && display ? '[声纹：' + display + '] ' : ''
    const coalescer = utteranceCoalescerRef.current
    if (coalescer) {
      coalescer.append({
        lane,
        canonical,
        text: transcription,
        at: Date.now(),
        meta: { scheduler, utteranceEnd, timing, fastPath, prefix },
      })
      return
    }
    const work = transcription.then((text) => text ? prefix + text : null)
    void work.catch(() => undefined)
    enqueueWithOrganizer(lane, canonical, work, scheduler, utteranceEnd, true, timing, fastPath)
  }

  /**
   * On-demand path for a completed utterance. Raw ASR starts immediately; a
   * cheap CAM++ self-similarity gate decides whether separation is needed at
   * all. Only a confident "same voice" result bypasses the model. Every error,
   * timeout, short clip, unanswered enrollment or uncertain score falls back to
   * the full separation path, so attribution quality never silently degrades.
   */
  const handleFastSegment = (
    samples: Float32Array,
    scheduler: SpeechScheduler,
    runLimited: <T>(task: () => Promise<T>) => Promise<T>,
  ): void => {
    const prefs = getPreferences()
    const startedAt = Date.now()
    const utteranceEnd = lastUtteranceEndRef.current || startedAt
    const timing: UtteranceTiming = {}
    if (lastSpeechEndRef.current > 0) timing.speechEndAt = lastSpeechEndRef.current
    const transcription = timedSamples(samples, runLimited, timing).text
    void transcription.catch(() => undefined)
    // Identify only after the gate. Calling it on mixed overlapping audio would
    // update the owner/guest clusters with two voices and degrade all later
    // attribution, so the fallback path must keep using the separated sources.
    const probe = Promise.race<OverlapProbe | null>([
      probeSpeakerOverlap(samples).catch(() => null),
      new Promise((resolve) => setTimeout(() => resolve(null), 450)),
    ])
    classifyRef.current = classifyRef.current.then(async () => {
      const verdict = await probe
      const gateDoneAt = Date.now()
      const base: SeparationLatencyDetail = {
        mode: 'fast',
        gateReason: verdict?.reason ?? 'probe-failed',
        ...(verdict?.minSimilarity === undefined ? {} : { selfSimilarity: verdict.minSimilarity }),
        ...(verdict?.ownerSimilarity === undefined ? {} : { ownerSimilarity: verdict.ownerSimilarity }),
        ...(verdict === null ? {} : { wallMs: gateDoneAt - startedAt }),
        modelCalls: 0,
      }
      timing.separationDoneAt = gateDoneAt
      timing.separation = base
      if (verdict?.singleSpeaker === true) {
        const laneHint = lastIdentityLaneRef.current ?? 'guest'
        const identity = await identifySpeakerForLane(samples, laneHint, prefs)
          .catch(() => identityCacheRef.current.get(laneHint) ?? null)
        enqueueFastSingle(identity, transcription, timing, scheduler, utteranceEnd, true, prefs)
        return
      }

      // Not confidently single: use the exact previous separation pipeline.
      // The mixed ASR already running is simply left to finish unused; it never
      // blocks this fallback, and a separation failure can still reuse it.
      let split: SeparationResult | null = null
      try {
        split = await separateSegment(samples, sessionId, prefs.speakerThreshold, true, prefs.ownerMargin)
      } catch (failure) {
        console.warn('[dsh-voice-dialog] on-demand separation failed', failure)
      }
      const separationDoneAt = Date.now()
      timing.separationDoneAt = separationDoneAt
      timing.separation = {
        ...base,
        mode: 'fallback',
        ...(split?.queueMs === undefined ? {} : { queueMs: split.queueMs }),
        ...(split?.workerMs === undefined ? {} : { modelMs: split.workerMs }),
        ...(split?.wallMs === undefined ? {} : { wallMs: split.wallMs }),
        modelCalls: split === null ? 0 : 1,
        gateReason: base.gateReason,
      }
      if (split?.separated === true && split.sources.length >= 2) {
        enqueueSeparated(split, scheduler, runLimited, timing.separation)
        return
      }
      // The model found one dominant stream, or failed. The raw transcript is
      // already in flight, so this is a zero-extra-inference safety net.
      const sourceIdentity = rememberSpeakerIdentity(split?.sources?.[0]?.identity ?? null)
      const laneHint = lastIdentityLaneRef.current ?? 'guest'
      const identity = sourceIdentity ?? await identifySpeakerForLane(samples, laneHint, prefs)
        .catch(() => identityCacheRef.current.get(laneHint) ?? null)
      enqueueFastSingle(identity, transcription, timing, scheduler, utteranceEnd, false, prefs)
    }).catch((failure: unknown) => {
      console.warn('[dsh-voice-dialog] fast speaker gate failed', failure)
    })
  }

  /** Identify first, then hand one lane to the scheduler. */
  const scheduleSegment = async (
    samples: Float32Array,
    scheduler: SpeechScheduler,
    runLimited: <T>(task: () => Promise<T>) => Promise<T>,
  ): Promise<void> => {
    const prefs = getPreferences()
    let identity: SpeakerIdentity | null = null

    const canSeparate = prefs.separateSpeakers && separationReadyRef.current
      && Date.now() >= separationRetryAtRef.current
    // Start normal ASR immediately. The separation model used to sit in front
    // of it, so even a single speaker paid the whole inference cost before the
    // transcript could enter the queue. With parallel ASR the two now race.
    const speculative = canSeparate && prefs.parallelAsr
      ? runLimited(() => transcribeSamples(samples))
      : null
    if (speculative) void speculative.catch(() => undefined)

    if (canSeparate) {
      try {
        const split = await separateSegment(samples, sessionId, prefs.speakerThreshold, true, prefs.ownerMargin)
        if (split.separated && split.sources.length >= 2) {
          enqueueSeparated(split, scheduler, runLimited)
          return
        }
        identity = rememberSpeakerIdentity(split.sources[0]?.identity ?? null)
        if (identity) {
          setSpeaker(displaySpeaker(sessionId, identity.label))
          reportSpeech(sessionId, 'speaker', displaySpeaker(sessionId, identity.label))
        }
      } catch (failure) {
        // Separation is an enhancement. A missing device, model, or a rare
        // inference failure must leave ordinary dictation untouched.
        console.warn('[dsh-voice-dialog] separation skipped', failure)
        // A transient worker/model failure should not disable separation for
        // the rest of the session; retry after a short cooldown.
        separationRetryAtRef.current = Date.now() + 30_000
      }
    }

    if (!identity && (prefs.speakerPrefix || prefs.speakerGate || prefs.guestMode !== 'steer'
      || speakerPolicy.hasCustomization(sessionId))) {
      try {
        const laneHint = lastIdentityLaneRef.current ?? 'guest'
        identity = await identifySpeakerForLane(samples, laneHint, prefs)
        if (identity) {
          setSpeaker(displaySpeaker(sessionId, identity.label))
          reportSpeech(sessionId, 'speaker', displaySpeaker(sessionId, identity.label))
        }
      } catch (failure) {
        // A missing model must not break normal dictation; the gate is
        // stricter because it is an explicit "only me" promise.
        if (prefs.speakerGate) {
          const message = failureText(failure)
          setError(message)
          return
        }
        console.warn('[dsh-voice-dialog] voiceprint skipped', failure)
      }
    }

    if (prefs.speakerGate && (!identity || !identity.owner)) {
      setSpeaker('已忽略其他人的声音')
      return
    }

    // An unknown/too-short lane is an unknown guest, not an implicit owner.
    const lane: SpeakerLane = identity ? laneForIdentity(identity) : 'guest'
    const canonical = identity?.label || '说话人1'
    const display = displaySpeaker(sessionId, canonical)
    if (lane === 'guest' && effectiveGuestMode(sessionId, canonical) === 'ignore') {
      setSpeaker('已忽略其他人的声音')
      return
    }
    if (lane === 'guest') setSpeaker(display || '其他人')

    const prefix = prefs.speakerPrefix && display ? '[声纹：' + display + '] ' : ''
    const timing: UtteranceTiming = {}
    if (lastSpeechEndRef.current > 0) timing.speechEndAt = lastSpeechEndRef.current
    const work = speculative
      ? (async () => {
          const text = await speculative
          return text ? prefix + text : null
        })()
      : (async () => {
          const timed = timedSamples(samples, runLimited, timing)
          const text = await timed.text
          return text ? prefix + text : null
        })()
    enqueueWithOrganizer(lane, canonical, work, scheduler, lastUtteranceEndRef.current || Date.now(), false, timing)
  }
  const handleSegment = (
    samples: Float32Array,
    scheduler: SpeechScheduler,
    runLimited: <T>(task: () => Promise<T>) => Promise<T>,
  ): void => {
    // Voiceprint calls are serialized by the host; ASR itself runs on up to
    // three lanes, so a slow guest line cannot block the owner's next line.
    classifyRef.current = classifyRef.current
      .then(() => scheduleSegment(samples, scheduler, runLimited))
      .catch((failure: unknown) => {
        const message = failureText(failure)
        setError(message)
        console.warn('[dsh-voice-dialog]', message)
      })
  }

  const makeScheduler = (): SpeechScheduler => new SpeechScheduler({
    deliver: async (text, mode) => {
      const session = ctx.sessions.binding(sessionId)?.session
      if (!session) throw new Error('当前会话不可用')
      const sent = await session.prompt([{ type: 'text', text }], mode)
      if (!sent.ok) throw new Error(sent.error?.message ?? '发送失败')
    },
    ownerMode: () => getPreferences().ownerMode,
    guestMode: (label) => effectiveGuestMode(sessionId, label),
    resolveSpeaker: (name) => speakerPolicy.resolve(sessionId, name),
    onControl: (control) => {
      if (control.action === 'interrupt') {
        organizerRef.current?.cancel()
        sharedPlayer.control({ action: 'stop' })
        sharedPlayer.unmute()
        // With a follow-up request the scheduler sends it as a steer, which
        // already interrupts the turn. A bare "打断" needs an explicit cancel.
        if (!control.rest) {
          const session = ctx.sessions.binding(sessionId)?.session
          void session?.cancel().catch((failure: unknown) => {
            console.warn('[dsh-voice-dialog] cancel after interrupt failed', failure)
          })
        }
        return
      }
      if (speakerPolicy.apply(sessionId, { speaker: control.target, policy: control.policy })) {
        const who = control.target === '*' ? '所有其他人' : displaySpeaker(sessionId, control.target)
        setSpeaker(control.policy === 'ignore' ? '已忽略' + who : control.policy === 'queue' ? '已恢复' + who : '允许' + who + '直接插话')
      }
    },
    onStatus: ({ active, queued }) => {
      setPending(active)
      setQueued(queued)
    },
    onError: (failure) => {
      const message = failureText(failure)
      setError(message)
      console.warn('[dsh-voice-dialog]', message)
    },
  })

  const start = async (): Promise<void> => {
    setError('')
    setSpeaker('')
    // Do not pre-judge the origin: a browser flag or a proxy can make
    // getUserMedia work on an origin that reports isSecureContext=false. Only
    // refuse when the API is genuinely absent, and let the real error surface.
    if (!navigator.mediaDevices?.getUserMedia) {
      setError('这个浏览器没有麦克风接口：用 https 地址或换浏览器再试')
      setPhase('idle')
      return
    }
    setPhase('starting')
    // A dismissed permission prompt can leave the promise pending forever, and
    // the button stays disabled ("tapping does nothing"). Give up and re-arm.
    const startGuard = setTimeout(() => {
      setError('启动超时：检查麦克风权限，或换用 https 地址再试')
      setPhase('idle')
    }, 15_000)
    try {
      const prefs = getPreferences()
      separationReadyRef.current = false
      separationRetryAtRef.current = 0
      if (prefs.separateSpeakers) {
        try {
          const status = await fetchSeparationStatus()
          separationReadyRef.current = status.ready
          // Build the ONNX session before the microphone opens. The previous
          // fire-and-forget warm could still be loading when the first sentence
          // ended, which put session creation (1.5-2 s) inside separationWaitMs.
          if (status.ready) {
            try { await warmSeparation() }
            catch (failure) {
              separationReadyRef.current = false
              console.warn('[dsh-voice-dialog] separation warmup failed', failure)
            }
          }
        } catch {
          // Separation is optional; ordinary dictation must still start.
        }
      }
      if (prefs.speakerGate) {
        const status = await fetchVoiceprintStatus()
        if (!status.ready) throw new Error(status.error ?? '声纹模型未安装，请在插件设置中准备')
        if (!status.enrolled) throw new Error('请先在插件设置里录制我的声纹')
      }
      const catalog = await ctx.remote.speech.catalog()
      if (!catalog.ok) throw new Error(catalog.error?.message ?? '语音识别服务不可用')
      const provider = catalog.value.providers.find((item: any) => item.id === catalog.value.selection.providerId)
      if (!provider || !['ready', 'standby', 'waking'].includes(provider.preparation.phase)) {
        // No sheet any more: the message itself has to carry the next step.
        setError('语音模型未就绪：到插件设置页点“准备语音模型”，再回来点麦克风')
        setPhase('idle')
        return
      }
      await sharedPlayer.enable()
      const scheduler = makeScheduler()
      schedulerRef.current = scheduler
      classifyRef.current = Promise.resolve()
      lastLaneTextRef.current = new Map()
      lastOwnerInputRef.current = ''
      utteranceCoalescerRef.current?.dispose()
      utteranceCoalescerRef.current = createUtteranceCoalescer<CoalescedVoiceSegment>({
        windowMs: UTTERANCE_COALESCE_WINDOW_MS,
        dedupeTranscript,
        submit: (batch) => {
          const first = batch.entries[0]
          if (!first) return
          const work = batch.text.then((text) => text ? first.meta.prefix + text : null)
          enqueueWithOrganizer(
            batch.lane,
            batch.canonical,
            work,
            first.meta.scheduler,
            first.meta.utteranceEnd,
            true,
            first.meta.timing,
            first.meta.fastPath,
          )
        },
      })
      identityCacheRef.current = new Map()
      lastIdentityLaneRef.current = null
      setPending(0)
      setQueued(0)
      const runLimited = createLimit(prefs.parallelAsr ? 3 : 1)
      const continuous = prefs.separateSpeakers && separationReadyRef.current
      // The fast path still uses the continuous microphone VAD, but not the
      // continuous separator: raw ASR starts at the endpoint and separation is
      // only invoked if the cheap speaker gate says it may be overlapping.
      const fastPath = continuous && prefs.separationFastPath
      separatorRef.current?.close()
      separatorRef.current = null
      // A declared close window only overrides the user's own pause setting.
      const declaredSpeech = sharedPlayer.declaredSpeechSettings()
      const micSilenceMs = typeof declaredSpeech.micSilenceMs === 'number'
        ? declaredSpeech.micSilenceMs : getPreferences().pauseMs
      const separationSilenceMs = typeof declaredSpeech.separationSilenceMs === 'number'
        ? declaredSpeech.separationSilenceMs : getPreferences().pauseMs
      let separator: ContinuousSeparation | null = null
      if (continuous && !fastPath) {
        separator = new ContinuousSeparation({
          sampleRate: 16_000,
          // A shorter window and step cut the dead time between the last
          // syllable and the moment the segment is handed to recognition.
          windowMs: 3000,
          hopMs: 700,
          // One pause value for both paths: the per-source tail must match the
          // number the user picked, or the custom setting only half applies.
          silenceMs: separationSilenceMs,
          separate: async (window) => {
            const split = await separateSegment(window, sessionId, prefs.speakerThreshold, false, prefs.ownerMargin)
            return {
              sources: split.sources.map((source) => ({
                samples: decodeWaveBase64(source.audioBase64),
                rms: source.rms,
              })),
              timing: {
                queueMs: split.queueMs ?? 0,
                modelMs: split.workerMs ?? split.elapsedMs,
                wallMs: split.wallMs ?? split.elapsedMs,
              },
            }
          },
          onSegment: (segment) => { enqueueContinuous(segment, scheduler, runLimited) },
          onError: (failure) => {
            console.warn('[dsh-voice-dialog] continuous separation failed', failure)
          },
        })
        separatorRef.current = separator
      }
      const mic = new MicrophoneLoop({
        deviceId: getPreferences().deviceId,
        silenceMs: micSilenceMs,
        // 0 = adaptive noise floor; a positive preference pins the gate.
        threshold: getPreferences().micThreshold > 0 ? getPreferences().micThreshold : undefined,
        continuous,
        onFrame: continuous && !fastPath ? (samples) => { separator?.push(samples) } : undefined,
        onLevel: (value) => setLevel(value),
        playbackState: () => sharedPlayer.playbackState(),
        onSpeechStart: (onset) => {
          speechOnsetAt = onset.startedAt
          reportSpeech(sessionId, 'start')
          // Sound alone is not an interruption: the volume ducks, the sentence
          // plays on. Only the host/model decides whether to hold or stop.
          sharedPlayer.unmute()
          if (holdTimer !== null) { clearTimeout(holdTimer); holdTimer = null }
          sharedPlayer.duck()
        },
        onPlaybackStuck: () => {
          // Last-resort only. The host has had a full second of speech:start and
          // still has the mouth open, so stop the feedback loop once.
          if (!sharedPlayer.playbackState().playing) return
          sharedPlayer.cutNow()
        },
        // Legacy continuous path only: overlap the speculative separation
        // with the endpoint wait. The fast path deliberately runs no model.
        onSpeechTail: () => { separator?.prewarm() },
        onSpeechEnd: () => {
          const spokeMs = speechOnsetAt > 0 ? Date.now() - speechOnsetAt : 0
          speechOnsetAt = 0
          reportSpeech(sessionId, 'end')
          sharedPlayer.restore()
          // Only meaningful if a sentence was actually held; a decision that
          // never arrives must not leave the reading stopped.
          sharedPlayer.resumeAfterSpeech(resumeDelayForUtterance(spokeMs))
          const now = Date.now()
          lastUtteranceEndRef.current = now
          lastSpeechEndRef.current = Math.max(0, now - getPreferences().pauseMs)
          // Keep the mixed tail: if only one person is talking, its transcript
          // can stand in for the separated lane and save a whole ASR call.
          const tail = separator?.takeMixedTail()
          if (tail && tail.length > 0) {
            const samples = tail.length
            const timing: UtteranceTiming = {}
            const text = runLimited(async () => {
              const call = await transcribeTimed(audioBase64(encodeWave(tail)))
              timing.asrStartAt = call.startedAt
              timing.asrDoneAt = call.doneAt
              if (call.inferMs !== undefined) timing.asrInferMs = call.inferMs
              return call.text
            })
            mixedTailRef.current = { samples, at: Date.now(), text, timing }
            void text.catch(() => undefined)
          }
          // Do not wait for the next hop: the moment the speaker stops, the
          // trailing window is flushed through separation instead of sitting
          // in the buffer for up to a full step (0.7 s by default).
          void separator?.flush()
            .then(() => { if (separator) reportSeparationPressure(separator) })
            .catch(() => undefined)
        },
        onSegment: fastPath
          ? (samples) => { handleFastSegment(samples, scheduler, runLimited) }
          : continuous ? undefined : (samples) => { handleSegment(samples, scheduler, runLimited) },
        onError: (failure) => {
          setError(failureText(failure))
        },
      })
      await mic.start()
      clearTimeout(startGuard)
      micRef.current = mic
      cancelRetainedStop()
      retainedMic = mic
      retainedSession = sessionId
      sharedPlayer.beginSession(sessionId)
      reportVoiceState(sessionId, true)
      setActive(true)
      setPhase('listening')
    } catch (failure) {
      clearTimeout(startGuard)
      separatorRef.current?.close()
      separatorRef.current = null
      utteranceCoalescerRef.current?.dispose()
      utteranceCoalescerRef.current = null
      schedulerRef.current?.dispose()
      schedulerRef.current = null
      setError(failureText(failure))
      setPhase('idle')
    }
  }

  const toggle = (): void => {
    if (phase === 'starting') return
    if (active) void stop()
    else void start()
  }

  const activity = pending > 0
    ? queued > 0 ? `并行识别 ${pending} 段 · ${queued} 条语音排队` : `正在并行识别（${pending}）…`
    : queued > 0 ? `语音排队（${queued}）…` : ''
  const activeActivity = activity
  const label = error || (active
    ? activeActivity || (speaker ? `正在听…（${speaker}）` : '正在听…点击结束')
    : '语音对话：点一下开始，多人插话按优先级排队，回答自动朗读')

  if (active) return <>
    <style>{MIC_CSS}</style>
    <div className="dsh-vd-captureStack">
      <div className="dsh-vd-captureRow" data-voice-activity={activeActivity ? 'transcribing' : 'recording'}>
        <Button type="button" className="dsh-vd-round" size="sm" aria-label="关闭语音对话"
          title="关闭收音，当前朗读不打断"
          onClick={() => { void stop() }}><IconCloseOutlineRegular size={14} /></Button>
        {activeActivity || error
          ? <span className="dsh-vd-activity" role="status">{error || activeActivity}</span>
          : <LiveWave level={level} />}
        <Button type="button" className="dsh-vd-round" size="sm" aria-label="挂断并停止朗读"
          title="挂断，同时打断当前朗读"
          onClick={() => {
            sharedPlayer.control({ action: 'stop' })
            void stop()
          }}><IconStopFillRegular size={14} /></Button>
      </div>
    </div>
  </>

  return <>
    <style>{MIC_CSS}</style>
    <span className="dsh-vd-row" data-voice-error={error ? 'true' : 'false'}>
      <Tooltip label={label} side="top" portal>
        <span className="dsh-vd-anchor">
          <Button className="dsh-vd-mic" size="sm" disabled={phase === 'starting'}
            aria-label={error ? `语音对话出错：${error}` : '开始语音对话'}
            aria-busy={phase === 'starting'}
            onClick={toggle}>
            <IconMicrophoneOutlineRegular size={18} />
          </Button>
        </span>
      </Tooltip>
      {error && <span className="dsh-vd-inlineError" role="alert">{error}</span>}
    </span>
    {banner && <div className="dsh-vd-banner" role="alert">
      <span className="dsh-vd-bannerText">{banner}</span>
      <button type="button" className="dsh-vd-bannerClose" aria-label="关闭提示"
        onClick={() => { setBanner('') }}><IconCloseOutlineRegular size={14} /></button>
    </div>}
  </>
}

const MIC_CSS = `
.dsh-vd-anchor { position: relative; display: inline-flex; flex: none; }
.dsh-vd-row { display: inline-flex; align-items: center; gap: 6px; }
.dsh-vd-mic { width: 28px; padding: 0; flex: none; }
.dsh-vd-captureStack { display: flex; flex-direction: column; gap: 4px; width: 100%; min-width: 0; }
.dsh-vd-captureRow { display: flex; align-items: center; gap: 12px; width: 100%; min-width: 0; min-height: 34px; }
.dsh-vd-round { width: 32px; height: 32px; padding: 0; border-radius: 50%; flex: none;
  background: var(--dsw-specific-selector); }
.dsh-vd-round:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover-solid); }
.dsh-vd-wave { display: block; flex: 1; width: 0; height: 24px; min-width: 24px;
  color: var(--dsw-alias-label-secondary); }
.dsh-vd-activity { display: flex; align-items: center; flex: 1; min-width: 0; font-size: 12px;
  color: var(--dsw-alias-label-secondary); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
/* A phone has no tooltip: the failure has to occupy real space. */
.dsh-vd-inlineError { max-width: 320px; font-size: 12px; line-height: 1.4; color: var(--dsw-alias-label-error, #d4380d); }
.dsh-vd-banner { position: fixed; left: 8px; right: 8px; bottom: 14px; z-index: 70; display: flex;
  align-items: center; gap: 8px; padding: 10px 12px; border-radius: 10px; font-size: 13px; line-height: 1.45;
  color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-overlay, #1f1f1f);
  border: 1px solid var(--dsw-alias-border-l1); box-shadow: 0 6px 24px rgb(0 0 0 / 35%); }
.dsh-vd-bannerText { flex: 1; min-width: 0; }
.dsh-vd-bannerClose { flex: none; display: inline-flex; align-items: center; justify-content: center;
  width: 32px; height: 32px; border: none; border-radius: 8px; background: transparent;
  color: var(--dsw-alias-label-secondary); cursor: pointer; }
`

interface VoiceSettingsProps {
  ctx: any
}

function VoiceSettings({ ctx }: VoiceSettingsProps) {
  const [prefs, setPrefs] = useState<VoiceDialogPreferences>(getPreferences())
  const [catalog, setCatalog] = useState<any>(null)
  const [host, setHost] = useState<HostConfig | null>(null)
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const [busy, setBusy] = useState(false)
  const [pauseDraft, setPauseDraft] = useState(String(getPreferences().pauseMs))
  // '自定义' is not a stored value, so remember the choice locally; otherwise
  // the select snaps back to the preset the moment the option is picked.
  const [customPause, setCustomPause] = useState(false)
  const [catalogError, setCatalogError] = useState('')
  const [actionError, setActionError] = useState('')
  const [voiceprint, setVoiceprint] = useState<VoiceprintStatus | null>(null)
  const [voiceprintError, setVoiceprintError] = useState('')
  const [voiceprintBusy, setVoiceprintBusy] = useState<'' | 'prepare' | 'record' | 'record-other' | 'forget'>('')
  const [separation, setSeparation] = useState<SeparationStatus | null>(null)
  const [separationError, setSeparationError] = useState('')
  const [separationBusy, setSeparationBusy] = useState(false)
  const [recordingTarget, setRecordingTarget] = useState<'owner' | 'guest' | ''>('')
  const [guestName, setGuestName] = useState('')
  const [speakerBusy, setSpeakerBusy] = useState('')
  const [recording, setRecording] = useState(false)
  const [recordLevel, setRecordLevel] = useState(0)
  const recordAbort = useRef<AbortController | null>(null)

  useEffect(() => subscribePreferences(setPrefs), [])
  useEffect(() => {
    let stopped = false
    const tick = async (): Promise<void> => {
      try {
        const result = await requireSpeech(ctx).catalog()
        if (!stopped) {
          if (result.ok) { setCatalog(result.value); setCatalogError('') }
          else setCatalogError(result.error?.message ?? '语音识别服务未连接')
        }
      } catch (failure) {
        if (!stopped) setCatalogError(failureText(failure))
      }
    }
    void tick()
    const timer = setInterval(() => { void tick() }, 2000)
    return () => { stopped = true; clearInterval(timer) }
  }, [ctx])
  useEffect(() => {
    void loadConfig().then(setHost).catch(() => undefined)
    void navigator.mediaDevices?.enumerateDevices?.()
      .then((all) => setDevices(all.filter((device) => device.kind === 'audioinput')))
      .catch(() => undefined)
  }, [])
  useEffect(() => { void refreshVoiceprint(); void refreshSeparation() }, [])
  useEffect(() => () => { recordAbort.current?.abort() }, [])

  const refreshVoiceprint = async (): Promise<void> => {
    try {
      setVoiceprint(await fetchVoiceprintStatus())
      setVoiceprintError('')
    } catch (failure) {
      setVoiceprintError(failureText(failure))
    }
  }

  const refreshSeparation = async (): Promise<void> => {
    try {
      setSeparation(await fetchSeparationStatus())
      setSeparationError('')
    } catch (failure) {
      setSeparationError(failureText(failure))
    }
  }

  const downloadSeparation = async (): Promise<void> => {
    setSeparationBusy(true)
    setSeparationError('')
    try {
      setSeparation(await prepareSeparation())
    } catch (failure) {
      setSeparationError(failureText(failure))
    } finally {
      setSeparationBusy(false)
    }
  }

  const downloadVoiceprint = async (): Promise<void> => {
    setVoiceprintBusy('prepare')
    setVoiceprintError('')
    try {
      setVoiceprint(await prepareVoiceprint())
    } catch (failure) {
      setVoiceprintError(failureText(failure))
    } finally {
      setVoiceprintBusy('')
    }
  }

  const recordVoice = async (target: 'owner' | 'guest'): Promise<void> => {
    setVoiceprintBusy(target === 'owner' ? 'record' : 'record-other')
    setVoiceprintError('')
    setActionError('')
    setRecording(true)
    setRecordingTarget(target)
    setRecordLevel(0)
    const abort = new AbortController()
    recordAbort.current = abort
    try {
      const samples = await recordVoiceSample({
        seconds: 6.5,
        deviceId: prefs.deviceId,
        onLevel: setRecordLevel,
        signal: abort.signal,
      })
      if (target === 'owner') await enrollVoiceprint(samples)
      else {
        await enrollOtherVoiceprint(samples, guestName)
        setGuestName('')
      }
      setVoiceprint(await fetchVoiceprintStatus())
    } catch (failure) {
      setVoiceprintError(failureText(failure))
    } finally {
      setRecording(false)
      setRecordingTarget('')
      setRecordLevel(0)
      setVoiceprintBusy('')
      recordAbort.current = null
    }
  }

  const recordMyVoice = (): Promise<void> => recordVoice('owner')
  const recordOtherVoice = (): Promise<void> => {
    if (!guestName.trim()) { setVoiceprintError('先给这个人起个名字'); return Promise.resolve() }
    return recordVoice('guest')
  }

  const renameSpeaker = async (profile: VoiceprintProfile): Promise<void> => {
    const name = window.prompt('新的声纹名字', profile.name)?.trim()
    if (!name || name === profile.name) return
    setSpeakerBusy(profile.id)
    setVoiceprintError('')
    try {
      await renameOtherVoiceprint(profile.id, name)
      setVoiceprint(await fetchVoiceprintStatus())
    } catch (failure) {
      setVoiceprintError(failureText(failure))
    } finally {
      setSpeakerBusy('')
    }
  }

  const removeSpeaker = async (profile: VoiceprintProfile): Promise<void> => {
    if (!window.confirm('删除「' + profile.name + '」的声纹？')) return
    setSpeakerBusy(profile.id)
    setVoiceprintError('')
    try {
      await removeOtherVoiceprint(profile.id)
      setVoiceprint(await fetchVoiceprintStatus())
    } catch (failure) {
      setVoiceprintError(failureText(failure))
    } finally {
      setSpeakerBusy('')
    }
  }

  const removeVoiceprint = async (): Promise<void> => {
    setVoiceprintBusy('forget')
    setVoiceprintError('')
    try {
      await forgetVoiceprint()
      await refreshVoiceprint()
    } catch (failure) {
      setVoiceprintError(failureText(failure))
    } finally {
      setVoiceprintBusy('')
    }
  }

  const [voice, setVoice] = useState('')
  const [rate, setRate] = useState(0)
  const rateTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [previewText, setPreviewText] = useState('你好，我是你的语音助手。')
  const [previewing, setPreviewing] = useState(false)
  const previewRef = useRef<HTMLAudioElement | null>(null)
  const previewUrl = useRef('')
  const previewFallback = useRef(false)
  const previewToken = useRef(0)
  useEffect(() => {
    if (!host) return
    setVoice(host.voice)
    setRate(host.rate ?? 0)
  }, [host])
  useEffect(() => () => {
    previewRef.current?.pause()
    previewRef.current = null
    if (previewUrl.current) URL.revokeObjectURL(previewUrl.current)
    previewUrl.current = ''
    previewToken.current++
    if (rateTimer.current) { clearTimeout(rateTimer.current); rateTimer.current = null }
    if (previewFallback.current) window.speechSynthesis?.cancel()
    previewFallback.current = false
  }, [])

  const stopPreview = (): void => {
    previewToken.current++
    previewRef.current?.pause()
    previewRef.current = null
    if (previewUrl.current) URL.revokeObjectURL(previewUrl.current)
    previewUrl.current = ''
    if (previewFallback.current) window.speechSynthesis?.cancel()
    previewFallback.current = false
    setPreviewing(false)
  }

  const speakPreviewFallback = (): boolean => {
    if (typeof speechSynthesis === 'undefined' || typeof SpeechSynthesisUtterance === 'undefined') return false
    const text = previewText.trim()
    if (!text) return false
    const token = ++previewToken.current
    const utterance = new SpeechSynthesisUtterance(text)
    utterance.volume = prefs.volume
    utterance.lang = /[\u3400-\u9fff]/.test(text) ? 'zh-CN' : 'en-US'
    utterance.onend = () => {
      if (token !== previewToken.current) return
      previewFallback.current = false
      setPreviewing(false)
    }
    utterance.onerror = (event) => {
      if (token !== previewToken.current) return
      previewFallback.current = false
      setPreviewing(false)
      if (event.error !== 'interrupted' && event.error !== 'canceled') setActionError('系统语音也无法试听')
    }
    window.speechSynthesis.cancel()
    window.speechSynthesis.resume()
    window.speechSynthesis.speak(utterance)
    previewFallback.current = true
    setPreviewing(true)
    setActionError('Edge TTS 暂时不可达，已改用系统语音试听。')
    return true
  }

  const changeVoice = async (next: string): Promise<void> => {
    setVoice(next)
    setBusy(true); setActionError('')
    try {
      const response = await fetch(apiUrl('/settings'), {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ voice: next }),
      })
      if (!response.ok) throw new Error(`保存音色失败（HTTP ${response.status}）`)
      const saved = await response.json() as { voice?: string }
      setHost((current) => current ? { ...current, voice: saved.voice ?? next } : current)
    } catch (failure) {
      setActionError(failureText(failure))
    } finally { setBusy(false) }
  }

  const persistRate = async (next: number): Promise<void> => {
    try {
      const response = await fetch(apiUrl('/settings'), {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ rate: next }),
      })
      if (!response.ok) throw new Error(`保存语速失败（HTTP ${response.status}）`)
      const saved = await response.json() as { rate?: number }
      setHost((current) => current ? { ...current, rate: saved.rate ?? next } : current)
    } catch (failure) {
      setActionError(failureText(failure))
    }
  }

  const changeRate = (next: number): void => {
    setRate(next)
    if (rateTimer.current) clearTimeout(rateTimer.current)
    rateTimer.current = setTimeout(() => {
      rateTimer.current = null
      void persistRate(next)
    }, 300)
  }

  const playPreview = async (): Promise<void> => {
    if (previewing) { stopPreview(); return }
    setBusy(true); setActionError('')
    try {
      const response = await fetch(apiUrl('/preview'), {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: previewText, voice, rate }),
      })
      if (!response.ok) {
        const detail = await response.json().catch(() => null) as { error?: string } | null
        throw new Error(detail?.error ?? `试听失败（HTTP ${response.status}）`)
      }
      const url = URL.createObjectURL(await response.blob())
      const audio = new Audio(url)
      previewRef.current = audio
      previewUrl.current = url
      audio.onended = () => { stopPreview() }
      audio.onerror = () => { stopPreview() }
      setPreviewing(true)
      await audio.play()
    } catch (failure) {
      stopPreview()
      if (speakPreviewFallback()) return
      setActionError(failureText(failure))
    } finally { setBusy(false) }
  }

  const save = (patch: Partial<VoiceDialogPreferences>): void => { setPreferences(patch); setPrefs(getPreferences()) }
  const commitPause = (raw: string): void => {
    const number = Number(raw)
    if (!Number.isFinite(number)) { setPauseDraft(String(prefs.pauseMs)); return }
    save({ pauseMs: number })
    setPauseDraft(String(getPreferences().pauseMs))
  }
  const invoke = async (action: () => Promise<any>): Promise<void> => {
    setBusy(true); setActionError('')
    try {
      const result = await action()
      if (result && result.ok === false) throw new Error(result.error?.message ?? '操作失败')
    } catch (failure) {
      setActionError(failureText(failure))
    } finally { setBusy(false) }
  }

  const selection = catalog?.selection
  const provider = catalog?.providers?.find((item: any) => item.id === selection?.providerId)
  const phase = provider?.preparation?.phase ?? 'unknown'
  const preparing = ['checking', 'downloading', 'loading', 'waking', 'cancelling'].includes(phase)
  const canPrepare = ['unprepared', 'failed', 'cancelled'].includes(phase)
  const downloading = provider?.preparation?.phase === 'downloading' ? provider.preparation : null
  const progress = downloading && downloading.totalBytes
    ? `${(downloading.completedBytes / 1_000_000).toFixed(1)} / ${(downloading.totalBytes / 1_000_000).toFixed(1)} MB`
    : ''

  return <div className="dsh-vd-settings">
    <style>{SETTINGS_CSS}</style>
    <h2>语音对话</h2>
    <p className="dsh-vd-muted">一个麦克风完成连续对话：停顿后自动识别，我说话默认等当前回答说完，其他人按优先级排队；助手回复自动朗读。设置只保存在这个浏览器。</p>

    <section>
      <h3>朗读</h3>
      <label className="dsh-vd-check"><input type="checkbox" checked={prefs.autoRead}
        onChange={(event) => { save({ autoRead: event.target.checked }) }} />自动朗读助手回复</label>
      <label>朗读音量<input type="range" min="0" max="1" step="0.05" value={prefs.volume}
        onChange={(event) => { save({ volume: Number(event.target.value) }) }} /><span>{Math.round(prefs.volume * 100)}%</span></label>
      <label>响度<input type="range" min="1" max="2.5" step="0.1" value={prefs.speechBoost}
        onChange={(event) => { save({ speechBoost: Number(event.target.value) }) }} /><span>{prefs.speechBoost.toFixed(1)}×</span></label>
      <label>说话时压低到<input type="range" min="0.8" max="1" step="0.02" value={prefs.duckLevel}
        onChange={(event) => { save({ duckLevel: Number(event.target.value) }) }} /><span>{Math.round(prefs.duckLevel * 100)}%</span></label>
      <label>语速<input type="range" min="-50" max="50" step="5" value={rate} disabled={!host}
        onChange={(event) => { changeRate(Number(event.target.value)) }} /><span>{rate > 0 ? '+' : ''}{rate}%</span></label>
      <label>朗读音色<select value={voice} disabled={busy || !host}
        onChange={(event) => { void changeVoice(event.target.value) }}>
        {VOICES.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        {voice && !VOICES.some(([id]) => id === voice) && <option value={voice}>{voice}</option>}
      </select></label>
      <div className="dsh-vd-preview">
        <input aria-label="试听文本" value={previewText} onChange={(event) => { setPreviewText(event.target.value) }} />
        <button type="button" className="dsh-vd-button" disabled={busy || !previewText.trim()}
          onClick={() => { void playPreview() }}>{previewing ? '停止试听' : busy ? '合成中…' : '试听'}</button>
      </div>
      {actionError && <p className="dsh-vd-error" role="alert">{actionError}</p>}
      <p className="dsh-vd-muted">说话只会压低朗读，不会切断回答；我默认排队，其他人也默认排队，等这一轮说完再交给模型。</p>
      {host && <p className="dsh-vd-muted">音色和语速保存在本机（重启后仍生效），朗读偏好保存在这个浏览器。</p>}
    </section>

    <section>
      <h3>语音识别</h3>
      <label>停顿多久算说完
        <select
          value={customPause || !PAUSE_PRESETS.some(([ms]) => ms === prefs.pauseMs) ? 'custom' : String(prefs.pauseMs)}
          disabled={busy}
          onChange={(event) => {
            if (event.target.value === 'custom') { setCustomPause(true); return }
            setCustomPause(false)
            commitPause(event.target.value)
          }}>
          {PAUSE_PRESETS.map(([ms, text]) => <option key={ms} value={String(ms)}>{text}</option>)}
          <option value="custom">自定义…</option>
        </select>
      </label>
      {(customPause || !PAUSE_PRESETS.some(([ms]) => ms === prefs.pauseMs)) && <label>自定义毫秒数
        <input type="number" min={400} max={4000} step={50} value={pauseDraft} disabled={busy}
          aria-label="自定义停顿毫秒"
          onChange={(event) => setPauseDraft(event.target.value)}
          onBlur={(event) => commitPause(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter') commitPause((event.target as HTMLInputElement).value) }} />
      </label>}
      {selection && <label>识别服务<select value={selection.providerId} disabled={busy}
        onChange={(event) => { void invoke(() => requireSpeech(ctx).configure({ providerId: event.target.value })) }}>
        {catalog.providers.map((item: any) => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select></label>}
      {selection && provider && <label>语言<select value={selection.language} disabled={busy}
        onChange={(event) => { void invoke(() => requireSpeech(ctx).configure({ language: event.target.value })) }}>
        {provider.languages.map((language: string) => <option key={language} value={language}>{language}</option>)}
      </select></label>}
      {provider && <p>状态：{phaseLabel(phase)}{progress ? ` · ${progress}` : ''}</p>}
      {provider?.preparation?.phase === 'failed' && <p className="dsh-vd-error">{provider.preparation.message}</p>}
      {canPrepare && <button type="button" className="dsh-vd-button" disabled={busy}
        onClick={() => { void invoke(() => requireSpeech(ctx).prepare(provider.id)) }}>准备语音模型</button>}
      {preparing && phase !== 'waking' && <button type="button" className="dsh-vd-button" disabled={busy}
        onClick={() => { void invoke(() => requireSpeech(ctx).cancelPreparation(provider.id)) }}>取消准备</button>}
      {!catalog && !catalogError && <p className="dsh-vd-muted">正在连接语音识别…</p>}
      {catalogError && <p className="dsh-vd-error" role="alert">{catalogError}</p>}
    </section>

    <section>
      <h3>声纹</h3>
      <p className="dsh-vd-muted">给每段语音标出说话人，模型就不会把不同的人当成同一个人。声纹只保存在本机，录音不会上传到外部服务。</p>
      <label className="dsh-vd-check"><input type="checkbox" checked={prefs.speakerPrefix}
        onChange={(event) => { save({ speakerPrefix: event.target.checked }) }} />给语音输入加声纹前缀（我 / 客人）</label>
      <label className="dsh-vd-check"><input type="checkbox" checked={prefs.speakerGate}
        onChange={(event) => { save({ speakerGate: event.target.checked }) }} />只回应我的声音</label>
      <label>认定阈值<input type="range" min={SPEAKER_THRESHOLD_MIN} max={SPEAKER_THRESHOLD_MAX} step="0.01" value={prefs.speakerThreshold}
        onChange={(event) => { save({ speakerThreshold: Number(event.target.value) }) }} /><span>{prefs.speakerThreshold.toFixed(2)}</span></label><label>声纹抢占余量<input type="range" min="0.04" max="0.3" step="0.01" value={prefs.ownerMargin}
onChange={(event) => { save({ ownerMargin: Number(event.target.value) }) }} /><span>{prefs.ownerMargin.toFixed(2)}</span></label>
      <p className="dsh-vd-muted">阈值越高越严格；别人被当成你的概率更低，但你自己也可能被忽略。建议从 0.5 开始。你的声纹默认优先，低于阈值仍会先认作你。</p>
      {voiceprint === null && !voiceprintError && <p className="dsh-vd-muted">正在检查声纹模型…</p>}
      {voiceprint && <div className="dsh-vd-vpStatus">
        <span>{voiceprint.ready ? '声纹模型已就绪' : voiceprint.modelPresent ? '缺少声纹组件' : '声纹模型未安装'}</span>
        <span>{voiceprint.enrolled ? '已登记我的声纹' : '尚未登记我的声纹'}</span>
        <span>已登记其他人 {voiceprint.speakerCount ?? 0} 个</span>
        {voiceprint.modelBytes > 0 && <span>{(voiceprint.modelBytes / 1_000_000).toFixed(1)} MB</span>}
      </div>}
      {voiceprint && !voiceprint.addonAvailable && <p className="dsh-vd-error">缺少本地声纹组件：在 profile 目录执行 pnpm add sherpa-onnx-node，然后重启 DSH。</p>}
      {voiceprint && !voiceprint.modelPresent && voiceprint.addonAvailable && <button type="button" className="dsh-vd-button"
        disabled={voiceprintBusy !== ''} onClick={() => { void downloadVoiceprint() }}>
        {voiceprintBusy === 'prepare' ? '下载中…' : '下载声纹模型（约 27MB）'}
      </button>}
      <div className="dsh-vd-preview">
        <button type="button" className="dsh-vd-button" disabled={voiceprintBusy !== '' || recording || !voiceprint?.ready}
          onClick={() => { void recordMyVoice() }}>
          {recording && recordingTarget === 'owner' ? '录音中…' : voiceprint?.enrolled ? '重新录制我的声纹' : '录制我的声纹'}
        </button>
        {voiceprint?.enrolled && <button type="button" className="dsh-vd-button" disabled={voiceprintBusy !== '' || recording}
          onClick={() => { void removeVoiceprint() }}>{voiceprintBusy === 'forget' ? '删除中…' : '删除我的声纹'}</button>}
      </div>
      <div className="dsh-vd-speakers">
        <h4>其他人</h4>
        <p className="dsh-vd-muted">录入后会用名字代替“客人1”，刷新页面、重启服务都还在。模型也能在对话里直接叫这个名字。</p>
        {voiceprint && (voiceprint.speakers ?? []).length === 0 && <p className="dsh-vd-muted">还没有录入其他人。</p>}
        {(voiceprint?.speakers ?? []).map((profile) => <div key={profile.id} className="dsh-vd-speakerRow">
          <span>{profile.name}</span>
          <button type="button" className="dsh-vd-button" disabled={speakerBusy !== '' || recording}
            onClick={() => { void renameSpeaker(profile) }}>{speakerBusy === profile.id ? '处理中…' : '重命名'}</button>
          <button type="button" className="dsh-vd-button" disabled={speakerBusy !== '' || recording}
            onClick={() => { void removeSpeaker(profile) }}>删除</button>
        </div>)}
        <div className="dsh-vd-preview">
          <input value={guestName} maxLength={12} placeholder="这个人的名字，例如 老婆"
            onChange={(event) => { setGuestName(event.target.value) }} />
          <button type="button" className="dsh-vd-button" disabled={voiceprintBusy !== '' || recording || !guestName.trim() || !voiceprint?.ready}
            onClick={() => { void recordOtherVoice() }}>
            {recording && recordingTarget === 'guest' ? '录音中…' : '录制这个人的声纹'}
          </button>
        </div>
      </div>
      {recording && <>
        <div className="dsh-vd-recordBar"><span style={{ width: `${Math.max(4, Math.round(recordLevel * 100))}%` }} /></div>
        <p className="dsh-vd-muted">{recordingTarget === 'guest'
          ? '请让这个人用平常音量说一句话，录音六秒后自动保存。'
          : '请用平常音量说一句话，例如：今天天气不错，我在和你说话。录音六秒后自动保存。'}</p>
      </>}
      {voiceprintError && <p className="dsh-vd-error" role="alert">{voiceprintError}</p>}
      <p className="dsh-vd-muted">带「客人」前缀的是其他人；只有登记过我的声纹，才能启用「只回应我的声音」。每次判定是你的声音，会用它慢慢强化声纹；其他人的声音不会写进去。</p>
    </section>

    <section>
      <h3>同时说话分离</h3>
      <p className="dsh-vd-muted">一个麦克风里两个人同时开口时，本地模型会把声音分成两路，再分别识别、分别标声纹。单人说话会自动走原来的识别路径，不会重复排队。</p>
      <label className="dsh-vd-check"><input type="checkbox" checked={prefs.separateSpeakers}
        onChange={(event) => { save({ separateSpeakers: event.target.checked }) }} />自动分离同时开口的声音</label>
      {separation === null && !separationError && <p className="dsh-vd-muted">正在检查分离模型…</p>}
      {separation && <div className="dsh-vd-vpStatus">
        <span>{separation.ready ? '分离模型已就绪' : separation.modelPresent ? '缺少分离组件' : '分离模型未安装'}</span>
        {separation.backend && <span>{separation.backend === 'dml' ? '显卡加速' : '处理器'}</span>}
        {separation.modelBytes > 0 && <span>{(separation.modelBytes / 1_000_000).toFixed(1)} MB</span>}
      </div>}
      {separation && !separation.addonAvailable && <p className="dsh-vd-error">缺少本地分离组件：在 profile 目录执行 pnpm add onnxruntime-node，然后重启 DSH。</p>}
      {separation && !separation.modelPresent && separation.addonAvailable && <button type="button" className="dsh-vd-button"
        disabled={separationBusy} onClick={() => { void downloadSeparation() }}>
        {separationBusy ? '下载中…' : '下载分离模型（约 234MB）'}
      </button>}
      {separation && separation.modelPresent && !separation.ready && <p className="dsh-vd-muted">模型已存在，但本地推理组件还没加载成功。</p>}
      {separationError && <p className="dsh-vd-error" role="alert">{separationError}</p>}
      <p className="dsh-vd-muted">开关在重新开始语音后生效。模型只支持两个人同时说；三个人以上仍可能混在一路里。</p>
    </section>

    <section>
      <h3>多人插话</h3>
      <p className="dsh-vd-muted">主人优先，默认不抢当前回答。所有语音按说话先后排一条队列，后来的话不会因为识别更快就超车。</p>
      <label>我说话时<select value={prefs.ownerMode} disabled={busy}
        onChange={(event) => { save({ ownerMode: event.target.value as VoiceDialogPreferences['ownerMode'] }) }}>
        <option value="queue">等当前回答说完（默认）</option>
        <option value="steer">立即插话，打断当前回答</option>
      </select></label>
      <label>其他人插话<select value={prefs.guestMode} disabled={busy}
        onChange={(event) => { save({ guestMode: event.target.value as VoiceDialogPreferences['guestMode'] }) }}>
        <option value="queue">排队，等当前回答说完</option>
        <option value="steer">直接插话，立即交给模型</option>
        <option value="ignore">忽略，不交给模型</option>
      </select></label>
      <label className="dsh-vd-check"><input type="checkbox" checked={prefs.parallelAsr}
        onChange={(event) => { save({ parallelAsr: event.target.checked }) }} />并行识别多段语音（最多三路）</label>
      <label className="dsh-vd-check"><input type="checkbox" checked={prefs.organizerEnabled}
        onChange={(event) => { save({ organizerEnabled: event.target.checked }) }} />并行组织层（由模型判断打断、排队或忽略）</label>
      <p className="dsh-vd-muted">先后接话的多个人可以同时识别，互不阻塞。同一个瞬间两个人同时开口时，上面的本地分离会把它拆成两路再排队；三个人以上仍可能混在一起。</p>
      <p className="dsh-vd-muted">并行组织层只处理我自己的新话：回答还在朗读时，让模型判断是立刻打断、继续排队，还是当作噪音忽略。判断超时或失败时按排队处理；明确说“打断”仍然优先。</p>
      <p className="dsh-vd-muted">最新一句说“打断 / 停一下”，会立刻停朗读并清掉还没送出的队列；说“忽略客人1 / 别理老婆”，会当场改策略并删掉那个人排队的句子；说“恢复”重新排队。</p>
      <p className="dsh-vd-muted">模型也能按声纹临时调整：如果某个客人总在插无关的话，可以让模型忽略他；也可以让模型给声纹起名，比如“这个是我老婆”，之后就用老婆称呼。主人不会被忽略。这些调整只在当前会话内存里生效，刷新页面就恢复默认。</p>
      <p className="dsh-vd-muted">没登记我的声纹时无法区分主人和客人，所有语音都按主人处理。</p>
    </section>

    <section>
      <h3>麦克风</h3>
      <label>输入设备<select value={prefs.deviceId} onChange={(event) => { save({ deviceId: event.target.value }) }}>
        <option value="">系统默认</option>
        {devices.map((device, index) => <option key={device.deviceId || index} value={device.deviceId}>
          {device.label || `麦克风 ${index + 1}`}
        </option>)}
      </select></label>
      <label>触发门槛<select value={prefs.micThreshold === 0 ? 'auto' : 'manual'}
        onChange={(event) => { save({ micThreshold: event.target.value === 'auto' ? 0 : 0.03 }) }}>
        <option value="auto">自动跟随环境</option>
        <option value="manual">手动固定</option>
      </select></label>
      {prefs.micThreshold > 0 && <label>门槛数值
        <input type="range" min="0.004" max="0.08" step="0.001" value={prefs.micThreshold}
          onChange={(event) => { save({ micThreshold: Number(event.target.value) }) }} />
        <span>{prefs.micThreshold.toFixed(3)}</span></label>}
      <p className="dsh-vd-muted">默认自动跟着环境噪音走；数值可手动固定，越小越容易触发。重新开始语音后生效。</p>
      <p className="dsh-vd-muted">首次使用需要允许浏览器访问麦克风；手机浏览器必须通过 HTTPS 或 localhost 访问。</p>
    </section>
  </div>
}

function phaseLabel(phase: string): string {
  switch (phase) {
    case 'ready': return '已就绪'
    case 'standby': return '待机'
    case 'waking': return '正在唤醒'
    case 'unprepared': return '未准备'
    case 'downloading': return '下载中'
    case 'checking': return '检查中'
    case 'loading': return '加载中'
    case 'cancelling': return '取消中'
    case 'failed': return '失败'
    case 'cancelled': return '已取消'
    default: return phase
  }
}

const SETTINGS_CSS = `
.dsh-vd-pauseRow { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.dsh-vd-pauseRow input { width: 96px; }
.dsh-vd-settings { display: flex; flex-direction: column; gap: 18px; max-width: 640px; padding: 4px 2px 24px; font-size: 13px; line-height: 1.6; color-scheme: light dark; }
.dsh-vd-settings h2 { margin: 0; font-size: 18px; }
.dsh-vd-settings h3 { margin: 0 0 10px; font-size: 14px; }
.dsh-vd-settings section { display: flex; flex-direction: column; gap: 10px; padding: 14px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; }
.dsh-vd-settings p { margin: 0; }
.dsh-vd-muted { color: var(--dsw-alias-label-secondary); }
.dsh-vd-error { color: var(--dsw-alias-state-error-primary); overflow-wrap: anywhere; }
.dsh-vd-settings label { display: flex; align-items: center; gap: 10px; }
.dsh-vd-settings label > input[type='range'] { flex: 1; min-width: 120px; accent-color: var(--dsw-alias-state-business-primary); }
.dsh-vd-settings label > span { width: 40px; text-align: right; color: var(--dsw-alias-label-tertiary); }
/* Native option popups ignore color: inherit; paint them with the theme surface. */
.dsh-vd-settings select { min-width: 180px; max-width: 100%; border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; padding: 6px 10px; background-color: var(--dsw-specific-selector); color: var(--dsw-alias-label-primary); font: inherit; }
.dsh-vd-settings select option { background-color: var(--dsw-specific-selector); color: var(--dsw-alias-label-primary); }
.dsh-vd-check { justify-content: flex-start; }
.dsh-vd-check input { accent-color: var(--dsw-alias-state-business-primary); }
.dsh-vd-preview { display: flex; align-items: center; gap: 8px; }
.dsh-vd-preview input { flex: 1; min-width: 0; border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; padding: 6px 10px; background-color: var(--dsw-specific-selector); color: var(--dsw-alias-label-primary); font: inherit; }
.dsh-vd-preview .dsh-vd-button { align-self: auto; white-space: nowrap; }
.dsh-vd-button { align-self: flex-start; border: 1px solid var(--dsw-alias-border-l1); border-radius: 7px; padding: 6px 12px; background: transparent; color: inherit; font: inherit; cursor: pointer; }
.dsh-vd-button:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.dsh-vd-button:disabled { opacity: .5; cursor: default; }
.dsh-vd-vpStatus { display: flex; flex-wrap: wrap; gap: 6px 14px; color: var(--dsw-alias-label-secondary); }
.dsh-vd-speakers { display: flex; flex-direction: column; gap: 8px; padding-top: 4px; border-top: 1px solid var(--dsw-alias-border-l1); }
.dsh-vd-speakers h4 { margin: 4px 0 0; font-size: 13px; }
.dsh-vd-speakerRow { display: flex; align-items: center; gap: 8px; }
.dsh-vd-speakerRow > span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-vd-speakers .dsh-vd-button { padding: 4px 9px; }
.dsh-vd-recordBar { height: 6px; overflow: hidden; border-radius: 3px; background: var(--dsw-alias-interactive-bg-hover); }
.dsh-vd-recordBar span { display: block; height: 100%; border-radius: 3px; background: var(--dsw-alias-state-business-primary); transition: width .08s linear; }
/* Phone: one column, full-width controls, 40px touch targets, nothing hidden
   behind hover — the same form must be usable inside the sheet at 390px. */
`
