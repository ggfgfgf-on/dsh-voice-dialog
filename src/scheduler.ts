/** Strict FIFO delivery for concurrent multi-speaker transcripts. */
import { parseQueueControl, type QueueControl } from './queue-control.js'
import type { QueuePlanItem } from './organizer.js'

export interface QueuePlanOutcome {
  applied: QueuePlanItem[]
  ignored: Array<{ id: number; reason: string }>
}

export type SpeakerLane = 'owner' | 'guest'
export type GuestMode = 'queue' | 'steer' | 'ignore'
export type PromptMode = 'steer' | 'queue'

export interface SchedulerStatus {
  /** Transcripts still being recognized. */
  active: number
  /** Captured utterances not yet handed to the model. */
  queued: number
}

export type QueueControlEvent =
  | { action: 'interrupt'; rest: string }
  | { action: 'speaker'; target: string; policy: 'ignore' | 'queue' | 'steer' }

export interface SpeechSchedulerOptions {
  deliver: (text: string, mode: PromptMode) => Promise<void>
  /** Owner delivery. Defaults to "steer" for backward compatibility. */
  ownerMode?: () => PromptMode
  guestMode: (label: string) => GuestMode
  /** Resolve a display name such as 老婆 back to the canonical voiceprint label. */
  resolveSpeaker?: (name: string) => string
  /** Apply an explicit queue command that must not reach the model as text. */
  onControl?: (control: QueueControlEvent) => void
  onStatus?: (status: SchedulerStatus) => void
  onError?: (error: unknown) => void
}

export interface QueueSnapshotEntry {
  seq: number
  /** Arrival id used by the planner to address this entry. */
  id: number
  lane: SpeakerLane
  /** Recognized text, empty while transcription is still running. */
  text: string
  ready: boolean
}

export interface EnqueueOptions {
  /**
   * Keeps this entry at the head of the FIFO until the parallel organizer has
   * decided. Later entries still cannot overtake it.
   */
  hold?: Promise<void>
  /** Lower is delivered earlier. Omitted entries fall back to arrival order. */
  priority?: number
  /** Stable arrival token captured before an asynchronous organizer decision. */
  order?: number
}

/** A stable handle for a later organizer decision. */
export interface SchedulerEntry {
  readonly seq: number
  /** Apply a delivery mode before this entry has been sent. */
  setMode(mode: PromptMode): void
  /** Drop only this entry; earlier/later entries keep their order. */
  drop(): void
  /**
   * True once the entry left the queue and was handed to the model. A late
   * organizer answer must not drop it after this point.
   */
  started(): boolean
}

interface Entry {
  seq: number
  lane: SpeakerLane
  label: string
  ready: boolean
  text: string | null
  dropped: boolean
  delivered: boolean
  modeOverride?: PromptMode
  priority?: number
  order: number
  hold?: Promise<void>
  holdSettled: boolean
  /** Resolves the local hold race when this entry is dropped or interrupted. */
  wakeHold?: () => void
}

const NOOP_ENTRY: SchedulerEntry = {
  seq: -1,
  setMode: () => undefined,
  drop: () => undefined,
  started: () => true,
}

/**
 * Every captured utterance gets a sequence number when it is enqueued, and the
 * scheduler drains them in that order. Recognition may finish out of order, but
 * a later line cannot overtake an earlier one. Only an explicit owner command
 * such as "打断" acts immediately; it also drops the still-waiting queue.
 */
export class SpeechScheduler {
  private entries: Entry[] = []
  private nextSeq = 0
  private nextOrder = 0
  private active = 0
  private closed = false
  private draining = false
  private lastGuestLabel = ''
  private controlChain: Promise<void> = Promise.resolve()

  constructor(private readonly options: SpeechSchedulerOptions) {}

