/**
 * L1 记录层：只记录，禁止任何判断。
 *
 * Every microphone/ASR transcript, voiceprint label and client event is
 * appended here in arrival order. This module must never decide whether a line
 * should be answered, interrupted or discarded: classification lives in
 * plan.ts (L3). The only jobs are append, subscribe, replay and an optional
 * batched write to a sink (the host may pass a JSONL appender).
 *
 * Writes are non-blocking: the sink is called from a timer in batches, and any
 * sink error is swallowed so the live path can never fail because of logging.
 */

export type RecordKind =
  | 'transcript'
  /** Speech the listener has not finished yet; recorded, never acted on by L1. */
  | 'partial'
  | 'voiceprint'
  /** One separation outcome: whether it split, how many sources, their lanes. */
  | 'source'
  | 'barge-in'
  | 'playback'
  | 'reply'
  | 'plan'
  | 'custom'

export interface RecordEvent {
  /** Monotonic, starting at 1. Gaps never happen inside one stream. */
  seq: number
  /** Wall clock at append time. */
  at: number
  kind: RecordKind
  [field: string]: unknown
}

export interface RecordStreamOptions {
  /** Ring capacity; the oldest events are dropped past it. Default 512. */
  capacity?: number
  /** Batch window for the sink. Default 250 ms. */
  flushMs?: number
  /** Flush at once once this many lines are buffered. Default 64. */
  batchMax?: number
  /** Persistence hook. Receives JSON lines; throw is swallowed. */
  sink?: (lines: readonly string[]) => void
  now?: () => number
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void
  /** Called when the sink throws so a caller can log it once. Never rethrows. */
  onError?: (error: unknown) => void
}

export interface RecordStream {
  /** Append one event. Never throws and never blocks. */
  append(kind: RecordKind, fields?: Record<string, unknown>): RecordEvent
  /** Live tail. Returns an unsubscribe function. */
  subscribe(listener: (event: RecordEvent) => void): () => void
  /** The most recent events, oldest first. */
  tail(count?: number): RecordEvent[]
  /** Everything still in the ring at or after fromSeq, oldest first. */
  replay(fromSeq?: number): RecordEvent[]
  size(): number
  lastSeq(): number
  /** Drain the persistence buffer now. */
  flush(): void
  dispose(): void
}

const DEFAULT_CAPACITY = 512
const DEFAULT_FLUSH_MS = 250
const DEFAULT_BATCH_MAX = 64

function asRecord(value: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  // seq/at/kind are owned by the stream; a caller may not forge them.
  const copy: Record<string, unknown> = {}
  for (const [key, field] of Object.entries(value)) {
    if (key === 'seq' || key === 'at' || key === 'kind') continue
    copy[key] = field
  }
  return copy
}

export function createRecordStream(options: RecordStreamOptions = {}): RecordStream {
  const capacity = Math.max(1, Math.floor(options.capacity ?? DEFAULT_CAPACITY))
  const flushMs = Math.max(0, Math.floor(options.flushMs ?? DEFAULT_FLUSH_MS))
  const batchMax = Math.max(1, Math.floor(options.batchMax ?? DEFAULT_BATCH_MAX))
  const now = options.now ?? (() => Date.now())
  const setTimer = options.setTimer
    ?? ((callback: () => void, delayMs: number) => setTimeout(callback, delayMs))
  const clearTimer = options.clearTimer
    ?? ((timer: ReturnType<typeof setTimeout>) => clearTimeout(timer))

  const ring: RecordEvent[] = []
  const listeners = new Set<(event: RecordEvent) => void>()
  let buffered: string[] = []
  let timer: ReturnType<typeof setTimeout> | undefined
  let seq = 0
  let disposed = false

  const flush = (): void => {
    if (timer !== undefined) {
      clearTimer(timer)
      timer = undefined
    }
    if (buffered.length === 0) return
    const batch = buffered
    buffered = []
    try {
      options.sink?.(batch)
    } catch (error) {
      // Persistence is a side channel: it must never reach the live path.
      try { options.onError?.(error) } catch { /* logging must not throw either */ }
    }
  }

  const schedule = (): void => {
    if (timer !== undefined || !options.sink) return
    timer = setTimer(() => {
      timer = undefined
      flush()
    }, flushMs)
    const handle = timer as { unref?: () => void } | undefined
    if (handle && typeof handle.unref === 'function') handle.unref()
  }

  return {
    append(kind, fields) {
      seq += 1
      const event: RecordEvent = { seq, at: now(), kind, ...asRecord(fields) }
      ring.push(event)
      if (ring.length > capacity) ring.splice(0, ring.length - capacity)
      for (const listener of [...listeners]) {
        try { listener(event) } catch { /* one broken subscriber must not stop the stream */ }
      }
      if (options.sink && !disposed) {
        try { buffered.push(JSON.stringify(event)) } catch { /* unserializable field: skip */ }
        if (buffered.length >= batchMax) flush()
        else schedule()
      }
      return event
    },
    subscribe(listener) {
      if (typeof listener !== 'function') return () => undefined
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    tail(count) {
      const size = typeof count === 'number' && Number.isFinite(count)
        ? Math.max(0, Math.floor(count))
        : ring.length
      return size === 0 ? [] : ring.slice(Math.max(0, ring.length - size))
    },
    replay(fromSeq) {
      const from = typeof fromSeq === 'number' && Number.isFinite(fromSeq) ? fromSeq : 0
      return ring.filter((event) => event.seq >= from)
    },
    size() {
      return ring.length
    },
    lastSeq() {
      return seq
    },
    flush,
    dispose() {
      disposed = true
      flush()
      listeners.clear()
    },
  }
}
