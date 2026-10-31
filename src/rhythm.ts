/**
 * Natural pacing between spoken blocks.
 *
 * A gap is played by the page, never synthesized by the engine: it changes how
 * the same audio is spaced, not the bytes and not the number of requests. That
 * is why a natural rhythm can be the default — the mechanical flatness people
 * hear is the missing silence between blocks, not the voice itself.
 */

/** How the pace of one block is resolved; every field is optional. */
export interface RhythmOptions {
  /** Silence after a block that closes a sentence (default 220 ms). */
  sentenceMs?: number
  /** Silence after a block that ends on a comma, 顿号, colon or semicolon (default 90 ms). */
  clauseMs?: number
  /** Relative variation of each gap, 0 makes every gap identical (default 0.35). */
  jitter?: number
  /** Hard ceiling for one gap (default 600 ms). */
  maxMs?: number
  /** Silence between the two halves of one long line; 0 never splits a line. */
  innerMs?: number
}

export const RHYTHM_DEFAULTS: Required<RhythmOptions> = {
  sentenceMs: 220,
  clauseMs: 90,
  jitter: 0.35,
  maxMs: 600,
  innerMs: 0,
}

/** Model-facing ranges; anything outside is clamped, never thrown. */
export const RHYTHM_LIMITS = {
  sentenceMs: { min: 0, max: 800, meaning: 'Silence after a sentence that ends a thought. 180-280 sounds like a person.' },
  clauseMs: { min: 0, max: 400, meaning: 'Silence after a comma or 顿号 cut. 60-120 keeps a list moving; 0 flattens it.' },
  jitter: { min: 0, max: 0.8, meaning: 'How much each gap varies around the nominal value. 0.3-0.4 avoids a metronome.' },
  maxMs: { min: 50, max: 1500, meaning: 'Ceiling for any one gap, so a long pause never appears mid-answer.' },
  innerMs: { min: 0, max: 400, meaning: 'Opt in: silence inside one long line. Costs one extra synthesis request, so 0 by default.' },
} as const

const SENTENCE_END = /[。！？!?…]$/u
const CLAUSE_END = /[，,、；;：:]$/u
const TRAIL = /[\s"'”’）)】》〉\]］\}]+$/u

/** Punctuation, quotes and brackets are not part of what the listener hears. */
export function trimSpoken(text: unknown): string {
  return String(text ?? '').replace(TRAIL, '').trim()
}

/** Deterministic 0..1 value from the text, so a test can predict every gap. */
function unitHash(text: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash / 0xffffffff
}

/** -1..1 variation around the nominal gap; the text itself is the seed. */
export function variationOf(text: string, seed = 0, jitter = RHYTHM_DEFAULTS.jitter): number {
  const amount = Math.max(0, Math.min(0.8, jitter))
  if (amount === 0) return 0
  return (unitHash(String(seed) + '\u0000' + text) * 2 - 1) * amount
}

function resolveOptions(options?: RhythmOptions | null): Required<RhythmOptions> {
  const merged: Required<RhythmOptions> = { ...RHYTHM_DEFAULTS }
  if (!options) return merged
  for (const key of Object.keys(RHYTHM_DEFAULTS) as Array<keyof RhythmOptions>) {
    const value = options[key]
    if (typeof value === 'number' && Number.isFinite(value)) merged[key] = value
  }
  return merged
}

/** Nominal silence for a block, before variation: sentence > clause > breath. */
export function baseGapMs(text: unknown, options?: RhythmOptions | null): number {
  const spoken = trimSpoken(text)
  if (!spoken) return 0
  const resolved = resolveOptions(options)
  if (SENTENCE_END.test(spoken)) return Math.max(0, resolved.sentenceMs)
  if (CLAUSE_END.test(spoken)) return Math.max(0, resolved.clauseMs)
  // A length cut leaves no punctuation: the speaker still takes a small breath.
  return Math.max(0, Math.round(resolved.clauseMs * 0.55))
}

/**
 * Silence the page leaves after this block. Deterministic for a given text and
 * seed, so playback is stable across replays and tests can assert the number.
 */
export function rhythmGapMs(text: unknown, options?: RhythmOptions | null, seed = 0): number {
  const spoken = trimSpoken(text)
  if (!spoken) return 0
  const resolved = resolveOptions(options)
  const base = baseGapMs(spoken, resolved)
  if (base <= 0) return 0
  const varied = base * (1 + variationOf(spoken, seed, resolved.jitter))
  return Math.max(0, Math.min(Math.max(50, resolved.maxMs), Math.round(varied)))
}

/** Where one long line may be split, and how long the silence at the seam is. */
export interface InnerPause {
  head: string
  tail: string
  gapMs: number
}

const INNER_MARKS = new Set(['，', ',', '、', '；', ';', '：', ':'])

/**
 * Split one long line at the comma nearest the middle so a mid-sentence breath
 * becomes audible. Only meaningful when innerMs is declared (it costs one extra
 * synthesis request); undefined means "speak it as one block".
 */
export function splitInnerPause(
  text: unknown,
  options?: RhythmOptions | null,
  seed = 0,
): InnerPause | undefined {
  const resolved = resolveOptions(options)
  if (!(resolved.innerMs > 0)) return undefined
  const spoken = String(text ?? '').trim()
  if (spoken.length < 12) return undefined
  const mid = spoken.length / 2
  let cut = -1
  let distance = Number.POSITIVE_INFINITY
  for (let index = 0; index < spoken.length; index += 1) {
    if (!INNER_MARKS.has(spoken[index]!)) continue
    const head = spoken.slice(0, index).replace(/\s/gu, '')
    const tail = spoken.slice(index + 1).replace(/\s/gu, '')
    if (head.length < 4 || tail.length < 4) continue
    const here = Math.abs(index - mid)
    if (here < distance) { distance = here; cut = index }
  }
  if (cut < 0) return undefined
  const head = spoken.slice(0, cut + 1).trim()
  const tail = spoken.slice(cut + 1).trim()
  if (!head || !tail) return undefined
  const varied = resolved.innerMs * (1 + variationOf(spoken, seed, resolved.jitter))
  return { head, tail, gapMs: Math.max(0, Math.min(resolved.maxMs, Math.round(varied))) }
}
