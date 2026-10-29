/**
 * Slow planner layer: output arrangement. It never sits on the reply path — the
 * utterance is already queued (and possibly answered) by the time a plan
 * arrives, so every plan is an optional correction that may only reorder or
 * delete sentences that have not started yet. It never authors new text.
 */
import {
  normalizeQueuePlan, normalizeSentenceIndices, parseOrganizerResponse,
  type OrganizerPendingLine, type QueuePlanItem,
} from './organizer.js'
import { boundedOrganizerBlocks } from './organizer-history.js'

export interface PlannerRequest {
  sessionId: string
  /** Idempotency key: one reply turn, one plan. */
  turnId: string
  text: string
  lane: 'owner' | 'guest'
  playing: boolean
  queued: number
  queue: Array<{ id: number; lane: string; text: string }>
  assistantPending: OrganizerPendingLine[]
}

export interface PlannerPlan {
  version: number
  turnId: string
  reason: string
  interrupt: boolean
  queuePlan?: QueuePlanItem[]
  dropSentences?: number[]
  reorder?: number[]
}

export type PlannerFn = (request: PlannerRequest, signal: AbortSignal) => Promise<unknown>

export interface PlannerOptions {
  /** Hard deadline for one plan. Long on purpose: nothing waits on it. */
  timeoutMs?: number
}

function readQueuePlan(value: unknown): QueuePlanItem[] {
  if (!value || typeof value !== 'object') return []
  const record = value as { queuePlan?: unknown; queue_plan?: unknown }
  return normalizeQueuePlan(record.queuePlan ?? record.queue_plan)
}

function readIndices(value: unknown): number[] {
  if (!value || typeof value !== 'object') return []
  const record = value as { dropSentences?: unknown; reorder?: unknown }
  return normalizeSentenceIndices(record.dropSentences ?? record.reorder)
}

/**
 * One planner per microphone session. Each call bumps the version and aborts the
 * previous request, so a late answer from an older turn can never rewrite a
 * newer one.
 */
export class SpeechPlanner {
  private version = 0
  private controller: AbortController | null = null
  private readonly timeoutMs: number

  constructor(private readonly planner: PlannerFn, options: PlannerOptions = {}) {
    this.timeoutMs = Math.max(1, Math.round(options.timeoutMs ?? 900))
  }

  async plan(request: PlannerRequest): Promise<PlannerPlan | null> {
    const version = ++this.version
    this.controller?.abort()
    const controller = new AbortController()
    this.controller = controller
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; controller.abort() }, this.timeoutMs)
    try {
      const deadline = new Promise<never>((_, reject) => {
        controller.signal.addEventListener('abort', () => reject(new Error('planner-aborted')), { once: true })
      })
      const raw = await Promise.race([
        this.planner(request, controller.signal).catch(() => null),
        deadline,
      ]).catch(() => null)
      if (version !== this.version) return null
      if (timedOut) return null
      const value = typeof raw === 'string' ? parseOrganizerResponse(raw) : raw
      if (!value || typeof value !== 'object') return null
      const record = value as Record<string, unknown> & { reason?: unknown }
      const queuePlan = readQueuePlan(record)
      const drops = readIndices({ dropSentences: record.dropSentences })
      const reorder = readIndices({ reorder: record.reorder })
      const action = typeof record.action === 'string' ? record.action : ''
      const interrupt = action === 'interrupt'
      if (!interrupt && queuePlan.length === 0 && drops.length === 0 && reorder.length === 0) return null
      return {
        version,
        turnId: request.turnId,
        reason: typeof record.reason === 'string' ? record.reason.slice(0, 80) : '',
        interrupt,
        ...(queuePlan.length === 0 ? {} : { queuePlan }),
        ...(drops.length === 0 ? {} : { dropSentences: drops }),
        ...(reorder.length === 0 ? {} : { reorder }),
      }
    } catch {
      return null
    } finally {
      clearTimeout(timer)
      if (this.controller === controller) this.controller = null
    }
  }

  isCurrent(plan: PlannerPlan | null | undefined): boolean {
    return plan !== null && plan !== undefined && plan.version === this.version
  }

  cancel(): void {
    this.version += 1
    this.controller?.abort()
    this.controller = null
  }
}

/** Apply-at-most-once bookkeeping, keyed by turn id plus plan version. */
export class PlanLedger {
  private readonly claimed = new Set<string>()
  tryClaim(plan: PlannerPlan): boolean {
    const key = plan.turnId + '#' + plan.version
    if (this.claimed.has(key)) return false
    this.claimed.add(key)
    if (this.claimed.size > 200) {
      const oldest = this.claimed.values().next().value
      if (oldest !== undefined) this.claimed.delete(oldest)
    }
    return true
  }
  clear(): void { this.claimed.clear() }
}

export interface PlanState {
  playing: boolean
  queued: number
  /** Arrival ids still waiting in the scheduler. */
  ids: readonly number[]
}

/**
 * A plan may only be applied while the turn it addresses still exists. Once the
 * queue is empty and nothing plays, the turn is over and the whole plan is
 * dropped instead of reviving stale content.
 */
export function shouldApplyPlan(plan: PlannerPlan | null | undefined, state: PlanState): boolean {
  if (!plan) return false
  if (state.queued === 0 && !state.playing) return false
  const addresses = [
    ...(plan.queuePlan ?? []).map((item) => item.id),
  ]
  if (addresses.length === 0) return true
  const alive = new Set(state.ids)
  return addresses.some((id) => alive.has(id))
}
export interface PlannerNeed {
  /** Read-aloud blocks of the current reply that have not been spoken yet. */
  pendingBlocks: number
  /** Captured utterances waiting in the scheduler. */
  queued?: number
}

