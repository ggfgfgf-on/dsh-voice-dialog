/** Continuous two-source separation with a 1.6 s VAD per separated source. */

import { zeroMeanCorrelation } from './separation-align.ts'

export interface ContinuousSource {
  samples: Float32Array
  rms?: number
}

export interface ContinuousWindowResult {
  sources: ContinuousSource[]
}

export interface ContinuousSegment {
  /** Stable source slot within this capture (0 or 1). */
  slot: number
  samples: Float32Array
  /** Absolute onset in the microphone timeline. */
  onsetMs: number
  /** Idempotency key; one utterance may reach the model only once. */
  utteranceId?: string
  /** True when the other lane carried speech in the same window. */
  siblingActive?: boolean
}

export interface ContinuousSeparationOptions {
  sampleRate?: number
  windowMs?: number
  hopMs?: number
  /** Per-source trailing silence that closes one segment. */
  silenceMs?: number
  minSpeechMs?: number
  maxSegmentMs?: number
  /** Absolute RMS floor; each source's VAD threshold adapts above it. */
  threshold?: number
  separate: (samples: Float32Array, startSample: number) => Promise<ContinuousWindowResult>
  onSegment: (segment: ContinuousSegment) => void
  onError?: (error: unknown) => void
}

interface PendingSegment {
  slot: number
  samples: Float32Array
  onsetMs: number
  onsetSample: number
  utteranceId?: string
  siblingActive?: boolean
}

interface Lane {
  preRoll: Float32Array[]
  preRollLength: number
  buffer: Float32Array[]
  length: number
  active: boolean
  speech: number
  silence: number
  lastSpeech: number
  startAbs: number
  threshold: number
}

function flatten(chunks: readonly Float32Array[]): Float32Array {
  const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const out = new Float32Array(length)
  let offset = 0
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length }
  return out
}

function concat(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(a.length + b.length)
  out.set(a, 0)
  out.set(b, a.length)
  return out
}

function rmsOf(samples: Float32Array): number {
  let sum = 0
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i]
  return Math.sqrt(sum / Math.max(1, samples.length))
}

function makeLane(threshold: number): Lane {
  return {
    preRoll: [], preRollLength: 0, buffer: [], length: 0, active: false,
    speech: 0, silence: 0, lastSpeech: 0, startAbs: 0, threshold,
  }
}

function resetLane(lane: Lane): void {
  lane.preRoll = []
  lane.preRollLength = 0
  lane.buffer = []
  lane.length = 0
  lane.active = false
  lane.speech = 0
  lane.silence = 0
  lane.lastSpeech = 0
  lane.startAbs = 0
}

/**
 * Remove text already emitted from the previous overlapping window.
 * Only long, exact overlaps are removed so ordinary repeated phrases survive.
 */
export function dedupeTranscript(previous: string, next: string): string {
  const before = previous.trim()
  const after = next.trim()
  if (!before || !after) return after
  if (after === before) return ''
  if (after.startsWith(before)) return after.slice(before.length).trim()
  const max = Math.min(before.length, after.length)
  for (let size = max; size >= 6; size--) {
    if (before.endsWith(after.slice(0, size))) return after.slice(size).trim()
  }
  return after
}

/**
 * Consume a continuous 16 kHz microphone stream.
 *
 * Every hop it separates the last window into two streams, appends only the
 * new hop to each stable slot, and runs an independent VAD per slot. A slot
 * closes after its own 1.6 s of silence, even while the other slot is talking.
 */
export class ContinuousSeparation {
  private readonly sampleRate: number
  private readonly windowSamples: number
  private readonly hopSamples: number
  private readonly silenceSamples: number
  private readonly minSpeechSamples: number
  private readonly maxSegmentSamples: number
  private readonly preRollSamples: number
  private readonly tailSamples: number
  private readonly floorThreshold: number
  private readonly subChunk: number
  private readonly separate: ContinuousSeparationOptions['separate']
  private readonly onSegment: (segment: ContinuousSegment) => void
  private readonly onError: (error: unknown) => void
  private readonly lanes: [Lane, Lane]
  private buffer: Float32Array = new Float32Array(0)
  private received = 0
  private lastActivitySample = 0
  private coveredUntil = 0
  private processing: Promise<void> | null = null
  private pending = false
  private stopped = false
  private previous: { sources: [Float32Array, Float32Array]; start: number } | undefined
  private ready: PendingSegment[] = []
  /**
   * Speculative separation of the window that is about to close. Filled while
   * the speaker is still finishing the sentence, so the 374 ms inference is
   * not paid again after the VAD decides the utterance ended.
   */
  private prewarmJob: {
    received: number
    lastActivity: number
    windowStart: number
    available: number
    result?: ContinuousWindowResult
    failed?: boolean
  } | null = null
  private prewarmPromise: Promise<void> | null = null
  private prewarmToken = 0
  private readonly prewarmStats = { started: 0, reused: 0, discarded: 0, missed: 0 }
  private lastWindowReused = false
  /** Mixed-stream ring buffer, for the single-speaker speculative ASR. */
  private mixedTail: Float32Array = new Float32Array(0)
  private utteranceSeq = 0

