/** Browser-local voice-dialog preferences; no host restart needed. */
import type { GuestMode, PromptMode } from './scheduler.ts'

export interface VoiceDialogPreferences {
  /** Read assistant replies aloud. */
  autoRead: boolean
  /** Playback gain, 0..1. */
  volume: number
  /** Gain multiplier while the user speaks, 0..1. */
  duckLevel: number
  /** Extra loudness on top of volume (1 = untouched, 2.5 = much louder). */
  speechBoost: number
  /** Preferred microphone device id ('' = browser default). */
  deviceId: string
  /** Silence that closes an utterance, in milliseconds. */
  pauseMs: number
  /**
   * Manual RMS gate override. 0 (default) follows the adaptive noise floor;
   * any other value pins the gate to that loudness.
   */
  micThreshold: number
  /** Prefix each transcript with the detected speaker label. */
  speakerPrefix: boolean
  /** Drop utterances that do not match the enrolled voiceprint. */
  speakerGate: boolean
  /** Cosine similarity at which an utterance counts as the enrolled speaker. */
  speakerThreshold: number
  /** How much more similar someone else must be before it beats the owner. */
  ownerMargin: number
  /** How the owner's own speech is delivered: soft queue or hard steer. */
  ownerMode: PromptMode
  /** What to do when someone other than the enrolled owner speaks. */
  guestMode: GuestMode
  /** Allow several utterances to be transcribed at the same time. */
  parallelAsr: boolean
  /**
   * Run one recognition on the audio already spoken this many milliseconds
   * after the previous partial call, during the silence wait. 0 (default) is
   * off, so a default install makes no extra recognition requests.
   */
  partialAsrMs: number
  /** Split overlapping speakers into two streams before recognition. */
  separateSpeakers: boolean
  /**
   * Hidden rollback switch: try a cheap single-speaker gate before separation.
   * Not exposed in the UI; localStorage can set it to false.
   */
  separationFastPath: boolean
  /** Let a parallel model decide whether to interrupt, queue, or ignore. */
  organizerEnabled: boolean
  /**
   * L2 chunk cap: cut one delivery into several raw chunks past this many
   * characters. 0 (default) never cuts, so the listener hears today's flow.
   */
  chunkMaxChars: number
}

const STORAGE_KEY = 'dsh-voice-dialog.preferences'

/** The owner's measured average sits near 0.56; 1 is the ceiling of the similarity score itself. */
export const SPEAKER_THRESHOLD_MIN = 0.35
export const SPEAKER_THRESHOLD_MAX = 1
export const SPEAKER_THRESHOLD_DEFAULT = 0.5

/** Partial recognition bounds: 0 is off, 2000 ms is longer than any useful wait. */
export const PARTIAL_ASR_MIN_MS = 0
export const PARTIAL_ASR_MAX_MS = 2000

/** 0 = off; anything above 2000 would fire less often than the wait itself. */
export function clampPartialAsr(value: unknown, fallback: number): number {
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(number)
    ? Math.min(PARTIAL_ASR_MAX_MS, Math.max(PARTIAL_ASR_MIN_MS, Math.round(number)))
    : fallback
}

const DEFAULTS: VoiceDialogPreferences = {
  autoRead: true,
  volume: 0.9,
  duckLevel: 0.85,
  speechBoost: 1.8,
  deviceId: '',
  pauseMs: 900,
  micThreshold: 0,
  speakerPrefix: true,
  speakerGate: false,
  speakerThreshold: SPEAKER_THRESHOLD_DEFAULT,
  ownerMargin: 0.12,
  ownerMode: 'queue',
  guestMode: 'queue',
  parallelAsr: true,
  partialAsrMs: 0,
  separateSpeakers: true,
  separationFastPath: true,
  organizerEnabled: true,
  chunkMaxChars: 0,
}

/** The silence wait, exposed so its 0 (immediate) floor is testable. */
export function clampPause(value: unknown, fallback: number): number {
  const number = typeof value === 'number' ? value : Number(value)
  // 0 = immediate: close the utterance on the first unvoiced frame. The VAD's
  // own minSpeechMs still refuses clicks, so this cannot cut half a syllable.
  return Number.isFinite(number) ? Math.min(4000, Math.max(0, Math.round(number))) : fallback
}

function clampThreshold(value: unknown, fallback: number): number {
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(number)
    ? Math.min(SPEAKER_THRESHOLD_MAX, Math.max(SPEAKER_THRESHOLD_MIN, Math.round(number * 100) / 100))
    : fallback
}

/** Same range as the settings slider: 0.04 means "anyone slightly closer wins". */
function clampMargin(value: unknown, fallback: number): number {
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(number) ? Math.min(0.3, Math.max(0.04, Math.round(number * 100) / 100)) : fallback
}

/** 1.0 leaves the original level alone; 2.5 is the loudest the limiter tolerates. */
function clampBoost(value: unknown, fallback: number): number {
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(number) ? Math.min(2.5, Math.max(1, Math.round(number * 10) / 10)) : fallback
}

/** 0 = no cap; 400 is a paragraph nobody says in one breath. */
function clampChunkMax(value: unknown, fallback: number): number {
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(number) ? Math.min(400, Math.max(0, Math.round(number))) : fallback
}

function clampMicThreshold(value: unknown, fallback: number): number {
  const number = typeof value === 'number' ? value : Number(value)
  // 0 means "follow the adaptive gate"; a positive value pins the gate.
  return Number.isFinite(number) ? Math.min(0.08, Math.max(0, Math.round(number * 1000) / 1000)) : fallback
}

