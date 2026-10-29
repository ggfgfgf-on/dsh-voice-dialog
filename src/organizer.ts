/** Parallel, model-driven delivery organizer. Pure: no DOM and no fetch here. */

export type OrganizerAction = 'interrupt' | 'queue' | 'ignore' | 'drop'
export type OrganizerLane = 'owner' | 'guest'

/** A numbered read-aloud block the organizer may reorder or drop. */
export interface OrganizerPendingBlock {
  text: string
  /** All blocks cut from one sentence share this id. */
  sentenceId?: number
  /** Position inside that sentence; used to keep same-sentence order stable. */
  chunkIndex?: number
}

export type OrganizerPendingLine = string | OrganizerPendingBlock

export interface OrganizerRequest {
  sessionId: string
  /** Visible transcript, without the speaker prefix. */
  text: string
  lane: OrganizerLane
  /** True while an assistant reply is still being spoken or queued. */
  playing: boolean
  /** Utterances already waiting in the speech scheduler. */
  queued: number
  /** FIFO contents the model must see before deciding. */
  queue?: Array<{ lane: string; text: string }>
  /** Owner weight: 1 for the owner lane, lower for guests. */
  ownerWeight?: number
  /** What the assistant still owes: index 0 is the block playing now. */
  assistantPending?: OrganizerPendingLine[]
  /** Text of the sentence being read out right now. */
  playingText?: string
  /** The owner's previous accepted line, so the intent is read in context. */
  previousText?: string
}

/** Fields that let the organizer rewrite what the assistant still owes. */
export interface OrganizerReorganizeFields {
  /** Indices into the pending-block snapshot; 0 is already playing. */
  dropSentences?: number[]
  /** Remaining block indices, in the order they should be spoken. */
  reorder?: number[]
}

export type QueuePlanAction = 'keep' | 'drop' | 'raise'

/** One adjudication of an already-queued utterance, addressed by arrival id. */
export interface QueuePlanItem {
  id: number
  action: QueuePlanAction
  priority?: number
}

export interface QueuePlanFields {
  queuePlan?: QueuePlanItem[]
}

export interface OrganizerPlan extends OrganizerReorganizeFields, QueuePlanFields {
  /** Monotonic version of this organizer instance. */
  version: number
  action: OrganizerAction
  /** Lower is earlier. Omitted means keep arrival order. */
  priority?: number
  reason: string
}

export interface ParsedOrganizer extends OrganizerReorganizeFields, QueuePlanFields {
  action: OrganizerAction
  priority?: number
  reason: string
}

export type OrganizerPlanner = (request: OrganizerRequest, signal: AbortSignal) => Promise<unknown>

export interface SpeechOrganizerOptions {
  /** Hard deadline for one decision. */
  timeoutMs?: number
}

/** Accept only the documented actions. */
export function normalizeOrganizerAction(value: unknown): OrganizerAction | null {
  if (typeof value !== 'string') return null
  const action = value.trim().toLowerCase()
  return action === 'interrupt' || action === 'queue' || action === 'ignore' || action === 'drop'
    ? action : null
}

/** Only an explicit model verdict may discard speech. */
export function shouldDeliverOrganizerAction(action: OrganizerAction): boolean {
  return action !== 'ignore' && action !== 'drop'
}

/** Priority is a non-negative integer; lower numbers are delivered first. */
export function normalizeOrganizerPriority(value: unknown): number | undefined {
  const number = typeof value === 'number'
    ? value
    : (typeof value === 'string' && /^\d+$/u.test(value.trim()) ? Number(value.trim()) : NaN)
  if (!Number.isFinite(number) || number < 0) return undefined
  return Math.min(1_000_000, Math.trunc(number))
}

/** Caps shared by the prompt builder and the client snapshot. */
export const ORGANIZER_PENDING_LIMIT = 12
export const ORGANIZER_PENDING_ITEM_CHARS = 120
export const ORGANIZER_PENDING_TOTAL_CHARS = 1200

/**
 * Coerce an untrusted index list: integers only, no negatives, duplicates and
 * junk dropped. Bounds are checked against the snapshot by applyReorganization,
 * because the parser does not know how many sentences exist.
 */
export function normalizeSentenceIndices(value: unknown): number[] {
  if (!Array.isArray(value)) return []
  const out: number[] = []
  for (const item of value) {
    const number = typeof item === 'number'
      ? item
      : (typeof item === 'string' && /^\d+$/u.test(item.trim()) ? Number(item.trim()) : NaN)
    if (!Number.isInteger(number) || number < 0) continue
    if (number > 10_000) continue
    if (out.includes(number)) continue
    out.push(number)
  }
  return out.slice(0, ORGANIZER_PENDING_LIMIT * 4)
}

const QUEUE_PLAN_LIMIT = 8