  constructor(options: ContinuousSeparationOptions) {
    this.sampleRate = Math.max(1000, Math.floor(options.sampleRate ?? 16_000))
    const windowMs = Math.max(250, options.windowMs ?? 4000)
    const hopMs = Math.max(100, Math.min(windowMs, options.hopMs ?? 1000))
    this.windowSamples = Math.round(this.sampleRate * windowMs / 1000)
    this.hopSamples = Math.round(this.sampleRate * hopMs / 1000)
    this.silenceSamples = Math.round(this.sampleRate * Math.max(100, options.silenceMs ?? 1600) / 1000)
    this.minSpeechSamples = Math.round(this.sampleRate * Math.max(50, options.minSpeechMs ?? 260) / 1000)
    this.maxSegmentSamples = Math.round(this.sampleRate * Math.max(windowMs, options.maxSegmentMs ?? 20_000) / 1000)
    this.preRollSamples = Math.round(this.sampleRate * 0.32)
    this.tailSamples = Math.round(this.sampleRate * 0.24)
    this.floorThreshold = Math.max(0.001, options.threshold ?? 0.008)
    this.subChunk = Math.max(32, Math.round(this.sampleRate * 0.1))
    this.separate = options.separate
    this.onSegment = options.onSegment
    this.onError = options.onError ?? (() => undefined)
    this.lanes = [makeLane(this.floorThreshold), makeLane(this.floorThreshold)]
  }

  /** Feed one 16 kHz chunk. Chunks may be any length. */
  push(chunk: Float32Array): void {
    if (this.stopped || chunk.length === 0) return
    this.buffer = concat(this.buffer, chunk)
    const keep = this.windowSamples * 4
    if (this.buffer.length > keep) this.buffer = this.buffer.slice(this.buffer.length - keep)
    this.received += chunk.length
    if (rmsOf(chunk) >= this.floorThreshold) {
      this.lastActivitySample = this.received
      // New speech after the tail went quiet means the prewarmed window no
      // longer describes the utterance that closes; drop it and let the
      // regular path recompute. The in-flight promise keeps running but its
      // token no longer matches, so it can never be reused.
      if (this.prewarmJob) {
        if (!this.prewarmJob.failed) this.prewarmStats.discarded += 1
        this.prewarmJob = null
        this.prewarmToken += 1
      }
    }
    this.mixedTail = this.mixedTail.length === 0
      ? new Float32Array(chunk)
      : concat(this.mixedTail, chunk)
    if (this.mixedTail.length > this.windowSamples) {
      this.mixedTail = this.mixedTail.slice(this.mixedTail.length - this.windowSamples)
    }
    this.maybeProcess()
  }

  /**
   * Speculatively separate the window that would be used if the utterance
   * closed right now. Safe to call repeatedly from the microphone's tail-timer
   * callback: one inference at a time, reused at most once.
   */
  prewarm(): void {
    if (this.stopped || this.prewarmPromise) return
    if (!this.lanes.some((lane) => lane.active)) return
    if (!this.hasWindow(true)) return
    const bufferStart = this.received - this.buffer.length
    let windowStart = this.previous ? this.previous.start + this.hopSamples : bufferStart
    if (windowStart < bufferStart) windowStart = bufferStart
    const available = Math.min(this.windowSamples, this.received - windowStart)
    if (available <= 0) return
    if (this.prewarmJob
      && this.prewarmJob.windowStart === windowStart
      && this.prewarmJob.available === available
      && this.prewarmJob.received === this.received) return
    const offset = Math.max(0, windowStart - bufferStart)
    const window = new Float32Array(this.windowSamples)
    window.set(this.buffer.subarray(offset, offset + available), 0)
    const token = ++this.prewarmToken
    const job = {
      received: this.received,
      lastActivity: this.lastActivitySample,
      windowStart,
      available,
    }
    this.prewarmJob = job
    this.prewarmStats.started += 1
    this.prewarmPromise = this.separate(window, windowStart).then((result) => {
      if (token !== this.prewarmToken || this.prewarmJob !== job) return
      job.result = result
    }).catch(() => {
      if (token !== this.prewarmToken || this.prewarmJob !== job) return
      job.failed = true
    }).finally(() => {
      if (token === this.prewarmToken) this.prewarmPromise = null
    })
  }