function parseGuestMode(value: unknown, fallback: GuestMode): GuestMode {
  return value === 'queue' || value === 'steer' || value === 'ignore' ? value : fallback
}

function parseOwnerMode(value: unknown, fallback: PromptMode): PromptMode {
  return value === 'queue' || value === 'steer' ? value : fallback
}

const listeners = new Set<(value: VoiceDialogPreferences) => void>()

function clamp(value: unknown, fallback: number): number {
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(number) ? Math.min(1, Math.max(0, number)) : fallback
}

function parse(raw: string | null): VoiceDialogPreferences {
  if (!raw) return { ...DEFAULTS }
  try {
    const value = JSON.parse(raw) as Partial<VoiceDialogPreferences>
    return {
      autoRead: typeof value.autoRead === 'boolean' ? value.autoRead : DEFAULTS.autoRead,
      volume: clamp(value.volume, DEFAULTS.volume),
      // Speaking barely lowers the reading now: an old 0.3 value made every answer
  // sound distant, and with the microphone always on it ducked constantly.
  duckLevel: Math.max(0.8, clamp(value.duckLevel, DEFAULTS.duckLevel)),
      speechBoost: clampBoost(value.speechBoost, DEFAULTS.speechBoost),
      deviceId: typeof value.deviceId === 'string' ? value.deviceId : DEFAULTS.deviceId,
      pauseMs: clampPause(value.pauseMs, DEFAULTS.pauseMs),
      // 0.022 was the old hard-coded default, not a deliberate choice: migrate
      // it to the adaptive gate so existing profiles get the new behaviour.
      micThreshold: clampMicThreshold(value.micThreshold, 0) === 0.022
        ? 0
        : clampMicThreshold(value.micThreshold, DEFAULTS.micThreshold),
      speakerPrefix: typeof value.speakerPrefix === 'boolean' ? value.speakerPrefix : DEFAULTS.speakerPrefix,
      speakerGate: typeof value.speakerGate === 'boolean' ? value.speakerGate : DEFAULTS.speakerGate,
      speakerThreshold: clampThreshold(value.speakerThreshold, DEFAULTS.speakerThreshold),
      ownerMargin: clampMargin(value.ownerMargin, DEFAULTS.ownerMargin),
      ownerMode: parseOwnerMode(value.ownerMode, DEFAULTS.ownerMode),
      guestMode: parseGuestMode(value.guestMode, DEFAULTS.guestMode),
      parallelAsr: typeof value.parallelAsr === 'boolean' ? value.parallelAsr : DEFAULTS.parallelAsr,
      partialAsrMs: clampPartialAsr(value.partialAsrMs, DEFAULTS.partialAsrMs),
      separateSpeakers: typeof value.separateSpeakers === 'boolean' ? value.separateSpeakers : DEFAULTS.separateSpeakers,
      separationFastPath: typeof value.separationFastPath === 'boolean' ? value.separationFastPath : DEFAULTS.separationFastPath,
      organizerEnabled: typeof value.organizerEnabled === 'boolean' ? value.organizerEnabled : DEFAULTS.organizerEnabled,
      chunkMaxChars: clampChunkMax(value.chunkMaxChars, DEFAULTS.chunkMaxChars),
    }
  } catch {
    return { ...DEFAULTS }
  }
}

let current: VoiceDialogPreferences | undefined

export function getPreferences(): VoiceDialogPreferences {
  if (current === undefined) {
    try { current = parse(localStorage.getItem(STORAGE_KEY)) }
    catch { current = { ...DEFAULTS } }
  }
  return current
}

export function setPreferences(patch: Partial<VoiceDialogPreferences>): VoiceDialogPreferences {
  const next = { ...getPreferences(), ...patch }
  next.volume = clamp(next.volume, DEFAULTS.volume)
  next.duckLevel = Math.max(0.8, clamp(next.duckLevel, DEFAULTS.duckLevel))
  next.speechBoost = clampBoost(next.speechBoost, DEFAULTS.speechBoost)
  next.pauseMs = clampPause(next.pauseMs, DEFAULTS.pauseMs)
  next.micThreshold = clampMicThreshold(next.micThreshold, DEFAULTS.micThreshold)
  next.speakerThreshold = clampThreshold(next.speakerThreshold, DEFAULTS.speakerThreshold)
  next.ownerMargin = clampMargin(next.ownerMargin, DEFAULTS.ownerMargin)
  next.ownerMode = parseOwnerMode(next.ownerMode, DEFAULTS.ownerMode)
  next.guestMode = parseGuestMode(next.guestMode, DEFAULTS.guestMode)
  next.parallelAsr = typeof next.parallelAsr === 'boolean' ? next.parallelAsr : DEFAULTS.parallelAsr
  next.partialAsrMs = clampPartialAsr(next.partialAsrMs, DEFAULTS.partialAsrMs)
  next.separateSpeakers = typeof next.separateSpeakers === 'boolean' ? next.separateSpeakers : DEFAULTS.separateSpeakers
  next.separationFastPath = typeof next.separationFastPath === 'boolean' ? next.separationFastPath : DEFAULTS.separationFastPath
  next.organizerEnabled = typeof next.organizerEnabled === 'boolean' ? next.organizerEnabled : DEFAULTS.organizerEnabled
  next.chunkMaxChars = clampChunkMax(next.chunkMaxChars, DEFAULTS.chunkMaxChars)
  current = next
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)) } catch { /* private mode */ }
  for (const listener of listeners) listener(next)
  return next
}

export function subscribePreferences(listener: (value: VoiceDialogPreferences) => void): () => void {
  listeners.add(listener)
  listener(getPreferences())
  return () => { listeners.delete(listener) }
}