/** Coerce an untrusted queue plan: known ids, known actions, one entry per id. */
export function normalizeQueuePlan(value: unknown): QueuePlanItem[] {
  const source = Array.isArray(value)
    ? value
    : (value && typeof value === 'object' && Array.isArray((value as { items?: unknown }).items)
      ? (value as { items: unknown[] }).items : [])
  const out: QueuePlanItem[] = []
  const seen = new Set<number>()
  for (const raw of source) {
    if (!raw || typeof raw !== 'object') continue
    const record = raw as { id?: unknown; action?: unknown; priority?: unknown }
    const id = typeof record.id === 'number'
      ? record.id
      : (typeof record.id === 'string' && /^\d+$/u.test(record.id.trim()) ? Number(record.id.trim()) : NaN)
    if (!Number.isInteger(id) || id < 0 || id > 1_000_000) continue
    if (seen.has(id)) continue
    const action = typeof record.action === 'string' ? record.action.trim().toLowerCase() : ''
    if (action !== 'keep' && action !== 'drop' && action !== 'raise') continue
    seen.add(id)
    const priority = action === 'raise' ? normalizeOrganizerPriority(record.priority) : undefined
    if (action === 'raise' && priority === undefined) {
      out.push({ id, action: 'keep' })
      continue
    }
    out.push({ id, action, ...(priority === undefined ? {} : { priority }) })
    if (out.length >= QUEUE_PLAN_LIMIT) break
  }
  return out
}

/** Tolerance: reorg fields may be null, a string, or missing entirely. */
function readReorganizeFields(value: unknown): OrganizerReorganizeFields {
  if (!value || typeof value !== 'object') return {}
  const record = value as Record<string, unknown>
  const drops = normalizeSentenceIndices(record.dropSentences ?? record.drop_sentences)
  const order = normalizeSentenceIndices(record.reorder ?? record.order)
  const queuePlan = normalizeQueuePlan(record.queuePlan ?? record.queue_plan)
  return {
    ...(drops.length === 0 ? {} : { dropSentences: drops }),
    ...(order.length === 0 ? {} : { reorder: order }),
    ...(queuePlan.length === 0 ? {} : { queuePlan }),
  }
}

export interface ReorganizationResult {
  /** Every kept index exactly once, in final speaking order. */
  order: number[]
  /** Indices the organizer explicitly removed. */
  dropped: number[]
}

/**
 * Turn a (possibly hostile) reorg decision into a total order over the kept
 * blocks. Invariants worth protecting:
 * - index 0 is already playing and can never be dropped here;
 * - every non-dropped index appears exactly once;
 * - indices listed in "reorder" come first, in that order, then the rest keep
 *   their arrival order, so an incomplete reorder never loses a block;
 * - when chunkGroups is supplied, blocks sharing a sentence never overtake
 *   each other even if the model returns an invalid intra-sentence order.
 */
export function applyReorganization(
  count: number,
  fields: OrganizerReorganizeFields,
  options: {
    keepFirst?: boolean
    /** group[i] identifies the sentence of block i; omitted preserves old global behavior. */
    chunkGroups?: readonly (string | number | undefined)[]
  } = {},
): ReorganizationResult {
  const size = Math.max(0, Math.min(ORGANIZER_PENDING_LIMIT, Math.trunc(Number(count) || 0)))
  const keepFirst = options.keepFirst !== false
  const all = Array.from({ length: size }, (_, index) => index)
  const dropped = normalizeSentenceIndices(fields.dropSentences)
    .filter((index) => index < size && !(keepFirst && index === 0))
  const alive = all.filter((index) => !dropped.includes(index))
  const preferred: number[] = []
  for (const index of normalizeSentenceIndices(fields.reorder)) {
    if (index >= size || dropped.includes(index) || preferred.includes(index)) continue
    preferred.push(index)
  }
  for (const index of alive) if (!preferred.includes(index)) preferred.push(index)

  if (!options.chunkGroups) return { order: preferred, dropped }

  // Preserve relative order inside one sentence while still allowing whole
  // sentences to move. Kahn's algorithm picks the earliest model-preferred
  // block whose same-sentence predecessor has already been spoken.
  const groupOf = (index: number): string => {
    const group = options.chunkGroups![index]
    return group === undefined || group === null ? '#' + index : String(group)
  }
  const previousInGroup = new Map<number, number>()
  const lastInGroup = new Map<string, number>()
  for (const index of alive) {
    const key = groupOf(index)
    const previous = lastInGroup.get(key)
    if (previous !== undefined) previousInGroup.set(index, previous)
    lastInGroup.set(key, index)
  }
  const rank = new Map<number, number>()
  preferred.forEach((index, position) => rank.set(index, position))
  const order: number[] = []
  const remaining = new Set(alive)
  while (remaining.size > 0) {
    let best: number | undefined
    let bestRank = Number.MAX_SAFE_INTEGER
    for (const candidate of remaining) {
      const previous = previousInGroup.get(candidate)
      if (previous !== undefined && remaining.has(previous)) continue
      const candidateRank = rank.get(candidate) ?? Number.MAX_SAFE_INTEGER
      if (best === undefined || candidateRank < bestRank) {
        best = candidate
        bestRank = candidateRank
      }
    }
    // A malformed cycle must never lose blocks; fall back to preferred order.
    if (best === undefined) best = preferred.find((index) => remaining.has(index))
    if (best === undefined) break
    remaining.delete(best)
    order.push(best)
  }
  return { order, dropped }
}

