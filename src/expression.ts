/**
 * Expressive speech as INTENT TOKENS. The model never sends numbers: it names a
 * tone, a pace or a pause, and this file owns the acoustics.
 *
 * Every value below is a delta applied on top of the queue's base prosody, and
 * the SUM is clamped, so a large intent can saturate but never overflow. With no
 * express call nothing here runs and the default delivery is unchanged.
 *
 * Pure and deterministic: no IO, no timers.
 */

export type Tone = 'neutral' | 'warm' | 'soft' | 'firm' | 'urgent' | 'bright'
export type Pace = 'even' | 'slower' | 'faster'
export type PauseToken = 'beat' | 'short' | 'long'

/** One intent unit. Consecutive units form one spoken line. */
export interface VoiceUnit {
  /** Spoken text; whitespace collapsed, at most 200 characters. */
  say?: string
  /** Delivery colour. */
  tone?: Tone
  /** Local pace intent. */
  pace?: Pace
  /** Words inside `say` to lean on (at most 4, each 24 chars or shorter). */
  /** Optional numeric adjustment for THIS step, applied on top of the base. */
  rate?: number
  /** Optional numeric adjustment for THIS step, applied on top of the base. */
  pitch?: number
  /** Optional numeric adjustment for THIS step, applied on top of the base. */
  volume?: number
  stress?: string[]
  /** Breathy delivery for this unit. */
  breath?: boolean
  /** Draw the tail out. */
  lengthen?: boolean
  /** A silence with no text. */
  pause?: PauseToken
  /** Character-level marks: repaint the audio of a few characters inside `say`. */
  mark?: ProsodyMark[]
}

/**
 * One mark inside a unit. `at` is a 0-based character index; `to` is the
 * exclusive end, so a bare `at` paints exactly one character. Every field is an
 * ADDITIONAL delta for that range, layered on the unit's own delivery; the unit's
 * prosody still wraps the whole request, so a mark is a LOCAL extra. Overlapping
 * marks add up, and the usual clamps apply once at the end.
 */
export interface ProsodyMark {
  at: number
  to?: number
  tone?: Tone
  pace?: Pace
  rate?: number
  pitch?: number
  volume?: number
}

/** Backwards-compatible alias. */
export type VoiceLine = VoiceUnit

export interface ProsodyBase { rate: number; pitch: number; volume: number }
export interface ResolvedProsody { rate: number; pitch: number; volume: number }

/** Plugin-owned acoustics. Tunable data, never model input. */
export const TONE_DELTAS: Record<Tone, { rate?: number; pitch?: number; volume?: number }> = {
  // Pitch stays inside a few percent on purpose: past that the voice stops
  // sounding like the same person. Character comes from rate, volume and the
  // ending contour instead.
  neutral: {},
  warm: { rate: -2, pitch: 3 },
  soft: { rate: -3, pitch: -3, volume: -8 },
  firm: { rate: -4, volume: 9 },
  urgent: { rate: 14, pitch: 2, volume: 4 },
  bright: { rate: 5, pitch: 6 },
}

export const PACE_DELTAS: Record<Pace, { rate?: number }> = {
  even: {},
  slower: { rate: -10 },
  faster: { rate: 10 },
}

/**
 * A named delivery, published to the model so it never has to guess numbers.
 * A style is a SEQUENCE: tokens plus an ending contour, resolved under whatever
 * the step itself declares.
 */
export interface StylePreset {
  tone?: Tone
  pace?: Pace
  rate?: number
  pitch?: number
  volume?: number
  breath?: boolean
  lengthen?: boolean
  /** Ending contour: positive rises, negative falls, painted on the last characters. */
  tail?: number
  meaning: string
}

export type StyleToken =
  | 'tender' | 'coy' | 'happy' | 'surprised' | 'hurt' | 'shy' | 'serious' | 'stern'
  | 'hurried' | 'sleepy' | 'playful' | 'comforting' | 'disappointed' | 'whisper'
  | 'hesitant' | 'amused'

