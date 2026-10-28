/** Priority-aware delivery for concurrent multi-speaker transcripts. */

export type SpeakerLane = 'owner' | 'guest'
export type GuestMode = 'queue' | 'steer' | 'ignore'
export type PromptMode = 'steer' | 'queue'

export interface SchedulerStatus {
  /** Transcripts still being recognized or delivered. */
  active: number
  /** Guest transcripts waiting for the current reply to finish. */
  queued: number
}

export interface SpeechSchedulerOptions {
  deliver: (text: string, mode: PromptMode) => Promise<void>
  guestMode: () => GuestMode
  /** How long to gather consecutive guest lines into one queued prompt. */
  batchMs?: number
  onStatus?: (status: SchedulerStatus) => void
  onError?: (error: unknown) => void
}

/**
 * Two ordered lanes share one model turn:
 *
 * - owner speech is delivered immediately with prompt mode "steer";
 * - guest speech is either batched behind the running reply ("queue"), sent
 *   immediately ("steer"), or dropped ("ignore").
 *
 * The caller may launch transcription in parallel; each lane still delivers in
 * utterance order, and a slow guest transcript never holds up the owner.
 */
export class SpeechScheduler {
  private ownerChain: Promise<void> = Promise.resolve()
  private guestChain: Promise<void> = Promise.resolve()
  private pending: Array<{ label: string; text: string }> = []
  private timer: ReturnType<typeof setTimeout> | undefined
  private active = 0
  private closed = false
  private readonly batchMs: number

  constructor(private readonly options: SpeechSchedulerOptions) {
    this.batchMs = Math.max(0, options.batchMs ?? 900)
  }

  /** Start tracking one utterance whose text will arrive asynchronously. */
  enqueue(lane: SpeakerLane, label: string, work: Promise<string | null>): void {
    if (this.closed) return
    this.active += 1
    this.emit()

    const resolve = async (): Promise<string | null> => {
      try {
        const text = await work
        return typeof text === 'string' && text.trim() ? text.trim() : null
      } catch (error) {
        this.options.onError?.(error)
        return null
      }
    }

    if (lane === 'owner') {
      this.ownerChain = this.ownerChain.then(async () => {
        try {
          const text = await resolve()
          if (text) await this.options.deliver(text, 'steer')
        } catch (error) {
          this.options.onError?.(error)
        } finally {
          this.active = Math.max(0, this.active - 1)
          this.emit()
        }
      })
      return
    }

    const mode = this.options.guestMode()
    if (mode === 'ignore') {
      void work.catch((error: unknown) => { this.options.onError?.(error) })
      this.active = Math.max(0, this.active - 1)
      this.emit()
      return
    }

    if (mode === 'steer') {
      this.guestChain = this.guestChain.then(async () => {
        try {
          const text = await resolve()
          if (text) await this.options.deliver(text, 'steer')
        } catch (error) {
          this.options.onError?.(error)
        } finally {
          this.active = Math.max(0, this.active - 1)
          this.emit()
        }
      })
      return
    }

    this.guestChain = this.guestChain.then(async () => {
      try {
        const text = await resolve()
        if (text) {
          this.pending.push({ label, text })
          this.schedule()
        }
      } catch (error) {
        this.options.onError?.(error)
      } finally {
        this.active = Math.max(0, this.active - 1)
        this.emit()
      }
    })
  }

  /** Send every waiting guest line immediately as one queued prompt. */
  flushGuests(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    if (this.pending.length === 0) return
    const batch = this.pending
    this.pending = []
    this.emit()
    const text = batch.map((item) => item.text).join('\n')
    this.guestChain = this.guestChain.then(async () => {
      try {
        if (this.options.guestMode() === 'ignore') return
        await this.options.deliver(text, 'queue')
      } catch (error) {
        this.options.onError?.(error)
      }
    })
  }

  /** Stop accepting work, but keep already captured guest lines. */
  dispose(): void {
    if (this.closed) return
    this.flushGuests()
    this.closed = true
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
  }

  status(): SchedulerStatus {
    return { active: this.active, queued: this.pending.length }
  }

  private schedule(): void {
    // In-flight transcripts may arrive after dispose(); they are already
    // captured speech, so still deliver them as one final batch.
    if (this.timer !== undefined || this.pending.length === 0) return
    if (this.batchMs === 0) {
      this.flushGuests()
      return
    }
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.flushGuests()
    }, this.batchMs)
  }

  private emit(): void {
    try {
      this.options.onStatus?.({ active: this.active, queued: this.pending.length })
    } catch {
      // Status UI must never break delivery.
    }
  }
}
