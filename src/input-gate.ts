/** Pure owner-input gate: rule first, bounded model fallback, never lose a real question. */

import { stripVoicePrefix } from './queue-control.js'

export type InputVerdict = 'steer' | 'queue' | 'drop'
export type VerdictSource = 'rule' | 'model'

export interface InputGateInput {
  text: string
  lane: 'owner' | 'guest'
  /** True while the assistant is speaking or has unread read-aloud blocks. */
  playing?: boolean
  /** Captured utterances already waiting. */
  queued?: number
  /** Last accepted owner transcript, used for the duplicate rule. */
  previousText?: string
}

export interface InputGateDecision {
  verdict: InputVerdict
  source: VerdictSource
  /** Time spent choosing, bounded by the gate budget. */
  verdictMs: number
  reason: string
  /** True when a guest bypassed the owner-only gate. */
  bypassed?: boolean
}

export interface InputGateOptions {
  /** Hard client budget. Kept below 250 ms by default. */
  timeoutMs?: number
  now?: () => number
  /** Fast-model fallback. Receives an AbortSignal that fires on timeout. */
  model?: (text: string, signal: AbortSignal) => Promise<unknown>
}

/** A real judgment needs more than a keyword lookup: give the model 600 ms. */
export const INPUT_GATE_TIMEOUT_MS = 600
export const INPUT_GATE_MAX_MS = 700

