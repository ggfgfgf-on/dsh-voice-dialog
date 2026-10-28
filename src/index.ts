/** dsh-voice-dialog host half: llm/stream tap -> sentence segmentation -> Edge TTS -> SSE. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { OUTPUT_FORMAT } from 'msedge-tts'
import { hasSpeechContent, sanitizeForSpeech, SentenceSegmenter } from './segmenter.ts'
import { isSpeakableChunk, shouldSpeak } from './speech-filter.ts'
import { createEdgeTts, rateToProsody, TtsQueue, type VoiceFrame } from './tts-queue.ts'
import { decodeWavBase64, VoiceprintService } from './voiceprint.ts'
import { VoiceProtocol, type VoiceCommand } from './voice-protocol.ts'

export const name = 'voice-dialog'
export const inject = ['webServer', 'tools', 'systemPrompt']

/** Fixed bootstrap path so the client can discover a custom basePath. */
const BOOTSTRAP_BASE = '/dsh-voice-dialog-api'
const SETTINGS_FILE = join(homedir(), '.dsh', 'voice-dialog', 'settings.json')

export interface VoiceControl {
  action: 'volume' | 'rate' | 'stop' | 'repeat' | 'speaker'
  level?: number
  rate?: number
  delta?: number
  speaker?: string
  policy?: 'queue' | 'steer' | 'ignore' | 'default'
  name?: string
}

export interface Config {
  /** Turn automatic read-aloud on or off. */
  enabled: boolean
  /** SSE/config route prefix. */
  basePath: string
  /** Initial Edge TTS voice id; the settings page may override it. */
  voice: string
  /** Initial speaking rate in percent (-50..50); the settings page may override it. */
  rate: number
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  basePath: z.string().default(BOOTSTRAP_BASE),
  voice: z.string().default('zh-CN-XiaoxiaoNeural'),
  rate: z.number().default(0),
})

/** Restore the voice chosen from the settings page, if it is still valid. */
function storedVoice(fallback: string): string {
  try {
    const data = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8')) as { voice?: unknown }
    return typeof data.voice === 'string' && data.voice.length > 0 ? data.voice : fallback
  } catch {
    return fallback
  }
}

function isVoiceId(value: string): boolean {
  return /^[A-Za-z]{2,3}-[A-Za-z0-9-]+Neural$/.test(value)
}

function clampRate(value: number): number {
  return Math.max(-50, Math.min(50, Math.round(value)))
}

/** Restore the rate chosen from the settings page. */
function storedRate(fallback: number): number {
  try {
    const data = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8')) as { rate?: unknown }
    return typeof data.rate === 'number' && Number.isFinite(data.rate) ? clampRate(data.rate) : fallback
  } catch {
    return fallback
  }
}