export const STYLES: Record<StyleToken, StylePreset> = {
  tender: { tone: 'warm', pace: 'slower', pitch: 1, meaning: '温柔：慢一点、音高略抬，像在近处说话。' },
  coy: { pace: 'slower', pitch: 4, tail: 8, meaning: '撒娇：拖慢、偏高，句尾往上带。' },
  happy: { tone: 'bright', pace: 'faster', tail: 4, meaning: '开心：轻快明亮，句尾上扬。' },
  surprised: { pitch: 3, rate: 3, tail: 10, meaning: '惊讶：起音偏高，句尾明显上扬。' },
  hurt: { tone: 'soft', pace: 'slower', volume: -3, tail: -6, meaning: '委屈：放轻放慢，句尾往下沉。' },
  shy: { tone: 'soft', pace: 'slower', volume: -5, breath: true, meaning: '害羞：气声多、音量小，中间有一下换气。' },
  serious: { tone: 'firm', meaning: '认真：结实清楚，不加装饰。' },
  stern: { tone: 'firm', rate: -4, pitch: -1, meaning: '严肃：更低更慢，压着说。' },
  hurried: { tone: 'urgent', pace: 'faster', meaning: '急促：明显加快，句子短促。' },
  sleepy: { pace: 'slower', rate: -12, pitch: -2, volume: -6, lengthen: true, meaning: '困倦：拖慢放软，句尾散掉，音高几乎不动。' },
  playful: { tone: 'bright', pace: 'faster', tail: 6, meaning: '俏皮：快而跳，句尾上挑。' },
  comforting: { tone: 'warm', pace: 'slower', rate: -3, volume: -4, meaning: '安慰：放慢压低一点，句尾收软。' },
  disappointed: { tone: 'soft', pace: 'slower', lengthen: true, tail: -8, meaning: '失望：慢、软，句尾落下去。' },
  whisper: { tone: 'soft', volume: -12, breath: true, meaning: '低语：音量明显收小，带一下换气。' },
  hesitant: { pace: 'slower', volume: -3, tail: -3, meaning: '犹豫：慢，句尾没底气。' },
  amused: { tone: 'bright', rate: 3, breath: true, meaning: '笑意：明亮，带一点笑的换气。' },
}

/** Published style names, derived from the same table the resolver reads. */
export const STYLE_TOKENS = Object.keys(STYLES) as StyleToken[]

/** Bounds and meaning of the optional per-step numeric adjustments. */
export const STEP_LIMITS = {
  rate: { min: -50, max: 50, meaning: '这一步的语速调整，百分比，正数更快。' },
  pitch: { min: -50, max: 50, meaning: '这一步的音高调整，百分比，正数更高。' },
  volume: { min: -100, max: 100, meaning: '这一步的响度调整，百分比，正数更响。' },
} as const

export type StepLimitKey = keyof typeof STEP_LIMITS

/** Character-level marks: what they are, written for the model. */
export const MARK_LIMITS = {
  max: 24,
  fields: ['at', 'to', 'tone', 'pace', 'rate', 'pitch', 'volume'],
  meaning: '一句话里的局部标定：at/to 圈出从第几个字到第几个字（从 0 数，to 不含），只改那几个字。'
    + '可以给 tone、pace、rate、pitch、volume，都是在这句已有语气之上再叠的局部变化，重叠会相加。'
    + '给了标定之后这句的文字不再被自动改写，位置才对得上。',
} as const

/** Numeric adjustment fields, derived from the same bounds used at synthesis. */
export const ADJUSTMENTS: { field: string; min: number; max: number; meaning: string }[] =
  (Object.keys(STEP_LIMITS) as StepLimitKey[]).map((field) => ({
    field,
    min: STEP_LIMITS[field].min,
    max: STEP_LIMITS[field].max,
    meaning: STEP_LIMITS[field].meaning,
  }))

/** Text constructs the model may set per step. */
export const CONSTRUCTS: { value: string; meaning: string }[] = [
  { value: 'lengthen', meaning: '把句尾拖长、收得软一点。' },
  { value: 'breath', meaning: '加一个换气的缝和一句尾的轻声，听起来更近。' },
]

/** Silence tokens, in milliseconds. */
export const PAUSE_MS: Record<PauseToken, number> = { beat: 280, short: 140, long: 600 }

/** One published word the model may use, with a line written for the model. */
export interface VocabularyEntry { value: string; meaning: string }

