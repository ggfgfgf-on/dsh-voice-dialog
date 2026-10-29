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
  /** Host-elected playback owner for this frame; absent means no election ran. */
  frameOwner?: string
  /** This page's own client id. */
  clientId?: string
}

/**
 * One session speaks from one tab. The host is the coordinator: it stamps the
 * elected client on every frame, so a tab obeys that decision instead of
 * guessing from its own microphone flag. Without a stamp (no election yet) the
 * local rule still applies, but it can only ever quiet a non-owner tab.
 */
export function shouldPlayFrame(state: PlayEligibility): boolean {
  return playBlockReason(state) === undefined
}

/**
 * Why a frame would not be played, as a short log token. Kept next to
 * shouldPlayFrame so a silent player can be explained without guessing.
 */
export function playBlockReason(state: PlayEligibility): string | undefined {
  if (state.muted) return 'muted'
  if (!state.autoRead) return 'autoread-off'
  // An addressed frame belongs to exactly one client: identity is required.
  if (state.frameOwner !== undefined && state.frameOwner !== state.clientId) return 'not-owner'
  const elected = state.frameOwner !== undefined && state.frameOwner === state.clientId
  // The host elected this tab: a stale local stop flag must not mute it.
  if (!state.active && !elected) return 'inactive'
  if (state.tabSession !== undefined && state.frameSession !== state.tabSession) {
    return 'other-session:' + state.tabSession + '!=' + state.frameSession
  }
  return undefined
}
