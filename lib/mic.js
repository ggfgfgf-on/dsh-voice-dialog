// src/barge-in.ts
var PLAYBACK_ECHO_GUARD_MS = 300;
var PLAYBACK_MIN_VOICED_MS = 400;
var PLAYBACK_FALLBACK_CUT_MS = 1e3;
function decideSpeechOnset(input) {
  if (!input.playing) {
    return { action: "report", reason: "idle", selfEcho: false };
  }
  const since = typeof input.playbackStartedAt === "number" && Number.isFinite(input.playbackStartedAt) ? input.onsetAt - input.playbackStartedAt : void 0;
  if (since !== void 0 && since >= 0 && since < PLAYBACK_ECHO_GUARD_MS) {
    return {
      action: "ignore",
      reason: "playback-echo-guard",
      sincePlaybackMs: since,
      selfEcho: true
    };
  }
  if (!(input.voicedMs >= PLAYBACK_MIN_VOICED_MS)) {
    return {
      action: "ignore",
      reason: "playback-min-sustained",
      ...since === void 0 ? {} : { sincePlaybackMs: since },
      selfEcho: false
    };
  }
  if (typeof input.rms === "number" && typeof input.threshold === "number" && (!Number.isFinite(input.rms) || input.rms < input.threshold)) {
    return {
      action: "ignore",
      reason: "playback-echo-threshold",
      ...since === void 0 ? {} : { sincePlaybackMs: since },
      selfEcho: false
    };
  }
  return {
    action: "report",
    reason: "playback-sustained-onset",
    ...since === void 0 ? {} : { sincePlaybackMs: since },
    selfEcho: false
  };
}
function shouldFallbackCut(input) {
  const limit = typeof input.fallbackMs === "number" && Number.isFinite(input.fallbackMs) ? Math.max(PLAYBACK_MIN_VOICED_MS, input.fallbackMs) : PLAYBACK_FALLBACK_CUT_MS;
  return input.playing === true && input.reported === true && input.hostResponded !== true && input.alreadyCut !== true && input.voicedMs >= limit;
}

// src/partial-asr.ts
var PARTIAL_WINDOW_MS = 1e4;
var PARTIAL_MIN_SPEECH_MS = 300;
function clampPartialMs(value) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? Math.min(2e3, Math.max(0, Math.round(number))) : 0;
}
function trimPartialWindow(chunks, sampleRate, windowMs = PARTIAL_WINDOW_MS) {
  if (chunks.length === 0) return [];
  const rate = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 16e3;
  const budget = Math.floor(rate * Math.max(0, windowMs) / 1e3);
  if (budget <= 0) return [];
  const out = [];
  let total = 0;
  for (let index = chunks.length - 1; index >= 0; index -= 1) {
    const chunk = chunks[index];
    if (!chunk) continue;
    out.unshift(chunk);
    total += chunk.length;
    if (total >= budget) break;
  }
  return out;
}