const TONE_MEANINGS: Record<Tone, string> = {
  neutral: '日常陈述，不加额外色彩。',
  warm: '带一点暖意，音高略抬。',
  soft: '放轻放低，像在近处小声说。',
  firm: '结实清楚，音量略高、语速略收。',
  urgent: '催促感，语速明显加快。',
  bright: '明亮上扬，适合好消息。',
}

const PACE_MEANINGS: Record<Pace, string> = {
  even: '保持当前语速。',
  slower: '这一步稍慢一点。',
  faster: '这一步稍快一点。',
}

const PAUSE_MEANINGS: Record<PauseToken, string> = {
  beat: '一个气口，约四分之一秒。',
  short: '很短的停顿。',
  long: '明显的停顿，像想了半拍。',
}

/**
 * The published vocabulary. Built from the SAME tables that drive synthesis, so
 * a token can never be offered to the model without an acoustic mapping.
 */
export const VOCABULARY: {
  tone: VocabularyEntry[]
  pace: VocabularyEntry[]
  pause: VocabularyEntry[]
} = {
  tone: (Object.keys(TONE_DELTAS) as Tone[]).map((value) => ({ value, meaning: TONE_MEANINGS[value] })),
  pace: (Object.keys(PACE_DELTAS) as Pace[]).map((value) => ({ value, meaning: PACE_MEANINGS[value] })),
  pause: (Object.keys(PAUSE_MS) as PauseToken[]).map((value) => ({ value, meaning: PAUSE_MEANINGS[value] })),
}

/** Accepted tokens, derived from the same tables the tool schema publishes. */
export const EXPRESS_TOKENS: { tone: Tone[]; pace: Pace[]; pause: PauseToken[] } = {
  tone: Object.keys(TONE_DELTAS) as Tone[],
  pace: Object.keys(PACE_DELTAS) as Pace[],
  pause: Object.keys(PAUSE_MS) as PauseToken[],
}

const MAX_UNITS = 12
const MAX_TEXT = 200
const MAX_STRESS = 4
const MAX_STRESS_CHARS = 24
const RATE_LIMIT = 50
const PITCH_LIMIT = 50
const VOLUME_LIMIT = 100
const ELISION = '——'
const BREATH_TAIL = '……'
const BREATH_RATE_DELTA = -8
const BREATH_VOLUME_DELTA = -15

const TONES = new Set(Object.keys(TONE_DELTAS))
const PACES = new Set(Object.keys(PACE_DELTAS))
const PAUSES = new Set(Object.keys(PAUSE_MS))

const clampNumber = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value))

/** Read an optional bounded number; non-numbers are ignored, not repaired. */
const toNumber = (value: unknown, min: number, max: number): number | undefined => {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number)) return undefined
  return clampNumber(Math.round(number), min, max)
}

/** Ending contour for a style: a short ramp over the last characters. */
function tailMarks(say: string, tail: number): ProsodyMark[] | undefined {
  const chars = Array.from(say)
  const closed = /[。！？!?，,、…—]$/u.test(say)
  const end = closed ? chars.length - 1 : chars.length
  if (end < 4) return undefined
  const count = Math.min(3, end)
  const marks: ProsodyMark[] = []
  for (let index = 0; index < count; index += 1) {
    marks.push({ at: end - count + index, pitch: Math.round((tail * (index + 1)) / count) })
  }
  return marks
}

/**
 * Layer a published style UNDER the step's own fields: whatever the step says
 * wins, the style fills the rest. An explicit mark sequence owns the contour, so
 * the preset only paints one when the step left it empty.
 */
function applyStylePreset(unit: VoiceUnit, style: StyleToken): void {
  const preset = STYLES[style]
  if (preset.tone !== undefined && unit.tone === undefined) unit.tone = preset.tone
  if (preset.pace !== undefined && unit.pace === undefined) unit.pace = preset.pace
  if (preset.rate !== undefined && unit.rate === undefined) unit.rate = preset.rate
  if (preset.pitch !== undefined && unit.pitch === undefined) unit.pitch = preset.pitch
  if (preset.volume !== undefined && unit.volume === undefined) unit.volume = preset.volume
  if (preset.breath === true && unit.breath === undefined) unit.breath = true
  if (preset.lengthen === true && unit.lengthen === undefined) unit.lengthen = true
  if (preset.tail !== undefined && unit.mark === undefined) {
    const mark = tailMarks(unit.say ?? '', preset.tail)
    if (mark !== undefined) unit.mark = mark
  }
}

