/**
 * The one writer of playback gain.
 *
 * Every change goes through apply(): cancel automation still scheduled, pin the
 * value that is audible right now, then ramp once to a target computed from
 * scratch. The target is always either `volume` or `volume * duckLevel`, and
 * nothing in this class ever remembers a reduced loudness, so no sequence of
 * ducks, cuts and restores can multiply the attenuation. Treating gain as a
 * stateful multiplier is what turns "I interrupted a few times" into "the voice
 * stays tiny".
 */

export type VolumeEvent = 'apply' | 'duck' | 'restore' | 'cut' | 'begin' | 'override'

/** One gain sample. Numbers and enum names only: no transcript, no audio. */
export interface VolumeSample {
  at: number
  event: VolumeEvent
  ducked: boolean
  target: number
  actual: number
  volumeOverride: number | null
  prefsVolume: number
  duckLevel: number
  suppressed: boolean
}

/** The subset of AudioParam this file needs; a fake is enough for tests. */
export interface GainParamLike {
  value: number
  cancelScheduledValues(time: number): void
  setValueAtTime(value: number, time: number): void
  linearRampToValueAtTime(value: number, time: number): void
}

/** The subset of BaseAudioContext this file needs. */
export interface GainContextLike {
  readonly currentTime: number
}

/** Short ramp so a change never clicks, but always lands exactly on target. */
export const GAIN_RAMP_SECONDS = 0.06
/** Fade used by an organizer-driven cut. */
export const CUT_FADE_SECONDS = 0.25
/** Longest a barge-in duck may last, even if the end of speech never arrives. */
export const DUCK_MAX_MS = 2500
/** After a cut, speech must not duck again immediately: that stacks. */
export const CUT_SUPPRESS_MS = 2500
/** The fade must never outlive the cut, even if nobody calls endCut(). */
export const CUT_RESTORE_MS = CUT_FADE_SECONDS * 1000 + 40

const clamp01 = (value: number): number => (Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0)

export interface VolumeRigOptions {
  /** Live audio context; undefined before the first playback. */
  context(): GainContextLike | undefined
  /** Live gain param; undefined before the first playback. */
  param(): GainParamLike | undefined
  /** Preference loudness, 0..1. */
  volume(): number
  /** Preference duck multiplier, 0..1. */
  duckLevel(): number
  now?(): number
  setTimer?(run: () => void, ms: number): unknown
  clearTimer?(handle: unknown): void
  sink?(sample: VolumeSample): void
}

export class VolumeRig {
  private readonly options: VolumeRigOptions
  private readonly now: () => number
  private readonly setTimer: (run: () => void, ms: number) => unknown
  private readonly clearTimer: (handle: unknown) => void
  private ducked = false
  private suppressUntil = 0
  private overrideLevel: number | undefined
  private duckTimer: unknown
  private cutTimer: unknown

