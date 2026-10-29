/** Drop predicates that run before the organizer: cheap, conservative, pure. */

export type GateLane = 'owner' | 'guest'

export interface GateVerdict {
  drop: boolean
  /** Stable reason string for the latency log. */
  reason?: string
}

const SPEAKER_PREFIX = /^\s*\[声纹：[^\]]*\]\s*/u
const PUNCTUATION = /[\s\u3000-\u303F\uFF00-\uFF0F\uFF1A-\uFF20\u200B-\u200D.,!?;:'"()\[\]{}\-—…、。，！？；：""''（）【】《》]/gu
const HARD_COMMAND = /打断|别说了|别说|闭嘴|安静|停一下|先停|打住|再说一遍|重复一遍|重说|再说一次/u
const FILLERS = new Set([
  '嗯', '啊', '呃', '哦', '唔', '哎', '唉', '喔', '噢', '咿',
  '嗯嗯', '啊啊', '呃呃', '哦哦', '嗯啊', '啊嗯', '呃啊', '哎哎',
])
const SINGLE_LATIN = /^[a-z]{1,4}$/u
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u

/** Strip the speaker prefix and punctuation so predicates see only content. */
export function normalizeForGate(raw: string): string {
  return String(raw ?? '').replace(SPEAKER_PREFIX, '').replace(PUNCTUATION, '').toLowerCase()
}

/**
 * Guest noise gate. The owner is never dropped here: "停" / "好" / "不" are
 * meaningful, and a wrong drop costs the user a whole turn.
 */
export function noiseGate(lane: GateLane, raw: string): GateVerdict {
  const text = normalizeForGate(raw)
  if (!text) return { drop: false }
  // An explicit command is never noise, whoever said it.
  if (HARD_COMMAND.test(text)) return { drop: false }
  if (lane === 'owner') return { drop: false }
  // A number is information ("3 个"), never noise.
  if (/\p{N}/u.test(text)) return { drop: false }
  if (text.length <= 2) return { drop: true, reason: 'noise-short' }
  if (FILLERS.has(text)) return { drop: true, reason: 'noise-filler' }
  if (SINGLE_LATIN.test(text)) return { drop: true, reason: 'noise-latin' }
  if (!LETTER_OR_DIGIT.test(text)) return { drop: true, reason: 'noise-symbol' }
  return { drop: false }
}

/** One spoken sentence and when it started, used to detect self-echo. */
export interface SpokenSample {
  text: string
  at: number
}

export const ECHO_WINDOW_MS = 8000
const ECHO_MIN_CHARS = 6
const ECHO_OVERLAP = 0.85

function units(text: string): string[] {
  const out: string[] = []
  const latin = text.match(/[a-z]{3,}/gu) ?? []
  out.push(...latin)
  const cjk = text.replace(/[^\u3400-\u9fff]/gu, '')
  for (let i = 0; i + 1 < cjk.length; i++) out.push(cjk.slice(i, i + 2))
  return out
}

function coverage(text: string, corpus: string): number {
  const parts = units(text)
  if (parts.length === 0) return 0
  let hits = 0
  for (const part of parts) if (corpus.includes(part)) hits += 1
  return hits / parts.length
}

/**
 * Self-echo gate: the reply is played through speakers, the microphone hears
 * it and the recognizer turns it back into text, which then reaches the model
 * as if the user had said it (the model "repeats the last report"). Only a
 * long, near-verbatim match against what was just spoken is dropped, so a
 * genuine short follow-up ("那个再说下") always survives.
 */
export function echoGate(
  raw: string,
  spoken: readonly SpokenSample[],
  now: number = Date.now(),
  windowMs: number = ECHO_WINDOW_MS,
): GateVerdict {
  const text = normalizeForGate(raw)
  if (text.length < ECHO_MIN_CHARS) return { drop: false }
  if (HARD_COMMAND.test(text)) return { drop: false }
  const recent = spoken
    .filter((sample) => now - sample.at <= windowMs)
    .map((sample) => normalizeForGate(sample.text))
    .join('')
  if (!recent) return { drop: false }
  if (recent.includes(text)) return { drop: true, reason: 'echo-contained' }
  return coverage(text, recent) >= ECHO_OVERLAP
    ? { drop: true, reason: 'echo-overlap' }
    : { drop: false }
}