/** Apply the read-aloud stream and its transport. */
export function apply(ctx: Context, config: Config): void {
  const base = config.basePath.replace(/\/+$/, '') || BOOTSTRAP_BASE
  let voice = storedVoice(config.voice)
  let rate = storedRate(config.rate)
  type SseSend = (event: 'audio' | 'control', data: VoiceFrame | VoiceControl) => void
  const clients = new Set<SseSend>()
  const queue = new TtsQueue({ voice })
  queue.setRate(rate)
  const voiceprint = new VoiceprintService()
  const broadcast = (event: 'audio' | 'control', data: VoiceFrame | VoiceControl): void => {
    for (const send of clients) {
      try {
        send(event, data)
      } catch {
        // A dead SSE connection is removed by its close handler.
      }
    }
  }

  const persistVoiceSettings = (): void => {
    mkdirSync(dirname(SETTINGS_FILE), { recursive: true })
    writeFileSync(SETTINGS_FILE, JSON.stringify({ voice, rate }), 'utf8')
  }
  const setRate = (next: number): number => {
    rate = clampRate(next)
    queue.setRate(rate)
    persistVoiceSettings()
    return rate
  }
  const unsubscribe = queue.subscribe((frame) => { broadcast('audio', frame) })
  ctx.effect(() => unsubscribe)
  ctx.effect(() => async () => { await queue.close() })
  // Dial Edge before the first reply: the proxy handshake is the slow/flaky
  // part, and waiting for it inside the first sentence feels like no audio.
  void queue.warm().catch((error: unknown) => {
    // eslint-disable-next-line no-console
    console.warn('[dsh-voice-dialog] TTS warmup failed: ' + String(error))
  })
  // Loading the embedding model is local and cheap, but the first utterance
  // should not pay for it. A missing model is reported in the settings page.
  try { voiceprint.warm() } catch (error) {
    // eslint-disable-next-line no-console
    console.warn('[dsh-voice-dialog] voiceprint warmup failed: ' + String(error))
  }

  // A subagent runs in its own session. The plugin speaks its final summary
  // straight into the parent's queue instead of waiting for the main model to
  // start another turn. Parentage is recorded at session creation; looking it
  // up on subagent/end can race the child's disposal.
  const activeVoice = new Map<string, number>()
  const childParents = new Map<string, string>()
  const announcedRuns = new Set<string>()
  ctx.on('session/created', (session: any) => {
    try {
      const parent = session?.header?.parentSession
      if (parent !== undefined && parent !== null) {
        childParents.set(String(session.id), String(parent))
      }
    } catch {
      // A session without a readable header is not a voice child.
    }
  })
  ctx.on('subagent/end', (info: any) => {
    try {
      if (info?.local !== true) return
      const runId = String(info?.runId ?? info?.id ?? '')
      if (!runId || announcedRuns.has(runId)) return
      const childId = String(info?.id ?? '')
      let parent = childParents.get(childId)
      if (parent === undefined) {
        const child = (ctx as unknown as { sessions?: { get(id: string): any } }).sessions?.get(childId)
        const headerParent = child?.header?.parentSession
        if (headerParent !== undefined && headerParent !== null) parent = String(headerParent)
      }
      if (parent === undefined || !voiceSessionActive(activeVoice, parent)) return
      const summary = summarizeForSpeech(assistantText(info?.lastAssistantMessage))
      if (!summary) return
      announcedRuns.add(runId)
      childParents.delete(childId)
      const spoken = /^(另外|还有|补充)/.test(summary) ? summary : '补充一下，' + summary
      queue.enqueue(parent, spoken, 'subagent-' + runId)
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn('[dsh-voice-dialog] subagent speech failed: ' + String(error))
    }
  })

  // Model-facing audio control for spoken meta-commands such as
  // "louder", "repeat that" or "stop talking". The browser applies it
  // immediately over the same SSE connection as the audio frames.
  const tools = (ctx as unknown as { tools: { register(definition: unknown): () => void } }).tools
  ctx.effect(() => tools.register({
    name: 'voice_dialog',
    description: 'Control the live voice-dialog audio. Call this when the user\'s voice input is a '
      + 'meta-command about the speaking itself, not normal conversation content: '
      + '"轻一点/小点声" -> action volume with delta -0.15; "响一点/大点声" -> action volume with delta 0.15; '
      + '"慢一点/说慢点" -> action rate with delta -10; "快一点/说快点" -> action rate with delta 10; '
      + '"语速调到百分之..." -> action rate with the absolute rate; '
      + '"听不清/什么/再说一遍/重复一遍" -> action repeat; "别说了/闭嘴/停/安静" -> action stop. '
      + 'For a guest who keeps interrupting with irrelevant talk, action speaker with speaker "客人1" and policy "ignore"; '
      + 'use policy "queue" to restore, "steer" to let that guest interrupt directly, or speaker "*" for all guests. '
      + 'When the owner gives a guest a name (for example "叫她老婆"), pass that name in the name field; future turns use it. '
      + 'The owner cannot be renamed or ignored. Do not call this for ordinary questions. The microphone stays on after stop.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['volume', 'rate', 'stop', 'repeat', 'speaker'],
          description: 'volume adjusts playback loudness; rate adjusts speaking speed for following sentences; stop silences the current reply; repeat replays the last reply; speaker renames a guest voiceprint and/or changes how that guest is delivered.',
        },
        level: { type: 'number', minimum: 0, maximum: 1, description: 'Absolute playback volume for action volume.' },
        rate: { type: 'number', minimum: -50, maximum: 50, description: 'Absolute speaking rate in percent for action rate, e.g. -20 or 20.' },
        delta: { type: 'number', minimum: -50, maximum: 50, description: 'Relative change: volume uses -1..1, rate uses -50..50 percent.' },
        speaker: { type: 'string', description: 'Guest voiceprint label for action speaker, e.g. 客人1, 说话人1, or a name the model assigned earlier; use * for all guests. The owner 我 cannot be changed.' },
        policy: { type: 'string', enum: ['queue', 'steer', 'ignore', 'default'], description: 'Delivery policy for action speaker: queue, steer, ignore, or default to restore the browser setting.' },
        name: { type: 'string', description: 'New short name for this guest voiceprint, e.g. 老婆 or 老王. Future transcripts and policies can use it. Only for a specific guest, not * or 我.' },
      },
      required: ['action'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          action: { type: 'string' },
          level: { type: 'number' },
          rate: { type: 'number' },
          speaker: { type: 'string' },
          policy: { type: 'string' },
          name: { type: 'string' },
        },
        required: ['ok', 'action'],
      },
      render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }],
    },
    execute: (args: unknown) => {
      const input = (args ?? {}) as Record<string, unknown>
      const action = input.action
      if (action === 'stop' || action === 'repeat') {
        broadcast('control', { action })
        return Promise.resolve({ ok: true, action })
      }
      if (action === 'speaker') {
        const speaker = typeof input.speaker === 'string' ? input.speaker.trim() : ''
        if (!speaker) throw new Error('voice_dialog speaker needs speaker')
        if (speaker === '我') throw new Error('the owner speaker cannot be changed')
        const rawPolicy = input.policy
        const policy = rawPolicy === undefined
          ? undefined
          : rawPolicy === 'queue' || rawPolicy === 'steer' || rawPolicy === 'ignore' || rawPolicy === 'default'
            ? rawPolicy
            : null
        if (policy === null) {
          throw new Error('voice_dialog speaker policy must be queue, steer, ignore or default')
        }
        const name = typeof input.name === 'string' ? input.name.trim() : ''
        if (name) {
          if (speaker === '*') throw new Error('cannot give all guests one name')
          if (name.length > 24 || /[\[\]\r\n]/.test(name) || name === '我' || name === '*') {
            throw new Error('voice_dialog speaker name must be 1-24 characters without brackets or newlines')
          }
        }
        if (policy === undefined && !name) {
          throw new Error('voice_dialog speaker needs a policy or name')
        }
        const payload: VoiceControl = { action, speaker }
        if (policy !== undefined) payload.policy = policy
        if (name) payload.name = name
        broadcast('control', payload)
        return Promise.resolve({ ok: true, action, speaker, ...(policy === undefined ? {} : { policy }), ...(name ? { name } : {}) })
      }
      if (action === 'volume') {
        const level = typeof input.level === 'number' && Number.isFinite(input.level)
          ? Math.max(0, Math.min(1, input.level)) : undefined
        const delta = typeof input.delta === 'number' && Number.isFinite(input.delta)
          ? Math.max(-1, Math.min(1, input.delta)) : undefined
        if (level === undefined && delta === undefined) {
          throw new Error('voice_dialog volume needs level or delta')
        }
        broadcast('control', { action, ...(level === undefined ? {} : { level }), ...(delta === undefined ? {} : { delta }) })
        return Promise.resolve({ ok: true, action, ...(level === undefined ? {} : { level }) })
      }
      if (action === 'rate') {
        const absolute = typeof input.rate === 'number' && Number.isFinite(input.rate) ? clampRate(input.rate) : undefined
        const delta = typeof input.delta === 'number' && Number.isFinite(input.delta) ? clampRate(input.delta) : undefined
        if (absolute === undefined && delta === undefined) {
          throw new Error('voice_dialog rate needs rate or delta')
        }
        const applied = setRate(absolute ?? rate + (delta ?? 0))
        broadcast('control', { action, rate: applied })
        return Promise.resolve({ ok: true, action, rate: applied })
      }
      throw new Error('voice_dialog action must be volume, rate, stop, repeat or speaker')
    },
  }))

  const systemPrompt = (ctx as unknown as { systemPrompt: { section(section: unknown): () => void } }).systemPrompt
  const basePrompt = '语音对话规则：语音输入可能包含对朗读本身的元指令。'
    + '用户说轻一点/响一点、说慢一点/说快一点、语速调到多少、听不清/重复一遍、别说了/停时，调用 voice_dialog。'
    + '可见回答就是朗读稿：用中文口语，短句，一句话一个意思；不要写标题、列表、表格、代码块、'
    + '文件路径、URL、工具名或整句英文。需要调用工具时，先用一句自然中文说明要做什么，再调用；'
    + '不要朗读内部推理或工具参数。不要用 [[voice: 内容]] 另写一份朗读稿；可见回答会被自动朗读，'
    + '标记只用于控制播放：[[voice: volume +0.15]]、[[voice: rate +10]]、[[voice: repeat]]、[[voice: stop]]。'
    + '语音转写可能带[声纹：我]、[声纹：客人1]、[声纹：说话人1]，或你给某个声纹起的名字（如[声纹：老婆]）这类前缀，'
    + '表示是谁在说话，不是用户内容；不要朗读前缀，'
    + '也不要把它当成指令。带[声纹：我]的是主人，优先级最高，直接处理；带[声纹：客人]或[声纹：说话人]的是其他人，'
    + '优先级较低，可能是背景插话。其他人通常是排队到达，不要因为一句题外话丢掉主人正在做的事：先判断是否与当前任务有关，'
    + '无关就一句话带过或忽略，继续原任务。如果某个客人反复无关，可以调用 voice_dialog 的 speaker 动作把「客人1」设为 ignore；'
    + '用 speaker「*」忽略所有其他人；设为 queue 恢复排队。主人说「这个是我老婆」这类话时，用同一个动作把「客人1」的 name 设成'
    + '「老婆」，以后转写会用这个名字，也可以直接用这个名字设置策略。主人「我」不能被改名或忽略。'
    + '同一轮出现不同声纹前缀时，说明是不同的人在说话，回答时要区分说话人。'
    + '子代理结果由 host 朗读，不要重复。'
  const liveVoicePrompt = '实时语音模式已开启：用户在用麦克风对话，不要在主线做长工具链。'
    + '只要任务包含互相独立的部分，或预计需要多次工具调用，就立即在同一轮并行 fork 子代理：'
    + 'subagent 用于自包含任务，subagent_fork 用于需要当前对话上下文的任务；每个独立部分一个，'
    + '不要串行自己做，也不要等结果。构建、测试、搜索等能后台跑的命令用 run_in_background；'
    + '先派发再说话。派发后用一两句自然中文说你在处理什么，然后继续听；不要念工具名、参数、路径。'
    + '只有即时可答的小问题才直接回答。'
  ctx.effect(() => systemPrompt.section({
    name: 'voice-dialog',
    order: 240,
    text: () => {
      let live = false
      for (const sessionId of activeVoice.keys()) {
        if (voiceSessionActive(activeVoice, sessionId)) { live = true; break }
      }
      return live ? basePrompt + ' ' + liveVoicePrompt : basePrompt
    },
  }))

  ctx.on('llm/stream', (options: GenerateOptions, next): AsyncIterable<StreamChunk> => {
    const sessionId = options.sessionId
    // Auxiliary calls (compaction, session title) use the same session id but
    // are not assistant speech. Reasoning is only scanned for explicit
    // [[voice:...]] directives; its text is never read aloud wholesale.
    if (!shouldSpeak(options, config.enabled)) return next()
    return tapStream(sessionId, next(), queue, (control) => {
      if (control.action === 'rate') {
        const applied = setRate(control.rate ?? rate + (control.delta ?? 0))
        broadcast('control', { action: 'rate', rate: applied })
        return
      }
      broadcast('control', control)
    })
  })

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: `${base}/stream`,
      handler: (req, res: ServerResponse) => {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
        })
        res.write('retry: 3000\n\n')
        const send: SseSend = (event, data) => {
          res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
        }
        clients.add(send)
        const heartbeat = setInterval(() => { res.write(': hb\n') }, 25000)
        const cleanup = (): void => {
          clearInterval(heartbeat)
          clients.delete(send)
        }
        req.on('close', cleanup)
        res.on('close', cleanup)
      },
    }),
  )

  const configHandler = (_req: unknown, res: ServerResponse): void => {
    writeJson(res, 200, { basePath: base, voice, rate, enabled: config.enabled })
  }
  for (const prefix of new Set([base, BOOTSTRAP_BASE])) {
    ctx.effect(() =>
      ctx.webServer.register({ kind: 'exact', path: `${prefix}/config`, handler: configHandler }),
    )
  }

  // The browser owns microphone lifetime; the host only needs to know which
  // parent sessions are currently allowed to speak background results. A
  // short client heartbeat refreshes the entry so a crashed tab expires.
  const voiceStateHandler = async (req: unknown, res: ServerResponse): Promise<void> => {
    try {
      const body = await readJson(req)
      const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
      if (!sessionId) { writeJson(res, 400, { error: 'missing sessionId' }); return }
      if (body.active === true) activeVoice.set(sessionId, Date.now())
      else activeVoice.delete(sessionId)
      writeJson(res, 200, { ok: true })
    } catch (error) {
      writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
    }
  }
  for (const prefix of new Set([base, BOOTSTRAP_BASE])) {
    ctx.effect(() =>
      ctx.webServer.register({ kind: 'exact', path: `${prefix}/voice-state`, handler: voiceStateHandler }),
    )
  }

  // Persisted voice selection. The client owns the catalog; the host only
  // validates the id, switches the live queue and stores the choice.
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: `${base}/settings`,
      handler: async (req, res: ServerResponse) => {
        try {
          const body = await readJson(req)
          const hasVoice = typeof body.voice === 'string'
          const hasRate = typeof body.rate === 'number' && Number.isFinite(body.rate)
          if (!hasVoice && !hasRate) {
            writeJson(res, 400, { error: 'voice or rate required' })
            return
          }
          if (hasVoice) {
            const next = String(body.voice).trim()
            if (!isVoiceId(next)) { writeJson(res, 400, { error: 'invalid voice id' }); return }
            if (next !== voice) await queue.setVoice(next)
            voice = next
          }
          if (hasRate) rate = clampRate(Number(body.rate))
          queue.setRate(rate)
          persistVoiceSettings()
          writeJson(res, 200, { ok: true, voice, rate })
        } catch (error) {
          writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    }),
  )

  // Short audition used by the settings page. It uses a throwaway synthesizer
  // so a preview cannot disturb the live reply queue.
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: `${base}/preview`,
      handler: async (req, res: ServerResponse) => {
        try {
          const body = await readJson(req)
          const text = typeof body.text === 'string' ? body.text.trim().slice(0, 300) : ''
          const requested = typeof body.voice === 'string' && isVoiceId(body.voice) ? body.voice : voice
          const requestedRate = typeof body.rate === 'number' && Number.isFinite(body.rate) ? clampRate(body.rate) : rate
          if (!text) { writeJson(res, 400, { error: 'empty text' }); return }
          const audio = await synthesizePreview(text, requested, requestedRate)
          res.writeHead(200, { 'content-type': 'audio/mpeg', 'content-length': String(audio.length) })
          res.end(audio)
        } catch (error) {
          writeJson(res, 502, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    }),
  )

  const voiceprintStatus = (_req: unknown, res: ServerResponse): void => {
    writeJson(res, 200, voiceprint.status())
  }
  const voiceprintPrepare = async (_req: unknown, res: ServerResponse): Promise<void> => {
    try { writeJson(res, 200, { ok: true, ...(await voiceprint.prepare()) }) }
    catch (error) { writeJson(res, 502, { error: error instanceof Error ? error.message : String(error) }) }
  }
  const voiceprintEnroll = async (req: unknown, res: ServerResponse): Promise<void> => {
    try {
      const body = await readJson(req as IncomingMessage, 4 * 1024 * 1024)
      const audio = typeof body.audioBase64 === 'string' ? body.audioBase64 : ''
      if (!audio) throw new Error('缺少录音数据')
      const result = await voiceprint.enroll(decodeWavBase64(audio))
      writeJson(res, 200, { ok: true, ...result })
    } catch (error) {
      writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
    }
  }
  const voiceprintIdentify = async (req: unknown, res: ServerResponse): Promise<void> => {
    try {
      const body = await readJson(req as IncomingMessage, 4 * 1024 * 1024)
      const audio = typeof body.audioBase64 === 'string' ? body.audioBase64 : ''
      if (!audio) throw new Error('缺少语音数据')
      const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
      const threshold = typeof body.threshold === 'number' ? body.threshold : undefined
      const result = await voiceprint.identify(decodeWavBase64(audio), { sessionId, threshold })
      writeJson(res, 200, { ok: true, ...result })
    } catch (error) {
      writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
    }
  }
  const voiceprintForget = (_req: unknown, res: ServerResponse): void => {
    voiceprint.forget()
    writeJson(res, 200, { ok: true })
  }
  const voiceprintEnrollSpeaker = async (req: unknown, res: ServerResponse): Promise<void> => {
    try {
      const body = await readJson(req as IncomingMessage, 4 * 1024 * 1024)
      const audio = typeof body.audioBase64 === 'string' ? body.audioBase64 : ''
      const name = typeof body.name === 'string' ? body.name : ''
      if (!audio) throw new Error('缺少录音数据')
      const result = await voiceprint.enrollSpeaker(decodeWavBase64(audio), name)
      writeJson(res, 200, { ok: true, ...result })
    } catch (error) {
      writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
    }
  }
  const voiceprintRenameSpeaker = async (req: unknown, res: ServerResponse): Promise<void> => {
    try {
      const body = await readJson(req as IncomingMessage)
      const id = typeof body.id === 'string' ? body.id : ''
      const name = typeof body.name === 'string' ? body.name : ''
      writeJson(res, 200, { ok: true, ...voiceprint.renameSpeaker(id, name) })
    } catch (error) {
      writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
    }
  }
  const voiceprintRemoveSpeaker = async (req: unknown, res: ServerResponse): Promise<void> => {
    try {
      const body = await readJson(req as IncomingMessage)
      const id = typeof body.id === 'string' ? body.id : ''
      voiceprint.removeSpeaker(id)
      writeJson(res, 200, { ok: true })
    } catch (error) {
      writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
    }
  }
  const voiceprintRoutes: Array<[string, (req: unknown, res: ServerResponse) => void | Promise<void>]> = [
    ['/voiceprint/status', voiceprintStatus],
    ['/voiceprint/prepare', voiceprintPrepare],
    ['/voiceprint/enroll', voiceprintEnroll],
    ['/voiceprint/identify', voiceprintIdentify],
    ['/voiceprint/forget', voiceprintForget],
    ['/voiceprint/speakers/enroll', voiceprintEnrollSpeaker],
    ['/voiceprint/speakers/rename', voiceprintRenameSpeaker],
    ['/voiceprint/speakers/remove', voiceprintRemoveSpeaker],
  ]
  for (const prefix of new Set([base, BOOTSTRAP_BASE])) {
    for (const [route, handler] of voiceprintRoutes) {
      ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: prefix + route, handler }))
    }
  }

  ctx.effect(() => () => { resetPreviewClient() })
}