  constructor(options: VolumeRigOptions) {
    this.options = options
    this.now = options.now ?? (() => Date.now())
    this.setTimer = options.setTimer ?? ((run, ms) => setTimeout(run, ms))
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))
  }

  /** Loudness before ducking: an explicit command wins over the slider. */
  volume(): number {
    return clamp01(this.overrideLevel ?? this.options.volume())
  }

  /** 1 while silent, duckLevel while the owner speaks. */
  duckMultiplier(): number {
    return this.ducked ? clamp01(this.options.duckLevel()) : 1
  }

  /** The only value allowed to reach the gain node. */
  target(): number {
    return clamp01(this.volume() * this.duckMultiplier())
  }

  isDucked(): boolean {
    return this.ducked
  }

  isSuppressed(): boolean {
    return this.now() < this.suppressUntil
  }

  chosenLevel(): number | undefined {
    return this.overrideLevel
  }

  /** What the listener actually hears, read back from the node. */
  actual(): number {
    const param = this.options.param()
    return param ? param.value : 0
  }

  /** Cancel what is scheduled, pin the live value, move once to the target. */
  apply(event: VolumeEvent = 'apply'): VolumeSample {
    const param = this.options.param()
    const context = this.options.context()
    const target = this.target()
    if (param && context) {
      const time = context.currentTime
      try {
        // A fade to zero left over from an interruption dies here; without this
        // the ramp stays the last scheduled event and holds the gain at 0.
        param.cancelScheduledValues(time)
        param.setValueAtTime(param.value, time)
        param.linearRampToValueAtTime(target, time + GAIN_RAMP_SECONDS)
      } catch {
        // A closed context must never break playback.
      }
    }
    return this.emit(event, false)
  }

  duck(): VolumeSample {
    if (this.isSuppressed()) {
      // Still inside the post-cut window: ducking now would stack on the fade.
      return this.emit('duck', true)
    }
    this.ducked = true
    const sample = this.apply('duck')
    this.clearDuckTimer()
    this.duckTimer = this.setTimer(() => {
      this.duckTimer = undefined
      if (this.ducked) this.restore()
    }, DUCK_MAX_MS)
    return sample
  }

  restore(): VolumeSample {
    this.clearDuckTimer()
    this.ducked = false
    return this.apply('restore')
  }

  /** Organizer cut: fade the sentence out, then forbid ducking for a while. */
  cutFade(): VolumeSample {
    this.clearDuckTimer()
    this.ducked = false
    this.suppressUntil = this.now() + CUT_SUPPRESS_MS
    const param = this.options.param()
    const context = this.options.context()
    if (param && context) {
      const time = context.currentTime
      try {
        param.cancelScheduledValues(time)
        param.setValueAtTime(param.value, time)
        param.linearRampToValueAtTime(0, time + CUT_FADE_SECONDS)
      } catch {
        // A closed context must not block the cut.
      }
    }
    const sample = this.emit('cut', false)
    this.clearCutTimer()
    this.cutTimer = this.setTimer(() => {
      this.cutTimer = undefined
      this.endCut()
    }, CUT_RESTORE_MS)
    return sample
  }

  /** The cut is over: full volume, explicitly, whatever state it was in. */
  endCut(): VolumeSample {
    this.clearCutTimer()
    this.ducked = false
    return this.apply('restore')
  }

  /** A new listening session must not open already quiet. */
  beginSession(): VolumeSample {
    this.clearDuckTimer()
    this.clearCutTimer()
    this.ducked = false
    this.suppressUntil = 0
    return this.apply('begin')
  }

  /** Absolute loudness from a voice_dialog command, or a relative step. */
  setOverride(value: number): VolumeSample {
    this.overrideLevel = clamp01(value)
    return this.apply('override')
  }

  adjust(delta: number): VolumeSample {
    return this.setOverride(this.volume() + delta)
  }

  clearOverride(): VolumeSample {
    this.overrideLevel = undefined
    return this.apply('override')
  }

  private clearDuckTimer(): void {
    if (this.duckTimer === undefined) return
    const handle = this.duckTimer
    this.duckTimer = undefined
    this.clearTimer(handle)
  }

  private clearCutTimer(): void {
    if (this.cutTimer === undefined) return
    const handle = this.cutTimer
    this.cutTimer = undefined
    this.clearTimer(handle)
  }

  private emit(event: VolumeEvent, suppressed: boolean): VolumeSample {
    const sample: VolumeSample = {
      at: this.now(),
      event,
      ducked: this.ducked,
      target: this.target(),
      actual: this.actual(),
      volumeOverride: this.overrideLevel ?? null,
      prefsVolume: clamp01(this.options.volume()),
      duckLevel: clamp01(this.options.duckLevel()),
      suppressed,
    }
    const sink = this.options.sink
    if (sink) {
      try { sink(sample) } catch { /* telemetry must never break playback */ }
    }
    return sample
  }
}
