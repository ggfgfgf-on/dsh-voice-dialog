/** Pure routing policies for the optimistic speech path. No DOM, no fetch. */

export interface DeliveryState {
  /** True while an assistant reply is audible. */
  playing: boolean
  /** Captured utterances waiting in the scheduler. */
  queued: number
  /** Utterances still being recognized. */
  active: number
}

/**
 * The organizer wait is only worth paying when a decision can still change
 * what the listener hears. With nothing playing and nothing queued, the line
 * can go to the model first and the decision can catch up in parallel.
 * Any doubt (busy player, queue, in-flight recognition) keeps the old
 * synchronous behaviour: order beats speed.
 */
export function shouldUseOptimisticFastPath(state: DeliveryState, enabled = true): boolean {
  if (!enabled) return false
  if (state.playing) return false
  if (!Number.isFinite(state.queued) || state.queued > 0) return false
  if (!Number.isFinite(state.active) || state.active > 0) return false
  return true
}

/**
 * The fast gate has exactly one job: while the assistant is speaking, decide
 * whether the new line must stop it at once. Out of playback the verdict can
 * only ever be "keep", so the call is skipped entirely instead of spending a
 * model round-trip on a foregone conclusion.
 */
export function shouldCallGate(state: { playing: boolean; queued?: number }, _imperative?: boolean): boolean {
  return state.playing === true
}

export type OptimisticVerdict = 'retract' | 'steer' | 'keep'

/**
 * What a late organizer answer may still do to an already-enqueued line.
 * Retraction is allowed only while the scheduler has not handed the line to
 * the model: once it started, dropping it would lose words the user said.
 */
export function resolveOptimisticVerdict(input: {
  action?: string | null
  started: boolean
}): OptimisticVerdict {
  const action = typeof input.action === 'string' ? input.action.trim().toLowerCase() : ''
  if (action === 'interrupt') return 'steer'
  if (action === 'drop' || action === 'ignore') return input.started ? 'keep' : 'retract'
  return 'keep'
}

/**
 * Conservative single-speaker test over per-source RMS values. Two sources
 * count as overlapping when the quieter one reaches 35% of the loudest, so a
 * weak bleed-through of the same voice never splits one utterance in two.
 */
export function isSingleActiveSource(rmsValues: readonly number[], floor = 0.004): boolean {
  const values = rmsValues
    .map((value) => (Number.isFinite(value) && value > 0 ? value : 0))
    .filter((value) => value >= floor)
  if (values.length <= 1) return true
  const loudest = Math.max(...values)
  const rest = values.filter((value) => value !== loudest)
  return rest.every((value) => value < loudest * 0.35)
}

/**
 * A speculative mixed-stream transcript may replace the separated transcript
 * only when both cover the same amount of audio. A shorter tail would drop
 * the beginning of the utterance, so anything outside the tolerance falls
 * back to recognizing the separated lane.
 */
export function canReuseSpeculativeAsr(
  laneSamples: number,
  mixedSamples: number,
  toleranceSamples = 1600,
): boolean {
  if (!Number.isFinite(laneSamples) || !Number.isFinite(mixedSamples)) return false
  if (laneSamples <= 0 || mixedSamples <= 0) return false
  return Math.abs(laneSamples - mixedSamples) <= Math.max(toleranceSamples, laneSamples * 0.1)
}

/**
 * Idempotency gate: one utterance id reaches the model at most once, even if
 * separation and the speculative path both complete for it.
 */
export function firstDelivery(seen: Set<string>, id: string): boolean {
  if (!id) return true
  if (seen.has(id)) return false
  seen.add(id)
  return true
}
