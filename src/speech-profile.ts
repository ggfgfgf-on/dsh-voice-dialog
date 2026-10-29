/**
 * The model-facing speech contract.
 *
 * Every field is optional: a declaration only overrides the mechanical default,
 * so with no declaration the plugin behaves exactly as it did before this file
 * existed. One pure resolver turns a declaration into the effective profile.
 */
export type InterruptionMode = 'sentence' | 'immediate' | 'never'

export interface SpeechProfile {
  /** How the assistant's own speech may be interrupted by the listener. */
  interruption?: InterruptionMode
  /** Longest single queue item still allowed to join a merged TTS request. */
  mergeMaxChars?: number
  /** Hard cap for one merged TTS request. */
  mergeRunMaxChars?: number
  /** Hard cap on how many queue items share one merged TTS request. */
  mergeRunMaxItems?: number
  /** Silence inserted between consecutive spoken blocks; 0 = start at once. */
  betweenBlocksMs?: number
  /** Mic silence that closes an utterance; undefined keeps the user's setting. */
  micSilenceMs?: number
  /** Per-source tail silence in continuous separation; undefined keeps the user's setting. */
  separationSilenceMs?: number
}

/** Today's live behaviour. A declaration only overrides these. */
export const DEFAULT_SPEECH_PROFILE: Required<SpeechProfile> = {
  interruption: 'sentence',
  mergeMaxChars: 40,
  mergeRunMaxChars: 160,
  mergeRunMaxItems: 6,
  betweenBlocksMs: 0,
  micSilenceMs: 900,
  separationSilenceMs: 1600,
}

const INTERRUPTION_MODES: readonly string[] = ['sentence', 'immediate', 'never']

/** Inclusive bounds for every numeric field; out-of-range values are clamped. */
const NUMERIC_RANGES: ReadonlyArray<readonly [keyof SpeechProfile, number, number]> = [
  ['mergeMaxChars', 8, 400],
  ['mergeRunMaxChars', 8, 1200],
  ['mergeRunMaxItems', 1, 32],
  ['betweenBlocksMs', 0, 2000],
  ['micSilenceMs', 400, 4000],
  ['separationSilenceMs', 400, 4000],
]

function clampInteger(value: unknown, low: number, high: number): number | undefined {
  const number = typeof value === 'number' ? value : Number.NaN
  if (!Number.isFinite(number)) return undefined
  return Math.min(high, Math.max(low, Math.round(number)))
}

/** Keep only recognised fields, drop garbage, clamp the numbers to sane ranges. */
export function normalizeSpeechProfile(input: unknown): SpeechProfile {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {}
  const record = input as Record<string, unknown>
  const profile: SpeechProfile = {}
  const mode = record.interruption
  if (typeof mode === 'string' && INTERRUPTION_MODES.includes(mode)) {
    profile.interruption = mode as InterruptionMode
  }
  for (const [key, low, high] of NUMERIC_RANGES) {
    const value = clampInteger(record[key], low, high)
    if (value !== undefined) (profile as Record<string, unknown>)[key] = value
  }
  return profile
}

/** declared wins per field, fallback fills the gaps, the default fills the rest. */
export function resolveSpeechProfile(
  declared?: SpeechProfile | null,
  fallback?: SpeechProfile | null,
): Required<SpeechProfile> {
  const resolved: Record<string, unknown> = { ...DEFAULT_SPEECH_PROFILE }
  for (const source of [fallback, declared]) {
    if (!source) continue
    for (const [key, value] of Object.entries(source)) {
      if (value !== undefined) resolved[key] = value
    }
  }
  return resolved as Required<SpeechProfile>
}
