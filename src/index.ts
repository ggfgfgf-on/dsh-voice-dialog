/** dsh-voice-dialog host half: llm/stream tap -> sentence segmentation -> Edge TTS -> SSE. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { OUTPUT_FORMAT } from 'msedge-tts'
import { buildSpeakerPrompt, parseSpeakerLines, SPEAKER_MAX_TOKENS, SPEAKER_SYSTEM_PROMPT } from './speaker.ts'
import {
  ATTENTION_MAX_TOKENS, ATTENTION_SYSTEM_PROMPT, attentionForSpeech, buildAttentionPrompt,
  parseAttentionMap, splitAttentionBlocks,
} from './attention.ts'
import {
  isLikelyRepeat, newLineText, REWRITE_MAX_TOKENS, REWRITE_SYSTEM_PROMPT, speechKey, StagedRewriter,
} from './rewriter.ts'
import { hasSpeechContent, sanitizeForSpeech, SentenceSegmenter, stripFillerHead, type SpeechBlock } from './segmenter.ts'
import { isSpeakableChunk, shouldSpeak } from './speech-filter.ts'
import { VisibleVoiceFilter } from './voice-marker.ts'
import { createEdgeTts, rateToProsody, TtsQueue, type VoiceFrame } from './tts-queue.ts'
import {
  ADJUSTMENTS, applyExpression, BREATH_GAP_MS, breathSeam, CONSTRUCTS, EXPRESS_TOKENS, expressionProsody,
  expressionSsmlChunks, MARK_LIMITS, normalizeVoiceUnits, pauseMsFor, splitStress, STEP_LIMITS, STYLES,
  STYLE_TOKENS, VOCABULARY, type VoiceUnit,
} from './expression.ts'
import { normalizeSpeechProfile, type SpeechProfile } from './speech-profile.ts'
import { decodeWavBase64, VoiceprintService } from './voiceprint.ts'
import { decodeAudioFrames } from './audio-transport.ts'
import { encodeWavBase64, SeparationService } from './separation.ts'
import { parseOrganizerResponse, type OrganizerPendingBlock } from './organizer.ts'
import {
  buildGatePrompt, GATE_MAX_TOKENS, GATE_SYSTEM_PROMPT, GATE_TIMEOUT_MS,
} from './gate-prompt.ts'
import {
  buildPlannerPrompt, PLANNER_MAX_TOKENS, PLANNER_SYSTEM_PROMPT, PLANNER_TIMEOUT_MS,
} from './planner.ts'
import { arrangementChanged, planChunkOutputOrder } from './arrange.ts'
import { ORGANIZER_SYSTEM_PROMPT_COMPACT, buildCompactOrganizerPrompt } from './organizer-compact.ts'
import { sanitizeLatencyRecord } from './latency.ts'
import { VOLUME_LOG_ROUTES } from './volume-log.ts'
import {
  boundedOrganizerBlocks, buildOrganizerPrompt,
  ORGANIZER_SYSTEM_PROMPT, OrganizerHistory,
} from './organizer-history.ts'
import { VoiceProtocol, type VoiceCommand } from './voice-protocol.ts'
import {
  FAST_LANE_MAX_TOKENS, FAST_LANE_SYSTEM_PROMPT, FAST_LANE_TIMEOUT_MS, FastLaneServo,
  parseFastLaneAnswer,
} from './fast-lane.ts'

export const name = 'voice-dialog'
export const inject = ['webServer', 'tools', 'systemPrompt', 'llm']

/** Fixed bootstrap path so the client can discover a custom basePath. */
const BOOTSTRAP_BASE = '/dsh-voice-dialog-api'
const SETTINGS_FILE = join(homedir(), '.dsh', 'voice-dialog', 'settings.json')

/** Staged-rewriter model call, provided by apply() so the tap stays ctx-free. */
let rewriteModel: ((sessionId: string, prompt: string, signal: AbortSignal) => Promise<string>) | undefined
let speakerModel: ((sessionId: string, prompt: string, signal: AbortSignal) => Promise<string>) | undefined
/** Attention pass: read the whole reply, score its blocks, then let the composer speak from that. */
let attentionModel: ((sessionId: string, prompt: string, signal: AbortSignal) => Promise<string>) | undefined
let rewriteEnabled = true
/** Fast-lane model call: one short spoken line while a long reasoning run is still going. */
let fastLaneModel: ((sessionId: string, prompt: string, signal: AbortSignal) => Promise<string>) | undefined
/** The owner's last words per session: the speaking layer leads with what was asked. */
const lastUserSpeech = new Map<string, string>()
let fastLaneEnabled = true

export interface VoiceControl {
  action: 'volume' | 'rate' | 'stop' | 'repeat' | 'speaker' | 'yield' | 'speech'
  /** Interruption contract for the assistant's own speech; only for action yield. */
  mode?: 'sentence' | 'immediate' | 'never'
  /** Model-declared speech profile; only for action speech. */
  profile?: SpeechProfile
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
  /** Rewrite the unread blocks into one spoken script (default on; false = read block by block). */
  rewriteEnabled?: boolean
  /** Speak one short line while a long reasoning run is still going (default on). */
  fastLaneEnabled?: boolean
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  basePath: z.string().default(BOOTSTRAP_BASE),
  voice: z.string().default('zh-CN-XiaoxiaoNeural'),
  rate: z.number().default(0),
  rewriteEnabled: z.boolean().default(true),
  fastLaneEnabled: z.boolean().default(true),
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
/** Two "separated" streams this similar are one voice split in half. */
const SAME_SPEAKER_SIMILARITY = 0.62
  let voice = storedVoice(config.voice)
  let rate = storedRate(config.rate)
  /** The model's own speech declaration; empty means "use today's behaviour". */
  let declaredSpeechProfile: SpeechProfile = {}
  type SseSend = (event: 'audio' | 'control', data: VoiceFrame | VoiceControl) => void
  const clients = new Set<SseSend>()
  const queue = new TtsQueue({ voice })
  queue.setRate(rate)
  const voiceprint = new VoiceprintService()
  const separation = new SeparationService()
  const broadcast = (event: 'audio' | 'control', data: VoiceFrame | VoiceControl): void => {
    const payload = event === 'audio' ? electOwner(data as VoiceFrame) : data
    for (const send of clients) {
      try {
        send(event, payload)
      } catch {
        // A dead SSE connection is removed by its close handler.
      }
    }
  }