const PREVIEW_ATTEMPTS = 2

type EdgeTtsClient = ReturnType<typeof createEdgeTts>
/** Auditions reuse one WebSocket; a fresh TLS handshake per click is both slow and flaky. */
let previewClient: EdgeTtsClient | undefined
/** Serializes auditions so two quick clicks cannot race on the shared socket. */
let previewChain: Promise<void> = Promise.resolve()

function resetPreviewClient(): void {
  const client = previewClient
  previewClient = undefined
  if (client) { try { client.close() } catch { /* already closed */ } }
}

async function previewTurn(text: string, requested: string, rate: number): Promise<Buffer> {
  const client = previewClient ?? (previewClient = createEdgeTts())
  await client.setMetadata(requested, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3, {
    wordBoundaryEnabled: false,
    sentenceBoundaryEnabled: false,
  })
  const { audioStream } = await client.toStream(text, { rate: rateToProsody(rate) })
  const chunks: Buffer[] = []
  for await (const chunk of audioStream) chunks.push(chunk as Buffer)
  const audio = Buffer.concat(chunks)
  if (audio.length === 0) throw new Error('empty synthesis')
  return audio
}

/**
 * One-shot audition on top of a persistent connection.
 *
 * The first click pays the handshake; later clicks reuse the open socket.
 * A reset closes and re-dials once before falling back to the system voice.
 */