  /** Start tracking one utterance whose text will arrive asynchronously. */
  enqueue(
    lane: SpeakerLane,
    label: string,
    work: Promise<string | null>,
    enqueueOptions: EnqueueOptions = {},
  ): SchedulerEntry {
    if (this.closed) return NOOP_ENTRY
    if (lane === 'guest' && label) this.lastGuestLabel = label
    const fallbackOrder = this.nextOrder++
    const priority = typeof enqueueOptions.priority === 'number'
      && Number.isFinite(enqueueOptions.priority) ? Math.trunc(enqueueOptions.priority) : undefined
    let wakeHold: (() => void) | undefined
    let hold = enqueueOptions.hold
    if (hold !== undefined) {
      const cancelled = new Promise<void>((resolve) => { wakeHold = resolve })
      hold = Promise.race([hold, cancelled])
    }
    const entry: Entry = {
      seq: this.nextSeq++,
      lane,
      label,
      ready: false,
      text: null,
      dropped: false,
      delivered: false,
      priority,
      order: typeof enqueueOptions.order === 'number' && Number.isFinite(enqueueOptions.order)
        ? enqueueOptions.order : fallbackOrder,
      hold,
      holdSettled: hold === undefined,
      wakeHold,
    }
    this.entries.push(entry)
    this.active += 1
    this.emit()

    void work.then((value) => {
      this.active = Math.max(0, this.active - 1)
      // A control command may already have dropped this entry.
      if (!this.entries.includes(entry)) { this.emit(); return }
      entry.ready = true
      entry.text = typeof value === 'string' && value.trim() ? value.trim() : null
      if (entry.lane === 'owner' && entry.text) {
        const control = parseQueueControl(entry.text)
        if (control) {
          entry.dropped = true
          this.remove(entry)
          this.applyControl(control, entry)
          this.emit()
          this.drain()
          return
        }
      }
      this.emit()
      this.drain()
    }, (error: unknown) => {
      this.active = Math.max(0, this.active - 1)
      entry.ready = true
      entry.text = null
      this.options.onError?.(error)
      this.emit()
      this.drain()
    })

    return {
      seq: entry.seq,
      setMode: (mode) => { this.setMode(entry, mode) },
      drop: () => { this.drop(entry) },
      started: () => entry.delivered,
    }
  }

  /** Send every ready utterance in order. Retained for compatibility. */
  flushGuests(): void {
    this.drain()
  }

  /** Stop accepting work, but keep already captured utterances. */
  dispose(): void {
    this.closed = true
    this.drain()
  }

  status(): SchedulerStatus {
    return { active: this.active, queued: this.entries.length }
  }

  /**
   * Read-only FIFO view for the organizer: what is waiting, in which lane, and
   * in whose words. Never mutates or wakes the pump.
   */
  snapshot(): QueueSnapshotEntry[] {
    return this.entries.map((entry) => ({
      seq: entry.seq,
      id: entry.order,
      lane: entry.lane,
      text: entry.text ?? '',
      ready: entry.ready,
    }))
  }

  /**
   * Apply a planner's queue adjudication. Only entries still waiting are
   * addressable: a started utterance can no longer be dropped here, it can only
   * be faded out by an interrupt. Unknown/duplicate ids are ignored, never
   * guessed, so a stale plan can only ever be a no-op.
   */
  applyQueuePlan(plan: readonly QueuePlanItem[]): QueuePlanOutcome {
    const applied: QueuePlanItem[] = []
    const ignored: Array<{ id: number; reason: string }> = []
    const seen = new Set<number>()
    for (const item of plan.slice(0, 16)) {
      const id = Math.trunc(Number(item.id))
      if (!Number.isInteger(id) || id < 0) { ignored.push({ id, reason: 'invalid-id' }); continue }
      if (seen.has(id)) { ignored.push({ id, reason: 'duplicate' }); continue }
      seen.add(id)
      const entry = this.entries.find((candidate) => candidate.order === id)
      if (!entry) { ignored.push({ id, reason: 'unknown-id' }); continue }
      if (entry.delivered) { ignored.push({ id, reason: 'started' }); continue }
      if (item.action === 'keep') { applied.push({ id, action: 'keep' }); continue }
      if (item.action === 'drop') {
        this.drop(entry)
        applied.push({ id, action: 'drop' })
        continue
      }
      if (item.action === 'raise') {
        const priority = Number(item.priority)
        if (!Number.isFinite(priority)) { ignored.push({ id, reason: 'invalid-priority' }); continue }
        entry.priority = Math.max(-1, Math.min(1_000_000, Math.trunc(priority)))
        applied.push({ id, action: 'raise', priority: entry.priority })
        continue
      }
      ignored.push({ id, reason: 'invalid-action' })
    }
    this.orderEntries()
    this.emit()
    this.drain()
    return { applied, ignored }
  }

