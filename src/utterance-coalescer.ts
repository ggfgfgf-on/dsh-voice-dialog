/** Merge adjacent short utterances from the same lane + canonical speaker. */
export const UTTERANCE_COALESCE_WINDOW_MS = 1500

export type CoalescerLane = 'owner' | 'guest'

export interface UtteranceCoalescerEntry<Meta = unknown> {
  lane: CoalescerLane
  canonical: string
  /** Raw ASR text, or a promise that settles when ASR completes. */
  text: string | null | Promise<string | null>
  /** Caller-owned metadata carried through to the flush callback. */
  meta: Meta
  /** Wall-clock arrival. Defaults to now(); keeps real gaps after async classification. */
  at?: number
}

export interface UtteranceCoalescerBatch<Meta = unknown> {
  lane: CoalescerLane
  canonical: string
  /** Deduped transcript assembled in append order. */
  text: Promise<string>
  entries: ReadonlyArray<UtteranceCoalescerEntry<Meta>>
}

export interface UtteranceCoalescer<Meta = unknown> {
  append(entry: UtteranceCoalescerEntry<Meta>): void
  /** Submit the pending batch immediately, ignoring the grace timer. */
  flushAll(): void
  /** Cancel only the timer; call flushAll() first when pending text must be delivered. */
  dispose(): void
}

export interface UtteranceCoalescerOptions<Meta = unknown> {
  windowMs?: number
  /** Labels that are guesses (说话人N) rather than an enrolled identity. */
  isTentativeCanonical?: (canonical: string) => boolean
  dedupeTranscript: (previous: string, next: string) => string
  submit: (batch: UtteranceCoalescerBatch<Meta>) => void
  now?: () => number
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void
}

interface PendingBatch<Meta> {
  lane: CoalescerLane
  canonical: string
  firstAt: number
  lastAt: number
  entries: UtteranceCoalescerEntry<Meta>[]
}

const keyOf = (lane: CoalescerLane, canonical: string): string => lane + ':' + canonical

/** A slot label is a guess; only enrolled names count as a speaker change. */
const DEFAULT_TENTATIVE_CANONICAL = (canonical: string): boolean => {
  const label = canonical.trim()
  return label === '' || /^说话人\d*$/.test(label) || /^speaker\d*$/i.test(label)
}

/**
 * Time-keyed batching behind the existing enqueueWithOrganizer path.
 *
 * A different speaker flushes the current batch synchronously, so the submit
 * callback is always called in first-arrival order. Same-speaker ASR promises
 * are assembled in append order and deduped against that key's previous text.
 */
export function createUtteranceCoalescer<Meta = unknown>(
  options: UtteranceCoalescerOptions<Meta>,
): UtteranceCoalescer<Meta> {
  const windowMs = Math.max(0, Math.floor(options.windowMs ?? UTTERANCE_COALESCE_WINDOW_MS))
  const now = options.now ?? (() => Date.now())
  const isTentative = options.isTentativeCanonical ?? DEFAULT_TENTATIVE_CANONICAL
  const setTimer = options.setTimer
    ?? ((callback: () => void, delayMs: number) => setTimeout(callback, delayMs))
  const clearTimer = options.clearTimer
    ?? ((timer: ReturnType<typeof setTimeout>) => clearTimeout(timer))
  const lastTextByKey = new Map<string, string>()
  const dedupeChainByKey = new Map<string, Promise<void>>()
  let pending: PendingBatch<Meta> | null = null
  let timer: ReturnType<typeof setTimeout> | undefined

  const cancelTimer = (): void => {
    if (timer === undefined) return
    clearTimer(timer)
    timer = undefined
  }

  const buildBatch = (current: PendingBatch<Meta>): UtteranceCoalescerBatch<Meta> => {
    const key = keyOf(current.lane, current.canonical)
    const entries = current.entries.slice()
    const previousWork = dedupeChainByKey.get(key) ?? Promise.resolve()
    const text = previousWork.then(async () => {
      let previous = lastTextByKey.get(key) ?? ''
      let combined = ''
      for (const entry of entries) {
        let next = ''
        try {
          const value = await entry.text
          if (typeof value === 'string') next = value
        } catch {
          // One failed ASR lane must not discard the other pieces in the batch.
          continue
        }
        const fresh = options.dedupeTranscript(previous, next)
        previous = next
        if (fresh) combined += fresh
      }
      lastTextByKey.set(key, previous)
      return combined
    })
    // Dedupe state must advance in submission order even when a batch rejects.
    dedupeChainByKey.set(key, text.then(() => undefined, () => undefined))
    return {
      lane: current.lane,
      canonical: current.canonical,
      text,
      entries,
    }
  }

  const flush = (): void => {
    if (!pending) return
    const current = pending
    pending = null
    cancelTimer()
    options.submit(buildBatch(current))
  }

  const schedule = (): void => {
    if (!pending) return
    cancelTimer()
    const elapsed = Math.max(0, now() - pending.lastAt)
    const delayMs = Math.max(0, windowMs - elapsed)
    timer = setTimer(() => {
      timer = undefined
      flush()
    }, delayMs)
  }

  return {
    append(entry) {
      const at = entry.at ?? now()
      if (pending) {
        const gapMs = Math.max(0, at - pending.lastAt)
        const laneChanged = pending.lane !== entry.lane
        // A placeholder label is a guess, not a new person: a flip between a
        // guess and a real identity must not split one sentence into two turns.
        const speakerChanged = pending.canonical !== entry.canonical
          && !isTentative(pending.canonical)
          && !isTentative(entry.canonical)
        if (laneChanged || speakerChanged || gapMs > windowMs) flush()
      }
      if (!pending) {
        pending = { lane: entry.lane, canonical: entry.canonical, firstAt: at, lastAt: at, entries: [] }
      } else if (isTentative(pending.canonical) && !isTentative(entry.canonical)) {
        // Keep the first definite identity the batch learned.
        pending.canonical = entry.canonical
      }
      pending.entries.push(entry)
      pending.lastAt = Math.max(pending.lastAt, at)
      schedule()
    },
    flushAll: flush,
    dispose() {
      pending = null
      cancelTimer()
    },
  }
}