  /** Prewarm counters plus the current hit rate, for the latency report. */
  prewarmReport(): { started: number; reused: number; discarded: number; missed: number; hitRate: number } {
    const { started, reused, discarded, missed } = this.prewarmStats
    const attempts = reused + missed
    return { started, reused, discarded, missed, hitRate: attempts === 0 ? 0 : reused / attempts }
  }

  /** True when the most recent window reused a speculative result. */
  consumeLastReused(): boolean {
    const value = this.lastWindowReused
    this.lastWindowReused = false
    return value
  }

  /** Copy of the mixed tail, for a speculative single-speaker ASR. */
  takeMixedTail(): Float32Array {
    return new Float32Array(this.mixedTail)
  }

  /** Finish buffered audio and emit every active lane. */
  async flush(): Promise<void> {
    this.pending = false
    if (this.lastActivitySample <= this.coveredUntil
      && this.received - this.lastActivitySample >= this.windowSamples
      && !this.lanes.some((lane) => lane.active)) {
      this.finalizeAll()
      return
    }
    if (this.processing) await this.processing.catch(() => undefined)
    // Drain every remaining hop. The last window may be shorter than 4 s;
    // zero-padding it still lets the model separate the tail.
    for (let guard = 0; guard < 32 && this.hasWindow(true); guard++) {
      const before = this.previous?.start
      await this.run(true)
      if (this.processing) await this.processing.catch(() => undefined)
      if (this.previous?.start === before) break
    }
    if (this.processing) await this.processing.catch(() => undefined)
    this.finalizeAll()
  }

  /** Drop all buffered audio without emitting. */
  close(): void {
    this.stopped = true
    this.buffer = new Float32Array(0)
    resetLane(this.lanes[0])
    resetLane(this.lanes[1])
    this.previous = undefined
    this.coveredUntil = 0
    this.ready = []
  }

  private hasWindow(flush: boolean): boolean {
    if (this.stopped || this.buffer.length === 0) return false
    const bufferStart = this.received - this.buffer.length
    let start = this.previous ? this.previous.start + this.hopSamples : bufferStart
    if (start < bufferStart) start = bufferStart
    const available = this.received - start
    return flush ? available > 0 : available >= this.windowSamples
  }

  private maybeProcess(): void {
    if (this.stopped) return
    // Do not run the separation model on an idle room. Keep the last 4 s in
    // the ring buffer so speech that starts after a quiet gap still has a
    // complete window; an active lane must still be processed so its own
    // 1.6 s silence timer can close it.
    if (this.lastActivitySample <= this.coveredUntil
      && this.received - this.lastActivitySample >= this.windowSamples
      && !this.lanes.some((lane) => lane.active)) {
      this.previous = undefined
      return
    }
    if (this.processing) { this.pending = true; return }
    if (!this.hasWindow(false)) return
    void this.run(false)
  }

  private run(flush: boolean): Promise<void> {
    if (this.processing) return this.processing
    const task = this.processWindow(flush)
      .catch((error: unknown) => { this.onError(error) })
      .finally(() => {
        this.processing = null
        if (this.pending) {
          this.pending = false
          this.maybeProcess()
        } else if (!flush) {
          this.maybeProcess()
        }
      })
    this.processing = task
    return task
  }

