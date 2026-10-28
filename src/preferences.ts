/** Browser-local voice-dialog preferences; no host restart needed. */

export interface VoiceDialogPreferences {
  /** Read assistant replies aloud. */
  autoRead: boolean
  /** Playback gain, 0..1. */
  volume: number
  /** Gain multiplier while the user speaks, 0..1. */
  duckLevel: number
  /** Preferred microphone device id ('' = browser default). */
  deviceId: string
}

const STORAGE_KEY = 'dsh-voice-dialog.preferences'
const DEFAULTS: VoiceDialogPreferences = { autoRead: true, volume: 0.9, duckLevel: 0.18, deviceId: '' }
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
