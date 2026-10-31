/**
 * L3 组织层：编排，而不是记录，也不是发声。
 *
 * One pure function turns a raw chunk (L2) plus the current delivery state into
 * a plan: reply / ack / hold / ignore, which lane runs it, and its priority.
 * Every decision that used to sit inline in the input gate, in the client
 * wiring and in the host queue is expressed here, so the other layers can be
 * mechanical:
 *
 *   L1 records, L2 chunks, L3 plans, L4 executes a plan item, L5 makes sound.
 *
 * The rule engine that used to live in input-gate.ts moved here unchanged, so a
 * declaration-free run still produces exactly the old verdicts.
 */

import { stripVoicePrefix } from './queue-control.js'

/* ------------------------------------------------------------------ *
 * Verdicts: the old input-gate vocabulary, now owned by this layer.
 * ------------------------------------------------------------------ */

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

  if (INTERRUPT.test(plain)) return rule('steer', 'explicit-interrupt', now, startedAt)
  if (CONTINUATION.test(text) || CONTINUATION.test(plain)) return rule('queue', 'supplement', now, startedAt)
  return null
}

/** Map a fast model response to one of the three caller-facing verdicts. */
export function normalizeModelVerdict(value: unknown): InputVerdict | null {
  if (!value || typeof value !== 'object') return null
  const record = value as { verdict?: unknown; action?: unknown; reason?: unknown }
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

/* ------------------------------------------------------------------ *
 * The plan: what to do with a chunk, on which lane, at which priority.
 * ------------------------------------------------------------------ */

export type PlanKind = 'reply' | 'ack' | 'hold' | 'ignore'
export type PlanLane = 'fast' | 'slow'
export type PlanSource = 'rule' | 'policy' | 'model'

export interface PlanItem {
  kind: PlanKind
  /** fast = sound something short now, slow = the full answer queue. */
  lane: PlanLane
  /** Lower runs first. Absent keeps arrival order, which is the old default. */
  priority?: number
  /** How long the fast lane may wait before executing it. */
  delayMs?: number
  /** Text the lane must speak; absent means the lane generates it. */
  text?: string
  reason: string
  source: PlanSource
  /** Plan-stream sequence number, so L4 can retract exactly this item. */
  seq?: number
  /** Planned from speech the listener has not finished; L4 may withdraw it. */
  provisional?: boolean
  /** Plan-stream seq of the provisional item this one replaces. */
  supersedes?: number
}

export interface PlanState {
  lane: 'owner' | 'guest'
  /** Canonical voiceprint label, for logging and guest policy lookup. */
  canonical?: string
  playing?: boolean
  queued?: number
  /** Last accepted owner transcript, used for the duplicate rule. */
  previousText?: string
  /** Effective guest policy; omitted means queue. */
  guestMode?: 'queue' | 'steer' | 'ignore'
  now?: () => number
}

export interface PlanChunk {
  text: string
}

const PRIORITY_STEER = -1

function guestPlan(mode: 'queue' | 'steer' | 'ignore'): PlanItem {
  if (mode === 'ignore') {
    return { kind: 'ignore', lane: 'slow', reason: 'guest-policy-ignore', source: 'policy' }
  }
  if (mode === 'steer') {
    return {
      kind: 'reply', lane: 'fast', priority: PRIORITY_STEER,
      reason: 'guest-steer', source: 'policy',
    }
  }
  return { kind: 'reply', lane: 'slow', reason: 'guest-queue', source: 'policy' }
}

/**
 * The single decision point. Pure: same chunk plus same state gives the same
 * plan, which is what makes the delivery testable and replayable.
 */
export function decidePlan(chunk: PlanChunk, state: PlanState): PlanItem[] {
  const decision = ruleInputDecision({
    text: chunk.text,
    lane: state.lane,
    playing: state.playing,
    queued: state.queued,
    previousText: state.previousText,
  }, state.now ?? Date.now)

  if (state.lane !== 'owner') {
    if (decision) return [guestPlan(state.guestMode ?? 'queue')]
  }

  if (decision) {
    switch (decision.verdict) {
      case 'drop':
        return [{ kind: 'ignore', lane: 'slow', reason: decision.reason, source: 'rule' }]
      case 'steer':
        return [{
          kind: 'reply', lane: 'fast', priority: PRIORITY_STEER,
          reason: decision.reason, source: 'rule',
        }]
      case 'queue':
        return [{ kind: 'hold', lane: 'slow', reason: decision.reason, source: 'rule' }]
    }
  }

  // No rule fired: an owner line is the floor, and the model reads it in its
  // own turn. Nothing here may reject it.
  return [{ kind: 'reply', lane: 'slow', reason: 'owner-floor', source: 'rule' }]
}

/**
 * Plan every chunk of one raw utterance. A split tail must not skip the
 * organization layer: it goes through the same decision, with the duplicate
 * rule carried from one chunk to the next.
 */
export function decideChunks(
  chunks: readonly string[],
  state: PlanState,
): { text: string; item: PlanItem }[] {
  const out: { text: string; item: PlanItem }[] = []
  let previous = state.previousText
  for (const text of chunks) {
    const item = decidePlan({ text }, { ...state, previousText: previous })[0]
    out.push({ text, item })
    previous = text
  }
  return out
}

/**
 * Provisional plan: the same rules applied while the listener is still talking.
 * Every item is marked provisional so L4 knows it may withdraw it, and nothing
 * here invents content: a provisional item is a shape, not a sentence.
 */
export function decidePartial(chunks: readonly string[], state: PlanState): PlanItem[] {
  return decideChunks(chunks, state).map(({ item }) => ({ ...item, provisional: true }))
}

export type ConfirmReason =
  | 'no-provisional'
  | 'rejected'
  | 'topic-shift'
  | 'shape-changed'
  | 'confirmed'

export interface ConfirmResult {
  /** True when the provisional plan still holds and may be kept. */
  confirmed: boolean
  /** The plan to run now: the confirmed provisional items, or the replacement. */
  items: PlanItem[]
  reason: ConfirmReason
}

/**
 * The corpus closed. Either the provisional plan still says what the final
 * text says (keep it) or it must be withdrawn and replaced: noise/duplicate,
 * a topic that moved, or an action that changed shape since the partial.
 */
export function confirmPlan(
  provisional: readonly PlanItem[],
  finalText: string,
  state: PlanState,
  partialText = '',
): ConfirmResult {
  const fresh = decidePlan({ text: finalText }, state)
  const head = provisional.find((item) => item && typeof item === 'object')
  if (!head) return { confirmed: false, items: fresh, reason: 'no-provisional' }
  // Noise or a duplicate: the partial plan dies with the corpus.
  if (fresh[0].kind === 'ignore') return { confirmed: false, items: fresh, reason: 'rejected' }
  if (partialText) {
    const before = squash(partialText)
    const after = squash(finalText)
    if (before.length >= 2 && after.length >= 2 && similarity(before, after) < 0.5) {
      return { confirmed: false, items: fresh, reason: 'topic-shift' }
    }
  }
  if (fresh[0].kind !== head.kind || fresh[0].lane !== head.lane) {
    return { confirmed: false, items: fresh, reason: 'shape-changed' }
  }
  const items = provisional.map(({ provisional: _provisional, ...rest }) => rest as PlanItem)
  return { confirmed: true, items, reason: 'confirmed' }
}

/** Turn a late model verdict into the same plan vocabulary. */
export function planFromVerdict(verdict: InputVerdict, reason = 'model'): PlanItem {
  if (verdict === 'steer') {
    return { kind: 'reply', lane: 'fast', priority: PRIORITY_STEER, reason, source: 'model' }
  }
  if (verdict === 'queue') return { kind: 'hold', lane: 'slow', reason, source: 'model' }
  return { kind: 'ignore', lane: 'slow', reason, source: 'model' }
}

/**
 * A short acknowledgement the fast lane may speak while the answer is not
 * ready yet. The wording is the caller's (the model declares it); only the
 * shape is decided here.
 */
export function planAck(text: string, delayMs?: number): PlanItem | null {
  const line = typeof text === 'string' ? text.trim() : ''
  if (line.length === 0 || line === 'none') return null
  const item: PlanItem = { kind: 'ack', lane: 'fast', text: line, reason: 'declared-ack', source: 'policy' }
  if (typeof delayMs === 'number' && Number.isFinite(delayMs) && delayMs > 0) item.delayMs = delayMs
  return item
}