  private async processWindow(flush: boolean): Promise<void> {
    if (this.stopped || this.buffer.length === 0) return
    const bufferStart = this.received - this.buffer.length
    let windowStart = this.previous ? this.previous.start + this.hopSamples : bufferStart
    if (windowStart < bufferStart) windowStart = bufferStart
    const available = Math.min(this.windowSamples, this.received - windowStart)
    if (available <= 0) return
    if (!flush && available < this.windowSamples) return
    const offset = windowStart - bufferStart
    if (offset < 0 || offset >= this.buffer.length) return
    const window = new Float32Array(this.windowSamples)
    window.set(this.buffer.subarray(offset, offset + available), 0)
    let result: ContinuousWindowResult
    try {
      result = await this.resolveWindow(window, windowStart, available)
    } catch (error) {
      // Separation is optional: keep dictating the mixed stream rather than
      // dropping the utterance. The next window retries the model.
      this.onError(error)
      result = { sources: [{ samples: window, rms: rmsOf(window) }] }
    }
    if (this.stopped) return

    const sources = (result.sources ?? []).map((source) => {
      const copy = new Float32Array(this.windowSamples)
      copy.set(source.samples.subarray(0, this.windowSamples))
      return { samples: copy, rms: source.rms ?? rmsOf(copy) }
    })
    let a = new Float32Array(this.windowSamples)
    let b = new Float32Array(this.windowSamples)
    let rmsA = 0
    let rmsB = 0

    if (sources.length >= 2) {
      let first = sources[0]
      let second = sources[1]
      if (this.previous && available === this.windowSamples) {
        const overlap = Math.max(0, Math.min(
          this.windowSamples,
          this.previous.start + this.windowSamples - windowStart,
        ))
        if (overlap >= 32) {
          const length = Math.min(overlap, this.windowSamples)
          const previousA = this.previous.sources[0].subarray(this.windowSamples - length)
          const previousB = this.previous.sources[1].subarray(this.windowSamples - length)
          const same = zeroMeanCorrelation(previousA, first.samples, 0)
            + zeroMeanCorrelation(previousB, second.samples, 0)
          const swapped = zeroMeanCorrelation(previousA, second.samples, 0)
            + zeroMeanCorrelation(previousB, first.samples, 0)
          if (swapped > same + 0.02) { const swap = first; first = second; second = swap }
        }
      }
      a = first.samples
      b = second.samples
      rmsA = first.rms ?? rmsOf(a)
      rmsB = second.rms ?? rmsOf(b)
    } else if (sources.length === 1) {
      const only = sources[0]
      let slot = 0
      if (this.previous && available === this.windowSamples) {
        const overlap = Math.max(0, Math.min(
          this.windowSamples,
          this.previous.start + this.windowSamples - windowStart,
        ))
        if (overlap >= 32) {
          const length = Math.min(overlap, this.windowSamples)
          const previousA = this.previous.sources[0].subarray(this.windowSamples - length)
          const previousB = this.previous.sources[1].subarray(this.windowSamples - length)
          const corrA = zeroMeanCorrelation(previousA, only.samples.subarray(0, length), 0)
          const corrB = zeroMeanCorrelation(previousB, only.samples.subarray(0, length), 0)
          if (corrB > corrA + 0.02) slot = 1
        }
      }
      if (slot === 0) { a = only.samples; rmsA = only.rms ?? rmsOf(a) }
      else { b = only.samples; rmsB = only.rms ?? rmsOf(b) }
    }

    let appendOffset = 0
    if (this.previous) {
      const previousEnd = this.previous.start + this.windowSamples
      if (windowStart > previousEnd) {
        this.appendZeros(windowStart - previousEnd, previousEnd)
      }
      appendOffset = Math.max(0, Math.min(available, previousEnd - windowStart))
    } else {
      // After an idle reset, do not re-append audio that was already covered.
      appendOffset = Math.max(0, Math.min(available, this.coveredUntil - windowStart))
    }
    const newLength = available - appendOffset
    if (newLength > 0) {
      const newStart = windowStart + appendOffset
      this.appendLane(0, a.subarray(appendOffset, appendOffset + newLength), newStart, rmsA)
      this.appendLane(1, b.subarray(appendOffset, appendOffset + newLength), newStart, rmsB)
    }
    this.previous = { sources: [a, b], start: windowStart }
    this.coveredUntil = Math.max(this.coveredUntil, windowStart + available)
  }

  /**
   * Prefer the speculative result when it describes exactly this window. An
   * in-flight prewarm for the same window is awaited instead of started
   * twice: its 374 ms inference is already running.
   */
  private async resolveWindow(
    window: Float32Array,
    windowStart: number,
    available: number,
  ): Promise<ContinuousWindowResult> {
    const job = this.prewarmJob
    const matches = job !== null
      && job.windowStart === windowStart
      && job.available === available
      && job.received === this.received
      && job.lastActivity === this.lastActivitySample
    if (job && matches) {
      if (this.prewarmPromise) await this.prewarmPromise.catch(() => undefined)
      if (job.result && !job.failed && this.prewarmJob === job) {
        this.prewarmJob = null
        this.prewarmStats.reused += 1
        this.lastWindowReused = true
        return job.result
      }
    }
    this.prewarmStats.missed += 1
    this.lastWindowReused = false
    return await this.separate(window, windowStart)
  }

  private appendZeros(length: number, absStart: number): void {
    const zeros = new Float32Array(Math.max(0, length))
    this.appendLane(0, zeros, absStart, 0)
    this.appendLane(1, zeros, absStart, 0)
  }