async function synthesizePreview(text: string, requested: string, rate: number): Promise<Buffer> {
  const run = previewChain.then(async () => {
    let lastError: unknown
    for (let attempt = 1; attempt <= PREVIEW_ATTEMPTS; attempt++) {
      try {
        return await previewTurn(text, requested, rate)
      } catch (error) {
        lastError = error
        resetPreviewClient()
        if (attempt < PREVIEW_ATTEMPTS) {
          await new Promise<void>((resolve) => setTimeout(resolve, 120))
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError))
  })
  previewChain = run.then(() => undefined, () => undefined)
  return run
}

/** How long a client's voice-state heartbeat keeps its session speakable. */
const VOICE_STATE_TTL_MS = 120_000

function voiceSessionActive(active: Map<string, number>, sessionId: string): boolean {
  const seen = active.get(sessionId)
  if (seen === undefined) return false
  if (Date.now() - seen > VOICE_STATE_TTL_MS) {
    active.delete(sessionId)
    return false
  }
  return true
}

/** Final subagent output is content blocks; only text blocks are speech. */
function assistantText(blocks: unknown): string {
  if (!Array.isArray(blocks)) return ''
  return blocks
    .map((block) => block !== null && typeof block === 'object'
      && (block as { type?: unknown }).type === 'text'
      && typeof (block as { text?: unknown }).text === 'string'
      ? (block as { text: string }).text
      : '')
    .filter((text) => text.length > 0)
    .join('\n')
}

/**
 * A spoken result is a glance, not the report. Strip markdown, collapse
 * whitespace, and cut at the last sentence boundary before the budget.
 */
function summarizeForSpeech(text: string, maxChars = 320): string {
  const clean = sanitizeForSpeech(text)
  if (!clean || !hasSpeechContent(clean)) return ''
  if (clean.length <= maxChars) return clean
  const cut = clean.slice(0, maxChars)
  const boundary = Math.max(
    cut.lastIndexOf('。'), cut.lastIndexOf('！'), cut.lastIndexOf('？'),
    cut.lastIndexOf('；'), cut.lastIndexOf('. '),
  )
  const body = boundary >= 80 ? cut.slice(0, boundary + 1) : cut
  return body.trim() + '…'
}

function writeJson(res: ServerResponse, status: number, value: unknown): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify(value))
}