/** Read a model-declared mark sequence; unusable marks are dropped, not repaired. */
function normalizeMarks(input: unknown): ProsodyMark[] | undefined {
  if (!Array.isArray(input)) return undefined
  const marks: ProsodyMark[] = []
  for (const entry of input) {
    if (marks.length >= MARK_LIMITS.max) break
    if (entry === null || typeof entry !== 'object') continue
    const row = entry as Record<string, unknown>
    const at = toNumber(row.at, 0, MAX_TEXT - 1)
    if (at === undefined) continue
    const tone = row.tone === undefined ? undefined : (typeof row.tone === 'string' ? row.tone.trim() : '')
    if (tone !== undefined && !TONES.has(tone)) continue
    const pace = row.pace === undefined ? undefined : (typeof row.pace === 'string' ? row.pace.trim() : '')
    if (pace !== undefined && !PACES.has(pace)) continue
    const mark: ProsodyMark = { at }
    const to = toNumber(row.to, 0, MAX_TEXT)
    if (to !== undefined && to > at) mark.to = to
    const rate = toNumber(row.rate, STEP_LIMITS.rate.min, STEP_LIMITS.rate.max)
    if (rate !== undefined && rate !== 0) mark.rate = rate
    const pitch = toNumber(row.pitch, STEP_LIMITS.pitch.min, STEP_LIMITS.pitch.max)
    if (pitch !== undefined && pitch !== 0) mark.pitch = pitch
    const volume = toNumber(row.volume, STEP_LIMITS.volume.min, STEP_LIMITS.volume.max)
    if (volume !== undefined && volume !== 0) mark.volume = volume
    if (tone !== undefined) mark.tone = tone as Tone
    if (pace !== undefined) mark.pace = pace as Pace
    if (mark.tone === undefined && mark.pace === undefined
      && mark.rate === undefined && mark.pitch === undefined && mark.volume === undefined) continue
    marks.push(mark)
  }
  return marks.length > 0 ? marks : undefined
}

/**
 * Keep at most 12 usable units. An unknown tone/pace/pause token rejects the
 * whole unit: a wrong label must never be silently spoken as neutral.
 */
export function normalizeVoiceUnits(input: unknown): VoiceUnit[] {
  if (!Array.isArray(input)) return []
  const units: VoiceUnit[] = []
  for (const raw of input) {
    if (units.length >= MAX_UNITS) break
    if (raw === null || typeof raw !== 'object') continue
    const row = raw as Record<string, unknown>

    if (row.pause !== undefined) {
      const pause = typeof row.pause === 'string' ? row.pause.trim() : ''
      if (!PAUSES.has(pause)) continue
      units.push({ pause: pause as PauseToken })
      continue
    }

    const collapsed = typeof row.say === 'string'
      ? row.say.replace(/\s+/gu, ' ').trim()
      : (typeof row.text === 'string' ? row.text.replace(/\s+/gu, ' ').trim() : '')
    if (collapsed === '') continue

    const style = row.style === undefined ? undefined : (typeof row.style === 'string' ? row.style.trim() : '')
    if (style !== undefined && !(style in STYLES)) continue

    const tone = row.tone === undefined ? undefined : (typeof row.tone === 'string' ? row.tone.trim() : '')
    if (tone !== undefined && !TONES.has(tone)) continue
    const pace = row.pace === undefined ? undefined : (typeof row.pace === 'string' ? row.pace.trim() : '')
    if (pace !== undefined && !PACES.has(pace)) continue

    const unit: VoiceUnit = { say: Array.from(collapsed).slice(0, MAX_TEXT).join('') }
    const stepRate = toNumber(row.rate, STEP_LIMITS.rate.min, STEP_LIMITS.rate.max)
    if (stepRate !== undefined) unit.rate = stepRate
    const stepPitch = toNumber(row.pitch, STEP_LIMITS.pitch.min, STEP_LIMITS.pitch.max)
    if (stepPitch !== undefined) unit.pitch = stepPitch
    const stepVolume = toNumber(row.volume, STEP_LIMITS.volume.min, STEP_LIMITS.volume.max)
    if (stepVolume !== undefined) unit.volume = stepVolume
    if (tone !== undefined) unit.tone = tone as Tone
    if (pace !== undefined) unit.pace = pace as Pace
    if (Array.isArray(row.stress)) {
      const stress: string[] = []
      for (const entry of row.stress) {
        if (stress.length >= MAX_STRESS) break
        if (typeof entry !== 'string') continue
        const word = entry.trim()
        if (word === '' || Array.from(word).length > MAX_STRESS_CHARS) continue
        stress.push(word)
      }
      if (stress.length > 0) unit.stress = stress
    }
    if (row.breath === true) unit.breath = true
    if (row.lengthen === true) unit.lengthen = true
    if (row.mark !== undefined) {
      const mark = normalizeMarks(row.mark)
      if (mark !== undefined) unit.mark = mark
    }
    if (style !== undefined) applyStylePreset(unit, style as StyleToken)
    units.push(unit)
  }
  return units
}

