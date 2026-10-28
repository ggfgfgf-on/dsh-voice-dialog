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
  constructor(options) {
    this.sampleRate = Math.max(1e3, Math.floor(options.sampleRate ?? 16e3));
    const windowMs = Math.max(250, options.windowMs ?? 4e3);
    const hopMs = Math.max(100, Math.min(windowMs, options.hopMs ?? 1e3));
    this.windowSamples = Math.round(this.sampleRate * windowMs / 1e3);
    this.hopSamples = Math.round(this.sampleRate * hopMs / 1e3);
    this.silenceSamples = Math.round(this.sampleRate * Math.max(100, options.silenceMs ?? 1600) / 1e3);
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
    if (rmsOf(chunk) >= this.floorThreshold) this.lastActivitySample = this.received;
    this.maybeProcess();
  }
  /** Finish buffered audio and emit every active lane. */
  async flush() {
    this.pending = false;
    if (this.lastActivitySample <= this.coveredUntil && this.received - this.lastActivitySample >= this.windowSamples && !this.lanes.some((lane) => lane.active)) {
      this.finalizeAll();
      return;
    }
    if (this.processing) await this.processing.catch(() => void 0);
    for (let guard = 0; guard < 32 && this.hasWindow(true); guard++) {
      const before = this.previous?.start;
      await this.run(true);
      if (this.processing) await this.processing.catch(() => void 0);
      if (this.previous?.start === before) break;
    }
    if (this.processing) await this.processing.catch(() => void 0);
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
    try {
      result = await this.separate(window, windowStart);
    } catch (error) {
      this.onError(error);
      result = { sources: [{ samples: window, rms: rmsOf(window) }] };
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
      this.onSegment({ slot: segment.slot, samples: segment.samples, onsetMs: segment.onsetMs });
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
    const pending = {
      slot,
      samples,
      onsetMs: Math.round(onsetSample * 1e3 / this.sampleRate),
      onsetSample
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
