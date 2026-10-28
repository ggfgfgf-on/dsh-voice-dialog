/** dsh-voice-dialog host half: llm/stream tap -> sentence segmentation -> Edge TTS -> SSE. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts'
import { SentenceSegmenter } from './segmenter.ts'
import { isSpeakableChunk, shouldSpeak } from './speech-filter.ts'
import { TtsQueue, type VoiceFrame } from './tts-queue.ts'

export const name = 'voice-dialog'
export const inject = ['webServer', 'tools', 'systemPrompt']

/** Fixed bootstrap path so the client can discover a custom basePath. */
const BOOTSTRAP_BASE = '/dsh-voice-dialog-api'
const SETTINGS_FILE = join(homedir(), '.dsh', 'voice-dialog', 'settings.json')

export interface VoiceControl {
  action: 'volume' | 'stop' | 'repeat'
  level?: number
  delta?: number
}

export interface Config {
  /** Turn automatic read-aloud on or off. */
  enabled: boolean
  /** SSE/config route prefix. */
  basePath: string
  /** Initial Edge TTS voice id; the settings page may override it. */
  voice: string
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  basePath: z.string().default(BOOTSTRAP_BASE),
  voice: z.string().default('zh-CN-XiaoxiaoNeural'),
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

/** Apply the read-aloud stream and its transport. */
export function apply(ctx: Context, config: Config): void {
  const base = config.basePath.replace(/\/+$/, '') || BOOTSTRAP_BASE
  let voice = storedVoice(config.voice)
  type SseSend = (event: 'audio' | 'control', data: VoiceFrame | VoiceControl) => void
  const clients = new Set<SseSend>()
  const queue = new TtsQueue({ voice })
  const broadcast = (event: 'audio' | 'control', data: VoiceFrame | VoiceControl): void => {
    for (const send of clients) {
      try {
        send(event, data)
      } catch {
        // A dead SSE connection is removed by its close handler.
      }
    }
  }

  const unsubscribe = queue.subscribe((frame) => { broadcast('audio', frame) })
  ctx.effect(() => unsubscribe)
  ctx.effect(() => async () => { await queue.close() })

  // Model-facing audio control for spoken meta-commands such as
  // "louder", "repeat that" or "stop talking". The browser applies it
  // immediately over the same SSE connection as the audio frames.
  const tools = (ctx as unknown as { tools: { register(definition: unknown): () => void } }).tools
  ctx.effect(() => tools.register({
    name: 'voice_dialog',
    description: 'Control the live voice-dialog audio. Call this when the user\'s voice input is a '
      + 'meta-command about the speaking itself, not normal conversation content: '
      + '"轻一点/小点声" -> action volume with delta -0.15; "响一点/大点声" -> action volume with delta 0.15; '
      + '"听不清/什么/再说一遍/重复一遍" -> action repeat; "别说了/闭嘴/停/安静" -> action stop. '
      + 'Do not call this for ordinary questions. The microphone stays on after stop.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['volume', 'stop', 'repeat'],
          description: 'volume adjusts playback loudness; stop silences the current reply; repeat replays the last reply.',
        },
        level: { type: 'number', minimum: 0, maximum: 1, description: 'Absolute playback volume for action volume.' },
        delta: { type: 'number', minimum: -1, maximum: 1, description: 'Relative volume change for action volume, e.g. -0.15 or 0.15.' },
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
      throw new Error('voice_dialog action must be volume, stop or repeat')
    },
  }))

  const systemPrompt = (ctx as unknown as { systemPrompt: { section(section: unknown): () => void } }).systemPrompt
  ctx.effect(() => systemPrompt.section({
    name: 'voice-dialog',
    order: 240,
    text: 'Voice input may contain meta-commands about the speaking itself. When the latest user '
      + 'utterance asks to change volume (轻一点/响一点), repeat (再说一遍/重复一遍/听不清/什么), or stop '
      + '(别说了/闭嘴/停), call voice_dialog instead of only replying in text. Never read reasoning or '
      + 'tool arguments aloud; only the final assistant reply is read.',
  }))

  ctx.on('llm/stream', (options: GenerateOptions, next): AsyncIterable<StreamChunk> => {
    const sessionId = options.sessionId
    // Auxiliary calls (compaction, session title) use the same session id but
    // are not assistant speech. Reasoning and tool arguments are filtered by
    // isSpeakableChunk below, so the model's chain of thought is never read.
    if (!shouldSpeak(options, config.enabled)) return next()
    return tapStream(sessionId, next(), queue)
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
    writeJson(res, 200, { basePath: base, voice, enabled: config.enabled })
  }
  for (const prefix of new Set([base, BOOTSTRAP_BASE])) {
    ctx.effect(() =>
      ctx.webServer.register({ kind: 'exact', path: `${prefix}/config`, handler: configHandler }),
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
          const next = typeof body.voice === 'string' ? body.voice.trim() : ''
          if (!isVoiceId(next)) { writeJson(res, 400, { error: 'invalid voice id' }); return }
          await queue.setVoice(next)
          voice = next
          mkdirSync(dirname(SETTINGS_FILE), { recursive: true })
          writeFileSync(SETTINGS_FILE, JSON.stringify({ voice }), 'utf8')
          writeJson(res, 200, { ok: true, voice })
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
        let preview: MsEdgeTTS | undefined
        try {
          const body = await readJson(req)
          const text = typeof body.text === 'string' ? body.text.trim().slice(0, 300) : ''
          const requested = typeof body.voice === 'string' && isVoiceId(body.voice) ? body.voice : voice
          if (!text) { writeJson(res, 400, { error: 'empty text' }); return }
          preview = new MsEdgeTTS()
          await preview.setMetadata(requested, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3, {
            wordBoundaryEnabled: false,
            sentenceBoundaryEnabled: false,
          })
          const { audioStream } = await preview.toStream(text)
          const chunks: Buffer[] = []
          for await (const chunk of audioStream) chunks.push(chunk as Buffer)
          const audio = Buffer.concat(chunks)
          if (audio.length === 0) { writeJson(res, 502, { error: 'empty synthesis' }); return }
          res.writeHead(200, { 'content-type': 'audio/mpeg', 'content-length': String(audio.length) })
          res.end(audio)
        } catch (error) {
          writeJson(res, 502, { error: error instanceof Error ? error.message : String(error) })
        } finally {
          if (preview) { try { await preview.close() } catch { /* already closed */ } }
        }
      },
    }),
  )
}

