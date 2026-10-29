// src/separation-align.ts
var SEPARATION_SAMPLE_RATE = 16e3;
var SEPARATION_WINDOW = SEPARATION_SAMPLE_RATE * 4;
var SEPARATION_HOP = SEPARATION_SAMPLE_RATE * 3.5;
var SEPARATION_FADE = SEPARATION_SAMPLE_RATE * 0.5;
function zeroMeanCorrelation(a, b, offset = 0) {
  const length = Math.min(a.length, b.length - offset);
  if (length < 32) return 0;
  let meanA = 0;
  let meanB = 0;
  for (let i = 0; i < length; i++) {
    meanA += a[i];
    meanB += b[offset + i];
  }
  meanA /= length;
  meanB /= length;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < length; i++) {
    const x = a[i] - meanA;
    const y = b[offset + i] - meanB;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  const denominator = Math.sqrt(normA * normB);
  return denominator > 1e-9 ? dot / denominator : 0;
}

// src/continuous-separation.ts
function flatten(chunks) {
  const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Float32Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
function concat(a, b) {
  const out = new Float32Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
function rmsOf(samples) {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / Math.max(1, samples.length));
}
function makeLane(threshold) {
  return {
    preRoll: [],
    preRollLength: 0,
    buffer: [],
    length: 0,
    active: false,
    speech: 0,
    silence: 0,
    lastSpeech: 0,
    startAbs: 0,
    threshold
  };
}
function resetLane(lane) {
  lane.preRoll = [];
  lane.preRollLength = 0;
  lane.buffer = [];
  lane.length = 0;
  lane.active = false;
  lane.speech = 0;
  lane.silence = 0;
  lane.lastSpeech = 0;
  lane.startAbs = 0;
}
function dedupeTranscript(previous, next) {
  const before = previous.trim();
  const after = next.trim();
  if (!before || !after) return after;
  if (after === before) return "";
  if (after.startsWith(before)) return after.slice(before.length).trim();
  const max = Math.min(before.length, after.length);
  for (let size = max; size >= 6; size--) {
    if (before.endsWith(after.slice(0, size))) return after.slice(size).trim();
  }
  return after;
}
var ContinuousSeparation = class {
  sampleRate;
  windowSamples;
  hopSamples;
  silenceSamples;
  minSpeechSamples;
  maxSegmentSamples;
  preRollSamples;
  tailSamples;
  floorThreshold;
  subChunk;
  separate;
  onSegment;
  onError;
  lanes;
  buffer = new Float32Array(0);
  received = 0;
  lastActivitySample = 0;
  coveredUntil = 0;
  processing = null;
  pending = false;
  stopped = false;
  previous;
  ready = [];
  /**
   * Speculative separation of the window that is about to close. Filled while
   * the speaker is still finishing the sentence, so the 374 ms inference is
   * not paid again after the VAD decides the utterance ended.
   */
  prewarmJob = null;
  prewarmPromise = null;
  prewarmToken = 0;
  /**
   * Backpressure state. A separation window that costs more than one hop means
   * the model cannot keep up with real time; queueing the next window anyway
   * makes the backlog grow with every sentence the person speaks, which is the
   * "it gets slower the longer I use it" report. Skipping every other window
   * keeps a bounded, non-growing delay.
   */
  hopBudgetMs;
  flushBudgetMs;
  skipWhileBehind;
  lastWindowMs = 0;
  lastModelMs = 0;
  flushDeadline = 0;
  flushMs = 0;
  flushTruncated = false;
  skippedWindows = 0;
  allowModelOnce = false;
  windowSkipped = false;
  /** Set while flush() closes the tail without the model, so no word is lost. */
  forceMixed = false;
  prewarmStats = { started: 0, reused: 0, discarded: 0, missed: 0 };
  lastWindowReused = false;
  lastWindowDiagnostics;
  /** Mixed-stream ring buffer, for the single-speaker speculative ASR. */
  mixedTail = new Float32Array(0);
  utteranceSeq = 0;
  constructor(options) {
    this.sampleRate = Math.max(1e3, Math.floor(options.sampleRate ?? 16e3));
    const windowMs = Math.max(250, options.windowMs ?? 4e3);
    const hopMs = Math.max(100, Math.min(windowMs, options.hopMs ?? 1e3));
    this.windowSamples = Math.round(this.sampleRate * windowMs / 1e3);
    this.hopSamples = Math.round(this.sampleRate * hopMs / 1e3);
    this.silenceSamples = Math.round(this.sampleRate * Math.max(100, options.silenceMs ?? 1600) / 1e3);
    this.hopBudgetMs = Math.max(40, options.hopBudgetMs ?? hopMs);
    this.flushBudgetMs = Math.max(200, options.flushBudgetMs ?? 1200);
    this.skipWhileBehind = options.skipWhileBehind !== false;
    this.minSpeechSamples = Math.round(this.sampleRate * Math.max(50, options.minSpeechMs ?? 260) / 1e3);
    this.maxSegmentSamples = Math.round(this.sampleRate * Math.max(windowMs, options.maxSegmentMs ?? 2e4) / 1e3);
    this.preRollSamples = Math.round(this.sampleRate * 0.32);
    this.tailSamples = Math.round(this.sampleRate * 0.24);
    this.floorThreshold = Math.max(1e-3, options.threshold ?? 8e-3);
    this.subChunk = Math.max(32, Math.round(this.sampleRate * 0.1));
    this.separate = options.separate;
    this.onSegment = options.onSegment;
    this.onError = options.onError ?? (() => void 0);
    this.lanes = [makeLane(this.floorThreshold), makeLane(this.floorThreshold)];
  }
  /** Feed one 16 kHz chunk. Chunks may be any length. */
  push(chunk) {
    if (this.stopped || chunk.length === 0) return;
    this.buffer = concat(this.buffer, chunk);
    const keep = this.windowSamples * 4;
    if (this.buffer.length > keep) this.buffer = this.buffer.slice(this.buffer.length - keep);
    this.received += chunk.length;
    if (rmsOf(chunk) >= this.floorThreshold) {
      this.lastActivitySample = this.received;
      if (this.prewarmJob) {
        if (!this.prewarmJob.failed) {
          this.prewarmStats.discarded += 1;
          this.prewarmStats.missed += 1;
        }
        this.prewarmJob = null;
        this.prewarmToken += 1;
      }
    }
    this.mixedTail = this.mixedTail.length === 0 ? new Float32Array(chunk) : concat(this.mixedTail, chunk);
    if (this.mixedTail.length > this.windowSamples) {
      this.mixedTail = this.mixedTail.slice(this.mixedTail.length - this.windowSamples);
    }
    this.maybeProcess();
  }
  /**
   * Speculatively separate the window that would be used if the utterance
   * closed right now. Safe to call repeatedly from the microphone's tail-timer
   * callback: one inference at a time, reused at most once.
   */
  prewarm() {
    if (this.stopped || this.prewarmPromise) return;
    if (this.isLagging()) return;
    if (!this.lanes.some((lane) => lane.active)) return;
    if (!this.hasWindow(true)) return;
    const bufferStart = this.received - this.buffer.length;
    let windowStart = this.previous ? this.previous.start + this.hopSamples : bufferStart;
    if (windowStart < bufferStart) windowStart = bufferStart;
    const available = Math.min(this.windowSamples, this.received - windowStart);
    if (available <= 0) return;
    if (this.prewarmJob && this.prewarmJob.windowStart === windowStart && this.prewarmJob.available === available && this.prewarmJob.received === this.received) return;
    const offset = Math.max(0, windowStart - bufferStart);
    const window = new Float32Array(this.windowSamples);
    window.set(this.buffer.subarray(offset, offset + available), 0);
    const token = ++this.prewarmToken;
    const job = {
      received: this.received,
      lastActivity: this.lastActivitySample,
      windowStart,
      available
    };
    this.prewarmJob = job;
    this.prewarmStats.started += 1;
    this.prewarmPromise = this.separate(window, windowStart).then((result) => {
      if (token !== this.prewarmToken || this.prewarmJob !== job) return;
      job.result = result;
      job.timing = result.timing;
    }).catch(() => {
      if (token !== this.prewarmToken || this.prewarmJob !== job) return;
      job.failed = true;
    }).finally(() => {
      if (token === this.prewarmToken) this.prewarmPromise = null;
    });
  }
  /** Prewarm counters plus the current hit rate, for the latency report. */
  prewarmReport() {
    const { started, reused, discarded, missed } = this.prewarmStats;
    const attempts = reused + missed;
    return { started, reused, discarded, missed, hitRate: attempts === 0 ? 0 : reused / attempts };
  }
  /** True when the most recent window reused a speculative result. */
  consumeLastReused() {
    const value = this.lastWindowReused;
    this.lastWindowReused = false;
    return value;
  }
  /** Copy of the mixed tail, for a speculative single-speaker ASR. */
  takeMixedTail() {
    return new Float32Array(this.mixedTail);
  }
  /** Finish buffered audio and emit every active lane. */
  async flush() {
    this.pending = false;
    if (this.lastActivitySample <= this.coveredUntil && this.received - this.lastActivitySample >= this.windowSamples && !this.lanes.some((lane) => lane.active)) {
      this.finalizeAll();
      return;
    }
    const flushStartedAt = Date.now();
    this.flushTruncated = false;
    this.flushDeadline = flushStartedAt + this.flushBudgetMs;
    try {
      if (this.processing) {
        await this.processing.catch(() => void 0);
        if (Date.now() >= this.flushDeadline) this.flushTruncated = true;
      }
      for (let guard = 0; guard < 32 && this.hasWindow(true); guard++) {
        const remaining = this.flushDeadline - Date.now();
        const expected = this.lastModelMs > 0 ? this.lastModelMs : this.hopBudgetMs;
        if (remaining <= 0 || remaining < expected) {
          this.flushTruncated = true;
          await this.coverMixedTail();
          break;
        }
        const before = this.previous?.start;
        await this.run(true);
        if (this.processing && Date.now() < this.flushDeadline) {
          await this.processing.catch(() => void 0);
        }
        if (this.previous?.start === before) break;
      }
    } finally {
      if (Date.now() - flushStartedAt > this.flushBudgetMs) this.flushTruncated = true;
      this.flushDeadline = 0;
    }
    this.flushMs = Date.now() - flushStartedAt;
    this.finalizeAll();
  }
  /** Drop all buffered audio without emitting. */
  close() {
    this.stopped = true;
    this.buffer = new Float32Array(0);
    resetLane(this.lanes[0]);
    resetLane(this.lanes[1]);
    this.previous = void 0;
    this.coveredUntil = 0;
    this.ready = [];
  }
  hasWindow(flush) {
    if (this.stopped || this.buffer.length === 0) return false;
    const bufferStart = this.received - this.buffer.length;
    let start = this.previous ? this.previous.start + this.hopSamples : bufferStart;
    if (start < bufferStart) start = bufferStart;
    const available = this.received - start;
    return flush ? available > 0 : available >= this.windowSamples;
  }
  maybeProcess() {
    if (this.stopped) return;
    if (this.flushDeadline > 0 && Date.now() >= this.flushDeadline) {
      this.flushTruncated = true;
      return;
    }
    if (this.lastActivitySample <= this.coveredUntil && this.received - this.lastActivitySample >= this.windowSamples && !this.lanes.some((lane) => lane.active)) {
      this.previous = void 0;
      return;
    }
    if (this.processing) {
      this.pending = true;
      return;
    }
    if (!this.hasWindow(false)) return;
    void this.run(false);
  }
  run(flush) {
    if (this.processing) return this.processing;
    const task = this.processWindow(flush).catch((error) => {
      this.onError(error);
    }).finally(() => {
      this.processing = null;
      if (this.pending) {
        this.pending = false;
        this.maybeProcess();
      } else if (!flush) {
        this.maybeProcess();
      }
    });
    this.processing = task;
    return task;
  }
  async processWindow(flush) {
    if (this.stopped || this.buffer.length === 0) return;
    const bufferStart = this.received - this.buffer.length;
    let windowStart = this.previous ? this.previous.start + this.hopSamples : bufferStart;
    if (windowStart < bufferStart) windowStart = bufferStart;
    const available = Math.min(this.windowSamples, this.received - windowStart);
    if (available <= 0) return;
    if (!flush && available < this.windowSamples) return;
    const offset = windowStart - bufferStart;
    if (offset < 0 || offset >= this.buffer.length) return;
    const window = new Float32Array(this.windowSamples);
    window.set(this.buffer.subarray(offset, offset + available), 0);
    let result;
    const startedAt = Date.now();
    try {
      const resolved = await this.resolveWindow(window, windowStart, available);
      result = resolved.result;
      this.lastWindowDiagnostics = resolved.diagnostics;
    } catch (error) {
      this.onError(error);
      result = { sources: [{ samples: window, rms: rmsOf(window) }] };
      this.lastWindowDiagnostics = {
        prewarm: "miss",
        windowMs: Date.now() - startedAt,
        modelCalls: 0,
        mixed: true
      };
    } finally {
      this.lastWindowMs = Date.now() - startedAt;
      if (!this.windowSkipped) this.lastModelMs = this.lastWindowMs;
      this.windowSkipped = false;
    }
    if (this.stopped) return;
    const sources = (result.sources ?? []).map((source) => {
      const copy = new Float32Array(this.windowSamples);
      copy.set(source.samples.subarray(0, this.windowSamples));
      return { samples: copy, rms: source.rms ?? rmsOf(copy) };
    });
    let a = new Float32Array(this.windowSamples);
    let b = new Float32Array(this.windowSamples);
    let rmsA = 0;
    let rmsB = 0;
    if (sources.length >= 2) {
      let first = sources[0];
      let second = sources[1];
      if (this.previous && available === this.windowSamples) {
        const overlap = Math.max(0, Math.min(
          this.windowSamples,
          this.previous.start + this.windowSamples - windowStart
        ));
        if (overlap >= 32) {
          const length = Math.min(overlap, this.windowSamples);
          const previousA = this.previous.sources[0].subarray(this.windowSamples - length);
          const previousB = this.previous.sources[1].subarray(this.windowSamples - length);
          const same = zeroMeanCorrelation(previousA, first.samples, 0) + zeroMeanCorrelation(previousB, second.samples, 0);
          const swapped = zeroMeanCorrelation(previousA, second.samples, 0) + zeroMeanCorrelation(previousB, first.samples, 0);
          if (swapped > same + 0.02) {
            const swap = first;
            first = second;
            second = swap;
          }
        }
      }
      a = first.samples;
      b = second.samples;
      rmsA = first.rms ?? rmsOf(a);
      rmsB = second.rms ?? rmsOf(b);
    } else if (sources.length === 1) {
      const only = sources[0];
      let slot = 0;
      if (this.previous && available === this.windowSamples) {
        const overlap = Math.max(0, Math.min(
          this.windowSamples,
          this.previous.start + this.windowSamples - windowStart
        ));
        if (overlap >= 32) {
          const length = Math.min(overlap, this.windowSamples);
          const previousA = this.previous.sources[0].subarray(this.windowSamples - length);
          const previousB = this.previous.sources[1].subarray(this.windowSamples - length);
          const corrA = zeroMeanCorrelation(previousA, only.samples.subarray(0, length), 0);
          const corrB = zeroMeanCorrelation(previousB, only.samples.subarray(0, length), 0);
          if (corrB > corrA + 0.02) slot = 1;
        }
      }
      if (slot === 0) {
        a = only.samples;
        rmsA = only.rms ?? rmsOf(a);
      } else {
        b = only.samples;
        rmsB = only.rms ?? rmsOf(b);
      }
    }
    let appendOffset = 0;
    if (this.previous) {
      const previousEnd = this.previous.start + this.windowSamples;
      if (windowStart > previousEnd) {
        this.appendZeros(windowStart - previousEnd, previousEnd);
      }
      appendOffset = Math.max(0, Math.min(available, previousEnd - windowStart));
    } else {
      appendOffset = Math.max(0, Math.min(available, this.coveredUntil - windowStart));
    }
    const newLength = available - appendOffset;
    if (newLength > 0) {
      const newStart = windowStart + appendOffset;
      this.appendLane(0, a.subarray(appendOffset, appendOffset + newLength), newStart, rmsA);
      this.appendLane(1, b.subarray(appendOffset, appendOffset + newLength), newStart, rmsB);
    }
    this.previous = { sources: [a, b], start: windowStart };
    this.coveredUntil = Math.max(this.coveredUntil, windowStart + available);
  }
  /**
   * Prefer the speculative result when it describes exactly this window. An
   * in-flight prewarm for the same window is awaited instead of started
   * twice: its 374 ms inference is already running.
   */
  async resolveWindow(window, windowStart, available) {
    const job = this.prewarmJob;
    const speechThrough = Math.min(this.windowSamples, Math.max(0, this.lastActivitySample - windowStart));
    const matches = job !== null && job.windowStart === windowStart && job.lastActivity === this.lastActivitySample && job.available >= speechThrough;
    if (job && matches) {
      const waitStartedAt = Date.now();
      if (this.prewarmPromise) await this.prewarmPromise.catch(() => void 0);
      if (job.result && !job.failed && this.prewarmJob === job) {
        this.prewarmJob = null;
        this.prewarmStats.reused += 1;
        this.lastWindowReused = true;
        return {
          result: job.result,
          diagnostics: {
            prewarm: "hit",
            prewarmWaitMs: Date.now() - waitStartedAt,
            ...job.timing ?? {},
            windowMs: Date.now() - waitStartedAt,
            modelCalls: 1
          }
        };
      }
    }
    if (job) this.prewarmStats.missed += 1;
    this.lastWindowReused = false;
    if (this.forceMixed) {
      this.windowSkipped = true;
      return {
        result: { sources: [{ samples: window, rms: rmsOf(window) }] },
        diagnostics: { prewarm: "miss", windowMs: 0, modelCalls: 0, mixed: true }
      };
    }
    if (this.isLagging() && !this.allowModelOnce) {
      this.skippedWindows += 1;
      this.allowModelOnce = true;
      this.windowSkipped = true;
      return {
        result: { sources: [{ samples: window, rms: rmsOf(window) }] },
        diagnostics: { prewarm: "miss", windowMs: 0, modelCalls: 0, mixed: true }
      };
    }
    this.allowModelOnce = false;
    const startedAt = Date.now();
    const result = await this.separate(window, windowStart);
    return {
      result,
      diagnostics: {
        prewarm: "miss",
        ...result.timing ?? {},
        windowMs: Date.now() - startedAt,
        modelCalls: 1
      }
    };
  }
  /**
   * Append every remaining hop to the lanes from the mixed audio, without
   * asking the model. Bounded and cheap: each hop is one RMS scan.
   */
  async coverMixedTail() {
    this.forceMixed = true;
    try {
      for (let guard = 0; guard < 64 && this.hasWindow(true); guard++) {
        const before = this.previous?.start;
        await this.run(true);
        if (this.processing) await this.processing.catch(() => void 0);
        if (this.previous?.start === before) break;
      }
    } finally {
      this.forceMixed = false;
    }
  }
  /** True when the last model window cost more than one hop of audio. */
  isLagging() {
    return this.skipWhileBehind && this.lastModelMs > this.hopBudgetMs * 0.9;
  }
  /** Backpressure counters for the latency report. */
  pressureReport() {
    return {
      lastWindowMs: this.lastWindowMs,
      lastModelMs: this.lastModelMs,
      hopBudgetMs: this.hopBudgetMs,
      skippedWindows: this.skippedWindows,
      flushMs: this.flushMs,
      flushTruncated: this.flushTruncated
    };
  }
  appendZeros(length, absStart) {
    const zeros = new Float32Array(Math.max(0, length));
    this.appendLane(0, zeros, absStart, 0);
    this.appendLane(1, zeros, absStart, 0);
  }
  appendLane(slot, samples, absStart, sourceRms) {
    const lane = this.lanes[slot];
    if (sourceRms > 0) {
      lane.threshold = Math.max(this.floorThreshold, Math.min(0.05, sourceRms * 0.2));
    }
    for (let offset = 0; offset < samples.length; offset += this.subChunk) {
      const piece = samples.subarray(offset, Math.min(samples.length, offset + this.subChunk));
      this.appendPiece(lane, piece, absStart + offset);
    }
  }
  appendPiece(lane, piece, absStart) {
    const level = rmsOf(piece);
    if (!lane.active) {
      if (level >= lane.threshold) {
        const preRoll = flatten(lane.preRoll);
        lane.buffer = lane.preRoll.length > 0 ? [...lane.preRoll, piece] : [piece];
        lane.length = preRoll.length + piece.length;
        lane.startAbs = absStart - preRoll.length;
        lane.active = true;
        lane.speech = piece.length;
        lane.silence = 0;
        lane.lastSpeech = lane.length;
        lane.preRoll = [];
        lane.preRollLength = 0;
        return;
      }
      lane.preRoll.push(piece);
      lane.preRollLength += piece.length;
      if (lane.preRollLength > this.preRollSamples) {
        const all = flatten(lane.preRoll);
        const keep = all.slice(all.length - this.preRollSamples);
        lane.preRoll = [keep];
        lane.preRollLength = keep.length;
      }
      return;
    }
    lane.buffer.push(piece);
    lane.length += piece.length;
    if (level >= lane.threshold) {
      lane.speech += piece.length;
      lane.silence = 0;
      lane.lastSpeech = lane.length;
    } else {
      lane.silence += piece.length;
    }
    if (lane.speech >= this.minSpeechSamples && (lane.silence >= this.silenceSamples || lane.length >= this.maxSegmentSamples)) {
      this.finalizeLane(lane);
    }
  }
  hasEarlierActive(onsetSample) {
    return this.lanes.some((lane) => lane.active && lane.startAbs < onsetSample);
  }
  emit(segment) {
    try {
      this.onSegment({
        slot: segment.slot,
        samples: segment.samples,
        onsetMs: segment.onsetMs,
        ...segment.utteranceId === void 0 ? {} : { utteranceId: segment.utteranceId },
        ...segment.siblingActive === void 0 ? {} : { siblingActive: segment.siblingActive },
        ...segment.separation === void 0 ? {} : { separation: segment.separation }
      });
    } catch (error) {
      this.onError(error);
    }
  }
  /** Release finished lanes in speaking order, not in the order they stopped. */
  drainReady() {
    if (this.ready.length === 0) return;
    const activeStarts = this.lanes.filter((lane) => lane.active).map((lane) => lane.startAbs);
    const block = activeStarts.length > 0 ? Math.min(...activeStarts) : Number.POSITIVE_INFINITY;
    this.ready.sort((a, b) => a.onsetSample - b.onsetSample || a.slot - b.slot);
    while (this.ready.length > 0 && this.ready[0].onsetSample < block) {
      this.emit(this.ready.shift());
    }
  }
  finalizeLane(lane) {
    const enough = lane.active && lane.speech >= this.minSpeechSamples && lane.length > 0;
    if (!enough) {
      resetLane(lane);
      this.drainReady();
      return;
    }
    const slot = this.lanes[0] === lane ? 0 : 1;
    const onsetSample = lane.startAbs;
    const end = Math.min(lane.length, lane.lastSpeech + this.tailSamples);
    const all = flatten(lane.buffer);
    const samples = all.slice(0, Math.max(1, end));
    const other = this.lanes[1 - slot];
    const segmentEnd = lane.startAbs + lane.length;
    const siblingActive = other.active && other.startAbs < segmentEnd && other.startAbs + other.length > lane.startAbs;
    const pending = {
      slot,
      samples,
      onsetMs: Math.round(onsetSample * 1e3 / this.sampleRate),
      onsetSample,
      utteranceId: "cont-" + ++this.utteranceSeq + "-" + slot,
      siblingActive,
      ...this.lastWindowDiagnostics === void 0 ? {} : { separation: { ...this.lastWindowDiagnostics } }
    };
    resetLane(lane);
    if (this.hasEarlierActive(onsetSample)) this.ready.push(pending);
    else {
      this.emit(pending);
      this.drainReady();
    }
  }
  finalizeAll() {
    const active = [0, 1].filter((slot) => this.lanes[slot].active).sort((a, b) => this.lanes[a].startAbs - this.lanes[b].startAbs);
    for (const slot of active) this.finalizeLane(this.lanes[slot]);
    this.drainReady();
  }
};
export {
  ContinuousSeparation,
  dedupeTranscript
};
