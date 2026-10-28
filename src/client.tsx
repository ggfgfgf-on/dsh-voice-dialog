/** dsh-voice-dialog client half: one microphone, continuous ASR steering, auto-read. */
import * as React from 'react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  Button, IconCloseOutlineRegular, IconMicrophoneOutlineRegular, IconStopFillRegular, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import speechRemote from './speech-remote.js'
import { MicrophoneLoop, recordVoiceSample } from './mic.ts'
import { ContinuousSeparation, dedupeTranscript, type ContinuousSegment } from './continuous-separation.ts'
import { getPreferences, setPreferences, subscribePreferences, type VoiceDialogPreferences } from './preferences.ts'
import { SpeechScheduler, type GuestMode } from './scheduler.ts'
import { SpeechOrganizer, type OrganizerRequest } from './organizer.ts'
import { parseQueueControl } from './queue-control.ts'
import { SpeakerPolicyStore } from './speaker-policy.ts'
import { audioBase64, decodeWaveBase64, encodeWave } from './wav.ts'

export const inject = ['remote']

const BOOTSTRAP_BASE = '/dsh-voice-dialog-api'
const BUNDLE_ID = 'dsh-voice-dialog'

interface VoiceFrame {
  sessionId: string
  seq: number
  replyId?: string
  text: string
  audio: string
  error?: string
}