const PUNCTUATION = /[\s\u3000-\u303F\uFF00-\uFF0F\uFF1A-\uFF20\u200B-\u200D.,!?;:'"()\[\]{}\-—…、。，！？；：""''（）【】《》]/gu
const PUNCT_ONLY = /^[\s\p{P}\p{S}]+$/u
const SINGLE_CHAR = /^[\p{L}\p{N}]$/u
const FILLERS = new Set([
  '嗯', '啊', '呃', '哦', '唔', '哎', '唉', '喔', '噢', '咿',
  '嗯嗯', '啊啊', '呃呃', '哦哦', '嗯啊', '啊嗯', '呃啊', '哎哎',
  'the', 'yeah', 'ok', 'okay', 'hmm', 'uh', 'um',
])
const QUESTION = /[?？]|(?:什么|为什么|怎么|怎样|如何|哪个|哪里|哪儿|谁|多少|几点|几号|是否|是不是|能不能|可不可以|会不会|有没有|要不要|好不好|行不行)/u
const IMPERATIVE = /^(?:请|麻烦|帮我|给我|替我|把|将|打开|关闭|关掉|开启|停止|停|开始|继续|查|搜|找|看|读|念|说|讲|写|做|来|去|调|设置|修改|改|换|切|放|播|暂停|重试|重复|退|取消|确认|发|删除|加|减|放大|缩小|音量|语速|静音|大声|小声|快一点|慢一点)/u
const INTERRUPT = /(?:打断|停下|停一下|先停|别说了|别说|闭嘴|安静|打住|换话题|换个话题)/u
const CONTINUATION = /^(?:另外|还有|以及|补充|顺便|对了|然后|接着|就是|其实|不过|而且|同时|再补充|刚想到)/u

/** Strip one or more voiceprint prefixes without altering the spoken text. */
export function cleanGateText(raw: string): string {
  return stripVoicePrefix(String(raw ?? ''))
}

function squash(raw: string): string {
  return cleanGateText(raw).replace(PUNCTUATION, '').toLowerCase()
}

/** Character-bigram Dice coefficient; stable for short Chinese transcripts. */
function similarity(left: string, right: string): number {
  if (!left || !right) return 0
  if (left === right) return 1
  if (left.length < 2 || right.length < 2) return 0
  const grams = (value: string): Map<string, number> => {
    const out = new Map<string, number>()
    for (let index = 0; index + 1 < value.length; index += 1) {
      const gram = value.slice(index, index + 2)
      out.set(gram, (out.get(gram) ?? 0) + 1)
    }
    return out
  }
  const a = grams(left)
  const b = grams(right)
  let overlap = 0
  for (const [gram, count] of a) overlap += Math.min(count, b.get(gram) ?? 0)
  return (2 * overlap) / (left.length - 1 + right.length - 1)
}

function rule(
  verdict: InputVerdict,
  reason: string,
  now: () => number,
  startedAt: number,
): InputGateDecision {
  return { verdict, source: 'rule', verdictMs: Math.max(0, Math.round(now() - startedAt)), reason }
}

/** A rule decision, or null when the fast model must arbitrate. */
export function ruleInputDecision(
  input: InputGateInput,
  now: () => number = Date.now,
): InputGateDecision | null {
  const startedAt = now()
  const raw = cleanGateText(input.text)
  const text = raw.replace(/\s+/gu, ' ').trim()
  if (input.lane !== 'owner') {
    return {
      verdict: 'queue', source: 'rule', verdictMs: 0,
      reason: 'guest-bypass', bypassed: true,
    }
  }
  if (!text || PUNCT_ONLY.test(text)) return rule('drop', 'empty-or-punctuation', now, startedAt)
  const plain = text.replace(PUNCTUATION, '').toLowerCase()
  if (!plain) return rule('drop', 'empty-or-punctuation', now, startedAt)
  if (SINGLE_CHAR.test(plain) || FILLERS.has(plain)) return rule('drop', 'noise-fragment', now, startedAt)

  const previous = squash(input.previousText ?? '')
  if (previous && (plain === previous || (plain.length >= 4 && similarity(plain, previous) >= 0.86))) {
    return rule('drop', 'duplicate-previous', now, startedAt)
  }

  // Only an explicit "stop talking" cuts the current sentence. A question is
  // not an interruption: a person finishes the sentence in their mouth before
  // answering, so while something is playing the new turn waits its turn.
  // Only a spoken "stop" is unambiguous enough to cut by rule. Whether a new
  // question should cut the sentence in progress is a judgment about intent and
  // context, so it goes to the model with everything it needs, never to a
  // keyword. A late or failed judgment waits: it must not lose the question and
  // must not stop the audio by accident.
  if (INTERRUPT.test(plain)) return rule('steer', 'explicit-interrupt', now, startedAt)
  if (CONTINUATION.test(text) || CONTINUATION.test(plain)) return rule('queue', 'supplement', now, startedAt)
  return null
}

/** Map a fast model response to one of the three caller-facing verdicts. */
export function normalizeModelVerdict(value: unknown): InputVerdict | null {
  if (!value || typeof value !== 'object') return null
  const record = value as { verdict?: unknown; action?: unknown; reason?: unknown }
  // The organizer route returns a conservative action (usually queue) even
  // when its model was unavailable or timed out. That is not a model verdict:
  // let the caller fall back to direct send instead of quietly queueing a real
  // owner question behind old audio.
  if (typeof record.reason === 'string'
    && /timeout|no-model-target|bad-input|invalid-model-output|empty-model-output/i.test(record.reason)) return null
  const candidate = typeof record.verdict === 'string'
    ? record.verdict
    : (typeof record.action === 'string' ? record.action : '')
  const token = candidate.trim().toLowerCase()
  if (token === 'steer' || token === 'direct' || token === 'interrupt') return 'steer'
  if (token === 'queue' || token === 'hold') return 'queue'
  if (token === 'drop' || token === 'ignore') return 'drop'
  return null
}

function fallbackQueue(now: () => number, startedAt: number, reason: string): InputGateDecision {
  return {
    verdict: 'queue', source: 'rule',
    verdictMs: Math.min(INPUT_GATE_MAX_MS, Math.max(0, Math.round(now() - startedAt))),
    reason,
  }
}

/**
 * Decide whether an owner transcript should steer, queue, or be dropped.
 * Rules answer the common cases synchronously. Only an ambiguous line pays the
 * model round trip, and timeout/error always preserves speech as a direct send.
 */
export async function decideInput(
  input: InputGateInput,
  options: InputGateOptions = {},
): Promise<InputGateDecision> {
  const now = options.now ?? Date.now
  const startedAt = now()
  const ruled = ruleInputDecision(input, now)
  if (ruled) return ruled
  const timeoutMs = Math.max(1, Math.min(INPUT_GATE_MAX_MS, Math.round(options.timeoutMs ?? INPUT_GATE_TIMEOUT_MS)))
  const model = options.model
  if (!model) return fallbackQueue(now, startedAt, 'no-model-default-queue')

  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = Symbol('timeout')
  try {
    const winner = await Promise.race([
      model(cleanGateText(input.text), controller.signal).catch(() => null),
      new Promise<typeof timedOut>((resolve) => {
        timer = setTimeout(() => resolve(timedOut), timeoutMs)
      }),
    ])
    if (winner === timedOut) {
      controller.abort()
      return fallbackQueue(now, startedAt, 'timeout-default-steer')
    }
    const verdict = normalizeModelVerdict(winner)
    const verdictMs = Math.min(INPUT_GATE_MAX_MS, Math.max(0, Math.round(now() - startedAt)))
    if (!verdict) return { verdict: 'steer', source: 'rule', verdictMs, reason: 'invalid-model-default-steer' }
    return { verdict, source: 'model', verdictMs, reason: 'model' }
  } catch {
    controller.abort()
    return fallbackQueue(now, startedAt, 'model-error-default-steer')
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** Exact fields appended to the existing utterance latency record. */
export function inputGateTraceFields(decision: InputGateDecision): {
  verdict: InputVerdict
  verdictSource: VerdictSource
  verdictMs: number
} {
  return {
    verdict: decision.verdict,
    verdictSource: decision.source,
    verdictMs: Math.min(INPUT_GATE_MAX_MS, Math.max(0, Math.round(decision.verdictMs))),
  }
}