  private setMode(entry: Entry, mode: PromptMode): void {
    if (this.closed || entry.dropped || entry.delivered) return
    entry.modeOverride = mode
    this.drain()
  }

  private drop(entry: Entry): void {
    if (entry.dropped || entry.delivered) return
    entry.dropped = true
    this.remove(entry)
    this.emit()
    this.drain()
  }

  private remove(entry: Entry): void {
    this.settleHold(entry)
    this.entries = this.entries.filter((item) => item !== entry)
  }

  /** Release a pump awaiting this entry's external hold, exactly once. */
  private settleHold(entry: Entry): void {
    entry.holdSettled = true
    const wake = entry.wakeHold
    entry.wakeHold = undefined
    wake?.()
  }

  private applyControl(control: QueueControl, entry: Entry): void {
    if (control.action === 'interrupt') {
      const prefix = entry.text?.match(/^\s*\[声纹：[^\]]*\]\s*/u)?.[0] ?? ''
      this.dropAll()
      this.options.onControl?.({ action: 'interrupt', rest: control.rest })
      if (control.rest) {
        const rest = prefix + control.rest
        this.controlChain = this.controlChain.then(async () => {
          try {
            await this.options.deliver(rest, 'steer')
          } catch (error) {
            this.options.onError?.(error)
          }
        })
      }
      return
    }

    let target = control.target
    if (!target || /^(?:他|她|它|这个|那个|这个人|那个人)$/u.test(target)) target = this.lastGuestLabel
    if (!target) target = '*'
    const canonical = target === '*' ? '*' : (this.options.resolveSpeaker?.(target) ?? target)
    if (canonical === '我') return

    for (const item of this.entries) {
      if (item.lane === 'guest' && (canonical === '*' || item.label === canonical)) this.settleHold(item)
    }
    this.entries = this.entries.filter((item) => {
      if (item.lane !== 'guest') return true
      return !(canonical === '*' || item.label === canonical)
    })
    this.options.onControl?.({ action: 'speaker', target: canonical, policy: control.policy })
  }

  private dropAll(): void {
    for (const entry of this.entries) this.settleHold(entry)
    this.entries = []
  }

  private drain(): void {
    if (this.draining) return
    this.draining = true
    void this.pump().finally(() => {
      this.draining = false
      if (this.entries[0]?.ready) this.drain()
    })
  }

  /** Stable priority order; equal priorities keep their arrival token. */
  private orderEntries(): void {
    this.entries.sort((left, right) => {
      const leftPriority = left.priority ?? Number.MAX_SAFE_INTEGER
      const rightPriority = right.priority ?? Number.MAX_SAFE_INTEGER
      if (leftPriority !== rightPriority) return leftPriority - rightPriority
      if (left.order !== right.order) return left.order - right.order
      return left.seq - right.seq
    })
  }

  private async pump(): Promise<void> {
    while (this.entries.length > 0) {
      this.orderEntries()
      const entry = this.entries[0]!
      if (!entry.ready) return
      if (entry.hold && !entry.holdSettled) {
        try { await entry.hold } catch { /* a failed plan must not wedge the queue */ }
        entry.holdSettled = true
        // The organizer may have dropped this entry while it was deciding.
        if (!this.entries.includes(entry) || this.entries[0] !== entry) continue
      }
      this.entries.shift()
      entry.delivered = true
      // The entry just left the queue: without this the status line keeps
      // showing the pre-shift count for the whole time it is being spoken.
      this.emit()
      if (entry.dropped || !entry.text) {
        this.emit()
        continue
      }

      let mode: PromptMode
      if (entry.modeOverride !== undefined) {
        mode = entry.modeOverride
      } else if (entry.lane === 'owner') {
        mode = this.options.ownerMode?.() ?? 'steer'
      } else {
        const guest = this.options.guestMode(entry.label)
        if (guest === 'ignore') {
          this.emit()
          continue
        }
        mode = guest === 'steer' ? 'steer' : 'queue'
      }

      try {
        await this.options.deliver(entry.text, mode)
      } catch (error) {
        this.options.onError?.(error)
      }
      this.emit()
    }
  }

  private emit(): void {
    try {
      this.options.onStatus?.({ active: this.active, queued: this.entries.length })
    } catch {
      // Status UI must never break delivery.
    }
  }
}
