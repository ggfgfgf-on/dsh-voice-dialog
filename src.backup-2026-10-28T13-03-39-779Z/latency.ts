/** Per-utterance latency trace. Pure: no DOM, no fetch; tests inject a clock. */

export type LatencyStage =
  | 'utterance_end'
  | 'separation_done'
  | 'asr_done'
  | 'organize_start'
  | 'organize_done'
  | 'enqueue'
  | 'first_token'
  | 'play_start'

/** Fixed order; every record lists all stages so an absent one is explicit. */
export const LATENCY_STAGES: readonly LatencyStage[] = [
  'utterance_end',
  'separation_done',
  'asr_done',
  'organize_start',
  'organize_done',
  'enqueue',
  'first_token',
  'play_start',
]

export interface UtteranceTrace {
  id: string
  sessionId: string
  lane: 'owner' | 'guest'
  /** Absolute ms when the utterance was created (usually the VAD close). */
  startedAt: number
  /** First mark wins: a repeated stage must not move the timestamp. */
  marks: Partial<Record<LatencyStage, number>>
  textLength: number
  preview: string
}

export interface UtteranceRecord {
  kind: 'utterance'
  id: string
  sessionId: string
  lane: 'owner' | 'guest'
  at: string
  textLength: number
  preview: string
  /** Milliseconds from utterance_end. null when the stage never happened. */
  stagesMs: Record<LatencyStage, number | null>
  totalMs: number
  organizerAction?: string
  fastPath?: boolean
  retracted?: boolean
  /** True when an out-of-order mark was clamped, so the number stays honest. */
  clamped?: boolean
  prewarm?: 'hit' | 'miss' | 'discarded'
}

export interface TraceInput {
  id?: string
  sessionId: string
  lane: 'owner' | 'guest'
  startedAt?: number
}

/** Host-side guard: only known fields, bounded strings and numbers. */
export function sanitizeLatencyRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const kind = typeof record.kind === 'string' ? record.kind.slice(0, 24) : ''
  if (!kind) return null
  const sessionId = typeof record.sessionId === 'string' ? record.sessionId.slice(0, 80) : ''
  const at = typeof record.at === 'string' ? record.at.slice(0, 32) : new Date().toISOString()
  const out: Record<string, unknown> = { kind, sessionId, at }
  for (const key of ['id', 'lane', 'preview', 'organizerAction', 'prewarm', 'replyId', 'phase', 'reason'] as const) {
    const field = record[key]
    if (typeof field === 'string') out[key] = field.slice(0, key === 'preview' ? 20 : 64)
  }
  for (const key of ['textLength', 'totalMs', 'fastPath', 'retracted', 'clamped', 'sinceEnqueueMs', 'epoch', 'seq'] as const) {
    const field = record[key]
    if (typeof field === 'number' && Number.isFinite(field)) out[key] = field
    else if (typeof field === 'boolean') out[key] = field
  }
  const stages = record.stagesMs
  if (stages && typeof stages === 'object') {
    const clean: Record<string, number | null> = {}
    for (const stage of LATENCY_STAGES) {
      const field = (stages as Record<string, unknown>)[stage]
      clean[stage] = typeof field === 'number' && Number.isFinite(field) ? field : null
    }
    out.stagesMs = clean
  }
  return out
}

let traceCounter = 0

/** Only the first 20 printable characters, never audio. */
export function latencyPreview(text: string): string {
  const flat = String(text ?? '').replace(/\s+/gu, ' ').trim()
  return flat.slice(0, 20)
}

export function createUtteranceTrace(input: TraceInput, clock: () => number = Date.now): UtteranceTrace {
  traceCounter += 1
  const startedAt = typeof input.startedAt === 'number' && Number.isFinite(input.startedAt)
    ? input.startedAt
    : clock()
  return {
    id: input.id ?? input.sessionId + ':' + startedAt + ':' + traceCounter,
    sessionId: input.sessionId,
    lane: input.lane,
    startedAt,
    marks: {},
    textLength: 0,
    preview: '',
  }
}

export function markUtteranceStage(
  trace: UtteranceTrace | undefined,
  stage: LatencyStage,
  clock: () => number = Date.now,
): void {
  if (!trace) return
  if (!LATENCY_STAGES.includes(stage)) return
  if (trace.marks[stage] !== undefined) return
  trace.marks[stage] = clock()
}

export function noteUtteranceText(trace: UtteranceTrace | undefined, text: string): void {
  if (!trace) return
  const flat = String(text ?? '').replace(/\s+/gu, ' ').trim()
  trace.textLength = flat.length
  trace.preview = latencyPreview(flat)
}

export interface RecordOptions {
  organizerAction?: string
  fastPath?: boolean
  retracted?: boolean
  prewarm?: 'hit' | 'miss' | 'discarded'
}

/**
 * Relative stage timings. Concurrent stages keep their own timestamps: the
 * optimistic enqueue legitimately happens before the organizer answers, so the
 * report must not pretend the stages are strictly ordered. Only a mark that
 * lands before the utterance end is clamped to 0, with clamped=true.
 */
export function buildUtteranceRecord(
  trace: UtteranceTrace,
  options: RecordOptions = {},
  clock: () => number = Date.now,
): UtteranceRecord {
  const base = trace.marks.utterance_end ?? trace.startedAt
  const stagesMs = {} as Record<LatencyStage, number | null>
  let maximum = 0
  let clamped = false
  for (const stage of LATENCY_STAGES) {
    const mark = trace.marks[stage]
    if (mark === undefined) { stagesMs[stage] = null; continue }
    let delta = mark - base
    if (delta < 0) { delta = 0; clamped = true }
    stagesMs[stage] = delta
    if (delta > maximum) maximum = delta
  }
  return {
    kind: 'utterance',
    id: trace.id,
    sessionId: trace.sessionId,
    lane: trace.lane,
    at: new Date(clock()).toISOString(),
    textLength: trace.textLength,
    preview: trace.preview,
    stagesMs,
    totalMs: maximum,
    ...(options.organizerAction === undefined ? {} : { organizerAction: options.organizerAction }),
    ...(options.fastPath === undefined ? {} : { fastPath: options.fastPath }),
    ...(options.retracted === undefined ? {} : { retracted: options.retracted }),
    ...(options.prewarm === undefined ? {} : { prewarm: options.prewarm }),
    ...(clamped ? { clamped: true } : {}),
  }
}