/** Alias kept so older call sites keep working. */
export const normalizeVoiceLines = normalizeVoiceUnits

/** Parse an SSML percent ('+10%', 'default') back into a number. */
export function parseProsodyPercent(value: string | undefined): number {
  if (typeof value !== 'string') return 0
  const trimmed = value.trim()
  if (trimmed === '' || trimmed === 'default') return 0
  const match = /^([+-]?\d+(?:\.\d+)?)%$/.exec(trimmed)
  if (!match) return 0
  const number = Number(match[1])
  return Number.isFinite(number) ? Math.round(number) : 0
}

/**
 * Effective prosody = clamp(base + tone delta + pace delta + breath delta).
 * The clamp applies to the SUM so intent saturates instead of overflowing.
 */
export function effectiveProsody(unit: VoiceUnit, base: ProsodyBase): ResolvedProsody {
  const tone = unit.tone === undefined ? TONE_DELTAS.neutral : TONE_DELTAS[unit.tone]
  const pace = unit.pace === undefined ? PACE_DELTAS.even : PACE_DELTAS[unit.pace]
  const breath = unit.breath === true
  // Order: base -> this step's numbers -> intent-token modifiers; clamp once.
  const drate = (unit.rate ?? 0) + (tone.rate ?? 0) + (pace.rate ?? 0) + (breath ? BREATH_RATE_DELTA : 0)
  const dpitch = (unit.pitch ?? 0) + (tone.pitch ?? 0)
  const dvolume = (unit.volume ?? 0) + (tone.volume ?? 0) + (breath ? BREATH_VOLUME_DELTA : 0)
  return {
    rate: clampNumber(base.rate + drate, -RATE_LIMIT, RATE_LIMIT),
    pitch: clampNumber(base.pitch + dpitch, -PITCH_LIMIT, PITCH_LIMIT),
    volume: clampNumber(base.volume + dvolume, -VOLUME_LIMIT, VOLUME_LIMIT),
  }
}

/** Stable key: two neighbours share one synthesis request only when equal. */
export function prosodyKey(resolved: ResolvedProsody): string {
  return resolved.rate + '|' + resolved.pitch + '|' + resolved.volume
}

/** Signed SSML percentage; mirrors rateToProsody() in tts-queue.ts. */
const signedPercent = (value: number): string => (value === 0 ? 'default' : (value > 0 ? '+' : '') + value + '%')

/** SSML prosody for one unit, resolved against the queue base. */
export function expressionProsody(unit: VoiceUnit, base: ProsodyBase): { rate: string; pitch: string; volume: string } {
  const resolved = effectiveProsody(unit, base)
  return {
    rate: signedPercent(resolved.rate),
    pitch: signedPercent(resolved.pitch),
    volume: signedPercent(resolved.volume),
  }
}

/** One resolved piece of a marked unit: text plus the local delta painted on it. */
export interface MarkSpan {
  text: string
  rate: number
  pitch: number
  volume: number
}

/** A mark's full delta, intent tokens folded in the same way as a step. */
function markDelta(mark: ProsodyMark): ResolvedProsody {
  const tone = mark.tone === undefined ? TONE_DELTAS.neutral : TONE_DELTAS[mark.tone]
  const pace = mark.pace === undefined ? PACE_DELTAS.even : PACE_DELTAS[mark.pace]
  return {
    rate: (mark.rate ?? 0) + (tone.rate ?? 0) + (pace.rate ?? 0),
    pitch: (mark.pitch ?? 0) + (tone.pitch ?? 0),
    volume: (mark.volume ?? 0) + (tone.volume ?? 0),
  }
}

