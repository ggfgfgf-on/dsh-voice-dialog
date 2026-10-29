/**
 * Monotonic ordering for spoken frames. Pure, so the rules are unit-testable
 * without a browser: the host numbers every reply (epoch) and every frame
 * within a session (seq). A frame that is older than what was already consumed
 * can never play again, which is what stops a late old-reply frame from
 * resurrecting inside a new reply.
 */

export interface FrameOrder {
  epoch: number
  seq: number
}

export type FrameVerdict = 'accept' | 'stale-epoch' | 'stale-seq' | 'duplicate'

export interface FrameLike {
  epoch?: unknown
  seq?: unknown
}

/** Read the ordering keys, or null for a legacy frame without them. */
export function orderOf(frame: FrameLike): FrameOrder | null {
  const epoch = typeof frame.epoch === 'number' ? frame.epoch : NaN
  const seq = typeof frame.seq === 'number' ? frame.seq : NaN
  if (!Number.isFinite(epoch) || epoch < 0) return null
  if (!Number.isFinite(seq) || seq < 0) return null
  return { epoch: Math.trunc(epoch), seq: Math.trunc(seq) }
}

export class FrameWindow {
  private high: FrameOrder | null = null

  current(): FrameOrder | null {
    return this.high === null ? null : { ...this.high }
  }

  /** Classify without mutating; call accept() for an accepted frame. */
  classify(order: FrameOrder | null): FrameVerdict {
    if (order === null) return 'accept'
    const high = this.high
    if (high === null) return 'accept'
    if (order.epoch < high.epoch) return 'stale-epoch'
    if (order.epoch > high.epoch) return 'accept'
    if (order.seq < high.seq) return 'stale-seq'
    if (order.seq === high.seq) return 'duplicate'
    return 'accept'
  }

  /** Remember an accepted frame; a lower key can never move the watermark back. */
  accept(order: FrameOrder | null): void {
    if (order === null) return
    const high = this.high
    if (high === null) { this.high = { ...order }; return }
    if (order.epoch > high.epoch) { this.high = { ...order }; return }
    if (order.epoch === high.epoch && order.seq > high.seq) this.high = { ...order }
  }

  /** Only a different session clears the watermark; stop/cut must not. */
  reset(): void { this.high = null }
}

export interface PlayEligibility {
  active: boolean
  muted: boolean
  autoRead: boolean
  /** Session this tab's microphone belongs to. */
  tabSession: string | undefined
  frameSession: string
}

/**
 * Only the tab whose microphone is open speaks a session's frames; a second tab
 * watching the same conversation must stay silent instead of double-reading.
 */
export function shouldPlayFrame(state: PlayEligibility): boolean {
  if (!state.active || state.muted || !state.autoRead) return false
  if (state.tabSession !== undefined && state.frameSession !== state.tabSession) return false
  return true
}
