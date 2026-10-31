/**
 * Partial recognition: spend the silence wait on text instead of silence.
 *
 * While an utterance is still open the microphone keeps its audio anyway, so a
 * cheap extra ASR call can turn the part already spoken into a partial line.
 * Everything here is pure: the microphone owns the buffer, the caller owns the
 * recognizer, and the closing recognition is never delayed or crowded out.
 *
 * Off unless the page preference partialAsrMs is greater than 0, so a default
 * install makes exactly zero additional recognition calls.
 */

/** Ceiling for the audio one partial call may carry, so a long utterance stays bounded. */
export const PARTIAL_WINDOW_MS = 10_000
/** A partial call on less speech than this cannot say anything useful. */
export const PARTIAL_MIN_SPEECH_MS = 300
/** Partial interval used by "即时" when nothing else is stored. */
export const IMMEDIATE_PARTIAL_MS = 400

/** Intervals derived from a setting are bounded the same way. */
export function clampPartialMs(value: unknown): number {
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(number) ? Math.min(2000, Math.max(0, Math.round(number))) : 0
}

/**
 * "即时" is one setting, not two: a zero silence wait means the utterance closes
 * on the first unvoiced frame, so recognition must run during the speech or the
 * text arrives after the sentence is already cut. Any real wait keeps partial
 * recognition off, which is today's behaviour.
 */
export function partialIntervalFor(waitMs: number, storedMs = 0): number {
  const wait = Number(waitMs)
  if (!Number.isFinite(wait) || wait > 0) return 0
  const stored = Number(storedMs)
  return Number.isFinite(stored) && stored > 0 ? stored : IMMEDIATE_PARTIAL_MS
}

export interface PartialGateInput {
  /** partialAsrMs > 0. False means the feature is off and no call is made. */
  enabled: boolean
  /** Requested spacing between partial calls, in milliseconds. */
  intervalMs: number
  /** Milliseconds since the previous partial call (or since speech started). */
  sinceLastMs: number
  /** A partial call is already running; one at a time. */
  inFlight: boolean
  /** The closing recognition has begun: drop anything still running. */
  finalizing?: boolean
  /** Voiced milliseconds accumulated in this utterance so far. */
  speechMs: number
  minSpeechMs?: number
}

/**
 * Whether one partial recognition may start now. The default case is "no":
 * every reason to stay quiet is checked before the caller spends a request.
 */
export function shouldFirePartial(input: PartialGateInput): boolean {
  if (!input.enabled) return false
  if (!(input.intervalMs > 0)) return false
  if (input.inFlight) return false
  if (input.finalizing) return false
  if (!(input.speechMs >= (input.minSpeechMs ?? PARTIAL_MIN_SPEECH_MS))) return false
  if (!(input.sinceLastMs >= input.intervalMs)) return false
  return true
}

/**
 * The newest partial text worth keeping, or null when it adds nothing.
 * A repeat, a revision that got shorter, or empty output is discarded: a
 * truncated hypothesis must not replace a longer one already being planned on.
 */
export function dedupePartial(previous: string, next: string): string | null {
  const clean = String(next ?? '').replace(/\s+/gu, ' ').trim()
  if (clean.length === 0) return null
  const last = String(previous ?? '').trim()
  if (clean === last) return null
  if (clean.length <= last.length) return null
  return clean
}

/**
 * Keep only the tail of an utterance within the window, so one long sentence
 * cannot grow the audio a partial call carries without bound.
 */
export function trimPartialWindow<T extends { length: number }>(
  chunks: readonly T[],
  sampleRate: number,
  windowMs: number = PARTIAL_WINDOW_MS,
): T[] {
  if (chunks.length === 0) return []
  const rate = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 16_000
  const budget = Math.floor((rate * Math.max(0, windowMs)) / 1000)
  if (budget <= 0) return []
  const out: T[] = []
  let total = 0
  for (let index = chunks.length - 1; index >= 0; index -= 1) {
    const chunk = chunks[index]
    if (!chunk) continue
    out.unshift(chunk)
    total += chunk.length
    if (total >= budget) break
  }
  return out
}