/** Small JSON body reader; voiceprint audio needs a larger cap than a voice id. */
async function readJson(req: IncomingMessage, limit = 64 * 1024): Promise<Record<string, unknown>> {
  return await new Promise((resolve, reject) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk: string) => {
      body += chunk
      if (body.length > limit) { req.destroy(); reject(new Error('body too large')) }
    })
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}') as Record<string, unknown>) }
      catch (error) { reject(error) }
    })
    req.on('error', reject)
  })
}

let replySequence = 0

async function* tapStream(
  sessionId: string,
  inner: AsyncIterable<StreamChunk>,
  queue: TtsQueue,
  control: (command: VoiceControl) => void,
): AsyncIterable<StreamChunk> {
  const replyId = `${sessionId}:${Date.now().toString(36)}:${replySequence++}`
  const segmenter = new SentenceSegmenter()
  const protocol = new VoiceProtocol()
  let directed = false
  const speak = (text: string): void => {
    const clean = sanitizeForSpeech(text)
    if (clean && hasSpeechContent(clean)) queue.enqueue(sessionId, clean, replyId)
  }
  const applyVoice = (command: VoiceCommand): void => {
    if (command.action === 'say') {
      // A say marker is an extra spoken prefix, not a replacement for the
      // answer. Suppressing the visible answer here was why the final output
      // could be silent after a short marker.
      speak(command.text)
      return
    }
    if (command.action === 'rate') {
      control({ action: 'rate', rate: command.rate, delta: command.delta })
      return
    }
    if (command.action === 'stop') directed = true
    control(command)
  }
  let completed = false
  let flushed = false
  let finishReason: unknown = null
  const flushOnce = (): void => {
    if (flushed) return
    flushed = true
    for (const sentence of segmenter.flush()) speak(sentence)
  }
  try {
    for await (const chunk of inner) {
      if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string') {
        for (const command of protocol.feed(chunk.text)) applyVoice(command)
      }
      if (isSpeakableChunk(chunk)) {
        // The model sometimes writes a directive in the visible answer. The
        // segmenter strips it from speech; parse it here so its content is
        // spoken rather than silently discarded.
        for (const command of protocol.feed(chunk.text)) applyVoice(command)
        if (!directed) {
          for (const sentence of segmenter.feed(chunk.text)) speak(sentence)
        }
      }
      if (chunk.type === 'finish') finishReason = chunk.reason
      yield chunk
    }
    completed = true
  } finally {
    // Do not speak a fragment from an aborted or failed stream.
    const aborted = finishReason !== null && typeof finishReason === 'object'
      && (finishReason as { kind?: unknown }).kind === 'aborted'
    protocol.flush()
    if (completed && !aborted) flushOnce()
  }
}
