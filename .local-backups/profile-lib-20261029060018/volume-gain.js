const GAIN_RAMP_SECONDS = 0.06;
const CUT_FADE_SECONDS = 0.25;
const DUCK_MAX_MS = 2500;
const CUT_SUPPRESS_MS = 2500;
const CUT_RESTORE_MS = CUT_FADE_SECONDS * 1e3 + 40;
const clamp01 = (value) => Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
class VolumeRig {
  options;
  now;
  setTimer;
  clearTimer;
  ducked = false;
  suppressUntil = 0;
  overrideLevel;
  duckTimer;
  cutTimer;
  constructor(options) {
    this.options = options;
    this.now = options.now ?? (() => Date.now());
    this.setTimer = options.setTimer ?? ((run, ms) => setTimeout(run, ms));
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle));
  }
  /** Loudness before ducking: an explicit command wins over the slider. */
  volume() {
    return clamp01(this.overrideLevel ?? this.options.volume());
  }
  /** 1 while silent, duckLevel while the owner speaks. */
  duckMultiplier() {
    return this.ducked ? clamp01(this.options.duckLevel()) : 1;
  }
  /** The only value allowed to reach the gain node. */
  target() {
    return clamp01(this.volume() * this.duckMultiplier());
  }
  isDucked() {
    return this.ducked;
  }
  isSuppressed() {
    return this.now() < this.suppressUntil;
  }
  chosenLevel() {
    return this.overrideLevel;
  }
  /** What the listener actually hears, read back from the node. */
  actual() {
    const param = this.options.param();
    return param ? param.value : 0;
  }
  /** Cancel what is scheduled, pin the live value, move once to the target. */
  apply(event = "apply") {
    const param = this.options.param();
    const context = this.options.context();
    const target = this.target();
    if (param && context) {
      const time = context.currentTime;
      try {
        param.cancelScheduledValues(time);
        param.setValueAtTime(param.value, time);
        param.linearRampToValueAtTime(target, time + GAIN_RAMP_SECONDS);
      } catch {
      }
    }
    return this.emit(event, false);
  }
  duck() {
    if (this.isSuppressed()) {
      return this.emit("duck", true);
    }
    this.ducked = true;
    const sample = this.apply("duck");
    this.clearDuckTimer();
    this.duckTimer = this.setTimer(() => {
      this.duckTimer = void 0;
      if (this.ducked) this.restore();
    }, DUCK_MAX_MS);
    return sample;
  }
  restore() {
    this.clearDuckTimer();
    this.ducked = false;
    return this.apply("restore");
  }
  /** Organizer cut: fade the sentence out, then forbid ducking for a while. */
  cutFade() {
    this.clearDuckTimer();
    this.ducked = false;
    this.suppressUntil = this.now() + CUT_SUPPRESS_MS;
    const param = this.options.param();
    const context = this.options.context();
    if (param && context) {
      const time = context.currentTime;
      try {
        param.cancelScheduledValues(time);
        param.setValueAtTime(param.value, time);
        param.linearRampToValueAtTime(0, time + CUT_FADE_SECONDS);
      } catch {
      }
    }
    const sample = this.emit("cut", false);
    this.clearCutTimer();
    this.cutTimer = this.setTimer(() => {
      this.cutTimer = void 0;
      this.endCut();
    }, CUT_RESTORE_MS);
    return sample;
  }
  /** The cut is over: full volume, explicitly, whatever state it was in. */
  endCut() {
    this.clearCutTimer();
    this.ducked = false;
    return this.apply("restore");
  }
  /** A new listening session must not open already quiet. */
  beginSession() {
    this.clearDuckTimer();
    this.clearCutTimer();
    this.ducked = false;
    this.suppressUntil = 0;
    return this.apply("begin");
  }
  /** Absolute loudness from a voice_dialog command, or a relative step. */
  setOverride(value) {
    this.overrideLevel = clamp01(value);
    return this.apply("override");
  }
  adjust(delta) {
    return this.setOverride(this.volume() + delta);
  }
  clearOverride() {
    this.overrideLevel = void 0;
    return this.apply("override");
  }
  clearDuckTimer() {
    if (this.duckTimer === void 0) return;
    const handle = this.duckTimer;
    this.duckTimer = void 0;
    this.clearTimer(handle);
  }
  clearCutTimer() {
    if (this.cutTimer === void 0) return;
    const handle = this.cutTimer;
    this.cutTimer = void 0;
    this.clearTimer(handle);
  }
  emit(event, suppressed) {
    const sample = {
      at: this.now(),
      event,
      ducked: this.ducked,
      target: this.target(),
      actual: this.actual(),
      volumeOverride: this.overrideLevel ?? null,
      prefsVolume: clamp01(this.options.volume()),
      duckLevel: clamp01(this.options.duckLevel()),
      suppressed
    };
    const sink = this.options.sink;
    if (sink) {
      try {
        sink(sample);
      } catch {
      }
    }
    return sample;
  }
}
export {
  CUT_FADE_SECONDS,
  CUT_RESTORE_MS,
  CUT_SUPPRESS_MS,
  DUCK_MAX_MS,
  GAIN_RAMP_SECONDS,
  VolumeRig
};
