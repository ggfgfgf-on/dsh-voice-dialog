/**
 * The model-facing speech contract.
 *
 * Every field is optional: a declaration only overrides the mechanical default,
 * so with no declaration the plugin behaves exactly as it did before this file
 * existed. One pure resolver turns a declaration into the effective profile.
 */
export type InterruptionMode = 'sentence' | 'immediate' | 'never'

/** Whether unfinished speech may drive a provisional plan. Off by default. */
export type EarlyStartMode = 'off' | 'partial'

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
  /** Longest raw-corpus chunk in characters before it is split; 0 = the pauses decide. */
  chunkMaxChars?: number
  /** Mic silence that closes an utterance; undefined keeps the user's setting. */
  micSilenceMs?: number
  /** Per-source tail silence in continuous separation; undefined keeps the user's setting. */
  separationSilenceMs?: number
  /** Pace between blocks: 'natural' varies it by punctuation, 'off' is metronomic. */
  rhythm?: RhythmMode
  /** Opt-in silence inside one long line (adds one request); 0 keeps one request per block. */
  innerPauseMs?: number
  /** One short line YOU write, said once if the listener is still waiting; empty = never. */
  backchannel?: string
  /** How long before that line is said; 0 leaves the moment to the wait itself. */
  backchannelAfterMs?: number
  /** Open a reply by picking up the listener's half sentence before new content. */
  warmOpen?: boolean
  /** How few characters the first block may speak on; 8 is the historical value. */
  firstBlockChars?: number
  /** Release the first block this long after the first token even without punctuation; 0 off. */
  firstBlockDeadlineMs?: number
  /**
   * 'off' (default) waits for the utterance to close before planning anything.
   * 'partial' lets unfinished speech produce a PROVISIONAL plan that may be
   * withdrawn when the corpus closes; anything already spoken stays spoken.
   */
  earlyStart?: EarlyStartMode
}

/** Pace modes. Natural is the default: variance, not a fixed interval. */
export type RhythmMode = 'natural' | 'off'

/**
 * Longest placeholder line. The wording is the model's own: this file only
 * bounds the SHAPE (one short acknowledgement), it never supplies vocabulary.
 */
export const BACKCHANNEL_MAX_CHARS = 24

/** Today's live behaviour. A declaration only overrides these. */
export const DEFAULT_SPEECH_PROFILE: Required<SpeechProfile> = {
  interruption: 'sentence',
  mergeMaxChars: 40,
  mergeRunMaxChars: 160,
  mergeRunMaxItems: 6,
  betweenBlocksMs: 0,
  chunkMaxChars: 0,
  micSilenceMs: 900,
  separationSilenceMs: 1600,
  rhythm: 'natural',
  innerPauseMs: 0,
  backchannel: '',
  backchannelAfterMs: 0,
  warmOpen: false,
  firstBlockChars: 8,
  firstBlockDeadlineMs: 0,
  earlyStart: 'off',
}

const INTERRUPTION_MODES: readonly string[] = ['sentence', 'immediate', 'never']

/** Inclusive bounds for every numeric field; out-of-range values are clamped. */
const NUMERIC_RANGES: ReadonlyArray<readonly [keyof SpeechProfile, number, number]> = [
  ['mergeMaxChars', 8, 400],
  ['mergeRunMaxChars', 8, 1200],
  ['mergeRunMaxItems', 1, 32],
  ['betweenBlocksMs', 0, 2000],
  ['chunkMaxChars', 0, 400],
  ['micSilenceMs', 400, 4000],
  ['separationSilenceMs', 400, 4000],
  ['innerPauseMs', 0, 400],
  ['backchannelAfterMs', 0, 5000],
  ['firstBlockChars', 4, 12],
  ['firstBlockDeadlineMs', 0, 2000],
]

const RHYTHM_MODES: readonly string[] = ['natural', 'off']
const EARLY_START_MODES: readonly string[] = ['off', 'partial']

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
  const rhythm = record.rhythm
  if (typeof rhythm === 'string' && RHYTHM_MODES.includes(rhythm)) {
    profile.rhythm = rhythm as RhythmMode
  }
  const backchannel = record.backchannel
  if (typeof backchannel === 'string') {
    const line = backchannel.replace(/\s+/g, ' ').trim().slice(0, BACKCHANNEL_MAX_CHARS)
    // 'none' stays accepted as "say nothing" so a fallback can be switched off.
    if (line === 'none') profile.backchannel = ''
    else if (line.length > 0) profile.backchannel = line
  }
  const earlyStart = record.earlyStart
  if (typeof earlyStart === 'string' && EARLY_START_MODES.includes(earlyStart)) {
    profile.earlyStart = earlyStart as EarlyStartMode
  }
  if (typeof record.warmOpen === 'boolean') profile.warmOpen = record.warmOpen
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
