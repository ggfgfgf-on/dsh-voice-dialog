/** dsh-voice-dialog client half: one microphone, continuous ASR steering, auto-read. */
import * as React from 'react'
import { useEffect, useRef, useState } from 'react'
import {
  Button, IconMicrophoneOutlineRegular, IconStopFillRegular, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import speechRemote from './speech-remote.js'
import { MicrophoneLoop } from './mic.ts'
import { getPreferences, setPreferences, subscribePreferences, type VoiceDialogPreferences } from './preferences.ts'
import { audioBase64, encodeWave } from './wav.ts'

export const inject = ['remote']

const BOOTSTRAP_BASE = '/dsh-voice-dialog-api'
const BUNDLE_ID = 'dsh-voice-dialog'

interface VoiceFrame {
  sessionId: string
  seq: number
  text: string
  audio: string
}

interface HostConfig {
  basePath: string
  voice: string
  enabled: boolean
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

  duck(): void {
    this.ducked = true
    this.applyGain()
  }

  restore(): void {
    this.ducked = false
    this.applyGain()
  }

  enqueue(frame: VoiceFrame): void {
    if (!this.prefs.autoRead) return
    this.queue.push(frame)
    if (!this.playing) this.playNext()
  }

  private clear(): void {
    this.queue.length = 0
    this.audio.pause()
    this.cleanupUrl()
    this.playing = false
    this.ducked = false
    this.blocked = false
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
    const target = this.ducked ? this.prefs.volume * this.prefs.duckLevel : this.prefs.volume
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
            if (frame.sessionId === sessionId) sharedPlayer.enqueue(frame)
          } catch {
            // A malformed frame must not tear down the stream.
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

interface VoiceMicProps {
  ctx: any
  sessionId: string
}

function VoiceMic({ ctx, sessionId }: VoiceMicProps) {
  const [active, setActive] = useState(false)
  const [phase, setPhase] = useState<'idle' | 'starting' | 'listening'>('idle')
  const [pending, setPending] = useState(0)
  const [error, setError] = useState('')
  const micRef = useRef<MicrophoneLoop | null>(null)
  const queueRef = useRef<Float32Array[]>([])
  const processing = useRef(false)
  useAutoRead(sessionId)

  const stop = async (): Promise<void> => {
    await micRef.current?.stop()
    micRef.current = null
    queueRef.current.length = 0
    setActive(false)
    setPhase('idle')
    sharedPlayer.restore()
  }

  useEffect(() => {
    setActive(false)
    setPhase('idle')
    setError('')
    return () => {
      void micRef.current?.stop()
      micRef.current = null
      queueRef.current.length = 0
      sharedPlayer.restore()
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
      const sent = await session.prompt([{ type: 'text', text }], 'steer')
      if (!sent.ok) throw new Error(sent.error?.message ?? '发送失败')
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : String(failure)
      setError(message)
      console.warn('[dsh-voice-dialog]', message)
    }
  }

  const start = async (): Promise<void> => {
    setError('')
    setPhase('starting')
    try {
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
        onSpeechStart: () => sharedPlayer.duck(),
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
    ? pending > 0 ? `正在识别并插入（${pending}）…` : '正在听…点击结束'
    : '语音对话：点一下开始，停顿后自动插入，回答自动朗读')

  return <>
    <style>{MIC_CSS}</style>
    <Tooltip label={label} side="top" portal>
      <span className="dsh-vd-anchor">
        <Button className="dsh-vd-mic" size="sm" disabled={phase === 'starting'}
          aria-label={error ? `语音对话出错：${error}` : active ? '结束语音对话' : '开始语音对话'}
          aria-pressed={active} onClick={toggle}
          style={active ? { background: 'var(--dsw-alias-state-error-primary)', color: '#fff' } : undefined}>
          {active ? <IconStopFillRegular size={16} /> : <IconMicrophoneOutlineRegular size={18} />}
        </Button>
        {active && <span className={`dsh-vd-pulse${pending > 0 ? ' dsh-vd-busy' : ''}`} />}
      </span>
    </Tooltip>
  </>
}

const MIC_CSS = `
.dsh-vd-anchor { position: relative; display: inline-flex; flex: none; }
.dsh-vd-mic { width: 28px; padding: 0; flex: none; }
.dsh-vd-mic[aria-pressed='true'] { animation: dsh-vd-breathe 2.4s ease-in-out infinite; }
.dsh-vd-pulse { position: absolute; top: -1px; right: -1px; width: 7px; height: 7px; border-radius: 50%;
  background: var(--dsw-alias-state-error-primary); pointer-events: none; }
.dsh-vd-pulse.dsh-vd-busy { animation: dsh-vd-pulse .8s ease-out infinite; }
@keyframes dsh-vd-pulse { 0% { box-shadow: 0 0 0 0 rgba(220,60,60,.55); } 100% { box-shadow: 0 0 0 5px rgba(220,60,60,0); } }
@keyframes dsh-vd-breathe { 0%,100% { opacity: 1; } 50% { opacity: .72; } }
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

  const [voice, setVoice] = useState('')
  const [previewText, setPreviewText] = useState('你好，我是你的语音助手。')
  const [previewing, setPreviewing] = useState(false)
  const previewRef = useRef<HTMLAudioElement | null>(null)
  const previewUrl = useRef('')
  useEffect(() => { if (host) setVoice(host.voice) }, [host])
  useEffect(() => () => {
    previewRef.current?.pause()
    previewRef.current = null
    if (previewUrl.current) URL.revokeObjectURL(previewUrl.current)
    previewUrl.current = ''
  }, [])

  const stopPreview = (): void => {
    previewRef.current?.pause()
    previewRef.current = null
    if (previewUrl.current) URL.revokeObjectURL(previewUrl.current)
    previewUrl.current = ''
    setPreviewing(false)
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
          onClick={() => { void playPreview() }}>{previewing ? '停止试听' : '试听'}</button>
      </div>
      {actionError && <p className="dsh-vd-error" role="alert">{actionError}</p>}
      <p className="dsh-vd-muted">说话只会压低朗读，不会切断回答；识别出的文字作为插话交给正在运行的模型，模型可以说完再回应。</p>
      {host && <p className="dsh-vd-muted">音色保存在本机（重启后仍生效），朗读偏好保存在这个浏览器。</p>}
    </section>

    <section>
      <h3>语音识别</h3>
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
.dsh-vd-settings { display: flex; flex-direction: column; gap: 18px; max-width: 640px; padding: 4px 2px 24px; font-size: 13px; line-height: 1.6; }
.dsh-vd-settings h2 { margin: 0; font-size: 18px; }
.dsh-vd-settings h3 { margin: 0 0 10px; font-size: 14px; }
.dsh-vd-settings section { display: flex; flex-direction: column; gap: 10px; padding: 14px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; }
.dsh-vd-settings p { margin: 0; }
.dsh-vd-muted { color: var(--dsw-alias-label-secondary); }
.dsh-vd-error { color: var(--dsw-alias-state-error-primary); overflow-wrap: anywhere; }
.dsh-vd-settings label { display: flex; align-items: center; gap: 10px; }
.dsh-vd-settings label > input[type='range'] { flex: 1; min-width: 120px; accent-color: var(--dsw-alias-state-business-primary); }
.dsh-vd-settings label > span { width: 40px; text-align: right; color: var(--dsw-alias-label-tertiary); }
.dsh-vd-settings select { min-width: 180px; max-width: 100%; border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; padding: 6px 10px; background: transparent; color: inherit; font: inherit; }
.dsh-vd-check { justify-content: flex-start; }
.dsh-vd-check input { accent-color: var(--dsw-alias-state-business-primary); }
.dsh-vd-preview { display: flex; align-items: center; gap: 8px; }
.dsh-vd-preview input { flex: 1; min-width: 0; border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; padding: 6px 10px; background: transparent; color: inherit; font: inherit; }
.dsh-vd-preview .dsh-vd-button { align-self: auto; white-space: nowrap; }
.dsh-vd-button { align-self: flex-start; border: 1px solid var(--dsw-alias-border-l1); border-radius: 7px; padding: 6px 12px; background: transparent; color: inherit; font: inherit; cursor: pointer; }
.dsh-vd-button:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.dsh-vd-button:disabled { opacity: .5; cursor: default; }
`