  /** Stamp the elected client on a frame; an unclaimed session stays unaddressed. */
  const electOwner = (frame: VoiceFrame): VoiceFrame => {
    const owner = ownerFor(frame.sessionId)
    return owner === undefined ? frame : { ...frame, owner }
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
  const unsubscribe = queue.subscribe((frame) => {
    broadcast('audio', frame)
  })
  ctx.effect(() => unsubscribe)
  ctx.effect(() => async () => { await queue.close() })
  ctx.effect(() => () => { void separation.close() })
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
  /**
   * The one client that speaks a session. Every tab subscribes to the same
   * stream, so the host names the speaker instead of letting each tab decide
   * from its own microphone flag - that is what made a stale tab go silent.
   */
  const voiceOwner = new Map<string, { clientId: string; at: number }>()
  const ownerFor = (sessionId: string): string | undefined => {
    const owner = voiceOwner.get(sessionId)
    if (!owner) return undefined
    if (Date.now() - owner.at > VOICE_OWNER_TTL_MS) {
      voiceOwner.delete(sessionId)
      return undefined
    }
    return owner.clientId
  }
  // The organizer reuses the provider/model that just produced the reply.
  // Unknown sessions still get a safe "queue" answer.
  const lastModelTarget = new Map<string, { provider: string; model: string }>()
  const organizerHistories = new Map<string, OrganizerHistory>()
  const organizerHistoryFor = (sessionId: string): OrganizerHistory => {
    let history = organizerHistories.get(sessionId)
    if (!history) {
      history = new OrganizerHistory()
      organizerHistories.set(sessionId, history)
    }
    return history
  }
  const voiceSessionLive = (sessionId: string): boolean => {
    const live = voiceSessionActive(activeVoice, sessionId)
    if (!live) organizerHistories.delete(sessionId)
    return live
  }
  const childParents = new Map<string, string>()
  const announcedRuns = new Set<string>()
  /**
   * Services built later in this mount, resolved by reference. The handlers
   * below are registered first and can fire while the plugin is still setting
   * itself up; touching a const directly from there is a declaration-order trap
   * that shows up as "X is not defined". Everything early goes through here.
   */
  const wiring: {
    speakDirect?: (sessionId: string, text: string, source: string) => void
    forgetSession?: (sessionId: string) => void
    isLive?: (sessionId: string) => boolean
  } = {}
  ctx.on('session/disposed', (session: any) => {
    try {
      const sessionId = String(session?.id ?? '')
      if (!sessionId) return
      activeVoice.delete(sessionId)
      wiring.forgetSession?.(sessionId)
      lastModelTarget.delete(sessionId)
      organizerHistories.delete(sessionId)
    } catch {
      // A session without a readable id has no history to clear.
    }
  })
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
      if (parent === undefined || wiring.isLive?.(parent) !== true) return
      const summary = summarizeForSpeech(assistantText(info?.lastAssistantMessage))
      if (!summary) return
      announcedRuns.add(runId)
      childParents.delete(childId)
      const spoken = /^(另外|还有|补充)/.test(summary) ? summary : '补充一下，' + summary
      wiring.speakDirect?.(parent, spoken, 'subagent-' + runId)
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
      + 'Action yield declares how your OWN speech may be interrupted while it is read aloud: mode sentence finishes the '
      + 'sentence being spoken and then drops the rest (default for normal answers), immediate cuts at once, '
      + 'never keeps playing to the end. Declare it before or during a long answer when the listener is likely to talk over you. '
      + 'The owner cannot be renamed or ignored. Do not call this for ordinary questions. The microphone stays on after stop. '
      + 'Action speech declares how your own answer is split, paced and interrupted: every field is optional and only overrides the built-in default, e.g. {"interruption":"sentence","mergeMaxChars":80,"betweenBlocksMs":150}. '
      + 'Action express is an OPTIONAL assist for delivery detail: it speaks an ordered sequence of steps, each either a speak step (say plus optional tone, pace, stress, breath, lengthen, rate, pitch, volume) or a pause step. ' + 'The optional numbers are per-step adjustments on top of the plugin base and shape THAT step only; they never replace the base. '
      + 'Without it nothing changes and a normal answer keeps today\'s delivery. It shapes how YOUR OWN speech sounds, not a settings panel; you express intent and the plugin owns the acoustics. '
      + 'Action capabilities publishes the authoritative token vocabulary (tone/pace/pause with a one-line meaning each) and the current read-only base; call it instead of guessing a token name.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['volume', 'rate', 'stop', 'repeat', 'speaker', 'yield', 'speech', 'express', 'capabilities'],
          description: 'volume adjusts playback loudness; rate adjusts speaking speed for following sentences; stop silences the current reply; repeat replays the last reply; speaker renames a guest voiceprint and/or changes how that guest is delivered; yield declares how your own read-aloud speech may be interrupted.',
        },
        level: { type: 'number', minimum: 0, maximum: 1, description: 'Absolute playback volume for action volume.' },
        rate: { type: 'number', minimum: -50, maximum: 50, description: 'Absolute speaking rate in percent for action rate, e.g. -20 or 20.' },
        delta: { type: 'number', minimum: -50, maximum: 50, description: 'Relative change: volume uses -1..1, rate uses -50..50 percent.' },
        speaker: { type: 'string', description: 'Guest voiceprint label for action speaker, e.g. 客人1, 说话人1, or a name the model assigned earlier; use * for all guests. The owner 我 cannot be changed.' },
        policy: { type: 'string', enum: ['queue', 'steer', 'ignore', 'default'], description: 'Delivery policy for action speaker: queue, steer, ignore, or default to restore the browser setting.' },
        name: { type: 'string', description: 'New short name for this guest voiceprint, e.g. 老婆 or 老王. Future transcripts and policies can use it. Only for a specific guest, not * or 我.' },
        profile: {
          type: 'object',
          additionalProperties: false,
          description: 'Speech profile for action speech. Every field is optional and only overrides the built-in default.',
          properties: {
            interruption: { type: 'string', enum: ['sentence', 'immediate', 'never'], description: 'How your own speech may be interrupted. sentence finishes the sentence being spoken.' },
            mergeMaxChars: { type: 'number', minimum: 8, maximum: 400, description: 'Longest line that may join a merged synthesis request.' },
            mergeRunMaxChars: { type: 'number', minimum: 8, maximum: 1200, description: 'Hard cap for one merged synthesis request.' },
            mergeRunMaxItems: { type: 'number', minimum: 1, maximum: 32, description: 'How many lines may share one synthesis request.' },
            betweenBlocksMs: { type: 'number', minimum: 0, maximum: 2000, description: 'Silence inserted between spoken blocks; 0 starts the next block at once.' },
            micSilenceMs: { type: 'number', minimum: 400, maximum: 4000, description: 'Silence that closes the listener utterance before recognition.' },
            separationSilenceMs: { type: 'number', minimum: 400, maximum: 4000, description: 'Tail silence for a separated speaker stream.' },
          },
        },
        sequence: {
          type: 'array',
          maxItems: 12,
          description: 'Ordered steps for action express. Steps play in array order; one call may carry a whole reply or a single special line.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              say: { type: 'string', description: 'Text to speak for this step, at most 200 characters.' },
              rate: { type: 'number', minimum: STEP_LIMITS.rate.min, maximum: STEP_LIMITS.rate.max, description: STEP_LIMITS.rate.meaning },
              pitch: { type: 'number', minimum: STEP_LIMITS.pitch.min, maximum: STEP_LIMITS.pitch.max, description: STEP_LIMITS.pitch.meaning },
              volume: { type: 'number', minimum: STEP_LIMITS.volume.min, maximum: STEP_LIMITS.volume.max, description: STEP_LIMITS.volume.meaning },
              tone: { type: 'string', enum: [...EXPRESS_TOKENS.tone], description: 'Delivery colour; the plugin maps it to acoustics.' },
              style: {
                type: 'string',
                enum: [...STYLE_TOKENS],
                description: 'A named delivery sequence the plugin already tuned (tender, coy, hurt, sleepy, whisper…). It fills tone, pace, numbers and an ending contour; anything this step declares itself wins. Prefer this over hand-picked numbers.',
              },
              pace: { type: 'string', enum: [...EXPRESS_TOKENS.pace], description: 'Local pace intent for this step.' },
              stress: { type: 'array', items: { type: 'string' }, maxItems: 4, description: 'Words inside say to lean on; each becomes a short emphasised fragment.' },
              granularity: { type: 'string', enum: ['smooth', 'fine'], description: 'Where a marked line may be cut. smooth (default) cuts only at punctuation, so a phrase is never spliced; fine allows a cut anywhere to bend every single character, and that seam is audible.' },
              breath: { type: 'boolean', description: 'Breathy delivery: a soft seam and a trailing pause.' },
              lengthen: { type: 'boolean', description: 'Draw the tail out instead of closing it hard.' },
              mark: {
                type: 'array',
                maxItems: MARK_LIMITS.max,
                description: MARK_LIMITS.meaning,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    at: { type: 'integer', minimum: 0, maximum: 199, description: '从第几个字开始（从 0 数，按字符计）。' },
                    to: { type: 'integer', minimum: 0, maximum: 200, description: '到第几个字为止，不含该字；不填就只改一个字。' },
                    tone: { type: 'string', enum: [...EXPRESS_TOKENS.tone], description: '这几个字的语气。' },
                    pace: { type: 'string', enum: [...EXPRESS_TOKENS.pace], description: '这几个字的语速。' },
                    rate: { type: 'number', minimum: STEP_LIMITS.rate.min, maximum: STEP_LIMITS.rate.max, description: '这几个字的语速增减。' },
                    pitch: { type: 'number', minimum: STEP_LIMITS.pitch.min, maximum: STEP_LIMITS.pitch.max, description: '这几个字的音高增减。' },
                    volume: { type: 'number', minimum: STEP_LIMITS.volume.min, maximum: STEP_LIMITS.volume.max, description: '这几个字的响度增减。' },
                  },
                  required: ['at'],
                },
              },
              pause: { type: 'string', enum: [...EXPRESS_TOKENS.pause], description: 'A silence with no text.' },
            },
          },
        },
        mode: { type: 'string', enum: ['sentence', 'immediate', 'never'], description: 'Interruption contract for action yield: sentence finishes the audible sentence then drops the rest (default), immediate cuts now, never lets the reply finish uninterrupted.' },
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
          mode: { type: 'string' },
          profile: { type: 'object' },
          lines: { type: 'number' },
          expressAvailable: { type: 'boolean' },
          vocabulary: { type: 'object' },
          base: { type: 'object' },
        },
        required: ['ok', 'action'],
      },
      render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }],
    },
    execute: (args: unknown) => {
      const input = (args ?? {}) as Record<string, unknown>
      const action = input.action
      if (action === 'capabilities') {
        return Promise.resolve({
          ok: true,
          action: 'capabilities',
          expressAvailable: true,
          vocabulary: {
            tone: VOCABULARY.tone,
            pace: VOCABULARY.pace,
            pause: VOCABULARY.pause,
            adjustments: ADJUSTMENTS,
            constructs: CONSTRUCTS,
            mark: MARK_LIMITS,
            granularity: {
              smooth: '默认：只在标点处断句，一句话不会被从中间劈开。',
              fine: '允许在任意两个字之间断开，能逐字改音高，代价是接缝听起来像被切开。',
            },
            styles: STYLE_TOKENS.map((value) => ({ value, meaning: STYLES[value].meaning })),
          },
          base: queue.prosodyBase(),
        })
      }
      if (action === 'express') {
        const requested = input.sequence ?? input.units ?? input.lines
        const steps = normalizeVoiceUnits(requested)
        if (steps.length === 0) {
          throw new Error('voice_dialog express needs at least one valid step')
        }
        let live: string | undefined
        let seenAt = -Infinity
        for (const [id, at] of activeVoice) {
          if (!voiceSessionLive(id)) continue
          if (at > seenAt) { seenAt = at; live = id }
        }
        if (live === undefined) throw new Error('voice_dialog express needs a live voice session')
        const base = queue.prosodyBase()
        const replyId = 'express-' + Date.now()
        const expanded: VoiceUnit[] = []
        for (const step of steps) {
          if (step.pause !== undefined) { expanded.push(step); continue }
          for (const piece of splitStress(step)) expanded.push(piece)
        }
        // Buffer one step so a following pause becomes the gap AFTER the block
        // it follows, which is where the listener actually hears it.
        type Ready = {
          text: string
          prosody: { rate: string; pitch: string; volume: string }
          gapAfterMs: number
          ssml?: string
        }
        // A marked step expands to several requests, so the buffer is a list.
        let buffered: Ready[] = []
        let chunkIndex = 0
        let spoken = 0
        const flush = (): void => {
          if (buffered.length === 0) return
          for (const ready of buffered) {
            queue.enqueue(live as string, ready.text, replyId, 0, {
              prosody: ready.prosody,
              ...(ready.ssml === undefined ? {} : { ssml: ready.ssml }),
              ...(ready.gapAfterMs > 0 ? { gapAfterMs: ready.gapAfterMs } : {}),
              chunkIndex: chunkIndex++,
            })
          }
          buffered = []
        }
        for (const step of expanded) {
          if (step.pause !== undefined) {
            const last = buffered[buffered.length - 1]
            if (last !== undefined) last.gapAfterMs += pauseMsFor(step.pause)
            continue
          }
          flush()
          const prosody = expressionProsody(step, base)
          const chunks = expressionSsmlChunks(step, base)
          if (chunks !== undefined) {
            buffered = chunks.map((chunk) => ({ text: chunk.text, ssml: chunk.ssml, prosody, gapAfterMs: 0 }))
          } else {
            // A marked step keeps its text verbatim: rewriting it would move the marks.
            const text = applyExpression(step)
            const seam = step.breath === true ? breathSeam(text) : undefined
            buffered = seam === undefined
              ? [{ text, prosody, gapAfterMs: 0 }]
              : [
                { text: seam[0], prosody, gapAfterMs: BREATH_GAP_MS },
                { text: seam[1], prosody, gapAfterMs: 0 },
              ]
          }
          spoken += 1
        }
        flush()
        return Promise.resolve({ ok: true, action: 'express', lines: spoken })
      }
      if (action === 'speech') {
        const declared = normalizeSpeechProfile(input.profile)
        if (Object.keys(declared).length === 0) {
          throw new Error('voice_dialog speech needs at least one valid profile field')
        }
        declaredSpeechProfile = { ...declaredSpeechProfile, ...declared }
        queue.setLimits({
          mergeMaxChars: declaredSpeechProfile.mergeMaxChars,
          mergeRunMaxChars: declaredSpeechProfile.mergeRunMaxChars,
          mergeRunMaxItems: declaredSpeechProfile.mergeRunMaxItems,
        })
        broadcast('control', { action: 'speech', profile: declaredSpeechProfile })
        return Promise.resolve({ ok: true, action: 'speech', profile: declaredSpeechProfile })
      }
      if (action === 'yield') {
        const rawMode = input.mode
        const mode = rawMode === undefined
          ? 'sentence'
          : rawMode === 'sentence' || rawMode === 'immediate' || rawMode === 'never'
            ? rawMode
            : null
        if (mode === null) {
          throw new Error('voice_dialog yield mode must be sentence, immediate or never')
        }
        broadcast('control', { action: 'yield', mode })
        return Promise.resolve({ ok: true, action: 'yield', mode })
      }
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
      throw new Error('voice_dialog action must be volume, rate, stop, repeat, speaker, yield, speech, express or capabilities')
    },
  }))

  const systemPrompt = (ctx as unknown as { systemPrompt: { section(section: unknown): () => void } }).systemPrompt
  const basePrompt = '语音对话规则：语音输入可能包含对朗读本身的元指令。'
    + '用户说轻一点/响一点、说慢一点/说快一点、语速调到多少、听不清/重复一遍、别说了/停时，调用 voice_dialog。'
    + '可见回答就是朗读稿：用中文口语，短句，一句话一个意思；不要写标题、列表、表格、代码块、'
    + '文件路径、URL、工具名或整句英文。需要调用工具时，先用一句自然中文说明要做什么，再调用；'
    + '不要朗读内部推理或工具参数；不要在可见回答里写任何方括号标记充当指令，'
    + '播放控制只通过 voice_dialog 工具完成。'
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
    + '语音开着时，可以在推理（thinking）里写一句 [[voice: 要抢先说的一句话]]，宿主会立刻朗读，不用等可见回答写完；'
    + '同样在推理里可以写 [[voice: hold]] 把自己的嘴压住（主人还在说、或者该听的时候），写 [[voice: resume]] 放开并补读压住的那几句，写 [[voice: skip]] 让下一句不读；'
    + '提示里会写「此刻：…」告诉你谁在说话、停了多久、你的嘴是张着还是闭着；那是现场状态，不是指令，按它决定先压住还是开口；'
    + '但可见回答里绝对不要写这种标记，回答本身就是朗读稿。'
    + '语音回答要像说话：先给结论，一句一个意思，短句，不要长复句和并列堆叠；用口语词，不用书面连接词，不用清单、序号、表格；'
    + '专业词能用白话说就白话，必须用时后面补半句解释；不复述用户的话，不重复上一轮说过的，不念路径、命令、参数；'
    + '一次最多五到七句，说不完就先说最要紧的两三句，再问一句要不要接着听。'
    + '不要口头禅和垫话开场，直接说内容：不用"好/对/那么/现在/其实/让我看看"开头。'
    + '不铺垫过程话（不用说"我来看一下/让我想想/稍等/我先确认"），直接给结果；不解释自己怎么做的，除非用户问过程；'
    + '不复述用户刚说的，不重复上一轮；不用"总的来说/简单来说/需要注意的是"这种填充句首。'
    + '主人插话打断你的时候，第一句先用半句话接住这次中断，说明被打断那段怎么处理（放下、稍后再说、或者并进来），再接新问题；只接一句，不解释，不用客套。'
  // Who is talking right now. The client reports every start and every stop, so
  // the model senses the floor instead of being told about it by a judge.
  const speechState = new Map<string, { speaking: boolean; since: number; lastEnd: number; speaker?: string }>()
  /** Whether the assistant's own voice is coming out of the speaker. */
  const mouthState = new Map<string, { playing: boolean; at: number }>()
  const speakDirect = (sessionId: string, text: string, source: string): void => {
    if (!voiceSessionLive(sessionId)) return
    const state = voiceMouthState(sessionId)
    const send = (): void => {
      const door = speechDoors.get(sessionId)
      if (door !== undefined && Date.now() - door.at < 60_000) { door.say(text); return }
      queue.enqueue(sessionId, text, 'direct-' + source + '-' + Date.now())
    }
    if (state.held) { state.parked.push(send); return }
    send()
  }
  wiring.speakDirect = speakDirect
  wiring.isLive = (sessionId: string) => voiceSessionLive(sessionId)
  wiring.forgetSession = (sessionId: string) => {
    speechState.delete(sessionId)
    mouthState.delete(sessionId)
    voiceMouth.delete(sessionId)
    speechDoors.delete(sessionId)
  }
  const recordSpeech = (sessionId: string, speaking: boolean): void => {
    const now = Date.now()
    const previous = speechState.get(sessionId)
    if (speaking) {
      speechState.set(sessionId, { speaking: true, since: previous?.speaking ? previous.since : now, lastEnd: previous?.lastEnd ?? 0, speaker: previous?.speaker })
      return
    }
    speechState.set(sessionId, { speaking: false, since: previous?.since ?? now, lastEnd: now, speaker: previous?.speaker })
  }
  const speechLine = (): string => {
    const now = Date.now()
    let talking: { since: number; speaker?: string } | undefined
    let lastEnd = -1
    for (const state of speechState.values()) {
      if (state.speaking && now - state.since < 60_000 && (talking === undefined || state.since > talking.since)) {
        talking = { since: state.since, speaker: state.speaker }
      }
      if (!state.speaking && state.lastEnd > lastEnd) lastEnd = state.lastEnd
    }
    let mouth = ''
    for (const state of mouthState.values()) {
      if (now - state.at > 20_000) continue
      mouth = state.playing ? '你的嘴现在是张着的（正在读）。' : '你的嘴现在是闭着的。'
      if (state.playing) break
    }
    if (talking !== undefined) {
      const who = talking.speaker ? talking.speaker : '有人'
      return `此刻：${who}正在说话（已 ${((now - talking.since) / 1000).toFixed(1)} 秒），先别抢。${mouth}`
    }
    if (lastEnd >= 0 && now - lastEnd < 15_000) {
      return `此刻：没人说话，最后开口的是${lastSpeakerName()}，在 ${((now - lastEnd) / 1000).toFixed(1)} 秒前。${mouth}`
    }
    return `此刻：没人说话。${mouth}`
  }
  const lastSpeakerName = (): string => {
    let name = '有人'
    for (const state of speechState.values()) { if (state.speaker) name = state.speaker }
    return name
  }
  // The work layer reports upward: every tool the assistant starts says, in one
  // short line, where the hands are. That is what keeps the mouth from going
  // silent for the length of a build. Tool names are fixed identifiers, so the
  // mapping is deterministic, never a guess about what the user meant.
  const workSpoken = new Map<string, number>()
  const workPhrase = (name: string): string => {
    if (/^(read|glob|grep)/.test(name)) return '我在翻文件。'
    if (/^(edit|write)/.test(name)) return '我在改。'
    if (/^(pwsh|desktop_|browser_)/.test(name)) return '我在跑命令。'
    if (/^(web_search|web_fetch)/.test(name)) return '我上网查一下。'
    if (/^(subagent|send_message|list_agents)/.test(name)) return '我让分身去查。'
    if (/^(run_code|vision_)/.test(name)) return '我在算。'
    return '我在弄。'
  }
  ctx.on('tools/execute', (exec: any, next: any): any => {
    try {
      const sessionId = String(exec?.agent?.session?.id ?? '')
      const name = typeof exec?.name === 'string' ? exec.name : ''
      if (sessionId && name && voiceSessionLive(sessionId)) {
        const now = Date.now()
        const last = workSpoken.get(sessionId) ?? 0
        const mouth = mouthState.get(sessionId)
        const quiet = mouth === undefined || (!mouth.playing && now - mouth.at > 3000)
        if (quiet && now - last > 5000) {
          workSpoken.set(sessionId, now)
          speakDirect(sessionId, workPhrase(name), 'work-' + now)
        }
      }
    } catch {
      // Progress speech is cosmetic: it must never break a tool call.
    }
    return next()
  })

  ctx.effect(() => systemPrompt.section({
    name: 'voice-dialog',
    order: 240,
    text: () => {
      let live = false
      for (const sessionId of activeVoice.keys()) {
        if (voiceSessionLive(sessionId)) { live = true; break }
      }
      return live ? basePrompt + ' ' + liveVoicePrompt + ' ' + speechLine() : basePrompt
    },
  }))

  ctx.on('llm/stream', (options: GenerateOptions, next): AsyncIterable<StreamChunk> => {
    const sessionId = options.sessionId
    if (sessionId !== undefined && options.purpose === undefined
      && typeof options.provider === 'string' && typeof options.model === 'string') {
      lastModelTarget.set(sessionId, { provider: options.provider, model: options.model })
    }
    // Auxiliary calls (compaction, session title, voice organizer) use the same
    // session id but are not assistant speech. Reasoning is only scanned for
    // explicit [[voice:...]] directives; its text is never read aloud wholesale.
    if (!shouldSpeak(options, config.enabled)) return next()
    // Outside a live voice session the plugin must be invisible to DSH: no
    // stream tap, no sentence segmentation, no speech traffic at all.
    if (sessionId === undefined || !voiceSessionLive(sessionId)) return next()
    return tapStream(sessionId, next(), queue, (control) => {
      if (control.action === 'rate') {
        const applied = setRate(control.rate ?? rate + (control.delta ?? 0))
        broadcast('control', { action: 'rate', rate: applied })
        return
      }
      broadcast('control', control)
    }, (assistantText) => {
      const clean = sanitizeForSpeech(assistantText)
      if (clean) organizerHistoryFor(sessionId).add('assistant', clean)
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
      const clientId = typeof body.clientId === 'string' ? body.clientId.trim() : ''
      if (body.speech === 'start' || body.speech === 'end') {
        if (activeVoice.has(sessionId)) recordSpeech(sessionId, body.speech === 'start')
        writeJson(res, 200, { ok: true })
        return
      }
      if (body.speech === 'speaker') {
        const speaker = typeof body.speaker === 'string' ? body.speaker.trim().slice(0, 24) : ''
        const state = speechState.get(sessionId)
        if (state !== undefined && speaker) state.speaker = speaker
        else if (speaker) speechState.set(sessionId, { speaking: false, since: Date.now(), lastEnd: 0, speaker })
        writeJson(res, 200, { ok: true })
        return
      }
      if (typeof body.playback === 'boolean') {
        mouthState.set(sessionId, { playing: body.playback, at: Date.now() })
        writeJson(res, 200, { ok: true })
        return
      }
      if (body.active === true) {
        activeVoice.set(sessionId, Date.now())
        // The most recent heartbeat owns playback until it stops or expires.
        if (clientId) voiceOwner.set(sessionId, { clientId, at: Date.now() })
      } else {
        // A tab that is not the owner cannot end the owner's session.
        const owner = voiceOwner.get(sessionId)
        if (owner !== undefined && (clientId === '' || owner.clientId === clientId)) {
          voiceOwner.delete(sessionId)
        }
        if (owner === undefined || clientId === '' || owner.clientId === clientId) {
          activeVoice.delete(sessionId)
          organizerHistories.delete(sessionId)
        }
      }
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

  // The page owns playback, so an interrupt must also tell the host to stop
  // synthesizing sentences nobody will hear. A reply id narrows the cancel to
  // the reply being cut; omitting it is the explicit "stop speaking" path.
  const ttsCancelHandler = async (req: unknown, res: ServerResponse): Promise<void> => {
    try {
      const body = await readJson(req)
      const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
      if (!sessionId) { writeJson(res, 400, { error: 'missing sessionId' }); return }
      const clientId = typeof body.clientId === 'string' ? body.clientId.trim() : ''
      const owner = voiceOwner.get(sessionId)
      if (owner !== undefined && clientId !== '' && owner.clientId !== clientId) {
        writeJson(res, 409, { error: 'another tab owns this voice session' })
        return
      }
      const replyId = typeof body.replyId === 'string' ? body.replyId.trim().slice(0, 200) : ''
      const result = replyId === '' ? queue.cancel(sessionId) : queue.cancelReply(sessionId, replyId)
      writeJson(res, 200, { ok: true, ...result })
    } catch (error) {
      writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
    }
  }
  for (const prefix of new Set([base, BOOTSTRAP_BASE])) {
    ctx.effect(() =>
      ctx.webServer.register({ kind: 'exact', path: `${prefix}/tts-cancel`, handler: ttsCancelHandler }),
    )
  }

  const ttsStateHandler = async (req: unknown, res: ServerResponse): Promise<void> => {
    try {
      const body = await readJson(req)
      const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
      if (!sessionId) { writeJson(res, 400, { error: 'missing sessionId' }); return }
      const clientId = typeof body.clientId === 'string' ? body.clientId.trim() : ''
      const owner = voiceOwner.get(sessionId)
      if (owner !== undefined && clientId !== '' && owner.clientId !== clientId) {
        writeJson(res, 409, { error: 'another tab owns this voice session' })
        return
      }
      writeJson(res, 200, { ok: true, ...queue.snapshot(sessionId) })
    } catch (error) {
      writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
    }
  }
  for (const prefix of new Set([base, BOOTSTRAP_BASE])) {
    ctx.effect(() =>
      ctx.webServer.register({ kind: 'exact', path: `${prefix}/tts-state`, handler: ttsStateHandler }),
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
      const margin = typeof body.margin === 'number' ? body.margin : undefined
      const result = await voiceprint.identify(decodeWavBase64(audio), { sessionId, threshold, margin })
      writeJson(res, 200, { ok: true, ...result })
    } catch (error) {
      writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
    }
  }
  const voiceprintOverlap = async (req: unknown, res: ServerResponse): Promise<void> => {
    try {
      const body = await readJson(req as IncomingMessage, 4 * 1024 * 1024)
      const audio = typeof body.audioBase64 === 'string' ? body.audioBase64 : ''
      if (!audio) throw new Error('缺少语音数据')
      const result = await voiceprint.overlap(decodeWavBase64(audio))
      writeJson(res, 200, { ok: true, ...result })
    } catch (error) {
      // The client treats any error as "fall back to separation".
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
  const separationStatus = (_req: unknown, res: ServerResponse): void => {
    writeJson(res, 200, separation.status())
  }
  const separationPrepare = async (_req: unknown, res: ServerResponse): Promise<void> => {
    try { writeJson(res, 200, { ok: true, ...(await separation.prepare()) }) }
    catch (error) { writeJson(res, 502, { error: error instanceof Error ? error.message : String(error) }) }
  }
  const separationWarm = async (_req: unknown, res: ServerResponse): Promise<void> => {
    try {
      await separation.warm()
      writeJson(res, 200, { ok: true, backend: separation.status().backend })
    } catch (error) {
      writeJson(res, 502, { error: error instanceof Error ? error.message : String(error) })
    }
  }
  const separationRun = async (req: unknown, res: ServerResponse): Promise<void> => {
    try {
      const incoming = req as IncomingMessage
      const body = await readJson(incoming, 8 * 1024 * 1024)
      const audio = typeof body.audioBase64 === 'string' ? body.audioBase64 : ''
      if (!audio) throw new Error('缺少语音数据')
      const startedAt = performance.now()
      const samples = decodeWavBase64(audio)
      noteTransport('json', incoming, audio.length, performance.now() - startedAt)
      await completeSeparation(
        typeof body.sessionId === 'string' ? body.sessionId : '',
        typeof body.threshold === 'number' ? body.threshold : undefined,
        typeof body.margin === 'number' ? body.margin : undefined,
        body.identify !== false,
        samples,
        res,
      )
    } catch (error) {
      writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
    }
  }

  /** Binary body: raw PCM16 frames, no base64, no WAV header. */
  const separationRunBinary = async (req: unknown, res: ServerResponse): Promise<void> => {
    try {
      const incoming = req as IncomingMessage
      const bytes = await readBinary(incoming, 8 * 1024 * 1024)
      const startedAt = performance.now()
      const decoded = decodeAudioFrames(bytes)
      const decodeMs = performance.now() - startedAt
      noteTransport('binary', incoming, bytes.length, decodeMs, decoded.droppedFrames)
      const threshold = Number(headerValue(incoming, 'x-voice-threshold'))
      const margin = Number(headerValue(incoming, 'x-voice-margin'))
      await completeSeparation(
        headerValue(incoming, 'x-voice-session'),
        Number.isFinite(threshold) && threshold > 0 ? threshold : undefined,
        Number.isFinite(margin) && margin > 0 ? margin : undefined,
        headerValue(incoming, 'x-voice-identify') !== '0',
        decoded.samples,
        res,
      )
    } catch (error) {
      writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
    }
  }

  /**
   * Shared separation pipeline. Both transports hand over Float32 samples, so
   * inference, voiceprint and the response shape stay byte-identical.
   */
  const completeSeparation = async (
    sessionId: string, threshold: number | undefined, margin: number | undefined, identify: boolean,
    samples: Float32Array, res: ServerResponse,
  ): Promise<void> => {
    try {
      const result = await separation.separate(samples)
      if (!identify) {
        writeJson(res, 200, {
          ok: true,
          separated: result.sources.length >= 2,
          elapsedMs: result.elapsedMs,
          queueMs: result.queueMs ?? 0,
          workerMs: result.elapsedMs,
          wallMs: result.wallMs ?? result.elapsedMs,
          sources: result.sources.map((source) => ({
            audioBase64: encodeWavBase64(source.samples),
            rms: source.rms,
            onsetMs: source.onsetMs,
            identity: null,
          })),
        })
        return
      }
      const loud = Math.max(...result.sources.map((source) => source.rms), 0)
      // A single voice split into two complementary halves reconstructs the
      // input and embeds back to one speaker; transcribing both halves would
      // duplicate the sentence and invent a second speaker.
      const pair = result.sources.length >= 2
        ? await voiceprint.pairSimilarity(result.sources[0]!.samples, result.sources[1]!.samples)
          .catch(() => 0)
        : 0
      // One dominant stream is ordinary dictation: keep the untouched audio
      // and the normal voiceprint path instead of transcribing artifacts.
      if (result.sources.length < 2 || loud < 0.002 || pair >= SAME_SPEAKER_SIMILARITY) {
        let identity: unknown = null
        try { identity = await voiceprint.identify(samples, { sessionId, threshold, margin }) } catch { /* optional */ }
        writeJson(res, 200, {
          ok: true,
          separated: false,
          elapsedMs: result.elapsedMs,
          queueMs: result.queueMs ?? 0,
          workerMs: result.elapsedMs,
          wallMs: result.wallMs ?? result.elapsedMs,
          sources: [{ audioBase64: encodeWavBase64(samples), rms: loud, onsetMs: 0, identity }],
        })
        return
      }
      const sources = []
      // Two separated streams are two different people; do not let the second
      // one fall into the first one's temporary guest cluster.
      const usedGuestLabels: string[] = []
      for (const source of result.sources) {
        let identity: any = null
        try {
          identity = await voiceprint.identify(source.samples, {
            sessionId,
            threshold,
            margin,
            adapt: false,
            excludeLabels: usedGuestLabels,
          })
        } catch { /* a very short stream can still be transcribed */ }
        if (identity?.enrolled && !identity.owner && identity.label) usedGuestLabels.push(identity.label)
        sources.push({
          audioBase64: encodeWavBase64(source.samples),
          rms: source.rms,
          onsetMs: source.onsetMs,
          identity,
        })
      }
      writeJson(res, 200, {
        ok: true, separated: true, elapsedMs: result.elapsedMs,
        queueMs: result.queueMs ?? 0, workerMs: result.elapsedMs,
        wallMs: result.wallMs ?? result.elapsedMs, sources,
      })
    } catch (error) {
      writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
    }
  }

  const voiceprintRoutes: Array<[string, (req: unknown, res: ServerResponse) => void | Promise<void>]> = [
    ['/voiceprint/status', voiceprintStatus],
    ['/voiceprint/prepare', voiceprintPrepare],
    ['/voiceprint/enroll', voiceprintEnroll],
    ['/voiceprint/identify', voiceprintIdentify],
    ['/voiceprint/overlap', voiceprintOverlap],
    ['/voiceprint/forget', voiceprintForget],
    ['/voiceprint/speakers/enroll', voiceprintEnrollSpeaker],
    ['/voiceprint/speakers/rename', voiceprintRenameSpeaker],
    ['/voiceprint/speakers/remove', voiceprintRemoveSpeaker],
  ]
  const separationRoutes: Array<[string, (req: unknown, res: ServerResponse) => void | Promise<void>]> = [
    ['/separation/status', separationStatus],
    ['/separation/prepare', separationPrepare],
    ['/separation/warm', separationWarm],
    ['/separation/separate', separationRun],
    ['/separation/separate-binary', separationRunBinary],
  ]
  const latencyHandler = async (req: unknown, res: ServerResponse): Promise<void> => {
    try {
      const body = await readJson(req as IncomingMessage, 16 * 1024)
      const record = sanitizeLatencyRecord(body)
      if (record) appendLatency(record)
    } catch { /* a malformed sample is dropped, never surfaced */ }
    writeJson(res, 200, { ok: true })
  }
  const organizerHandler = async (req: unknown, res: ServerResponse): Promise<void> => {
    let timedOut = false
    try {
      const body = await readJson(req as IncomingMessage)
      const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
      const text = typeof body.text === 'string' ? body.text.trim().slice(0, 2000) : ''
      const lane = body.lane === 'guest' ? 'guest' : 'owner'
      const playing = body.playing === true
      const queued = typeof body.queued === 'number' && Number.isFinite(body.queued)
        ? Math.max(0, Math.round(body.queued)) : 0
      const queue: Array<{ lane: string; text: string }> = Array.isArray(body.queue)
        ? body.queue.slice(0, 8).flatMap((item: unknown) => {
            if (!item || typeof item !== 'object') return []
            const record = item as { lane?: unknown; text?: unknown }
            if (typeof record.text !== 'string' || !record.text.trim()) return []
            return [{ lane: record.lane === 'guest' ? 'guest' : 'owner', text: record.text.trim().slice(0, 120) }]
          })
        : []
      const ownerWeight = typeof body.ownerWeight === 'number' && Number.isFinite(body.ownerWeight)
        ? Math.max(0, Math.min(1, body.ownerWeight)) : 1
      // Read-aloud blocks the assistant still owes. Index 0 is playing now.
      // Bounded here as well as in the client: this is untrusted input.
      const assistantPending: OrganizerPendingBlock[] = Array.isArray(body.assistantPending)
        ? boundedOrganizerBlocks(body.assistantPending as unknown[])
        : []
      // What the listener is hearing right now. Without it the gate can only
      // classify words; with it the model reads the intent behind them.
      const playingText = typeof body.playingText === 'string' ? body.playingText.trim().slice(0, 200) : ''
      const previousText = typeof body.previousText === 'string' ? body.previousText.trim().slice(0, 200) : ''
      if (!sessionId || !text) {
        writeJson(res, 200, { action: 'queue', reason: 'bad-input' })
        return
      }
      const target = lastModelTarget.get(sessionId)
      if (!target) {
        writeJson(res, 200, { action: 'queue', reason: 'no-model-target' })
        return
      }
      const controller = new AbortController()
      const gateStartedAt = Date.now()
      const timer = setTimeout(() => { timedOut = true; controller.abort() }, GATE_TIMEOUT_MS)
      let raw = ''
      let reasoning = ''
      // The gate answers one question — does this line want the floor now —
      // but it answers from meaning, so the model sees the sentence being read,
      // what is still owed, what is waiting, and the owner's previous line.
      const gatePrompt = buildGatePrompt({
        text,
        playing,
        queued,
        ...(playingText ? { playingText } : {}),
        ...(previousText ? { previousText } : {}),
        ...(queue.length > 0 ? { queue: queue.map((item) => item.text) } : {}),
        ...(assistantPending.length > 0
          ? { pending: assistantPending.map((block) => block.text) } : {}),
      })
      // GenerateOptions.purpose is a closed union in dsh-llm. The gate is
      // another auxiliary call: adapters only forward the purpose as metadata,
      // and shouldSpeak() filters anything with a purpose out of TTS.
      try {
        const llm = (ctx as unknown as {
          llm: { stream(options: GenerateOptions): AsyncIterable<StreamChunk> }
        }).llm
        const stream = llm.stream({
          provider: target.provider,
          model: target.model,
          system: GATE_SYSTEM_PROMPT,
          messages: [{
            role: 'user',
            content: [{ type: 'text', text: gatePrompt }],
          }],
          maxTokens: GATE_MAX_TOKENS,
          temperature: 0,
          // A classifier must not spend its whole budget thinking: reasoning deltas
          // used to arrive instead of text, leaving the visible buffer empty.
          reasoningEffort: 'off' as unknown as GenerateOptions['reasoningEffort'],
          signal: controller.signal,
          sessionId: sessionId as GenerateOptions['sessionId'],
          purpose: 'voice-organizer',
        } as GenerateOptions)
        for await (const chunk of stream) {
          if (chunk.type === 'text-delta') raw += chunk.text
          else if (chunk.type === 'reasoning-delta') reasoning += (chunk as { text?: string }).text ?? ''
        }
      } finally {
        clearTimeout(timer)
      }
      if (timedOut) {
        appendOrganizerLog({
          layer: 'gate', action: 'timeout', reason: 'timeout', playing: playing ? 1 : 0,
          promptChars: GATE_SYSTEM_PROMPT.length + gatePrompt.length, maxTokens: GATE_MAX_TOKENS,
          elapsedMs: Date.now() - gateStartedAt, changed: 0, text,
        })
        writeJson(res, 200, { action: 'queue', reason: 'timeout' })
        return
      }
      const parsed = parseOrganizerResponse(raw) ?? parseOrganizerResponse(reasoning)
      const seen = (raw || reasoning).replace(/\s+/gu, ' ').trim().slice(0, 48)
      const decision = parsed
        ? {
            action: parsed.action,
            ...(parsed.priority === undefined ? {} : { priority: parsed.priority }),
            reason: parsed.reason || 'model',
          }
        : { action: 'queue' as const, reason: seen ? 'invalid-model-output:' + seen : 'empty-model-output' }
      appendOrganizerLog({
        layer: 'gate', action: decision.action, reason: decision.reason, playing: playing ? 1 : 0,
        promptChars: GATE_SYSTEM_PROMPT.length + gatePrompt.length, maxTokens: GATE_MAX_TOKENS,
        elapsedMs: Date.now() - gateStartedAt,
        // Only an actual interruption changed what the listener heard.
        changed: decision.action === 'interrupt' ? 1 : 0, text,
      })
      writeJson(res, 200, decision)
    } catch (error) {
      const reason = timedOut ? 'timeout' : (error instanceof Error ? error.message : String(error)).slice(0, 80)
      writeJson(res, 200, { action: 'queue', reason })
    }
  }
  /**
   * Slow planner layer. Its answer never blocks the reply path: by the time it
   * arrives the line is already queued, so it may only correct what has not
   * started yet.
   */
  const plannerHandler = async (req: unknown, res: ServerResponse): Promise<void> => {
    const startedAt = Date.now()
    let timedOut = false
    let ruleDecision: { reorder?: number[]; dropSentences?: number[]; reason: string } | null = null
    try {
      const body = await readJson(req as IncomingMessage)
      const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
      const text = typeof body.text === 'string' ? body.text.trim().slice(0, 2000) : ''
      const lane = body.lane === 'guest' ? 'guest' : 'owner'
      const playing = body.playing === true
      const queued = typeof body.queued === 'number' && Number.isFinite(body.queued)
        ? Math.max(0, Math.round(body.queued)) : 0
      const queue: Array<{ id: number; lane: string; text: string }> = Array.isArray(body.queue)
        ? body.queue.slice(0, 8).flatMap((item: unknown) => {
            if (!item || typeof item !== 'object') return []
            const record = item as { id?: unknown; lane?: unknown; text?: unknown }
            const id = Math.trunc(Number(record.id))
            if (!Number.isInteger(id) || id < 0) return []
            if (typeof record.text !== 'string' || !record.text.trim()) return []
            return [{ id, lane: record.lane === 'guest' ? 'guest' : 'owner', text: record.text.trim() }]
          })
        : []
      const assistantPending: OrganizerPendingBlock[] = Array.isArray(body.assistantPending)
        ? boundedOrganizerBlocks(body.assistantPending as unknown[])
        : []
      if (!sessionId || !text) {
        writeJson(res, 200, { reason: 'bad-input' })
        return
      }
      // Deterministic fallback: even when the model times out or returns
      // nothing, "先说结论/别讲背景" still rearranges what has not started.
      // The bounds above are exactly the block indices returned by rules.
      const pendingView = assistantPending
      const rulePlan = planChunkOutputOrder(pendingView, text)
      const reordered = rulePlan.order.some((value, index) => value !== index)
      ruleDecision = arrangementChanged(rulePlan)
        ? {
            ...(reordered ? { reorder: rulePlan.order } : {}),
            ...(rulePlan.dropped.length === 0 ? {} : { dropSentences: rulePlan.dropped }),
            reason: 'rule',
          }
        : null
      const history = organizerHistoryFor(sessionId)
      const historySnapshot = history.snapshot()
      history.add('user', text)
      lastUserSpeech.set(sessionId, text)
      const target = lastModelTarget.get(sessionId)
      if (!target) {
        writeJson(res, 200, { reason: 'no-model-target' })
        return
      }
      const prompt = buildPlannerPrompt({
        text, lane, playing, queued, queue, assistantPending,
        history: historySnapshot.map((entry) => ({ role: entry.role, text: entry.text })),
      })
      const controller = new AbortController()
      const timer = setTimeout(() => { timedOut = true; controller.abort() }, PLANNER_TIMEOUT_MS)
      let raw = ''
      let reasoning = ''
      try {
        const llm = (ctx as unknown as {
          llm: { stream(options: GenerateOptions): AsyncIterable<StreamChunk> }
        }).llm
        const stream = llm.stream({
          provider: target.provider,
          model: target.model,
          system: PLANNER_SYSTEM_PROMPT,
          messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
          maxTokens: PLANNER_MAX_TOKENS,
          temperature: 0,
          reasoningEffort: 'off' as unknown as GenerateOptions['reasoningEffort'],
          signal: controller.signal,
          sessionId: sessionId as GenerateOptions['sessionId'],
          purpose: 'voice-organizer',
        } as GenerateOptions)
        for await (const chunk of stream) {
          if (chunk.type === 'text-delta') raw += chunk.text
          else if (chunk.type === 'reasoning-delta') reasoning += (chunk as { text?: string }).text ?? ''
        }
      } finally {
        clearTimeout(timer)
      }
      if (timedOut) {
        appendOrganizerLog({
          layer: 'planner', action: ruleDecision ? 'rule' : 'timeout', reason: 'timeout',
          promptChars: PLANNER_SYSTEM_PROMPT.length + prompt.length, maxTokens: PLANNER_MAX_TOKENS,
          elapsedMs: Date.now() - startedAt, changed: ruleDecision ? 1 : 0, text,
        })
        writeJson(res, 200, ruleDecision ?? { reason: 'timeout' })
        return
      }
      const parsed = parseOrganizerResponse(raw) ?? parseOrganizerResponse(reasoning)
      // Bound every index against exactly what the prompt showed.
      const shownIds = new Set(queue.map((item) => item.id))
      const queuePlan = (parsed?.queuePlan ?? []).filter((item) => shownIds.has(item.id))
      const dropSentences = (parsed?.dropSentences ?? []).filter((index) => index >= 0 && index < pendingView.length)
      const reorder = (parsed?.reorder ?? []).filter((index) => index >= 0 && index < pendingView.length)
      const interrupt = parsed?.action === 'interrupt'
      const changed = interrupt || queuePlan.length > 0 || dropSentences.length > 0 || reorder.length > 0
      const usedRule = !changed && ruleDecision !== null
      const decision = {
        ...(interrupt ? { interrupt: true } : {}),
        ...(queuePlan.length === 0 ? {} : { queuePlan }),
        ...(changed || ruleDecision?.dropSentences === undefined ? {} : { dropSentences: ruleDecision.dropSentences }),
        ...(changed || ruleDecision?.reorder === undefined ? {} : { reorder: ruleDecision.reorder }),
        reason: usedRule ? 'rule' : (parsed?.reason || (changed ? 'model' : 'unchanged')),
      }
      appendOrganizerLog({
        layer: 'planner',
        action: changed ? 'plan' : (usedRule ? 'rule' : 'unchanged'),
        reason: decision.reason, playing: playing ? 1 : 0,
        promptChars: PLANNER_SYSTEM_PROMPT.length + prompt.length, maxTokens: PLANNER_MAX_TOKENS,
        elapsedMs: Date.now() - startedAt, changed: (changed || usedRule) ? 1 : 0, text,
      })
      writeJson(res, 200, decision)
    } catch (error) {
      const reason = timedOut ? 'timeout' : (error instanceof Error ? error.message : String(error)).slice(0, 80)
      writeJson(res, 200, ruleDecision ?? { reason })
    }
  }
  rewriteEnabled = config.rewriteEnabled !== false
  rewriteModel = async (sessionId, prompt, signal) => {
    const target = lastModelTarget.get(sessionId)
    if (!target) return ''
    const llm = (ctx as unknown as {
      llm: { stream(options: GenerateOptions): AsyncIterable<StreamChunk> }
    }).llm
    let text = ''
    try {
      for await (const chunk of llm.stream({
        provider: target.provider,
        model: target.model,
        system: REWRITE_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
        maxTokens: REWRITE_MAX_TOKENS,
        temperature: 0,
        reasoningEffort: 'off' as unknown as GenerateOptions['reasoningEffort'],
        signal,
        sessionId,
        purpose: 'voice-organizer',
      } as GenerateOptions)) {
        if (chunk.type === 'text-delta') text += chunk.text
      }
    } catch {
      // A failed rewrite is a missing improvement, never a lost sentence.
    }
    return text
  }
  // The speaking layer composes speech from meaning; it needs its own prompt
  // and a bigger budget than the one-line rewriter.
  speakerModel = async (sessionId, prompt, signal) => {
    const target = lastModelTarget.get(sessionId)
    if (!target) return ''
    const llm = (ctx as unknown as {
      llm: { stream(options: GenerateOptions): AsyncIterable<StreamChunk> }
    }).llm
    let text = ''
    try {
      for await (const chunk of llm.stream({
        provider: target.provider,
        model: target.model,
        system: SPEAKER_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
        maxTokens: SPEAKER_MAX_TOKENS,
        temperature: 0.3,
        reasoningEffort: 'off' as unknown as GenerateOptions['reasoningEffort'],
        signal,
        sessionId,
        purpose: 'voice-organizer',
      } as GenerateOptions)) {
        if (chunk.type === 'text-delta') text += chunk.text
      }
    } catch {
      // A failed compose is a missing improvement, never a lost sentence.
    }
    return text
  }
  // The attention pass is the "read the whole thing first" half of speaking. It
  // may only reorder and drop, never invent: a failure just means the composer
  // runs without a plan, exactly as before.
  attentionModel = async (sessionId, prompt, signal) => {
    const target = lastModelTarget.get(sessionId)
    if (!target) return ''
    const llm = (ctx as unknown as {
      llm: { stream(options: GenerateOptions): AsyncIterable<StreamChunk> }
    }).llm
    let text = ''
    try {
      for await (const chunk of llm.stream({
        provider: target.provider,
        model: target.model,
        system: ATTENTION_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
        maxTokens: ATTENTION_MAX_TOKENS,
        temperature: 0,
        reasoningEffort: 'off' as unknown as GenerateOptions['reasoningEffort'],
        signal,
        sessionId,
        purpose: 'voice-organizer',
      } as GenerateOptions)) {
        if (chunk.type === 'text-delta') text += chunk.text
      }
    } catch {
      // No plan is a missing improvement, never a lost sentence.
    }
    return text
  }
  fastLaneEnabled = config.fastLaneEnabled !== false
  fastLaneModel = async (sessionId, prompt, signal) => {
    const target = lastModelTarget.get(sessionId)
    if (!target) return ''
    const llm = (ctx as unknown as {
      llm: { stream(options: GenerateOptions): AsyncIterable<StreamChunk> }
    }).llm
    let text = ''
    try {
      for await (const chunk of llm.stream({
        provider: target.provider,
        model: target.model,
        system: FAST_LANE_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
        maxTokens: FAST_LANE_MAX_TOKENS,
        temperature: 0.2,
        reasoningEffort: 'off' as unknown as GenerateOptions['reasoningEffort'],
        signal,
        sessionId,
        purpose: 'voice-organizer',
      } as GenerateOptions)) {
        if (chunk.type === 'text-delta') text += chunk.text
      }
    } catch {
      // A missed fast line is a missed nicety, never a broken reply.
    }
    return text
  }
  const organizerRoutes: Array<[string, (req: unknown, res: ServerResponse) => void | Promise<void>]> = [
    ['/organize', organizerHandler],
    ['/plan', plannerHandler],
    ['/latency', latencyHandler],
  ]
  for (const prefix of new Set([base, BOOTSTRAP_BASE])) {
    for (const [route, handler] of [...voiceprintRoutes, ...separationRoutes, ...organizerRoutes, ...VOLUME_LOG_ROUTES]) {
      ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: prefix + route, handler }))
    }
  }

  ctx.effect(() => () => { resetPreviewClient() })
}

/** Last time an utterance entered the model, per session, for first-token timing. */
const lastEnqueueAt = new Map<string, number>()

/** Append one latency sample. A lost sample must never break speech. */
function appendLatency(record: Record<string, unknown>): void {
  try {
    appendFileSync(join(tmpdir(), 'dsh-voice-latency.jsonl'), JSON.stringify(record) + '\n')
    const sessionId = typeof record.sessionId === 'string' ? record.sessionId : ''
    if (sessionId && record.kind === 'utterance') lastEnqueueAt.set(sessionId, Date.now())
  } catch { /* logging is best-effort */ }
}

export interface OrganizerLogEntry {
  layer: 'gate' | 'planner'
  action: string
  reason: string
  /** 1 while the assistant was speaking when this layer ran. */
  playing?: 0 | 1
  /** Characters the model actually received (system + user). */
  promptChars: number
  maxTokens: number
  elapsedMs: number
  /** 1 when the decision changed something the listener would hear. */
  changed: 0 | 1
  text: string
}

/** One line per decision, with prompt size and usefulness, auditable later. */
function appendOrganizerLog(entry: OrganizerLogEntry): void {
  try {
    const preview = entry.text.replace(/\s+/gu, ' ').trim().slice(0, 20)
    appendFileSync(join(tmpdir(), 'dsh-voice-organizer.log'),
      `${new Date().toISOString()} layer=${entry.layer} ${entry.action} ${entry.reason}`
      + ` promptChars=${entry.promptChars} maxTokens=${entry.maxTokens} ms=${entry.elapsedMs}`
      + ` changed=${entry.changed} playing=${entry.playing ?? 0} text=${entry.text.length} preview=${preview}\n`,
    )
  } catch { /* logging must never fail a decision */ }
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
/** How long an elected playback owner keeps the floor without a heartbeat. */
const VOICE_OWNER_TTL_MS = 90_000

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

/** Binary body reader for the PCM transport; never decodes as text. */
async function readBinary(req: IncomingMessage, limit = 8 * 1024 * 1024): Promise<Uint8Array> {
  return await new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    req.on('data', (chunk: Buffer) => {
      total += chunk.length
      if (total > limit) { req.destroy(); reject(new Error('body too large')); return }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(new Uint8Array(Buffer.concat(chunks).buffer, 0, total)))
    req.on('error', reject)
  })
}

function headerValue(req: IncomingMessage, name: string): string {
  const value = req.headers[name]
  return typeof value === 'string' ? value.slice(0, 200) : ''
}

/** One transport record per separation request, so both paths stay comparable. */
function noteTransport(
  transport: 'json' | 'binary', req: IncomingMessage, bytes: number, decodeMs: number,
  droppedFrames = 0,
): void {
  try {
    appendLatency({
      kind: 'transport',
      sessionId: headerValue(req, 'x-voice-session') || 'anonymous',
      at: new Date().toISOString(),
      transport,
      bytes,
      decodeMs: Math.round(decodeMs * 100) / 100,
      droppedFrames,
    })
  } catch { /* telemetry must never fail a request */ }
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

// One door into the mouth for every layer that wants to be heard: the reply
// pipeline, a subagent summary, the work layer. Hold, skip and the parking
// queue live here, so [[voice: hold]] silences all of them at once instead of
// only the answer that happened to be generating.
//
// Module scope, not locals of apply(): the reply pipeline is tapStream(),
// which sits above apply() in this file. As locals they were invisible to the
// tap, and the only symptom was "voiceMouthState is not defined" the moment a
// reply tried to speak.
const voiceMouth = new Map<string, { held: boolean; skip: number; parked: Array<() => void> }>()
const voiceMouthState = (sessionId: string): { held: boolean; skip: number; parked: Array<() => void> } => {
  let state = voiceMouth.get(sessionId)
  if (state === undefined) {
    state = { held: false, skip: 0, parked: [] }
    voiceMouth.set(sessionId, state)
  }
  return state
}
/** The live reply pipeline, when one is running, so direct speech keeps its dedupe. */
const speechDoors = new Map<string, { at: number; say: (text: string) => void }>()

async function* tapStream(
  sessionId: string,
  inner: AsyncIterable<StreamChunk>,
  queue: TtsQueue,
  control: (command: VoiceControl) => void,
  recordAssistant: (text: string) => void,
): AsyncIterable<StreamChunk> {
  // One monotonically increasing round per assistant reply; frames carry it
  // so the client can tell a late old-reply frame from a fresh one.
  const round = replySequence++
  const replyId = `${sessionId}:${Date.now().toString(36)}:${round}`
  // Clause-sized blocks reach TTS as soon as a comma clause is complete,
  // which is earlier than the old whole-sentence tap. Metadata lets the client
  // organizer reorder across sentences without scrambling a sentence itself.
  const segmenter = new SentenceSegmenter({ firstClauseChars: 8 })
  const protocol = new VoiceProtocol()
  let directed = false
  let firstTokenLogged = false
  // Staged rewriting: the opener keeps its exact wording and starts TTS at
  // once; every later block is folded into one script. The 450 ms budget is
  // spent while the opener is already being read, so nothing waits for it.
  // Servo state lives above speak so the answer can hand over from inside it.
  let servo: FastLaneServo | undefined
  let servoSpeaking = false
  let staged: StagedRewriter | undefined
  let opener = ''
  // When the last line actually reached the queue, for the fast lane's floor.
  let lastSpeakAt = 0
  const noteSpeech = (): void => { lastSpeakAt = Date.now() }
  // Everything the rewriter already handed to TTS, in order. Drafts are
  // cumulative, so a later draft repeats what the listener has heard; only
  // the unheard tail may reach the queue.
  const publishedLines: string[] = []
  // Exact keys, not paraphrases: a draft that only re-punctuates a line that
  // already played must never reach the queue a second time.
  const publishedKeys = new Set<string>()
  // Every line that reaches the player is recorded, so a reported repeat can
  // be traced to the two lines that produced it.
  const logSpoken = (text: string, source: string): void => {
    try {
      appendFileSync(join(tmpdir(), 'dsh-voice-spoken.jsonl'),
        JSON.stringify({ at: new Date().toISOString(), sessionId, replyId, round, source, text }) + '\n')
    } catch { /* diagnostics only */ }
  }
  const publishRewrite = (line: string): void => {
    const full = line.trim()
    if (!full) return
    const key = speechKey(full)
    if (publishedKeys.has(key)) {
      logSpoken(full, 'repeat')
      return
    }
    publishedKeys.add(key)
    const delta = newLineText(publishedLines, full)
    // A line that extends an already spoken one is new content by definition;
    // only a standalone line can be the same sentence said a second time.
    const repeated = delta === full && isLikelyRepeat(publishedLines, full)
    logSpoken(full, repeated ? 'repeat' : 'rewrite')
    publishedLines.push(full)
    if (!delta || repeated) return
    queue.enqueue(sessionId, delta, replyId, round, {})
    noteSpeech()
  }
  // Speaking layer: after the opener plays verbatim, the rest of the reply is
  // composed as speech from its meaning instead of being polished line by line.
  let composer: string[] = []
  let composeTimer: ReturnType<typeof setTimeout> | null = null
  let composed = 0
  // A compose that stalls must never leave the listener in silence: the batch
  // then falls back to the line-by-line rewriter, which is worse speech but
  // always arrives. A person does not go quiet mid-answer waiting for a plan.
  const COMPOSE_WATCHDOG_MS = 1800
  const flushComposer = (): void => {
    if (composeTimer !== null) { clearTimeout(composeTimer); composeTimer = null }
    if (composer.length === 0) return
    try {
      composeSpeech()
    } catch { /* a compose bug is a lost improvement, never a dead host */ }
  }
  const composeSpeech = (): void => {
    const batch = composer
    composer = []
    const text = batch.join('')
    const model = speakerModel
    if (!model) {
      for (const piece of batch) if (staged !== undefined) staged.push({ text: piece })
      return
    }
    composed += 1
    let settled = false
    let watchdog: ReturnType<typeof setTimeout> | null = null
    const finish = (lines: string[]): void => {
      if (settled) return
      settled = true
      if (watchdog !== null) { clearTimeout(watchdog); watchdog = null }
      composed -= 1
      if (lines.length > 0) { for (const line of lines) publishRewrite(line); return }
      for (const piece of batch) if (staged !== undefined) staged.push({ text: piece })
    }
    watchdog = setTimeout(() => { finish([]) }, COMPOSE_WATCHDOG_MS)
    // What the listener just asked decides what leads. This function lives above
    // apply(), so it reads the module-level record, never a local of apply().
    const question = lastUserSpeech.get(sessionId)
    void (async () => {
      let plan: ReturnType<typeof attentionForSpeech>
      const blocks = splitAttentionBlocks(text)
      if (attentionModel && blocks.length > 1) {
        try {
          const raw = await attentionModel(
            sessionId, buildAttentionPrompt(blocks, publishedLines, question), undefined)
          const map = parseAttentionMap(raw, blocks.length)
          if (map) plan = attentionForSpeech(map, blocks)
        } catch { /* the composer speaks without a plan */ }
      }
      if (settled) return
      const answer = await model(
        sessionId, buildSpeakerPrompt(text, publishedLines, question, plan), undefined)
      finish(parseSpeakerLines(answer))
    })().catch(() => { finish([]) })
  }
  // The model can take the floor away from its own mouth for a moment
  // ([[voice: hold]]) while the owner is still talking, and hand it back later
  // ([[voice: resume]]). Held blocks are kept in order, never dropped.
  const mouthHere = voiceMouthState(sessionId)
  const speak = (block: SpeechBlock | string): void => {
    // Direct speech from other layers joins this pipeline, so it gets the same
    // dedupe and the same hold as the answer itself.
    speechDoors.set(sessionId, { at: Date.now(), say: (text: string) => { speak(text) } })
    if (mouthHere.held) { mouthHere.parked.push(() => speak(block)); return }
    if (mouthHere.skip > 0) { mouthHere.skip -= 1; return }
    // Real answer text always wins: the servo stops talking the moment it starts.
    if (!servoSpeaking) servo?.stop('answer')
    const source = typeof block === 'string' ? block : block.text
    const clean = stripFillerHead(sanitizeForSpeech(source))
    if (!clean || !hasSpeechContent(clean)) return
    const meta = typeof block === 'string'
      ? {}
      : { sentenceId: block.sentenceId, chunkIndex: block.chunkIndex }
    if (!rewriteEnabled) {
      queue.enqueue(sessionId, clean, replyId, round, meta)
      noteSpeech()
      return
    }
    if (staged === undefined) {
      opener = clean
      logSpoken(clean, 'opener')
      publishedLines.push(clean)
      publishedKeys.add(speechKey(clean))
      queue.enqueue(sessionId, clean, replyId, round, meta)
      noteSpeech()
      staged = new StagedRewriter({
        call: (prompt, signal) => (rewriteModel ? rewriteModel(sessionId, prompt, signal) : Promise.resolve('')),
        onPublish: (result) => { for (const line of result.lines) publishRewrite(line) },
      })
      staged.markSpoken(clean)
      staged.push({ text: clean, ...meta })
      return
    }
    composer.push(clean)
    if (composeTimer !== null) clearTimeout(composeTimer)
    if (composed === 0) {
      composeTimer = setTimeout(() => { composeTimer = null; flushComposer() }, 450)
    }
  }
  // Servo: while the model reasons, keep the queue fed with what the thinking
  // has already settled. It hands over to the answer the moment real text
  // speaks, and every line it says goes through the same dedupe as the answer.
  if (fastLaneEnabled) {
    servo = new FastLaneServo({
      call: (prompt, signal) => (fastLaneModel ? fastLaneModel(sessionId, prompt, signal) : Promise.resolve('')),
      say: (line) => {
        servoSpeaking = true
        try { speak(line) } finally { servoSpeaking = false }
      },
      startAt: Date.now(),
    })
  }
  const applyVoice = (command: VoiceCommand): void => {
    if (command.action === 'hold') { mouthHere.held = true; return }
    if (command.action === 'resume') {
      mouthHere.held = false
      const pending = mouthHere.parked
      mouthHere.parked = []
      for (const replay of pending) {
        try { replay() } catch { /* one lost line must not silence the rest */ }
      }
      return
    }
    if (command.action === 'skip') { mouthHere.skip += command.count; return }
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
    if (command.action === 'stop') {
      directed = true
      servo?.stop('owner-stop')
    }
    control(command)
  }
  // The visible answer must never show raw control markers. The chat UI renders
  // text deltas verbatim, so the tap strips complete markers here and holds a
  // trailing partial one until the next chunk decides its fate.
  const visibleFilter = new VisibleVoiceFilter()
  let assistantVisible = ''
  let completed = false
  let flushed = false
  let finishReason: unknown = null
  const flushOnce = (): void => {
    if (flushed) return
    flushed = true
    for (const block of segmenter.flushBlocks()) speak(block)
  }
  try {
    for await (const chunk of inner) {
      if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string') {
        for (const command of protocol.feed(chunk.text)) applyVoice(command)
        servo?.push(chunk.text)
      }
      let outbound: StreamChunk = chunk
      if (!firstTokenLogged && chunk.type === 'text-delta'
        && typeof chunk.text === 'string' && chunk.text.length > 0) {
        firstTokenLogged = true
        const since = lastEnqueueAt.get(sessionId)
        appendLatency({
          kind: 'first_token',
          sessionId,
          replyId,
          at: new Date().toISOString(),
          ...(since === undefined ? {} : { sinceEnqueueMs: Date.now() - since }),
        })
      }
      if (isSpeakableChunk(chunk)) {
        // The model sometimes writes a directive in the visible answer. The
        // segmenter strips it from speech; parse it here so its content is
        // spoken rather than silently discarded.
        for (const command of protocol.feed(chunk.text)) applyVoice(command)
        const visible = visibleFilter.push(chunk.text)
        assistantVisible += visible
        if (!directed) {
          for (const block of segmenter.feedBlocks(visible)) speak(block)
        }
        outbound = { ...chunk, text: visible }
      }
      if (chunk.type === 'finish') finishReason = chunk.reason
      if (outbound.type === 'text-delta' && typeof outbound.text === 'string' && outbound.text.length === 0) continue
      yield outbound
    }
    completed = true
  } finally {
    servo?.stop('stream-end')
    // Do not speak a fragment from an aborted or failed stream.
    const aborted = finishReason !== null && typeof finishReason === 'object'
      && (finishReason as { kind?: unknown }).kind === 'aborted'
    protocol.flush()
    if (completed && !aborted) {
      flushOnce()
      if (assistantVisible.trim()) {
        try { recordAssistant(assistantVisible) } catch { /* history is best-effort */ }
      }
    }
  }
}
