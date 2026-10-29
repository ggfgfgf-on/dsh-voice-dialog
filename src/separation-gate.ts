/**
 * Cheap, conservative "is this probably one speaker?" gate.
 *
 * Separation is expensive, but skipping it for overlapping speech corrupts
 * speaker attribution. This module therefore has one safe fast-path decision:
 * two separated chunks of the same utterance must both match each other and,
 * when an owner template exists, the enrolled owner. Anything else is
 * "uncertain" and stays on the legacy separation path.
 */

export interface SpeechWindow {
  samples: Float32Array
  startSample: number
  endSample: number
}

export interface SpeechWindowSelection {
  windows: SpeechWindow[]
  activeSamples: number
  reason: 'ok' | 'no-speech' | 'too-short'
}

export interface OverlapDecision {
  /** At least one suspicion signal fired (changing voice or weak owner match). */
  suspected: boolean
  /** Safe to bypass separation. Only true when confidence is high. */
  singleSpeaker: boolean
  /** True only for a positive single-speaker or positive overlap decision. */
  confident: boolean
  reason: 'same-voice' | 'voice-changed' | 'owner-mismatch' | 'uncertain' | 'insufficient-audio' | 'voiceprint-not-ready'
  minSimilarity?: number
  ownerSimilarity?: number
  /** Similarity required before the fast path is allowed. */
  threshold: number
}

const FRAME_MS = 100
const MIN_ACTIVE_MS = 700
const TARGET_WINDOW_MS = 1600
/** One second of voiced audio is the shortest window whose embedding holds up. */
const MIN_WINDOW_SAMPLES = 16000
const DEFAULT_SINGLE_THRESHOLD = 0.62
const DEFAULT_SUSPECT_THRESHOLD = 0.48
const DEFAULT_OWNER_FLOOR = 0.5

function frameRms(samples: Float32Array, start: number, length: number): number {
  let sum = 0
  const end = Math.min(samples.length, start + length)
  for (let i = start; i < end; i++) sum += samples[i] * samples[i]
  return Math.sqrt(sum / Math.max(1, end - start))
}

/**
 * Trim leading/trailing silence and return two non-overlapping chunks, one
 * from the beginning and one from the end of the voiced region. The chunks are
 * deliberately separated in time: a changing voice makes their embeddings
 * diverge, which is the signal the gate needs.
 */
export function selectSpeechWindows(
  samples: Float32Array,
  sampleRate = 16_000,
): SpeechWindowSelection {
  const rate = Math.max(1000, Math.floor(sampleRate))
  const frame = Math.max(160, Math.round(rate * FRAME_MS / 1000))
  if (samples.length < frame * 2) {
    return { windows: [], activeSamples: 0, reason: 'too-short' }
  }
  const levels: number[] = []
  for (let at = 0; at + frame <= samples.length; at += frame) levels.push(frameRms(samples, at, frame))
  const sorted = [...levels].sort((a, b) => a - b)
  const noise = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.2))] ?? 0
  const threshold = Math.max(0.006, noise * 2.2)
  let first = -1
  let last = -1
  for (let index = 0; index < levels.length; index++) {
    if (levels[index]! < threshold) continue
    // A single 100 ms click is not speech.
    if (index + 1 < levels.length && levels[index + 1]! < threshold) continue
    if (first < 0) first = index
    last = index + 1
  }
  if (first < 0 || last <= first) return { windows: [], activeSamples: 0, reason: 'no-speech' }
  const activeStart = first * frame
  const activeEnd = Math.min(samples.length, last * frame)
  const activeSamples = activeEnd - activeStart
  if (activeSamples < Math.round(rate * MIN_ACTIVE_MS / 1000)) {
    return { windows: [], activeSamples, reason: 'too-short' }
  }
  const windowSamples = Math.min(
    Math.round(rate * TARGET_WINDOW_MS / 1000),
    Math.floor(activeSamples * 0.42),
  )
  if (windowSamples < MIN_WINDOW_SAMPLES) {
    return { windows: [], activeSamples, reason: 'too-short' }
  }
  return {
    windows: [
      { samples: samples.slice(activeStart, activeStart + windowSamples), startSample: activeStart, endSample: activeStart + windowSamples },
      { samples: samples.slice(activeEnd - windowSamples, activeEnd), startSample: activeEnd - windowSamples, endSample: activeEnd },
    ],
    activeSamples,
    reason: 'ok',
  }
}

/**
 * Turn self-similarity (first vs last speech chunk) and optional owner
 * similarity into a three-way decision. The uncertain middle is intentional:
 * it falls back to the previous behaviour instead of gambling on attribution.
 */
export function decideSpeakerGate(input: {
  selfSimilarities: readonly number[]
  ownerSimilarity?: number
  singleThreshold?: number
  suspectThreshold?: number
  ownerFloor?: number
}): OverlapDecision {
  const singleThreshold = input.singleThreshold ?? DEFAULT_SINGLE_THRESHOLD
  const suspectThreshold = input.suspectThreshold ?? DEFAULT_SUSPECT_THRESHOLD
  const ownerFloor = input.ownerFloor ?? DEFAULT_OWNER_FLOOR
  const similarities = input.selfSimilarities.filter((value) => Number.isFinite(value))
  if (similarities.length === 0) {
    // Too little stable audio to judge. Running the model here used to split a
    // single speaker into two halves, so short clips stay on the single lane.
    return { suspected: false, singleSpeaker: true, confident: false, reason: 'insufficient-audio', threshold: singleThreshold }
  }
  const minSimilarity = Math.min(...similarities)
  const ownerSimilarity = typeof input.ownerSimilarity === 'number' && Number.isFinite(input.ownerSimilarity)
    ? input.ownerSimilarity
    : undefined
  const common = {
    minSimilarity: Math.round(minSimilarity * 1000) / 1000,
    ...(ownerSimilarity === undefined ? {} : { ownerSimilarity: Math.round(ownerSimilarity * 1000) / 1000 }),
    threshold: singleThreshold,
  }
  if (minSimilarity < suspectThreshold) {
    return { ...common, suspected: true, singleSpeaker: false, confident: true, reason: 'voice-changed' }
  }
  if (ownerSimilarity !== undefined && ownerSimilarity < ownerFloor) {
    return { ...common, suspected: true, singleSpeaker: false, confident: true, reason: 'owner-mismatch' }
  }
  if (minSimilarity >= singleThreshold) {
    return { ...common, suspected: false, singleSpeaker: true, confident: true, reason: 'same-voice' }
  }
  return { ...common, suspected: false, singleSpeaker: false, confident: false, reason: 'uncertain' }
}