/**
 * Paint one delta per character, then fold equal neighbours into spans. This is
 * the single place character marks become audio; undefined means nothing usable
 * was marked and the plain path stays untouched.
 */
export function resolveMarks(unit: VoiceUnit): MarkSpan[] | undefined {
  const text = typeof unit.say === 'string' ? unit.say : ''
  const marks = unit.mark
  if (text === '' || marks === undefined || marks.length === 0) return undefined
  const chars = Array.from(text)
  const lanes: ResolvedProsody[] = chars.map(() => ({ rate: 0, pitch: 0, volume: 0 }))
  let painted = false
  for (const mark of marks) {
    if (mark.at < 0 || mark.at >= chars.length) continue
    const to = Math.min(chars.length, Math.max(mark.at + 1, mark.to ?? mark.at + 1))
    const delta = markDelta(mark)
    if (delta.rate === 0 && delta.pitch === 0 && delta.volume === 0) continue
    painted = true
    for (let index = mark.at; index < to; index += 1) {
      const lane = lanes[index] as ResolvedProsody
      lane.rate += delta.rate
      lane.pitch += delta.pitch
      lane.volume += delta.volume
    }
  }
  if (!painted) return undefined
  const spans: MarkSpan[] = []
  for (let index = 0; index < chars.length; index += 1) {
    const lane = lanes[index] as ResolvedProsody
    const last = spans[spans.length - 1]
    if (last !== undefined && last.rate === lane.rate && last.pitch === lane.pitch
      && last.volume === lane.volume) {
      last.text += chars[index]
      continue
    }
    spans.push({ text: chars[index] as string, rate: lane.rate, pitch: lane.pitch, volume: lane.volume })
  }
  return spans
}

