/** Per-utterance latency trace. Pure: no DOM, no fetch; tests inject a clock. */

export type LatencyStage =
  | 'utterance_end'
  | 'separation_done'
  | 'asr_start'
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
  'asr_start',
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

/**
 * Wall-clock facts that a stage mark alone cannot express: when the speaker
 * actually stopped, when the recognizer call started and returned, and how much
 * of that call the server spent inside the model.
 */
export interface SeparationLatencyDetail {
  mode?: 'fast' | 'continuous' | 'fallback'
  prewarm?: 'hit' | 'miss' | 'discarded'
  /** Host-side time behind another separation request. */
  queueMs?: number
  /** Worker/model time only. */
  modelMs?: number
  /** Full host call wall time. */
  wallMs?: number
  /** Time waiting for a prewarm that was already in flight. */
  prewarmWaitMs?: number
  /** Resolve-to-result time observed by ContinuousSeparation. */
  windowMs?: number
  /** How many model windows this segment needed. */
  modelCalls?: number
  /** Gate verdict (same-voice, voice-changed, owner-mismatch, uncertain...). */
  gateReason?: string
  selfSimilarity?: number
  ownerSimilarity?: number
}

export interface UtteranceTiming {
  /** Last speech sample of the utterance, before the VAD waited out its tail. */
  speechEndAt?: number
  /** Moment the separation result (or the fast-path gate) reached the client. */
  separationDoneAt?: number
  asrStartAt?: number
  asrDoneAt?: number
  /** Inference seconds reported by the recognizer, when the provider returns it. */
  asrInferMs?: number
  /** Measured split of the separation wait, when available. */
  separation?: SeparationLatencyDetail
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
  /** Owner input-gate decision, when this utterance went through it. */
  verdict?: 'steer' | 'queue' | 'drop'
  verdictSource?: 'rule' | 'model'
  verdictMs?: number
  fastPath?: boolean
  retracted?: boolean
  /** True when an out-of-order mark was clamped, so the number stays honest. */
  clamped?: boolean
  prewarm?: 'hit' | 'miss' | 'discarded'
  separationMode?: 'fast' | 'continuous' | 'fallback'
  separationPrewarm?: 'hit' | 'miss' | 'discarded'
  separationQueueMs?: number
  separationModelMs?: number
  separationWallMs?: number
  separationPrewarmWaitMs?: number
  separationWindowMs?: number
  separationModelCalls?: number
  separationGate?: string
  separationSelfSimilarity?: number
  separationOwnerSimilarity?: number
  /** Trailing silence the VAD already waited through before it closed the utterance. */
  endpointWaitMs?: number
  /** utterance_end -> separation result. */
  separationWaitMs?: number
  /** separation result (or utterance end) -> recognizer call start: queue wait. */
  asrQueueMs?: number
  /** Recognizer call wall time, transport included. */
  asrWallMs?: number
  /** asrWallMs minus the provider's own inference time. */
  asrTransportMs?: number
  asrInferMs?: number
  /** Sum of the four waits: endpoint + separation + queue + transport + inference. */
  decomposedMs?: number
  /** enqueue (or asr_done) minus decomposedMs; near zero means the split explains the total. */
  residualMs?: number
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
  for (const key of ['id', 'lane', 'preview', 'organizerAction', 'verdict', 'verdictSource', 'prewarm', 'replyId', 'phase', 'reason',
    'separationMode', 'separationPrewarm', 'separationGate'] as const) {
    const field = record[key]
    if (typeof field === 'string') out[key] = field.slice(0, key === 'preview' ? 20 : 64)
  }
  for (const key of ['textLength', 'totalMs', 'verdictMs', 'fastPath', 'retracted', 'clamped', 'sinceEnqueueMs', 'epoch', 'seq',
    'endpointWaitMs', 'separationWaitMs', 'asrQueueMs', 'asrWallMs', 'asrTransportMs', 'asrInferMs',
    'decomposedMs', 'residualMs', 'separationQueueMs', 'separationModelMs', 'separationWallMs',
    'separationPrewarmWaitMs', 'separationWindowMs', 'separationModelCalls',
    'separationSelfSimilarity', 'separationOwnerSimilarity'] as const) {
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
  verdict?: 'steer' | 'queue' | 'drop'
  verdictSource?: 'rule' | 'model'
  verdictMs?: number
  fastPath?: boolean
  retracted?: boolean
  prewarm?: 'hit' | 'miss' | 'discarded'
  timing?: UtteranceTiming
  separation?: SeparationLatencyDetail
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
  const timing = options.timing ?? {}
  // The honest base is when the speaker stopped, not when the VAD decided to
  // stop: the tail pause is latency the user already felt.
  const base = timing.speechEndAt ?? trace.marks.utterance_end ?? trace.startedAt
  // Facts measured outside the stage marks are authoritative for their stage.
  const marks: Partial<Record<LatencyStage, number>> = { ...trace.marks }
  if (timing.separationDoneAt !== undefined) marks.separation_done = timing.separationDoneAt
  if (timing.asrStartAt !== undefined) marks.asr_start = timing.asrStartAt
  if (timing.asrDoneAt !== undefined) marks.asr_done = timing.asrDoneAt
  const stagesMs = {} as Record<LatencyStage, number | null>
  let maximum = 0
  let clamped = false
  for (const stage of LATENCY_STAGES) {
    const mark = marks[stage]
    if (mark === undefined) { stagesMs[stage] = null; continue }
    let delta = mark - base
    if (delta < 0) { delta = 0; clamped = true }
    stagesMs[stage] = delta
    if (delta > maximum) maximum = delta
  }
  const utteranceEnd = stagesMs.utterance_end
  const asrStart = stagesMs.asr_start
  const asrDone = stagesMs.asr_done
  const separation = stagesMs.separation_done
  const derived: Pick<UtteranceRecord, 'endpointWaitMs' | 'separationWaitMs' | 'asrQueueMs'
    | 'asrWallMs' | 'asrTransportMs' | 'asrInferMs' | 'decomposedMs' | 'residualMs'> = {}
  if (utteranceEnd !== null) {
    derived.endpointWaitMs = utteranceEnd
    if (separation !== null && separation >= utteranceEnd) derived.separationWaitMs = separation - utteranceEnd
    if (asrStart !== null) {
      const anchor = separation !== null ? separation : utteranceEnd
      if (asrStart >= anchor) derived.asrQueueMs = asrStart - anchor
    }
    if (asrStart !== null && asrDone !== null && asrDone >= asrStart) {
      derived.asrWallMs = asrDone - asrStart
      if (options.timing?.asrInferMs !== undefined) {
        const infer = Math.max(0, Math.round(options.timing.asrInferMs))
        derived.asrInferMs = infer
        derived.asrTransportMs = Math.max(0, derived.asrWallMs - infer)
      }
    }
    if (timing.separation?.mode === 'fast' && separation !== null && asrDone !== null) {
      // The fast path starts raw ASR and the speaker gate at the same instant;
      // adding both waits would double-count the overlap. The enqueue is ready
      // when the slower of the two finishes.
      derived.asrQueueMs = 0
      const gateReady = Math.max(0, separation - utteranceEnd)
      const asrReady = Math.max(0, asrDone - utteranceEnd)
      derived.decomposedMs = derived.endpointWaitMs + Math.max(gateReady, asrReady)
      const ready = stagesMs.enqueue ?? asrDone
      if (ready !== null) derived.residualMs = Math.round(ready - derived.decomposedMs)
    } else {
      const parts = [derived.endpointWaitMs, derived.separationWaitMs, derived.asrQueueMs,
        derived.asrTransportMs, derived.asrInferMs]
      if (parts.every((value) => value !== undefined)) {
        derived.decomposedMs = parts.reduce((sum, value) => sum + (value as number), 0)
        const ready = stagesMs.enqueue ?? asrDone
        if (ready !== null) derived.residualMs = Math.round(ready - derived.decomposedMs)
      }
    }
  }
  const separationDetail = options.separation ?? timing.separation
  const separationFields: Partial<Pick<UtteranceRecord,
    'separationMode' | 'separationPrewarm' | 'separationQueueMs' | 'separationModelMs'
    | 'separationWallMs' | 'separationPrewarmWaitMs' | 'separationWindowMs'
    | 'separationModelCalls' | 'separationGate' | 'separationSelfSimilarity'
    | 'separationOwnerSimilarity'>> = {}
  if (separationDetail?.mode !== undefined) separationFields.separationMode = separationDetail.mode
  if (separationDetail?.prewarm !== undefined) separationFields.separationPrewarm = separationDetail.prewarm
  for (const [key, value] of [
    ['separationQueueMs', separationDetail?.queueMs],
    ['separationModelMs', separationDetail?.modelMs],
    ['separationWallMs', separationDetail?.wallMs],
    ['separationPrewarmWaitMs', separationDetail?.prewarmWaitMs],
    ['separationWindowMs', separationDetail?.windowMs],
    ['separationModelCalls', separationDetail?.modelCalls],
    ['separationSelfSimilarity', separationDetail?.selfSimilarity],
    ['separationOwnerSimilarity', separationDetail?.ownerSimilarity],
  ] as const) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      separationFields[key] = key.includes('Similarity') ? Math.round(value * 1000) / 1000 : Math.round(value)
    }
  }
  if (separationDetail?.gateReason !== undefined) separationFields.separationGate = separationDetail.gateReason
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
    ...(options.verdict === undefined ? {} : { verdict: options.verdict }),
    ...(options.verdictSource === undefined ? {} : { verdictSource: options.verdictSource }),
    ...(options.verdictMs === undefined ? {} : { verdictMs: options.verdictMs }),
    ...(options.fastPath === undefined ? {} : { fastPath: options.fastPath }),
    ...(options.retracted === undefined ? {} : { retracted: options.retracted }),
    ...(options.prewarm === undefined ? {} : { prewarm: options.prewarm }),
    ...separationFields,
    ...(clamped ? { clamped: true } : {}),
    ...Object.fromEntries(Object.entries(derived).filter(([, value]) => value !== undefined)),
  }
}
