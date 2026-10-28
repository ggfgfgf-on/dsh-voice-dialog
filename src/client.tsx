/** dsh-voice-dialog client half: one microphone, continuous ASR steering, auto-read. */
import * as React from 'react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  Button, IconCloseOutlineRegular, IconMicrophoneOutlineRegular, IconStopFillRegular, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import speechRemote from './speech-remote.js'
import { MicrophoneLoop, recordVoiceSample } from './mic.ts'
import { getPreferences, setPreferences, subscribePreferences, type VoiceDialogPreferences } from './preferences.ts'
import { audioBase64, encodeWave } from './wav.ts'

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
  action: 'volume' | 'stop' | 'repeat'
  level?: number
  delta?: number
}

interface HostConfig {
  basePath: string
  voice: string
  enabled: boolean
}

interface VoiceprintStatus {
  ready: boolean
  addonAvailable: boolean
  modelPresent: boolean
  enrolled: boolean
  modelPath: string
  modelBytes: number
  embeddingDim?: number
  error?: string
}

interface SpeakerIdentity {
  enrolled: boolean
  owner: boolean
  label: string
  similarity: number
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
    this.queue.push(frame)
    if (!this.playing) this.playNext()
  }

  private clear(): void {
    this.queue.length = 0
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
            sharedPlayer.control(JSON.parse((event as MessageEvent<string>).data) as VoiceControl)
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

function VoiceMic({ ctx, sessionId, onActiveChange }: VoiceMicProps) {
  const [active, setActive] = useState(false)
  const [level, setLevel] = useState(0)
  const [phase, setPhase] = useState<'idle' | 'starting' | 'listening'>('idle')
  const [pending, setPending] = useState(0)
  const [error, setError] = useState('')
  const [speaker, setSpeaker] = useState('')
  const micRef = useRef<MicrophoneLoop | null>(null)
  const queueRef = useRef<Float32Array[]>([])
  const processing = useRef(false)
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

  const stop = async (): Promise<void> => {
    cancelRetainedStop()
    retainedMic = null
    retainedSession = null
    await micRef.current?.stop()
    micRef.current = null
    // Keep already captured segments: stopping the microphone must not lose
    // the last sentence the user just spoke.
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
        void mic.stop()
        reportVoiceState(sessionId, false)
        sharedPlayer.endSession()
        sharedPlayer.restore()
      }, 1200)
    }
  }, [sessionId])

  const drain = async (): Promise<void> => {
    if (processing.current) return
    processing.current = true
    try {
      while (queueRef.current.length > 0) {
        setPending(queueRef.current.length)
        await transcribeAndSend(queueRef.current.shift()!)
      }
    } finally {
      processing.current = false
      setPending(0)
      sharedPlayer.restore()
    }
  }

  const transcribeAndSend = async (samples: Float32Array): Promise<void> => {
    try {
      const prefs = getPreferences()
      let prefix = ''
      if (prefs.speakerPrefix || prefs.speakerGate) {
        try {
          const identity = await identifySpeaker(samples, sessionId, prefs.speakerThreshold)
          setSpeaker(identity.label)
          if (prefs.speakerGate && !identity.owner) {
            setSpeaker('已忽略其他人的声音')
            return
          }
          if (prefs.speakerPrefix && identity.label) prefix = '[声纹：' + identity.label + '] '
        } catch (failure) {
          // A missing model must not break normal dictation; the gate is
          // stricter because it is an explicit "only me" promise.
          if (prefs.speakerGate) throw failure
          console.warn('[dsh-voice-dialog] voiceprint skipped', failure)
        }
      }
      const catalog = await ctx.remote.speech.catalog()
      if (!catalog.ok) throw new Error(catalog.error?.message ?? '语音识别服务不可用')
      const provider = catalog.value.providers.find((item: any) => item.id === catalog.value.selection.providerId)
      if (!provider || !['ready', 'standby', 'waking'].includes(provider.preparation.phase)) {
        throw new Error('语音模型未就绪，请在插件设置中准备')
      }
      const result = await ctx.remote.speech.transcribe({
        audioBase64: audioBase64(encodeWave(samples)),
        ...catalog.value.selection,
      }, new AbortController().signal)
      if (!result.ok) throw new Error(result.error?.message ?? '识别失败')
      const text = String(result.value?.text ?? '').trim()
      if (!text) return
      const session = ctx.sessions.binding(sessionId)?.session
      if (!session) throw new Error('当前会话不可用')
      const sent = await session.prompt([{ type: 'text', text: prefix + text }], 'steer')
      if (!sent.ok) throw new Error(sent.error?.message ?? '发送失败')
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : String(failure)
      setError(message)
      console.warn('[dsh-voice-dialog]', message)
    }
  }

  const start = async (): Promise<void> => {
    setError('')
    setSpeaker('')
    setPhase('starting')
    try {
      const prefs = getPreferences()
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
      const mic = new MicrophoneLoop({
        deviceId: getPreferences().deviceId,
        silenceMs: getPreferences().pauseMs,
        onLevel: (value) => setLevel(value),
        onSpeechStart: () => { sharedPlayer.unmute(); sharedPlayer.duck() },
        onSpeechEnd: () => { sharedPlayer.restore() },
        onSegment: (samples) => {
          queueRef.current.push(samples)
          void drain()
        },
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
      setError(failure instanceof Error ? failure.message : String(failure))
      setPhase('idle')
    }
  }

  const toggle = (): void => {
    if (phase === 'starting') return
    if (active) void stop()
    else void start()
  }

  const label = error || (active
    ? pending > 0 ? `正在识别并插入（${pending}）…` : speaker ? `正在听…（${speaker}）` : '正在听…点击结束'
    : '语音对话：点一下开始，停顿后自动插入，回答自动朗读')

  if (active) return <>
    <style>{MIC_CSS}</style>
    <div className="dsh-vd-captureRow" data-voice-activity={pending > 0 ? 'transcribing' : 'recording'}>
      <Button type="button" className="dsh-vd-round" size="sm" aria-label="结束语音对话"
        onClick={() => { void stop() }}><IconCloseOutlineRegular size={14} /></Button>
      {pending > 0 || error
        ? <span className="dsh-vd-activity" role="status">{error || `正在识别并插入（${pending}）…`}</span>
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
  const [voiceprintBusy, setVoiceprintBusy] = useState<'' | 'prepare' | 'record' | 'forget'>('')
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
  useEffect(() => { void refreshVoiceprint() }, [])
  useEffect(() => () => { recordAbort.current?.abort() }, [])

  const refreshVoiceprint = async (): Promise<void> => {
    try {
      setVoiceprint(await fetchVoiceprintStatus())
      setVoiceprintError('')
    } catch (failure) {
      setVoiceprintError(failure instanceof Error ? failure.message : String(failure))
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

  const recordMyVoice = async (): Promise<void> => {
    setVoiceprintBusy('record')
    setVoiceprintError('')
    setActionError('')
    setRecording(true)
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
      await enrollVoiceprint(samples)
      setVoiceprint(await fetchVoiceprintStatus())
    } catch (failure) {
      setVoiceprintError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setRecording(false)
      setRecordLevel(0)
      setVoiceprintBusy('')
      recordAbort.current = null
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
  const [previewText, setPreviewText] = useState('你好，我是你的语音助手。')
  const [previewing, setPreviewing] = useState(false)
  const previewRef = useRef<HTMLAudioElement | null>(null)
  const previewUrl = useRef('')
  const previewFallback = useRef(false)
  const previewToken = useRef(0)
  useEffect(() => { if (host) setVoice(host.voice) }, [host])
  useEffect(() => () => {
    previewRef.current?.pause()
    previewRef.current = null
    if (previewUrl.current) URL.revokeObjectURL(previewUrl.current)
    previewUrl.current = ''
    previewToken.current++
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

  const playPreview = async (): Promise<void> => {
    if (previewing) { stopPreview(); return }
    setBusy(true); setActionError('')
    try {
      const response = await fetch(apiUrl('/preview'), {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: previewText, voice }),
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
    <p className="dsh-vd-muted">一个麦克风完成连续对话：停顿后自动识别并插入当前回答，助手回复自动朗读。设置只保存在这个浏览器。</p>

    <section>
      <h3>朗读</h3>
      <label className="dsh-vd-check"><input type="checkbox" checked={prefs.autoRead}
        onChange={(event) => { save({ autoRead: event.target.checked }) }} />自动朗读助手回复</label>
      <label>朗读音量<input type="range" min="0" max="1" step="0.05" value={prefs.volume}
        onChange={(event) => { save({ volume: Number(event.target.value) }) }} /><span>{Math.round(prefs.volume * 100)}%</span></label>
      <label>说话时压低到<input type="range" min="0" max="0.6" step="0.02" value={prefs.duckLevel}
        onChange={(event) => { save({ duckLevel: Number(event.target.value) }) }} /><span>{Math.round(prefs.duckLevel * 100)}%</span></label>
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
      <p className="dsh-vd-muted">说话只会压低朗读，不会切断回答；识别出的文字作为插话交给正在运行的模型，模型可以说完再回应。</p>
      {host && <p className="dsh-vd-muted">音色保存在本机（重启后仍生效），朗读偏好保存在这个浏览器。</p>}
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
          {recording ? '录音中…' : voiceprint?.enrolled ? '重新录制我的声纹' : '录制我的声纹'}
        </button>
        {voiceprint?.enrolled && <button type="button" className="dsh-vd-button" disabled={voiceprintBusy !== '' || recording}
          onClick={() => { void removeVoiceprint() }}>{voiceprintBusy === 'forget' ? '删除中…' : '删除声纹'}</button>}
      </div>
      {recording && <>
        <div className="dsh-vd-recordBar"><span style={{ width: `${Math.max(4, Math.round(recordLevel * 100))}%` }} /></div>
        <p className="dsh-vd-muted">请用平常音量说一句话，例如：今天天气不错，我在和你说话。录音六秒后自动保存。</p>
      </>}
      {voiceprintError && <p className="dsh-vd-error" role="alert">{voiceprintError}</p>}
      <p className="dsh-vd-muted">带「客人」前缀的是其他人；只有登记过我的声纹，才能启用「只回应我的声音」。</p>
    </section>

    <section>
      <h3>麦克风</h3>
      <label>输入设备<select value={prefs.deviceId} onChange={(event) => { save({ deviceId: event.target.value }) }}>
        <option value="">系统默认</option>
        {devices.map((device, index) => <option key={device.deviceId || index} value={device.deviceId}>
          {device.label || `麦克风 ${index + 1}`}
        </option>)}
      </select></label>
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
.dsh-vd-recordBar { height: 6px; overflow: hidden; border-radius: 3px; background: var(--dsw-alias-interactive-bg-hover); }
.dsh-vd-recordBar span { display: block; height: 100%; border-radius: 3px; background: var(--dsw-alias-state-business-primary); transition: width .08s linear; }
`
