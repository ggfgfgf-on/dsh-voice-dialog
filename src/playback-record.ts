/**
 * L1 playback events: the state of the mouth, not every frame.
 *
 * "playing" is reported by a heartbeat, so writing one line per report would
 * bury the stream in duplicates. Only a CHANGE of phase is recorded, and the
 * recorder remembers the last phase per session.
 */

export type PlaybackPhase = 'idle' | 'playing' | 'paused'

const PHASES: readonly string[] = ['idle', 'playing', 'paused']

export interface PlaybackTransition {
  phase: PlaybackPhase
  /** False means this phase was already the last one: nothing to record. */
  changed: boolean
}

/** Pure: turn a raw report into a phase transition, or null when unusable. */
export function playbackTransition(
  previous: PlaybackPhase | undefined,
  next: string,
): PlaybackTransition | null {
  if (typeof next !== 'string' || !PHASES.includes(next)) return null
  const phase = next as PlaybackPhase
  return { phase, changed: previous !== phase }
}

export interface PlaybackSink {
  append(kind: 'playback', fields: Record<string, unknown>): unknown
}

export interface PlaybackRecorder {
  /** Record a report; returns true when it actually wrote an event. */
  note(sessionId: string, phase: string, fields?: Record<string, unknown>): boolean
  lastPhase(sessionId: string): PlaybackPhase | undefined
  /** Forget one session (or all of them). */
  reset(sessionId?: string): void
}

export function createPlaybackRecorder(stream: PlaybackSink): PlaybackRecorder {
  const last = new Map<string, PlaybackPhase>()
  return {
    note(sessionId, phase, fields) {
      const key = typeof sessionId === 'string' ? sessionId : ''
      const transition = playbackTransition(last.get(key), phase)
      if (!transition) return false
      last.set(key, transition.phase)
      if (!transition.changed) return false
      try {
        stream.append('playback', { sessionId: key, phase: transition.phase, ...(fields ?? {}) })
      } catch { /* the record layer is a side channel */ }
      return true
    },
    lastPhase(sessionId) {
      return last.get(typeof sessionId === 'string' ? sessionId : '')
    },
    reset(sessionId) {
      if (sessionId === undefined) last.clear()
      else last.delete(sessionId)
    },
  }
}