// src/mic.ts
var TARGET_RATE = 16e3;
var BUFFER_SIZE = 1024;
var TAIL_HINT_MS = 250;
var NOISE_FLOOR_WINDOW_MS = 2500;
var NOISE_FLOOR_PERCENTILE = 0.2;
var INITIAL_NOISE_FLOOR = 0.012;
var ONSET_NOISE_FACTOR = 3;
var MIN_ONSET_RMS = 4e-3;
var MAX_ONSET_RMS = 0.05;
var HOLD_THRESHOLD_RATIO = 0.65;
var MIN_MANUAL_THRESHOLD = 5e-3;
var MAX_MANUAL_THRESHOLD = 0.08;
function clampManualThreshold(value) {
  const threshold = Number(value);
  if (!Number.isFinite(threshold)) return void 0;
  return Math.min(MAX_MANUAL_THRESHOLD, Math.max(MIN_MANUAL_THRESHOLD, threshold));
}
var AdaptiveNoiseFloor = class {
  window = [];
  capacity = 0;
  windowMs;
  percentile;
  constructor(windowMs = NOISE_FLOOR_WINDOW_MS, percentile = NOISE_FLOOR_PERCENTILE) {
    this.windowMs = Math.max(1, windowMs);
    this.percentile = Math.min(0.5, Math.max(0, percentile));
  }
  /** Add one non-speech frame and return the updated floor. */
  push(rms, chunkMs) {
    if (!Number.isFinite(rms) || rms < 0 || !(chunkMs > 0)) return this.value;
    const capacity = Math.max(1, Math.ceil(this.windowMs / chunkMs));
    if (capacity !== this.capacity) {
      this.capacity = capacity;
      if (this.window.length > capacity) this.window.splice(0, this.window.length - capacity);
    }
    this.window.push(rms);
    if (this.window.length > capacity) this.window.shift();
    return this.value;
  }
  get value() {
    if (this.window.length === 0) return INITIAL_NOISE_FLOOR;
    const sorted = [...this.window].sort((a, b) => a - b);
    return sorted[Math.floor((sorted.length - 1) * this.percentile)];
  }
};
var DEFAULT_PLAYBACK_LEVEL = 0.65;
var ECHO_FLOOR_MIN_RMS = 8e-3;
var ECHO_FLOOR_GAIN_RMS = 0.052;
function resolveMicThresholds(noiseFloor, manualThreshold, playback) {
  let onset = manualThreshold === void 0 ? Math.min(MAX_ONSET_RMS, Math.max(MIN_ONSET_RMS, noiseFloor * ONSET_NOISE_FACTOR)) : manualThreshold;
  if (playback?.playing) {
    const raw = typeof playback.level === "number" && Number.isFinite(playback.level) ? playback.level : DEFAULT_PLAYBACK_LEVEL;
    const level = Math.min(1, Math.max(0, raw));
    const echoFloor = ECHO_FLOOR_MIN_RMS + level * ECHO_FLOOR_GAIN_RMS;
    onset = Math.max(onset, echoFloor);
  }
  return { onset, hold: onset * HOLD_THRESHOLD_RATIO };
}
function endpointReached(state) {
  if (!(state.speechMs >= state.minSpeechMs)) return false;
  if (state.totalMs >= state.maxSegmentMs) return true;
  const required = state.silenceMs > 0 ? state.silenceMs : 1;
  return state.silence >= required;
}
function flatten(chunks) {
  const length = chunks.reduce((n, chunk) => n + chunk.length, 0);
  const out = new Float32Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
function resample(samples, from, to) {
  if (from === to) return samples;
  const ratio = from / to;
  const out = new Float32Array(Math.max(1, Math.round(samples.length / ratio)));
  for (let i = 0; i < out.length; i++) {
    const position = i * ratio;
    const left = Math.floor(position);
    const right = Math.min(samples.length - 1, left + 1);
    const frac = position - left;
    out[i] = samples[left] * (1 - frac) + samples[right] * frac;
  }
  return out;
}
var MicrophoneLoop = class {
  context;
  stream;
  source;
  processor;
  sink;
  active = false;
  options;
  constructor(options = {}) {
    const manualThreshold = options.threshold === void 0 ? void 0 : clampManualThreshold(options.threshold);
    this.options = {
      ...options,
      preRollMs: options.preRollMs ?? 320,
      silenceMs: options.silenceMs ?? 1400,
      minSpeechMs: options.minSpeechMs ?? 260,
      maxSegmentMs: options.maxSegmentMs ?? 25e3,
      threshold: manualThreshold,
      deviceId: options.deviceId ?? ""
    };
  }
  /** Acquire the microphone and start emitting segments. */
  async start() {
    if (this.active) return;
    const devices = navigator.mediaDevices;
    if (!devices) throw new Error("\u5F53\u524D\u9875\u9762\u4E0D\u662F\u5B89\u5168\u4E0A\u4E0B\u6587\uFF0C\u6D4F\u89C8\u5668\u4E0D\u63D0\u4F9B\u9EA6\u514B\u98CE API\uFF1B\u8BF7\u4F7F\u7528 HTTPS \u6216 localhost\u3002");
    this.stream = await devices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
        ...this.options.deviceId ? { deviceId: { exact: this.options.deviceId } } : {}
      },
      video: false
    });
    const Ctor = window.AudioContext;
    this.context = new Ctor();
    await this.context.resume();
    this.active = true;
    this.source = this.context.createMediaStreamSource(this.stream);
    this.processor = this.context.createScriptProcessor(BUFFER_SIZE, 1, 1);
    this.sink = this.context.createGain();
    this.sink.gain.value = 0;
    this.source.connect(this.processor);
    this.processor.connect(this.sink);
    this.sink.connect(this.context.destination);
    this.attach();
  }
  /** Stop capture and release every browser resource. */
  async stop() {
    this.active = false;
    this.processor?.disconnect();
    this.source?.disconnect();
    this.sink?.disconnect();
    this.stream?.getTracks().forEach((track) => {
      track.stop();
    });
    this.stream = void 0;
    this.processor = void 0;
    this.source = void 0;
    this.sink = void 0;
    const context = this.context;
    this.context = void 0;
    if (context && context.state !== "closed") await context.close().catch(() => void 0);
  }
  /**
   * Apply recognition settings changed while the microphone is open. A finite
   * threshold switches this instance to manual onset control; omitting the
   * field leaves the current mode (adaptive or manual) unchanged.
   */
  tune(patch) {
    if (patch.silenceMs !== void 0) {
      const ms = Number(patch.silenceMs);
      if (Number.isFinite(ms)) this.options.silenceMs = Math.min(4e3, Math.max(0, Math.round(ms)));
    }
    if (patch.partialMs !== void 0) {
      this.options.partialMs = clampPartialMs(patch.partialMs);
    }
    if (patch.threshold !== void 0) {
      if (patch.threshold === null || Number(patch.threshold) === 0) {
        this.options.threshold = void 0;
      } else {
        const threshold = clampManualThreshold(patch.threshold);
        if (threshold !== void 0) this.options.threshold = threshold;
      }
    }
  }
  attach() {
    const processor = this.processor;
    const context = this.context;
    if (!processor || !context) return;
    const chunkMs = processor.bufferSize / context.sampleRate * 1e3;
    const preRollLimit = Math.max(1, Math.ceil(this.options.preRollMs / chunkMs));
    let preRoll = [];
    let segment = [];
    let speaking = false;
    let silence = 0;
    let speech = 0;
    let totalMs = 0;
    let announced = false;
    let tailAnnounced = false;
    let voiceStartedAt = 0;
    let voicedRun = 0;
    let echoBlocked = false;
    let fallbackCutSent = false;
    let lastPartialAt = 0;
    const noiseFloor = new AdaptiveNoiseFloor();
    const reset = () => {
      preRoll = [];
      segment = [];
      speaking = false;
      silence = 0;
      speech = 0;
      totalMs = 0;
      announced = false;
      tailAnnounced = false;
      voiceStartedAt = 0;
      voicedRun = 0;
      echoBlocked = false;
      fallbackCutSent = false;
      lastPartialAt = 0;
    };
    const playbackNow = () => this.options.playbackState?.() ?? { playing: false };
    const onset = () => ({
      startedAt: voiceStartedAt,
      voicedMs: voicedRun,
      reportedAt: Date.now()
    });
    const announce = (rms, threshold) => {
      if (announced || echoBlocked) return;
      const playback = playbackNow();
      if (playback.playing) {
        const decision = decideSpeechOnset({
          playing: true,
          playbackStartedAt: playback.startedAt,
          onsetAt: voiceStartedAt,
          voicedMs: voicedRun,
          rms,
          threshold
        });
        if (decision.action !== "report") {
          if (decision.selfEcho) echoBlocked = true;
          return;
        }
      } else if (speech < this.options.minSpeechMs) return;
      announced = true;
      try {
        this.options.onSpeechStart?.(onset());
      } catch (error) {
        this.options.onError?.(error);
      }
    };
    const fallbackCut = () => {
      if (!announced || echoBlocked || fallbackCutSent) return;
      const playback = playbackNow();
      if (!playback.playing) return;
      if (!shouldFallbackCut({
        playing: true,
        reported: true,
        hostResponded: playback.hostResponded,
        voicedMs: voicedRun,
        alreadyCut: fallbackCutSent
      })) return;
      fallbackCutSent = true;
      try {
        this.options.onPlaybackStuck?.(onset());
      } catch (error) {
        this.options.onError?.(error);
      }
    };
    const finalize = () => {
      const captured = flatten(segment);
      const seconds = captured.length / context.sampleRate;
      const enough = speech >= this.options.minSpeechMs;
      const wasAnnounced = announced;
      const swallowed = echoBlocked;
      reset();
      if (swallowed) return;
      if (wasAnnounced) {
        try {
          this.options.onSpeechEnd?.();
        } catch (error) {
          this.options.onError?.(error);
        }
      }
      if (!enough || captured.length === 0) return;
      const samples = resample(captured, context.sampleRate, TARGET_RATE);
      try {
        this.options.onSegment?.(samples, seconds);
      } catch (error) {
        this.options.onError?.(error);
      }
    };
    const emitPartial = () => {
      const interval = this.options.partialMs ?? 0;
      const sink = this.options.onPartial;
      if (!(interval > 0) || !sink) return;
      if (!announced || echoBlocked) return;
      if (speech < Math.max(this.options.minSpeechMs, PARTIAL_MIN_SPEECH_MS)) return;
      const now = Date.now();
      const since = lastPartialAt > 0 ? now - lastPartialAt : now - voiceStartedAt;
      if (since < interval) return;
      const recent = trimPartialWindow(segment, context.sampleRate, this.options.partialWindowMs ?? PARTIAL_WINDOW_MS);
      if (recent.length === 0) return;
      lastPartialAt = now;
      const samples = resample(flatten(recent), context.sampleRate, TARGET_RATE);
      try {
        sink(samples, { seconds: samples.length / TARGET_RATE, speechMs: speech, at: now });
      } catch (error) {
        this.options.onError?.(error);
      }
    };
    processor.onaudioprocess = (event) => {
      if (!this.active) return;
      const input = event.inputBuffer.getChannelData(0);
      const copy = new Float32Array(input.length);
      copy.set(input);
      let sum = 0;
      for (const sample of copy) sum += sample * sample;
      const rms = Math.sqrt(sum / copy.length);
      this.options.onLevel?.(Math.min(1, rms / 0.25));
      if (this.options.onFrame) {
        try {
          this.options.onFrame(resample(copy, context.sampleRate, TARGET_RATE));
        } catch (error) {
          this.options.onError?.(error);
        }
      }
      const manualThreshold = this.options.threshold;
      if (!speaking && manualThreshold === void 0) noiseFloor.push(rms, chunkMs);
      const playback = playbackNow();
      const thresholds = resolveMicThresholds(noiseFloor.value, manualThreshold, playback);
      const openUtterance = () => {
        speaking = true;
        voiceStartedAt = Date.now();
        voicedRun = chunkMs;
        const probe = playback.playing ? decideSpeechOnset({
          playing: true,
          playbackStartedAt: playback.startedAt,
          onsetAt: voiceStartedAt,
          voicedMs: 0
        }) : void 0;
        echoBlocked = probe?.selfEcho === true;
      };
      if (this.options.continuous) {
        if (!speaking) {
          if (rms < thresholds.onset) return;
          openUtterance();
          speech = chunkMs;
          silence = 0;
          totalMs = chunkMs;
          segment = [copy];
          announce(rms, thresholds.onset);
          return;
        }
        segment.push(copy);
        totalMs += chunkMs;
        if (rms >= thresholds.hold) {
          speech += chunkMs;
          voicedRun += chunkMs;
          silence = 0;
          tailAnnounced = false;
          announce(rms, thresholds.onset);
          fallbackCut();
        } else {
          voicedRun = 0;
          silence += chunkMs;
          if (!tailAnnounced && silence >= TAIL_HINT_MS) {
            tailAnnounced = true;
            try {
              this.options.onSpeechTail?.();
            } catch (error) {
              this.options.onError?.(error);
            }
          }
        }
        emitPartial();
        if (endpointReached({
          totalMs,
          maxSegmentMs: this.options.maxSegmentMs,
          silenceMs: this.options.silenceMs,
          silence,
          speechMs: speech,
          minSpeechMs: this.options.minSpeechMs
        })) finalize();
        return;
      }
      if (!speaking) {
        preRoll.push(copy);
        if (preRoll.length > preRollLimit) preRoll.shift();
        if (rms < thresholds.onset) return;
        openUtterance();
        segment = [...preRoll, copy];
        speech = chunkMs;
        silence = 0;
        totalMs = segment.reduce((n, c) => n + c.length, 0) / context.sampleRate * 1e3;
        return;
      }
      segment.push(copy);
      totalMs += chunkMs;
      if (rms >= thresholds.hold) {
        speech += chunkMs;
        voicedRun += chunkMs;
        silence = 0;
        announce(rms, thresholds.onset);
        fallbackCut();
      } else {
        voicedRun = 0;
        silence += chunkMs;
      }
      emitPartial();
      if (endpointReached({
        totalMs,
        maxSegmentMs: this.options.maxSegmentMs,
        silenceMs: this.options.silenceMs,
        silence,
        speechMs: speech,
        minSpeechMs: this.options.minSpeechMs
      })) finalize();
    };
  }
};
async function recordVoiceSample(options = {}) {
  if (options.signal?.aborted) throw new Error("\u5F55\u97F3\u5DF2\u53D6\u6D88");
  const seconds = Math.min(15, Math.max(1, options.seconds ?? 6.5));
  const devices = navigator.mediaDevices;
  if (!devices) throw new Error("\u5F53\u524D\u9875\u9762\u4E0D\u662F\u5B89\u5168\u4E0A\u4E0B\u6587\uFF0C\u6D4F\u89C8\u5668\u4E0D\u63D0\u4F9B\u9EA6\u514B\u98CE API\uFF1B\u8BF7\u4F7F\u7528 HTTPS \u6216 localhost\u3002");
  const stream = await devices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
      ...options.deviceId ? { deviceId: { exact: options.deviceId } } : {}
    },
    video: false
  });
  let context;
  try {
    const Ctor = window.AudioContext;
    context = new Ctor();
    await context.resume();
  } catch (error) {
    stream.getTracks().forEach((track) => {
      track.stop();
    });
    throw error;
  }
  const source = context.createMediaStreamSource(stream);
  const processor = context.createScriptProcessor(BUFFER_SIZE, 1, 1);
  const sink = context.createGain();
  sink.gain.value = 0;
  const chunks = [];
  let peak = 0;
  let done = false;
  let timer;
  return await new Promise((resolve, reject) => {
    const cleanup = async (error) => {
      if (done) return;
      done = true;
      if (timer !== void 0) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      processor.onaudioprocess = null;
      try {
        processor.disconnect();
        source.disconnect();
        sink.disconnect();
      } catch {
      }
      stream.getTracks().forEach((track) => {
        track.stop();
      });
      const captured = flatten(chunks);
      const samples = resample(captured, context.sampleRate, TARGET_RATE);
      if (context.state !== "closed") await context.close().catch(() => void 0);
      if (error) {
        reject(error);
        return;
      }
      if (peak < 8e-3) {
        reject(new Error("\u6CA1\u6709\u542C\u5230\u58F0\u97F3\uFF0C\u8BF7\u9760\u8FD1\u9EA6\u514B\u98CE\u518D\u8BD5"));
        return;
      }
      if (samples.length / TARGET_RATE < 1) {
        reject(new Error("\u5F55\u97F3\u592A\u77ED\uFF0C\u8BF7\u8BF4\u6EE1\u4E24\u79D2\u518D\u8BD5"));
        return;
      }
      resolve(samples);
    };
    const onAbort = () => {
      void cleanup(new Error("\u5F55\u97F3\u5DF2\u53D6\u6D88"));
    };
    timer = setTimeout(() => {
      void cleanup();
    }, seconds * 1e3);
    options.signal?.addEventListener("abort", onAbort);
    processor.onaudioprocess = (event) => {
      if (done) return;
      const input = event.inputBuffer.getChannelData(0);
      const copy = new Float32Array(input.length);
      copy.set(input);
      chunks.push(copy);
      let sum = 0;
      for (const sample of copy) sum += sample * sample;
      const rms = Math.sqrt(sum / copy.length);
      if (rms > peak) peak = rms;
      options.onLevel?.(Math.min(1, rms / 0.25));
    };
    source.connect(processor);
    processor.connect(sink);
    sink.connect(context.destination);
  });
}
export {
  AdaptiveNoiseFloor,
  MicrophoneLoop,
  endpointReached,
  recordVoiceSample,
  resolveMicThresholds
};