const escapeXml = (text: string): string => text
  .replace(/&/gu, '&amp;')
  .replace(/</gu, '&lt;')
  .replace(/>/gu, '&gt;')
  .replace(/"/gu, '&quot;')
  .replace(/'/gu, '&apos;')

/**
 * Measured on the live readaloud endpoint: two <prosody> elements in one request
 * synthesize, three close the socket before turn.end. Every request this module
 * builds therefore carries at most two, and a unit with more marked regions is
 * spoken as consecutive chunks. Nesting is refused as well, so a marked chunk is
 * sent without the template wrapper and every element holds FULL values.
 */
export const MAX_SPANS_PER_REQUEST = 2

/** One request's worth of marked text; the plain text is kept for the fallback. */
export interface SsmlChunk {
  text: string
  ssml: string
}

/**
 * Split one marked unit into per-request chunks of at most two prosody elements.
 * Returns undefined when nothing usable was marked, so the plain path (and its
 * byte-identical requests) stays untouched.
 */
export function expressionSsmlChunks(unit: VoiceUnit, base: ProsodyBase): SsmlChunk[] | undefined {
  const spans = resolveMarks(unit)
  if (spans === undefined) return undefined
  const step = effectiveProsody(unit, base)
  const solved = spans.map((span) => ({
    text: span.text,
    rate: clampNumber(step.rate + span.rate, -RATE_LIMIT, RATE_LIMIT),
    pitch: clampNumber(step.pitch + span.pitch, -PITCH_LIMIT, PITCH_LIMIT),
    volume: clampNumber(step.volume + span.volume, -VOLUME_LIMIT, VOLUME_LIMIT),
  }))
  // Punctuation on its own is not a request: the endpoint answers it with no
  // audio at all. Fold it into its neighbour so every chunk actually speaks.
  const speakable = (text: string): boolean => /[\p{L}\p{N}]/u.test(text)
  const folded: typeof solved = []
  for (const span of solved) {
    const last = folded[folded.length - 1]
    if (last !== undefined && !speakable(span.text)) {
      last.text += span.text
      continue
    }
    folded.push({ ...span })
  }
  const chunks: SsmlChunk[] = []
  for (let index = 0; index < folded.length; index += MAX_SPANS_PER_REQUEST) {
    const group = folded.slice(index, index + MAX_SPANS_PER_REQUEST)
    chunks.push({
      text: group.map((span) => span.text).join(''),
      ssml: group.map((span) => '<prosody rate="' + signedPercent(span.rate)
        + '" pitch="' + signedPercent(span.pitch) + '" volume="' + signedPercent(span.volume)
        + '">' + escapeXml(span.text) + '</prosody>').join(''),
    })
  }
  return chunks
}

/** Silence a pause unit asks for. */
export function pauseMsFor(pause: PauseToken): number {
  return PAUSE_MS[pause] ?? 0
}

/**
 * Split one unit at its first stressed word into three units: before, the word
 * itself (tone firm), after. Breath/lengthen stay on the last piece because they
 * shape the tail of a line, not every fragment.
 */
export function splitStress(unit: VoiceUnit): VoiceUnit[] {
  const text = typeof unit.say === 'string' ? unit.say : ''
  // Marks are character positions; splitting the text would move them.
  if (text === '' || unit.pause !== undefined || (unit.mark?.length ?? 0) > 0) return [unit]
  const words = (unit.stress ?? []).filter((word) => word !== '' && text.includes(word))
  if (words.length === 0) return [unit]
  const word = words[0]!
  const at = text.indexOf(word)
  const before = text.slice(0, at)
  const after = text.slice(at + word.length)
  const base: VoiceUnit = { ...unit }
  delete base.stress
  delete base.breath
  delete base.lengthen
  const pieces: VoiceUnit[] = []
  if (before.trim() !== '') pieces.push({ ...base, say: before })
  pieces.push({ ...base, say: word, tone: 'firm' })
  if (after.trim() !== '') pieces.push({ ...base, say: after })
  const last = pieces[pieces.length - 1]
  if (last !== undefined) {
    if (unit.breath === true) last.breath = true
    if (unit.lengthen === true) last.lengthen = true
  }
  return pieces
}

/** True when the text already ends in an elided or breathy tail. */
const endsSoft = (text: string): boolean => /(?:—|…)$/u.test(text)

const lengthenTail = (text: string): string => {
  if (endsSoft(text)) return text
  return /[。！？!?]$/u.test(text) ? text.replace(/[。！？!?]$/u, ELISION) : text + BREATH_TAIL
}

const breathe = (text: string): string => {
  let next = text
  if (!/[，,、]/u.test(next) && !endsSoft(next)) {
    const chars = Array.from(next.replace(/[。！？!?]$/u, ''))
    if (chars.length >= 4) {
      const cut = Math.floor((chars.length * 2) / 3)
      next = chars.slice(0, cut).join('') + '，' + chars.slice(cut).join('')
    }
  }
  if (!/[。！？!?…—]$/u.test(next)) next += BREATH_TAIL
  return next
}

/** Silence left where `breath` puts its soft seam, in ms. */
export const BREATH_GAP_MS = 200

/**
 * Split a line at the breath seam so the gap is AUDIBLE: the text already got a
 * comma from `breathe`, this returns the two halves around it. A breath the
 * engine cannot voice is at least a real pause in the right place.
 */
export function breathSeam(text: string): [string, string] | undefined {
  const chars = Array.from(text)
  if (chars.length < 6) return undefined
  const cut = Math.floor((chars.length * 2) / 3)
  // Nearest seam to the two-thirds point, on either side: a short sentence often
  // puts its comma before that point.
  const seams: number[] = []
  for (let index = 1; index < chars.length - 1; index += 1) {
    if (/[，,、…—]/u.test(chars[index] as string)) seams.push(index)
  }
  const first = seams[0]
  if (first === undefined) return undefined
  let at = first
  for (const seam of seams) {
    if (Math.abs(seam - cut) < Math.abs(at - cut)) at = seam
  }
  return [chars.slice(0, at + 1).join(''), chars.slice(at + 1).join('')]
}

/**
 * Text-level delivery constructs. `lengthen` runs first, then `breath`; both
 * are idempotent, so applying this twice returns the same string.
 */
export function applyExpression(unit: VoiceUnit): string {
  let text = typeof unit.say === 'string' ? unit.say : ''
  if (text === '') return ''
  if (unit.lengthen === true) text = lengthenTail(text)
  if (unit.breath === true) text = breathe(text)
  return text
}
