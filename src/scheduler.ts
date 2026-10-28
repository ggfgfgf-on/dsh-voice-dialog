/** Strict FIFO delivery for concurrent multi-speaker transcripts. */
import { parseQueueControl, type QueueControl } from './queue-control.js'

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

export interface EnqueueOptions {
  /**
   * Keeps this entry at the head of the FIFO until the parallel organizer has
   * decided. Later entries still cannot overtake it.
   */
  hold?: Promise<void>
}

/** A stable handle for a later organizer decision. */
export interface SchedulerEntry {
  readonly seq: number
  /** Apply a delivery mode before this entry has been sent. */
  setMode(mode: PromptMode): void
  /** Drop only this entry; earlier/later entries keep their order. */
  drop(): void
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
  hold?: Promise<void>
  holdSettled: boolean
}

const NOOP_ENTRY: SchedulerEntry = { seq: -1, setMode: () => undefined, drop: () => undefined }

/**
 * Every captured utterance gets a sequence number when it is enqueued, and the
 * scheduler drains them in that order. Recognition may finish out of order, but
 * a later line cannot overtake an earlier one. Only an explicit owner command
 * such as "打断" acts immediately; it also drops the still-waiting queue.
 */
export class SpeechScheduler {
  private entries: Entry[] = []
  private nextSeq = 0
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
    const entry: Entry = {
      seq: this.nextSeq++,
      lane,
      label,
      ready: false,
      text: null,
      dropped: false,
      delivered: false,
      hold: enqueueOptions.hold,
      holdSettled: enqueueOptions.hold === undefined,
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
    this.entries = this.entries.filter((item) => item !== entry)
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

    this.entries = this.entries.filter((item) => {
      if (item.lane !== 'guest') return true
      return !(canonical === '*' || item.label === canonical)
    })
    this.options.onControl?.({ action: 'speaker', target: canonical, policy: control.policy })
  }

  private dropAll(): void {
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

  private async pump(): Promise<void> {
    while (this.entries.length > 0) {
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