/**
 * The slow layer is only worth a model call when there is something to
 * rearrange. A reply with a single unread block, or an idle queue with nothing
 * pending, has no order to change, so the call is skipped instead of spending
 * latency behind the reply.
 */
export function shouldRunPlanner(state: PlannerNeed): boolean {
  const safe = (value: number | undefined): number => (
    Number.isFinite(value) ? Math.max(0, Math.trunc(value as number)) : 0
  )
  return safe(state.pendingBlocks) >= 2 || safe(state.queued) >= 2
}

/** Slow layer bounds, asserted by tests. */
export const PLANNER_PROMPT_LIMIT = 1600
export const PLANNER_MAX_TOKENS = 200
export const PLANNER_TIMEOUT_MS = 900
export const PLANNER_QUEUE_LIMIT = 8
export const PLANNER_PENDING_LIMIT = 8
export const PLANNER_HISTORY_PER_ROLE = 3
export const PLANNER_ITEM_CHARS = 80

export const PLANNER_SYSTEM_PROMPT =
  '你是语音输出编排器（慢判层）。你的本职是组织"我还没说出口的话"，不是拦用户输入。'
  + '输入：待说朗读块（带编号，可能标注同一句）、已排队条目、用户新话。'
  + '你可以：reorder 调整朗读块顺序（结论/答案提前）、dropSentences 删除一个或多个朗读块'
  + '（仅限重复、背景铺垫、与最新话冲突）、queuePlan 裁决已排队条目（keep/drop/raise+priority）。'
  + '同一句内的块必须保持原相对顺序；可以整句前移/后移，也可以丢掉单个块。'
  + '禁止：新增内容、改写文字、编造数字、动正在播或已播的块。'
  + '用户说"先说结论/别讲背景"时：结论块排最前，背景块进 dropSentences，未点名的块不删。'
  + '输出一行JSON：{"reorder":[1,0],"dropSentences":[2],"queuePlan":[],"interrupt":false,"reason":"≤10字"}；'
  + '没有更合适的顺序就输出 {"reason":"不变"}。'

export interface PlannerPromptInput {
  text: string
  lane: 'owner' | 'guest'
  playing: boolean
  queued: number
  queue: Array<{ id: number; lane: string; text: string }>
  assistantPending: OrganizerPendingLine[]
  history: Array<{ role: string; text: string }>
}

function clipItem(text: string, limit: number = PLANNER_ITEM_CHARS): string {
  const flat = String(text ?? '').replace(/\s+/gu, ' ').trim()
  return flat.length > limit ? flat.slice(0, limit) : flat
}

function historyLines(history: PlannerPromptInput['history']): string[] {
  const kept: string[] = []
  let users = 0
  let assistants = 0
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const item = history[index]
    if (!item) continue
    const role = item.role === 'assistant' ? 'assistant' : 'user'
    if (role === 'assistant' ? assistants >= PLANNER_HISTORY_PER_ROLE : users >= PLANNER_HISTORY_PER_ROLE) continue
    const text = clipItem(item.text)
    if (!text) continue
    kept.push((role === 'assistant' ? '助手：' : '我：') + text)
    if (role === 'assistant') assistants += 1
    else users += 1
  }
  return kept.reverse()
}

/** Planner user message, trimmed until it fits PLANNER_PROMPT_LIMIT. */
export function buildPlannerPrompt(input: PlannerPromptInput): string {
  const head = [
    '朗读中：' + (input.playing ? '是' : '否'),
    '排队条数：' + Math.max(0, Math.round(input.queued)),
    '说话人：' + (input.lane === 'owner' ? '我' : '其他人'),
  ]
  const queue = input.queue.slice(0, PLANNER_QUEUE_LIMIT)
    .map((item) => '队列 ' + item.id + '|' + (item.lane === 'guest' ? '其他人' : '我') + '：' + clipItem(item.text))
  const pending = boundedOrganizerBlocks(input.assistantPending)
    .slice(0, PLANNER_PENDING_LIMIT)
    .map((block, index) => {
      const meta = block.sentenceId === undefined
        ? ''
        : '（句' + block.sentenceId + '块' + ((block.chunkIndex ?? 0) + 1) + '）'
      return '待说 ' + index + '|' + clipItem(block.text) + meta
    })
  const history = historyLines(input.history)
  const tail = ['新话：' + clipItem(input.text)]
  // Trim from the least important part (history, then queue, then pending) so
  // the newest instruction always survives.
  const dropOrder: Array<'history' | 'queue' | 'pending'> = ['history', 'queue', 'pending']
  const sections: Record<'history' | 'queue' | 'pending' | 'tail', string[]> = {
    history, queue, pending, tail,
  }
  const render = (): string => [head, history, queue, pending, tail].flat().join('\n')
  for (const key of dropOrder) {
    while (PLANNER_SYSTEM_PROMPT.length + render().length > PLANNER_PROMPT_LIMIT && sections[key].length > 0) {
      sections[key].shift()
    }
    if (PLANNER_SYSTEM_PROMPT.length + render().length <= PLANNER_PROMPT_LIMIT) break
  }
  const text = [head, sections.history, sections.queue, sections.pending, sections.tail].flat().join('\n')
  return text.length > PLANNER_PROMPT_LIMIT - PLANNER_SYSTEM_PROMPT.length
    ? text.slice(0, Math.max(0, PLANNER_PROMPT_LIMIT - PLANNER_SYSTEM_PROMPT.length))
    : text
}

export function plannerPromptChars(input: PlannerPromptInput): number {
  return PLANNER_SYSTEM_PROMPT.length + buildPlannerPrompt(input).length
}
