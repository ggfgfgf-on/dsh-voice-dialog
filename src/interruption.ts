/** The interruption contract the model declares for its own speech. */

export type InterruptionMode = 'sentence' | 'immediate' | 'never'

/** 'cut' = stop now, 'drain' = finish the audible sentence then stop, 'keep' = do not touch audio. */
export type InterruptionDecision = 'cut' | 'drain' | 'keep'

/** Normal answers finish the sentence in progress instead of being clipped. */
export const DEFAULT_INTERRUPTION_MODE: InterruptionMode = 'sentence'

export interface InterruptionState {
  /** A sentence is audible right now. */
  playing: boolean
  /** A cut is already fading out. */
  cutting: boolean
  /** "stop talking" is in force. */
  muted: boolean
  /** Read-aloud is live for this session. */
  active: boolean
}

/** What a listener speaking does to the audible sentence the moment it starts. */
export type OnsetYieldDecision = 'pause' | 'atBoundary' | 'ignore'

/**
 * Decide the reaction at speech ONSET, before any transcript exists.
 * 'pause' holds the sentence where it is; 'atBoundary' lets the sentence finish
 * and holds at its end; 'ignore' leaves the audio completely alone.
 */
export function decideSpeechOnsetYield(
  mode: InterruptionMode | undefined,
  state: InterruptionState,
): OnsetYieldDecision {
  if (mode === 'never') return 'ignore'
  if (!state.active || state.muted || state.cutting) return 'ignore'
  if (!state.playing) return 'ignore'
  return mode === 'immediate' ? 'pause' : 'atBoundary'
}

/**
 * A pending 'sentence' request may only fire on a sentence boundary. A hold
 * that fired mid-sentence would be the hard cut this contract exists to avoid.
 */
export function decideBoundaryHold(
  pending: boolean,
  point: 'sentence' | 'mid',
): 'hold' | 'continue' {
  return pending && point === 'sentence' ? 'hold' : 'continue'
}

export function isInterruptionMode(value: unknown): value is InterruptionMode {
  return value === 'sentence' || value === 'immediate' || value === 'never'
}

/**
 * Decide what a listener speaking does to the assistant's own audio.
 *
 * The guards are deliberately conservative: when nothing is audible, or a cut
 * is already in flight, or the listener asked for silence, the answer is
 * 'keep'. Only a live sentence is ever interrupted, and only when the declared
 * mode allows it. An undeclared mode behaves like the default.
 */
export function decideInterruption(
  mode: InterruptionMode | undefined,
  state: InterruptionState,
): InterruptionDecision {
  if (mode === 'never') return 'keep'
  if (!state.active || state.muted || state.cutting) return 'keep'
  if (!state.playing) return 'keep'
  return mode === 'immediate' ? 'cut' : 'drain'
}