function writeJson(res: ServerResponse, status: number, value: unknown): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify(value))
}

/** Small JSON body reader; the settings payload is a single voice id. */
async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return await new Promise((resolve, reject) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk: string) => {
      body += chunk
      if (body.length > 64 * 1024) { req.destroy(); reject(new Error('body too large')) }
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
): AsyncIterable<StreamChunk> {
  const replyId = `${sessionId}:${Date.now().toString(36)}:${replySequence++}`
  const segmenter = new SentenceSegmenter()
  let completed = false
  let flushed = false
  let finishReason: unknown = null
  const flushOnce = (): void => {
    if (flushed) return
    flushed = true
    for (const sentence of segmenter.flush()) queue.enqueue(sessionId, sentence, replyId)
  }
  try {
    for await (const chunk of inner) {
      if (isSpeakableChunk(chunk)) {
        for (const sentence of segmenter.feed(chunk.text)) queue.enqueue(sessionId, sentence, replyId)
      }
      if (chunk.type === 'finish') finishReason = chunk.reason
      yield chunk
    }
    completed = true
  } finally {
    // Do not speak a fragment from an aborted or failed stream.
    const aborted = finishReason !== null && typeof finishReason === 'object'
      && (finishReason as { kind?: unknown }).kind === 'aborted'
    if (completed && !aborted) flushOnce()
  }
}
