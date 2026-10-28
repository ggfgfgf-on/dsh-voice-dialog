/** Browser-local voice-dialog preferences; no host restart needed. */
import type { GuestMode, PromptMode } from './scheduler.ts'

export interface VoiceDialogPreferences {
  /** Read assistant replies aloud. */
  autoRead: boolean
  /** Playback gain, 0..1. */
  volume: number
  /** Gain multiplier while the user speaks, 0..1. */
  duckLevel: number
  /** Preferred microphone device id ('' = browser default). */
  deviceId: string
  /** Silence that closes an utterance, in milliseconds. */
  pauseMs: number
  /** Prefix each transcript with the detected speaker label. */
  speakerPrefix: boolean
  /** Drop utterances that do not match the enrolled voiceprint. */
  speakerGate: boolean
  /** Cosine similarity at which an utterance counts as the enrolled speaker. */
  speakerThreshold: number
  /** How the owner's own speech is delivered: soft queue or hard steer. */
  ownerMode: PromptMode
  /** What to do when someone other than the enrolled owner speaks. */
  guestMode: GuestMode
  /** Allow several utterances to be transcribed at the same time. */
  parallelAsr: boolean
}

const STORAGE_KEY = 'dsh-voice-dialog.preferences'
const DEFAULTS: VoiceDialogPreferences = {
  autoRead: true,
  volume: 0.9,
  duckLevel: 0.18,
  deviceId: '',
  pauseMs: 1600,
  speakerPrefix: true,
  speakerGate: false,
  speakerThreshold: 0.52,
  ownerMode: 'queue',
  guestMode: 'queue',
  parallelAsr: true,
}

function clampPause(value: unknown, fallback: number): number {
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(number) ? Math.min(3000, Math.max(800, Math.round(number))) : fallback
}

function clampThreshold(value: unknown, fallback: number): number {
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(number) ? Math.min(0.8, Math.max(0.35, Math.round(number * 100) / 100)) : fallback
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
      duckLevel: clamp(value.duckLevel, DEFAULTS.duckLevel),
      deviceId: typeof value.deviceId === 'string' ? value.deviceId : DEFAULTS.deviceId,
      pauseMs: clampPause(value.pauseMs, DEFAULTS.pauseMs),
      speakerPrefix: typeof value.speakerPrefix === 'boolean' ? value.speakerPrefix : DEFAULTS.speakerPrefix,
      speakerGate: typeof value.speakerGate === 'boolean' ? value.speakerGate : DEFAULTS.speakerGate,
      speakerThreshold: clampThreshold(value.speakerThreshold, DEFAULTS.speakerThreshold),
      ownerMode: parseOwnerMode(value.ownerMode, DEFAULTS.ownerMode),
      guestMode: parseGuestMode(value.guestMode, DEFAULTS.guestMode),
      parallelAsr: typeof value.parallelAsr === 'boolean' ? value.parallelAsr : DEFAULTS.parallelAsr,
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
  next.duckLevel = clamp(next.duckLevel, DEFAULTS.duckLevel)
  next.pauseMs = clampPause(next.pauseMs, DEFAULTS.pauseMs)
  next.speakerThreshold = clampThreshold(next.speakerThreshold, DEFAULTS.speakerThreshold)
  next.ownerMode = parseOwnerMode(next.ownerMode, DEFAULTS.ownerMode)
  next.guestMode = parseGuestMode(next.guestMode, DEFAULTS.guestMode)
  next.parallelAsr = typeof next.parallelAsr === 'boolean' ? next.parallelAsr : DEFAULTS.parallelAsr
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