interface VoiceControl {
  action: 'volume' | 'rate' | 'stop' | 'repeat' | 'speaker'
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
  sources: SeparatedSource[]
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
  const body = JSON.stringify({ sessionId, active })
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

async function separateSegment(
  samples: Float32Array, sessionId: string, threshold: number, identify = true,
): Promise<SeparationResult> {
  const response = await fetch(apiUrl('/separation/separate'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      audioBase64: audioBase64(encodeWave(samples)),
      sessionId,
      threshold,
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
  samples: Float32Array, sessionId: string, threshold: number,
): Promise<SpeakerIdentity> {
  const response = await fetch(apiUrl('/voiceprint/identify'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      audioBase64: audioBase64(encodeWave(samples)),
      sessionId,
      threshold,
    }),
  })
  if (!response.ok) throw await errorFrom(response, '声纹识别失败')
  return await response.json() as SpeakerIdentity
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
 * Page-level player. A barge-in only ducks this gain: playback is never
 * cancelled by the user speaking, so the assistant can finish its thought
 * while the transcript is steered into the running model.
 */
class TtsPlayer {
  private readonly audio = new Audio()
  private context: AudioContext | undefined
  private gain: GainNode | undefined
  private source: MediaElementAudioSourceNode | undefined
  private readonly queue: VoiceFrame[] = []
  private prefs: VoiceDialogPreferences = getPreferences()
  private url: string | undefined
  private playing = false
  private ducked = false
  private blocked = false
  private active = false
  private muted = false
  private cutting = false
  private afterCut: VoiceFrame[] = []
  private cutReplyId: string | undefined
  private cutToken = 0
  private currentFrame: VoiceFrame | undefined
  private sessionId: string | undefined
  private volumeOverride: number | undefined
  private lastReplyId: string | undefined
  private lastTexts: string[] = []
  private lastFrames: VoiceFrame[] = []
  private readonly unsubscribe = subscribePreferences((value) => {
    this.prefs = value
    if (!value.autoRead) this.clear()
    else this.applyGain()
  })

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
    this.sessionId = sessionId
    this.active = true
    this.muted = false
    void this.enable()
  }

  /** A new user utterance ends a previous "stop talking" mute. */
  unmute(): void { this.muted = false }

  /** Stop accepting new sentences; already queued audio keeps playing. */
  endSession(): void {
    this.active = false
  }

  /** True while a reply is audible or waiting to be read. */
  busy(): boolean {
    return this.active && (this.playing || this.queue.length > 0 || this.cutting)
  }

  /**
   * Organizer-driven cut: fade the current sentence, drop unread old frames,
   * then let frames that arrived during the fade start the new answer.
   */
  cut(expectedVersion: number, isCurrent: (version: number) => boolean): boolean {
    if (!this.active || this.muted || !this.sessionId) return false
    if (!isCurrent(expectedVersion)) return false
    if (!this.playing && this.queue.length === 0) return false
    const token = ++this.cutToken
    this.cutting = true
    this.cutReplyId = this.currentFrame?.replyId
    const context = this.context
    const gain = this.gain
    if (gain && context) {
      try {
        gain.gain.cancelScheduledValues(context.currentTime)
        gain.gain.setValueAtTime(gain.gain.value, context.currentTime)
        gain.gain.linearRampToValueAtTime(0, context.currentTime + 0.25)
      } catch {
        // A closed context must not block the cut.
      }
    }
    setTimeout(() => {
      if (token !== this.cutToken) return
      if (!this.active || !isCurrent(expectedVersion)) {
        const pending = this.afterCut
        this.afterCut = []
        this.cutting = false
        this.applyGain()
        if (this.active) for (const frame of pending) this.enqueue(frame)
        return
      }
      this.queue.length = 0
      this.audio.pause()
      this.audio.onended = null
      this.audio.onerror = null
      this.cleanupUrl()
      try { window.speechSynthesis?.cancel() } catch { /* unsupported */ }
      this.playing = false
      this.ducked = false
      this.blocked = false
      this.cutting = false
      const pending = this.afterCut
      this.afterCut = []
      this.applyGain()
      for (const frame of pending) this.enqueue(frame)
    }, 260)
    return true
  }

  /** Apply a control broadcast from the model-facing voice_dialog tool. */
  control(control: VoiceControl): void {
    if (control.action === 'stop') { this.stopAll(); return }
    if (control.action === 'repeat') { this.repeatLast(); return }
    if (control.action === 'volume') {
      const base = this.currentVolume()
      const next = typeof control.level === 'number' ? control.level : base + (control.delta ?? 0)
      this.volumeOverride = Math.max(0, Math.min(1, next))
      this.applyGain()
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
    if (frame.audio.length > 0 && !frame.error) this.lastFrames.push(frame)
    if (this.lastTexts.length > 80) this.lastTexts.shift()
    if (this.lastFrames.length > 80) this.lastFrames.shift()
  }

  private currentVolume(): number {
    return Math.max(0, Math.min(1, this.volumeOverride ?? this.prefs.volume))
  }

  private halt(): void {
    this.queue.length = 0
    this.afterCut = []
    this.cutting = false
    this.cutToken += 1
    this.cutReplyId = undefined
    this.audio.pause()
    this.cleanupUrl()
    try { window.speechSynthesis?.cancel() } catch { /* unsupported */ }
    this.playing = false
    this.ducked = false
    this.blocked = false
  }

  private stopAll(): void {
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
    this.ducked = true
    this.applyGain()
    // The system-voice fallback has no Web Audio gain; pause it softly instead.
    try { window.speechSynthesis?.pause() } catch { /* unsupported */ }
  }

  restore(): void {
    this.ducked = false
    this.applyGain()
    try { window.speechSynthesis?.resume() } catch { /* unsupported */ }
  }

  /** Read one sentence with the platform voice when Edge TTS is unavailable. */
  speakFallback(text: string, frame?: VoiceFrame): void {
    if (!this.active || this.muted || !this.prefs.autoRead || !text.trim() || typeof SpeechSynthesisUtterance === 'undefined') return
    if (frame) this.note(frame)
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
    if (!this.active || this.muted || !this.prefs.autoRead) return
    // A second tab can share the same SSE broadcast; only the session whose
    // microphone is open may speak.
    if (this.sessionId !== undefined && frame.sessionId !== this.sessionId) return
    this.note(frame)
    if (this.cutReplyId !== undefined && frame.replyId !== this.cutReplyId) this.cutReplyId = undefined
    if (this.cutReplyId !== undefined && frame.replyId === this.cutReplyId) return
    if (this.cutting) { this.afterCut.push(frame); return }
    this.queue.push(frame)
    if (!this.playing) this.playNext()
  }

  private clear(): void {
    this.queue.length = 0
    this.afterCut = []
    this.cutting = false
    this.cutToken += 1
    this.cutReplyId = undefined
    this.audio.pause()
    try { window.speechSynthesis?.cancel() } catch { /* unsupported */ }
    this.cleanupUrl()
    this.playing = false
    this.ducked = false
    this.blocked = false
    this.lastTexts = []
    this.lastFrames = []
    this.lastReplyId = undefined
  }

  private ensureContext(): void {
    if (this.context) return
    const Ctor = window.AudioContext
    if (!Ctor) return
    this.context = new Ctor()
    this.source = this.context.createMediaElementSource(this.audio)
    this.gain = this.context.createGain()
    this.source.connect(this.gain)
    this.gain.connect(this.context.destination)
    this.applyGain()
  }

  private applyGain(): void {
    if (!this.gain || !this.context) return
    const target = this.currentVolume() * (this.ducked ? this.prefs.duckLevel : 1)
    this.gain.gain.setTargetAtTime(target, this.context.currentTime, 0.08)
  }

  private playNext(): void {
    const frame = this.queue.shift()
    if (!frame) {
      this.playing = false
      return
    }
    this.ensureContext()
    this.cleanupUrl()
    this.currentFrame = frame
    this.url = base64ToAudioUrl(frame.audio)
    this.audio.src = this.url
    this.playing = true
    this.audio.onended = () => { this.cleanupUrl(); this.playNext() }
    this.audio.onerror = () => { this.cleanupUrl(); this.playNext() }
    void this.audio.play().catch(() => {
      // Autoplay was blocked: keep the frame so the first gesture can replay it.
      this.queue.unshift(frame)
      this.playing = false
      this.blocked = true
    })
  }

  private cleanupUrl(): void {
    if (this.url) URL.revokeObjectURL(this.url)
    this.url = undefined
  }
}

const sharedPlayer = new TtsPlayer()

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

function openSettings(ctx: any): void {
  try { ctx.pluginNavigation.openBundle(BUNDLE_ID) } catch (error) {
    console.warn('[dsh-voice-dialog] cannot open bundle settings', error)
  }
}

export async function apply(ctx: any): Promise<() => Promise<void>> {
  // Mount the speech Remote contribution here instead of relying on the
  // built-in voice-input client plugin to mount it for us. The contribution
  // must be mounted before a nested inject can wait for remote.speech.
  const disposeRemote = await ctx.remote.$mount(speechRemote)
  const ui = ctx.inject(['remote.speech', 'slots', 'sessions', 'pluginNavigation'], (scope: any) => {
    scope.slots.inject('conversation.input.activity', () =>
      scope.slots.register({
        name: 'conversation.input.activity',
        // Shadow the official one-shot mic at the same seat. Only one
        // microphone remains: no toolbar button and no floating panel.
        priority: -100,
        inject: () => ({ ctx: scope }),
      }, VoiceMic),
    )
    scope.slots.inject('plugins.bundle.config', () =>
      scope.slots.register({
        name: 'plugins.bundle.config',
        key: BUNDLE_ID,
        inject: () => ({ ctx: scope }),
      }, VoiceSettings),
    )
  })
  try { await ui } catch (error) { await ui.dispose(); await disposeRemote(); throw error }
  return async () => { await ui.dispose(); await disposeRemote() }
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
  const micRef = useRef<MicrophoneLoop | null>(null)
  const schedulerRef = useRef<SpeechScheduler | null>(null)
  const classifyRef = useRef<Promise<void>>(Promise.resolve())
  const separationReadyRef = useRef(false)
  const separationRetryAtRef = useRef(0)
  const separatorRef = useRef<ContinuousSeparation | null>(null)
  const organizerRef = useRef<SpeechOrganizer | null>(null)
  const lastLaneTextRef = useRef<Map<string, string>>(new Map())
  useAutoRead(sessionId)
  useLayoutEffect(() => {
    onActiveChange?.(active)
    return () => { onActiveChange?.(false) }
  }, [active, onActiveChange])

  useEffect(() => {
    if (!active) return
    reportVoiceState(sessionId, true)
    const heartbeat = setInterval(() => { reportVoiceState(sessionId, true) }, 45_000)
    return () => { clearInterval(heartbeat) }
  }, [active, sessionId])

  useEffect(() => {
    const onPageHide = (): void => { reportVoiceState(sessionId, false, true) }
    window.addEventListener('pagehide', onPageHide)
    return () => { window.removeEventListener('pagehide', onPageHide) }
  }, [sessionId])

  const flushSeparator = async (): Promise<void> => {
    const separator = separatorRef.current
    separatorRef.current = null
    if (!separator) return
    try {
      await separator.flush()
      // Let the voiceprint/ASR chain enqueue the final lanes before dispose().
      await classifyRef.current
    } catch (failure) {
      console.warn('[dsh-voice-dialog] continuous flush failed', failure)
    } finally {
      separator.close()
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

  const transcribeAudio = async (audioBase64Value: string): Promise<string> => {
    const catalog = await ctx.remote.speech.catalog()
    if (!catalog.ok) throw new Error(catalog.error?.message ?? '语音识别服务不可用')
    const provider = catalog.value.providers.find((item: any) => item.id === catalog.value.selection.providerId)
    if (!provider || !['ready', 'standby', 'waking'].includes(provider.preparation.phase)) {
      throw new Error('语音模型未就绪，请在插件设置中准备')
    }
    const result = await ctx.remote.speech.transcribe({
      audioBase64: audioBase64Value,
      ...catalog.value.selection,
    }, new AbortController().signal)
    if (!result.ok) throw new Error(result.error?.message ?? '识别失败')
    return String(result.value?.text ?? '').trim()
  }

  const transcribeSamples = (samples: Float32Array): Promise<string> =>
    transcribeAudio(audioBase64(encodeWave(samples)))

  /**
   * Queue immediately, but when an assistant reply is active let the parallel
   * organizer decide whether this owner line should steer, queue, or vanish.
   * The entry keeps its FIFO position; only its delivery mode can change.
   */
  const enqueueWithOrganizer = (
    lane: 'owner' | 'guest',
    canonical: string,
    work: Promise<string | null>,
    scheduler: SpeechScheduler,
  ): void => {
    const prefs = getPreferences()
    if (!prefs.organizerEnabled || lane !== 'owner') {
      scheduler.enqueue(lane, canonical, work)
      return
    }
    let organizer = organizerRef.current
    if (!organizer) {
      organizer = new SpeechOrganizer((request, signal) => organizeSpeech(request, signal), { timeoutMs: 1300 })
      organizerRef.current = organizer
    }
    let release!: () => void
    const hold = new Promise<void>((resolve) => { release = resolve })
    let settled = false
    let safety: ReturnType<typeof setTimeout> | null = null
    const finish = (): void => {
      if (settled) return
      settled = true
      if (safety !== null) clearTimeout(safety)
      release()
    }
    const entry = scheduler.enqueue(lane, canonical, work, { hold })
    // A hung ASR call must not wedge the FIFO head forever.
    safety = setTimeout(finish, 5000)
    void work.then(async (text) => {
      if (!text) return
      // An explicit "打断" / stop wins over any model decision.
      if (organizerRef.current !== organizer) return
      if (parseQueueControl(text)) return
      if (!sharedPlayer.busy() && scheduler.status().queued <= 1) return
      const spoken = text.replace(/^\s*\[声纹：[^\]]*\]\s*/u, '')
      const plan = await organizer!.plan({
        sessionId,
        text: spoken,
        lane,
        playing: sharedPlayer.busy(),
        queued: Math.max(0, scheduler.status().queued - 1),
      })
      if (settled || !plan || !organizer!.isCurrent(plan)) return
      if (plan.action === 'interrupt') {
        entry.setMode('steer')
        sharedPlayer.cut(plan.version, (version) => organizer!.isCurrent(plan))
      } else if (plan.action === 'ignore') {
        entry.drop()
      }
    }).catch((failure: unknown) => {
      console.warn('[dsh-voice-dialog] organizer skipped', failure)
    }).finally(finish)
  }

  /** Turn the two separated streams into two independently labelled lanes. */
  const enqueueSeparated = (
    result: SeparationResult,
    scheduler: SpeechScheduler,
    runLimited: <T>(task: () => Promise<T>) => Promise<T>,
  ): void => {
    const prefs = getPreferences()
    const tasks: Array<{
      lane: 'owner' | 'guest'
      canonical: string
      onsetMs: number
      work: Promise<string | null>
    }> = []
    result.sources.forEach((source, index) => {
      const identity = source.identity
      const canonical = identity?.label || '说话人' + (index + 1)
      const lane: 'owner' | 'guest' = identity?.enrolled === true && !identity.owner ? 'guest' : 'owner'
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
      const work = runLimited(async () => {
        const text = await transcribeAudio(source.audioBase64)
        return text ? prefix + text : null
      })
      tasks.push({ lane, canonical, onsetMs: source.onsetMs, work })
    })
    // Keep the earlier speaker first; if they started together, the owner goes first.
    tasks.sort((a, b) => a.onsetMs - b.onsetMs
      || (a.lane === b.lane ? 0 : a.lane === 'owner' ? -1 : 1))
    for (const task of tasks) enqueueWithOrganizer(task.lane, task.canonical, task.work, scheduler)
  }

  /** Identify a continuously separated lane, then queue its new text. */
  const enqueueContinuous = (
    segment: ContinuousSegment,
    scheduler: SpeechScheduler,
    runLimited: <T>(task: () => Promise<T>) => Promise<T>,
  ): void => {
    classifyRef.current = classifyRef.current.then(async () => {
      const prefs = getPreferences()
      let identity: SpeakerIdentity | null = null
      try {
        identity = await identifySpeaker(segment.samples, sessionId, prefs.speakerThreshold)
      } catch {
        // A short or noisy lane can still be transcribed without a voiceprint.
      }
      const fallback = '说话人' + (segment.slot + 1)
      const canonical = identity?.label || fallback
      const lane: 'owner' | 'guest' = identity
        ? (identity.enrolled && !identity.owner ? 'guest' : 'owner')
        : (segment.slot === 0 ? 'owner' : 'guest')
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
      const key = lane + ':' + canonical
      const work = runLimited(async () => {
        const text = await transcribeSamples(segment.samples)
        const fresh = dedupeTranscript(lastLaneTextRef.current.get(key) ?? '', text)
        lastLaneTextRef.current.set(key, text)
        if (!fresh) return null
        return prefs.speakerPrefix && display ? '[声纹：' + display + '] ' + fresh : fresh
      })
      enqueueWithOrganizer(lane, canonical, work, scheduler)
    }).catch((failure: unknown) => {
      console.warn('[dsh-voice-dialog] continuous speaker routing failed', failure)
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
        const split = await separateSegment(samples, sessionId, prefs.speakerThreshold)
        if (split.separated && split.sources.length >= 2) {
          enqueueSeparated(split, scheduler, runLimited)
          return
        }
        identity = split.sources[0]?.identity ?? null
        if (identity) setSpeaker(displaySpeaker(sessionId, identity.label))
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
        identity = await identifySpeaker(samples, sessionId, prefs.speakerThreshold)
        setSpeaker(displaySpeaker(sessionId, identity.label))
      } catch (failure) {
        // A missing model must not break normal dictation; the gate is
        // stricter because it is an explicit "only me" promise.
        if (prefs.speakerGate) {
          const message = failure instanceof Error ? failure.message : String(failure)
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

    // Without an enrolled voiceprint there is no priority signal. Keep the
    // previous behaviour: treat dictation as the owner instead of queueing it.
    const lane = identity?.enrolled === true && !identity.owner ? 'guest' : 'owner'
    const canonical = identity?.label ?? ''
    const display = canonical ? displaySpeaker(sessionId, canonical) : ''
    if (lane === 'guest' && effectiveGuestMode(sessionId, canonical) === 'ignore') {
      setSpeaker('已忽略其他人的声音')
      return
    }
    if (lane === 'guest') setSpeaker(display || '其他人')

    const prefix = prefs.speakerPrefix && display ? '[声纹：' + display + '] ' : ''
    const work = speculative
      ? (async () => {
          const text = await speculative
          return text ? prefix + text : null
        })()
      : runLimited(async () => {
          const text = await transcribeSamples(samples)
          return text ? prefix + text : null
        })
    enqueueWithOrganizer(lane, canonical, work, scheduler)
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
        const message = failure instanceof Error ? failure.message : String(failure)
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
      const message = failure instanceof Error ? failure.message : String(failure)
      setError(message)
      console.warn('[dsh-voice-dialog]', message)
    },
  })

  const start = async (): Promise<void> => {
    setError('')
    setSpeaker('')
    setPhase('starting')
    try {
      const prefs = getPreferences()
      separationReadyRef.current = false
      separationRetryAtRef.current = 0
      if (prefs.separateSpeakers) {
        try {
          const status = await fetchSeparationStatus()
          separationReadyRef.current = status.ready
          // Loading the 245 MB model takes a couple of seconds; do it while
          // the user is still listening, not after the first overlap.
          if (status.ready) void warmSeparation().catch(() => undefined)
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
        setError('语音模型未就绪，请在插件设置中准备')
        openSettings(ctx)
        setPhase('idle')
        return
      }
      await sharedPlayer.enable()
      const scheduler = makeScheduler()
      schedulerRef.current = scheduler
      classifyRef.current = Promise.resolve()
      lastLaneTextRef.current = new Map()
      setPending(0)
      setQueued(0)
      const runLimited = createLimit(prefs.parallelAsr ? 3 : 1)
      const continuous = prefs.separateSpeakers && separationReadyRef.current
      separatorRef.current?.close()
      separatorRef.current = null
      let separator: ContinuousSeparation | null = null
      if (continuous) {
        separator = new ContinuousSeparation({
          sampleRate: 16_000,
          separate: async (window) => {
            const split = await separateSegment(window, sessionId, prefs.speakerThreshold, false)
            return {
              sources: split.sources.map((source) => ({
                samples: decodeWaveBase64(source.audioBase64),
                rms: source.rms,
              })),
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
        silenceMs: getPreferences().pauseMs,
        threshold: getPreferences().micThreshold,
        continuous,
        onFrame: continuous ? (samples) => { separator?.push(samples) } : undefined,
        onLevel: (value) => setLevel(value),
        onSpeechStart: () => { sharedPlayer.unmute(); sharedPlayer.duck() },
        onSpeechEnd: () => { sharedPlayer.restore() },
        onSegment: continuous ? undefined : (samples) => { handleSegment(samples, scheduler, runLimited) },
        onError: (failure) => {
          setError(failure instanceof Error ? failure.message : String(failure))
        },
      })
      await mic.start()
      micRef.current = mic
      cancelRetainedStop()
      retainedMic = mic
      retainedSession = sessionId
      sharedPlayer.beginSession(sessionId)
      reportVoiceState(sessionId, true)
      setActive(true)
      setPhase('listening')
    } catch (failure) {
      separatorRef.current?.close()
      separatorRef.current = null
      schedulerRef.current?.dispose()
      schedulerRef.current = null
      setError(failure instanceof Error ? failure.message : String(failure))
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
  const label = error || (active
    ? activity || (speaker ? `正在听…（${speaker}）` : '正在听…点击结束')
    : '语音对话：点一下开始，多人插话按优先级排队，回答自动朗读')

  if (active) return <>
    <style>{MIC_CSS}</style>
    <div className="dsh-vd-captureRow" data-voice-activity={activity ? 'transcribing' : 'recording'}>
      <Button type="button" className="dsh-vd-round" size="sm" aria-label="结束语音对话"
        onClick={() => { void stop() }}><IconCloseOutlineRegular size={14} /></Button>
      {activity || error
        ? <span className="dsh-vd-activity" role="status">{error || activity}</span>
        : <LiveWave level={level} />}
      <Button type="button" className="dsh-vd-round" size="sm" aria-label="结束语音对话"
        onClick={() => { void stop() }}><IconStopFillRegular size={14} /></Button>
    </div>
  </>

  return <>
    <style>{MIC_CSS}</style>
    <Tooltip label={label} side="top" portal>
      <span className="dsh-vd-anchor">
        <Button className="dsh-vd-mic" size="sm" disabled={phase === 'starting'}
          aria-label={error ? `语音对话出错：${error}` : '开始语音对话'}
          aria-busy={phase === 'starting'} onClick={toggle}>
          <IconMicrophoneOutlineRegular size={18} />
        </Button>
      </span>
    </Tooltip>
  </>
}

const MIC_CSS = `
.dsh-vd-anchor { position: relative; display: inline-flex; flex: none; }
.dsh-vd-mic { width: 28px; padding: 0; flex: none; }
.dsh-vd-captureRow { display: flex; align-items: center; gap: 12px; width: 100%; min-width: 0; min-height: 34px; }
.dsh-vd-round { width: 32px; height: 32px; padding: 0; border-radius: 50%; flex: none;
  background: var(--dsw-specific-selector); }
.dsh-vd-round:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover-solid); }
.dsh-vd-wave { display: block; flex: 1; width: 0; height: 24px; min-width: 24px;
  color: var(--dsw-alias-label-secondary); }
.dsh-vd-activity { display: flex; align-items: center; flex: 1; min-width: 0; font-size: 12px;
  color: var(--dsw-alias-label-secondary); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
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
        const result = await ctx.remote.speech.catalog()
        if (!stopped) {
          if (result.ok) { setCatalog(result.value); setCatalogError('') }
          else setCatalogError(result.error?.message ?? '语音识别服务未连接')
        }
      } catch (failure) {
        if (!stopped) setCatalogError(failure instanceof Error ? failure.message : String(failure))
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
      setVoiceprintError(failure instanceof Error ? failure.message : String(failure))
    }
  }

  const refreshSeparation = async (): Promise<void> => {
    try {
      setSeparation(await fetchSeparationStatus())
      setSeparationError('')
    } catch (failure) {
      setSeparationError(failure instanceof Error ? failure.message : String(failure))
    }
  }

  const downloadSeparation = async (): Promise<void> => {
    setSeparationBusy(true)
    setSeparationError('')
    try {
      setSeparation(await prepareSeparation())
    } catch (failure) {
      setSeparationError(failure instanceof Error ? failure.message : String(failure))
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
      setVoiceprintError(failure instanceof Error ? failure.message : String(failure))
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
      setVoiceprintError(failure instanceof Error ? failure.message : String(failure))
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
      setVoiceprintError(failure instanceof Error ? failure.message : String(failure))
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
      setVoiceprintError(failure instanceof Error ? failure.message : String(failure))
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
      setVoiceprintError(failure instanceof Error ? failure.message : String(failure))
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
      setActionError(failure instanceof Error ? failure.message : String(failure))
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
      setActionError(failure instanceof Error ? failure.message : String(failure))
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
      setActionError(failure instanceof Error ? failure.message : String(failure))
    } finally { setBusy(false) }
  }

  const save = (patch: Partial<VoiceDialogPreferences>): void => { setPreferences(patch); setPrefs(getPreferences()) }
  const invoke = async (action: () => Promise<any>): Promise<void> => {
    setBusy(true); setActionError('')
    try {
      const result = await action()
      if (result && result.ok === false) throw new Error(result.error?.message ?? '操作失败')
    } catch (failure) {
      setActionError(failure instanceof Error ? failure.message : String(failure))
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
      <label>说话时压低到<input type="range" min="0" max="0.6" step="0.02" value={prefs.duckLevel}
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
      <label>停顿多久算说完<select value={String(prefs.pauseMs)} disabled={busy}
        onChange={(event) => { save({ pauseMs: Number(event.target.value) }) }}>
        <option value="1200">1.2 秒（快，容易截话）</option>
        <option value="1600">1.6 秒（默认）</option>
        <option value="2000">2.0 秒（少截话）</option>
        <option value="2500">2.5 秒（慢，适合思考）</option>
      </select></label>
      {selection && <label>识别服务<select value={selection.providerId} disabled={busy}
        onChange={(event) => { void invoke(() => ctx.remote.speech.configure({ providerId: event.target.value })) }}>
        {catalog.providers.map((item: any) => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select></label>}
      {selection && provider && <label>语言<select value={selection.language} disabled={busy}
        onChange={(event) => { void invoke(() => ctx.remote.speech.configure({ language: event.target.value })) }}>
        {provider.languages.map((language: string) => <option key={language} value={language}>{language}</option>)}
      </select></label>}
      {provider && <p>状态：{phaseLabel(phase)}{progress ? ` · ${progress}` : ''}</p>}
      {provider?.preparation?.phase === 'failed' && <p className="dsh-vd-error">{provider.preparation.message}</p>}
      {canPrepare && <button type="button" className="dsh-vd-button" disabled={busy}
        onClick={() => { void invoke(() => ctx.remote.speech.prepare(provider.id)) }}>准备语音模型</button>}
      {preparing && phase !== 'waking' && <button type="button" className="dsh-vd-button" disabled={busy}
        onClick={() => { void invoke(() => ctx.remote.speech.cancelPreparation(provider.id)) }}>取消准备</button>}
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
      <label>认定阈值<input type="range" min="0.35" max="0.8" step="0.01" value={prefs.speakerThreshold}
        onChange={(event) => { save({ speakerThreshold: Number(event.target.value) }) }} /><span>{prefs.speakerThreshold.toFixed(2)}</span></label>
      <p className="dsh-vd-muted">阈值越高越严格；别人被当成你的概率更低，但你自己也可能被忽略。建议从 0.52 开始。</p>
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
      <label>触发门槛<input type="range" min="0.005" max="0.08" step="0.001" value={prefs.micThreshold}
        onChange={(event) => { save({ micThreshold: Number(event.target.value) }) }} />
        <span>{prefs.micThreshold.toFixed(3)}</span></label>
      <p className="dsh-vd-muted">数字越小越容易触发；环境噪音大时调高，小声说话总被漏掉时调低。默认 0.022，重新开始语音后生效。</p>
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
`