/** Apply a plan to block objects, using sentenceId to keep intra-sentence order. */
export function applyChunkReorganization(
  chunks: readonly OrganizerPendingBlock[],
  fields: OrganizerReorganizeFields,
  options: { keepFirst?: boolean } = {},
): ReorganizationResult {
  return applyReorganization(chunks.length, fields, {
    ...options,
    chunkGroups: chunks.map((chunk) => chunk.sentenceId),
  })
}

/**
 * Tolerate fenced JSON and a short prose preamble. The host asks for JSON, but
 * a model that ignores that instruction must still yield a safe queue default.
 */
export function parseOrganizerResponse(raw: string): ParsedOrganizer | null {
  if (typeof raw !== 'string' || !raw.trim()) return null
  const text = raw.replace(/```(?:json)?/giu, '').trim()
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start >= 0 && end > start) {
    try {
      const value = JSON.parse(text.slice(start, end + 1)) as { action?: unknown; priority?: unknown; reason?: unknown }
      const action = normalizeOrganizerAction(value.action)
      if (action) {
        const priority = normalizeOrganizerPriority(value.priority)
        return {
          action,
          ...(priority === undefined ? {} : { priority }),
          ...readReorganizeFields(value),
          reason: typeof value.reason === 'string' ? value.reason.slice(0, 80) : '',
        }
      }
    } catch {
      // Truncated JSON (the model ran out of tokens mid-object) still names the action.
    }
  }
  // Last resort: the action word itself, whether the object was cut or never closed.
  const keyword = text.match(/"?action"?\s*[:：]\s*"?\s*(interrupt|queue|ignore|drop)/iu)
  if (keyword) return { action: keyword[1]!.toLowerCase() as OrganizerAction, reason: 'keyword' }
  return null
}

/** A parsed object may come from fetch.json() without another JSON round trip. */
function parsePlannerValue(value: unknown): ParsedOrganizer | null {
  if (typeof value === 'string') return parseOrganizerResponse(value)
  if (!value || typeof value !== 'object') return null
  const record = value as { action?: unknown; priority?: unknown; reason?: unknown }
  const action = normalizeOrganizerAction(record.action)
  if (!action) return null
  const priority = normalizeOrganizerPriority(record.priority)
  return {
    action,
    ...(priority === undefined ? {} : { priority }),
    ...readReorganizeFields(record),
    reason: typeof record.reason === 'string' ? record.reason.slice(0, 80) : '',
  }
}

/**
 * One organizer per microphone session. Every call bumps the version and
 * aborts the previous model request; a slow old answer can never cut a newer
 * reply. Timeouts and malformed output fall back to the safe "queue" action.
 */
export class SpeechOrganizer {
  private version = 0
  private controller: AbortController | null = null
  private latest: OrganizerPlan | null = null
  private readonly timeoutMs: number

  constructor(private readonly planner: OrganizerPlanner, options: SpeechOrganizerOptions = {}) {
    this.timeoutMs = Math.max(1, Math.round(options.timeoutMs ?? 1200))
  }

  async plan(request: OrganizerRequest): Promise<OrganizerPlan | null> {
    const version = ++this.version
    this.controller?.abort()
    const controller = new AbortController()
    this.controller = controller
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, this.timeoutMs)

    try {
      const raw = await this.planner(request, controller.signal)
      // A newer utterance started while this request was in flight.
      if (version !== this.version) return null
      if (timedOut) return this.fallback(version, 'timeout')
      const parsed = parsePlannerValue(raw)
      if (!parsed) return this.fallback(version, 'invalid')
      const plan: OrganizerPlan = {
        version,
        action: parsed.action,
        ...(parsed.priority === undefined ? {} : { priority: parsed.priority }),
        ...(parsed.dropSentences === undefined ? {} : { dropSentences: parsed.dropSentences }),
        ...(parsed.reorder === undefined ? {} : { reorder: parsed.reorder }),
        ...(parsed.queuePlan === undefined ? {} : { queuePlan: parsed.queuePlan }),
        reason: parsed.reason,
      }
      this.latest = plan
      return plan
    } catch {
      if (version !== this.version) return null
      return this.fallback(version, timedOut ? 'timeout' : 'error')
    } finally {
      clearTimeout(timer)
      if (this.controller === controller) this.controller = null
    }
  }

  /** The only legal gate for applying or cutting: this plan is still newest. */
  isCurrent(plan: OrganizerPlan | null | undefined): boolean {
    return plan !== null && plan !== undefined && plan.version === this.version
  }

  /** An explicit "打断" command wins over any organizer request in flight. */
  cancel(): void {
    this.version += 1
    this.controller?.abort()
    this.controller = null
    this.latest = null
  }

  last(): OrganizerPlan | null {
    return this.latest
  }

  private fallback(version: number, reason: string): OrganizerPlan {
    const plan: OrganizerPlan = { version, action: 'queue', reason }
    this.latest = plan
    return plan
  }
}