  private appendLane(slot: number, samples: Float32Array, absStart: number, sourceRms: number): void {
    const lane = this.lanes[slot]!
    if (sourceRms > 0) {
      lane.threshold = Math.max(this.floorThreshold, Math.min(0.05, sourceRms * 0.2))
    }
    for (let offset = 0; offset < samples.length; offset += this.subChunk) {
      const piece = samples.subarray(offset, Math.min(samples.length, offset + this.subChunk))
      this.appendPiece(lane, piece, absStart + offset)
    }
  }

  private appendPiece(lane: Lane, piece: Float32Array, absStart: number): void {
    const level = rmsOf(piece)
    if (!lane.active) {
      if (level >= lane.threshold) {
        const preRoll = flatten(lane.preRoll)
        lane.buffer = lane.preRoll.length > 0 ? [...lane.preRoll, piece] : [piece]
        lane.length = preRoll.length + piece.length
        lane.startAbs = absStart - preRoll.length
        lane.active = true
        lane.speech = piece.length
        lane.silence = 0
        lane.lastSpeech = lane.length
        lane.preRoll = []
        lane.preRollLength = 0
        return
      }
      lane.preRoll.push(piece)
      lane.preRollLength += piece.length
      if (lane.preRollLength > this.preRollSamples) {
        const all = flatten(lane.preRoll)
        const keep = all.slice(all.length - this.preRollSamples)
        lane.preRoll = [keep]
        lane.preRollLength = keep.length
      }
      return
    }

    lane.buffer.push(piece)
    lane.length += piece.length
    if (level >= lane.threshold) {
      lane.speech += piece.length
      lane.silence = 0
      lane.lastSpeech = lane.length
    } else {
      lane.silence += piece.length
    }
    if (lane.speech >= this.minSpeechSamples
      && (lane.silence >= this.silenceSamples || lane.length >= this.maxSegmentSamples)) {
      this.finalizeLane(lane)
    }
  }

  private hasEarlierActive(onsetSample: number): boolean {
    return this.lanes.some((lane) => lane.active && lane.startAbs < onsetSample)
  }

  private emit(segment: PendingSegment): void {
    try {
      this.onSegment({
        slot: segment.slot,
        samples: segment.samples,
        onsetMs: segment.onsetMs,
        ...(segment.utteranceId === undefined ? {} : { utteranceId: segment.utteranceId }),
        ...(segment.siblingActive === undefined ? {} : { siblingActive: segment.siblingActive }),
      })
    } catch (error) {
      this.onError(error)
    }
  }

  /** Release finished lanes in speaking order, not in the order they stopped. */
  private drainReady(): void {
    if (this.ready.length === 0) return
    const activeStarts = this.lanes.filter((lane) => lane.active).map((lane) => lane.startAbs)
    const block = activeStarts.length > 0 ? Math.min(...activeStarts) : Number.POSITIVE_INFINITY
    this.ready.sort((a, b) => a.onsetSample - b.onsetSample || a.slot - b.slot)
    while (this.ready.length > 0 && this.ready[0]!.onsetSample < block) {
      this.emit(this.ready.shift()!)
    }
  }

  private finalizeLane(lane: Lane): void {
    const enough = lane.active && lane.speech >= this.minSpeechSamples && lane.length > 0
    if (!enough) {
      resetLane(lane)
      this.drainReady()
      return
    }
    const slot = this.lanes[0] === lane ? 0 : 1
    const onsetSample = lane.startAbs
    const end = Math.min(lane.length, lane.lastSpeech + this.tailSamples)
    const all = flatten(lane.buffer)
    const samples = all.slice(0, Math.max(1, end))
    // Only a lane that genuinely overlapped in time counts as a second
    // speaker. Conservatively, any overlap keeps the full two-lane path.
    const other = this.lanes[1 - slot]!
    const segmentEnd = lane.startAbs + lane.length
    const siblingActive = other.active
      && other.startAbs < segmentEnd
      && other.startAbs + other.length > lane.startAbs
    const pending: PendingSegment = {
      slot,
      samples,
      onsetMs: Math.round(onsetSample * 1000 / this.sampleRate),
      onsetSample,
      utteranceId: 'cont-' + (++this.utteranceSeq) + '-' + slot,
      siblingActive,
    }
    resetLane(lane)
    if (this.hasEarlierActive(onsetSample)) this.ready.push(pending)
    else {
      this.emit(pending)
      this.drainReady()
    }
  }

  private finalizeAll(): void {
    const active = [0, 1]
      .filter((slot) => this.lanes[slot]!.active)
      .sort((a, b) => this.lanes[a]!.startAbs - this.lanes[b]!.startAbs)
    for (const slot of active) this.finalizeLane(this.lanes[slot]!)
    this.drainReady()
  }
}
