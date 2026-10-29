/** Adapted from the built-in DSH voice-input audio capture (MIT). See NOTICE. */
/** Continuous microphone capture with RMS endpoint detection; outputs 16 kHz mono samples. */

import {
  PLAYBACK_ECHO_GUARD_MS, PLAYBACK_MIN_VOICED_MS,
  decideSpeechOnset, shouldFallbackCut,
} from './barge-in.ts'

/** Live player state used for echo suppression. */
export interface MicPlaybackSnapshot {
  playing: boolean
  /** Start of the current TTS frame; resets on every frame. */
  startedAt?: number
  /** Current output gain after volume/ducking, 0..1. */
  level?: number
  /** The host stopped or held the mouth in response to speech:start. */
  hostResponded?: boolean
}

export interface MicSpeechOnset {
  /** First voiced frame, not the moment the 400 ms gate opened. */
  startedAt: number
  /** Contiguous voiced duration when reported. */
  voicedMs: number
  reportedAt: number
}

export interface MicOptions {
  /** Leading audio retained before speech starts. */
  preRollMs?: number
  /** Trailing silence that closes one utterance. */
  silenceMs?: number
  /** Ignore bursts shorter than this. */
  minSpeechMs?: number
  /** Hard cap so one utterance cannot grow without bound. */
  maxSegmentMs?: number
  /**
   * Manual RMS onset threshold. Omit it to adapt the onset threshold to the
   * measured room noise; supplying it disables the adaptive estimate.
   */
  threshold?: number
  /** Emit continuous 16 kHz frames instead of waiting for a global silence. */
  continuous?: boolean
  /** Every captured chunk, resampled to 16 kHz. Used by source separation. */
  onFrame?: (samples: Float32Array) => void
  /** Preferred input device; empty uses the browser default. */
  deviceId?: string
  onLevel?: (level: number) => void
  /**
   * Fired only when an onset survives the echo guard and sustained-voiced gate.
   * The page reports this; it must not cut playback by itself.
   */
  onSpeechStart?: (onset: MicSpeechOnset) => void
  /** Live playback state; when omitted the microphone behaves as if idle. */
  playbackState?: () => MicPlaybackSnapshot
  /**
   * Last-resort feedback cut: reported speech has remained continuously voiced
   * for PLAYBACK_FALLBACK_CUT_MS while the player is still audible.
   */
  onPlaybackStuck?: (onset: MicSpeechOnset) => void
  /** Fired once the utterance closes, so playback can leave ducked mode. */
  onSpeechEnd?: () => void
  /**
   * Fired once when trailing silence reaches ~250 ms while the utterance is
   * still open. Callers start separation speculatively, so the model's 374 ms
   * is not paid after the endpoint decision.
   */
  onSpeechTail?: () => void
  onSegment?: (samples: Float32Array, seconds: number) => void
  onError?: (error: unknown) => void
}

const TARGET_RATE = 16_000
const BUFFER_SIZE = 1024
/** Trailing silence after which a speculative separation is started. */
const TAIL_HINT_MS = 250

/**
 * Noise tracking is deliberately slow (2.5 s) so syllables do not move the
 * floor, but shorter than a room-change event. A low percentile is less
 * sensitive than a mean to keyboard taps and other short transients.
 */
const NOISE_FLOOR_WINDOW_MS = 2500
const NOISE_FLOOR_PERCENTILE = 0.2
/** Before the first frame arrives, use the old conservative RMS value. */
const INITIAL_NOISE_FLOOR = 0.012

/**
 * 3x the 20th-percentile noise RMS is about 9.5 dB of headroom: quiet speech
 * clears it once the room is quiet, while normal room-noise peaks do not.
 * Clamping avoids a zero floor opening on digital silence and prevents loud
 * background noise from making the gate impossible to trigger.
 */
const ONSET_NOISE_FACTOR = 3
const MIN_ONSET_RMS = 0.004
const MAX_ONSET_RMS = 0.05

/**
 * Once open, the gate only needs 65% of the onset level (about 3.7 dB lower).
 * That keeps quiet final syllables from chopping an utterance into pieces,
 * while still requiring more than the tracked noise floor.
 */
const HOLD_THRESHOLD_RATIO = 0.65

/** Manual thresholds retain the public tune() range. */
const MIN_MANUAL_THRESHOLD = 0.005
const MAX_MANUAL_THRESHOLD = 0.08

/** RMS levels that start and continue one utterance. */
export interface MicThresholds {
  onset: number
  hold: number
}

/** Clamp a caller-supplied threshold, or return undefined for adaptive mode. */
function clampManualThreshold(value: number): number | undefined {
  const threshold = Number(value)
  if (!Number.isFinite(threshold)) return undefined
  return Math.min(MAX_MANUAL_THRESHOLD, Math.max(MIN_MANUAL_THRESHOLD, threshold))
}

/**
 * Rolling noise-floor estimate based on the 20th percentile of recent
 * non-speech frames. Speech frames are never fed to it, so the talker's own
 * level cannot ratchet the opening threshold upward mid-utterance.
 */
export class AdaptiveNoiseFloor {
  private window: number[] = []
  private capacity = 0
  private readonly windowMs: number
  private readonly percentile: number

  constructor(windowMs = NOISE_FLOOR_WINDOW_MS, percentile = NOISE_FLOOR_PERCENTILE) {
    this.windowMs = Math.max(1, windowMs)
    this.percentile = Math.min(0.5, Math.max(0, percentile))
  }

  /** Add one non-speech frame and return the updated floor. */
  push(rms: number, chunkMs: number): number {
    if (!Number.isFinite(rms) || rms < 0 || !(chunkMs > 0)) return this.value
    const capacity = Math.max(1, Math.ceil(this.windowMs / chunkMs))
    if (capacity !== this.capacity) {
      this.capacity = capacity
      if (this.window.length > capacity) this.window.splice(0, this.window.length - capacity)
    }
    this.window.push(rms)
    if (this.window.length > capacity) this.window.shift()
    return this.value
  }

  get value(): number {
    if (this.window.length === 0) return INITIAL_NOISE_FLOOR
    const sorted = [...this.window].sort((a, b) => a - b)
    return sorted[Math.floor((sorted.length - 1) * this.percentile)]
  }
}

/** Conservative output level when the caller cannot provide the measured gain. */
const DEFAULT_PLAYBACK_LEVEL = 0.65
/** Echo floor at silence, plus a proportional part at full playback gain. */
const ECHO_FLOOR_MIN_RMS = 0.008
const ECHO_FLOOR_GAIN_RMS = 0.052

/** Resolve the high opening gate and the lower utterance-hold gate. */
export function resolveMicThresholds(
  noiseFloor: number,
  manualThreshold?: number,
  playback?: Pick<MicPlaybackSnapshot, 'playing' | 'level'>,
): MicThresholds {
  let onset = manualThreshold === undefined
    ? Math.min(MAX_ONSET_RMS, Math.max(MIN_ONSET_RMS, noiseFloor * ONSET_NOISE_FACTOR))
    : manualThreshold
  if (playback?.playing) {
    // Unknown output level degrades to the conservative default, not to "no
    // gate": loud playback can otherwise put its own voice over the threshold.
    const raw = typeof playback.level === 'number' && Number.isFinite(playback.level)
      ? playback.level : DEFAULT_PLAYBACK_LEVEL
    const level = Math.min(1, Math.max(0, raw))
    const echoFloor = ECHO_FLOOR_MIN_RMS + level * ECHO_FLOOR_GAIN_RMS
    onset = Math.max(onset, echoFloor)
  }
  return { onset, hold: onset * HOLD_THRESHOLD_RATIO }
}

/** Flatten captured chunks into one buffer. */
function flatten(chunks: readonly Float32Array[]): Float32Array {
  const length = chunks.reduce((n, chunk) => n + chunk.length, 0)
  const out = new Float32Array(length)
  let offset = 0
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length }
  return out
}

/** Linear resampling is enough for 16 kHz speech capture. */
function resample(samples: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return samples
  const ratio = from / to
  const out = new Float32Array(Math.max(1, Math.round(samples.length / ratio)))
  for (let i = 0; i < out.length; i++) {
    const position = i * ratio
    const left = Math.floor(position)
    const right = Math.min(samples.length - 1, left + 1)
    const frac = position - left
    out[i] = samples[left] * (1 - frac) + samples[right] * frac
  }
  return out
}

/**
 * Keep one microphone stream alive and emit complete utterances.
 *
 * The browser's echoCancellation is the first line of defence while the
 * assistant speaks. The caller may additionally duck playback after
 * onSpeechStart; capture itself never stops the reply.
 */
export class MicrophoneLoop {
  private context: AudioContext | undefined
  private stream: MediaStream | undefined
  private source: MediaStreamAudioSourceNode | undefined
  private processor: ScriptProcessorNode | undefined
  private sink: GainNode | undefined
  private active = false
  private readonly options: Required<Pick<MicOptions, 'preRollMs' | 'silenceMs' | 'minSpeechMs' | 'maxSegmentMs' | 'deviceId'>> & MicOptions

  constructor(options: MicOptions = {}) {
    // Leaving threshold undefined is significant: it selects adaptive mode.
    const manualThreshold = options.threshold === undefined
      ? undefined
      : clampManualThreshold(options.threshold)
    this.options = {
      ...options,
      preRollMs: options.preRollMs ?? 320,
      silenceMs: options.silenceMs ?? 1400,
      minSpeechMs: options.minSpeechMs ?? 260,
      maxSegmentMs: options.maxSegmentMs ?? 25_000,
      threshold: manualThreshold,
      deviceId: options.deviceId ?? '',
    }
  }

  /** Acquire the microphone and start emitting segments. */
  async start(): Promise<void> {
    if (this.active) return
    const devices = (navigator as Partial<Navigator>).mediaDevices
    if (!devices) throw new Error('当前页面不是安全上下文，浏览器不提供麦克风 API；请使用 HTTPS 或 localhost。')
    this.stream = await devices.getUserMedia({
      audio: {
        echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1,
        ...(this.options.deviceId ? { deviceId: { exact: this.options.deviceId } } : {}),
      },
      video: false,
    })
    const Ctor = window.AudioContext
    // Keep the hardware output rate. A 16 kHz AudioContext can drag the
    // device into narrowband mode and make concurrent TTS playback quieter.
    this.context = new Ctor()
    await this.context.resume()
    this.active = true
    this.source = this.context.createMediaStreamSource(this.stream)
    this.processor = this.context.createScriptProcessor(BUFFER_SIZE, 1, 1)
    this.sink = this.context.createGain()
    this.sink.gain.value = 0
    this.source.connect(this.processor)
    this.processor.connect(this.sink)
    this.sink.connect(this.context.destination)
    this.attach()
  }

  /** Stop capture and release every browser resource. */
  async stop(): Promise<void> {
    this.active = false
    this.processor?.disconnect()
    this.source?.disconnect()
    this.sink?.disconnect()
    this.stream?.getTracks().forEach((track) => { track.stop() })
    this.stream = undefined
    this.processor = undefined
    this.source = undefined
    this.sink = undefined
    const context = this.context
    this.context = undefined
    if (context && context.state !== 'closed') await context.close().catch(() => undefined)
  }

  /**
   * Apply recognition settings changed while the microphone is open. A finite
   * threshold switches this instance to manual onset control; omitting the
   * field leaves the current mode (adaptive or manual) unchanged.
   */
  tune(patch: { silenceMs?: number; threshold?: number | null }): void {
    if (patch.silenceMs !== undefined) {
      const ms = Number(patch.silenceMs)
      if (Number.isFinite(ms)) this.options.silenceMs = Math.min(4000, Math.max(400, Math.round(ms)))
    }
    if (patch.threshold !== undefined) {
      // null (or 0) hands control back to the adaptive noise floor.
      if (patch.threshold === null || Number(patch.threshold) === 0) {
        this.options.threshold = undefined
      } else {
        const threshold = clampManualThreshold(patch.threshold)
        if (threshold !== undefined) this.options.threshold = threshold
      }
    }
  }

  private attach(): void {
    const processor = this.processor
    const context = this.context
    if (!processor || !context) return
    const chunkMs = processor.bufferSize / context.sampleRate * 1000
    const preRollLimit = Math.max(1, Math.ceil(this.options.preRollMs / chunkMs))
    let preRoll: Float32Array[] = []
    let segment: Float32Array[] = []
    let speaking = false
    let silence = 0
    let speech = 0
    let totalMs = 0
    let announced = false
    let tailAnnounced = false
    let voiceStartedAt = 0
    let voicedRun = 0
    let echoBlocked = false
    let fallbackCutSent = false
    const noiseFloor = new AdaptiveNoiseFloor()

    const reset = (): void => {
      preRoll = []
      segment = []
      speaking = false
      silence = 0
      speech = 0
      totalMs = 0
      announced = false
      tailAnnounced = false
      voiceStartedAt = 0
      voicedRun = 0
      echoBlocked = false
      fallbackCutSent = false
    }

    const playbackNow = (): MicPlaybackSnapshot =>
      this.options.playbackState?.() ?? { playing: false }

    const onset = (): MicSpeechOnset => ({
      startedAt: voiceStartedAt,
      voicedMs: voicedRun,
      reportedAt: Date.now(),
    })

    /** Report only after the echo guard and the playback-specific sustain gate. */
    const announce = (rms: number, threshold: number): void => {
      if (announced || echoBlocked) return
      const playback = playbackNow()
      if (playback.playing) {
        const decision = decideSpeechOnset({
          playing: true,
          playbackStartedAt: playback.startedAt,
          onsetAt: voiceStartedAt,
          voicedMs: voicedRun,
          rms,
          threshold,
        })
        if (decision.action !== 'report') {
          if (decision.selfEcho) echoBlocked = true
          return
        }
      } else if (speech < this.options.minSpeechMs) return
      announced = true
      try { this.options.onSpeechStart?.(onset()) } catch (error) { this.options.onError?.(error) }
    }

    /** Safety valve only: reported, unanswered, continuously voiced, still audible. */
    const fallbackCut = (): void => {
      if (!announced || echoBlocked || fallbackCutSent) return
      const playback = playbackNow()
      if (!playback.playing) return
      if (!shouldFallbackCut({
        playing: true,
        reported: true,
        hostResponded: playback.hostResponded,
        voicedMs: voicedRun,
        alreadyCut: fallbackCutSent,
      })) return
      fallbackCutSent = true
      try { this.options.onPlaybackStuck?.(onset()) } catch (error) { this.options.onError?.(error) }
    }

    const finalize = (): void => {
      const captured = flatten(segment)
      const seconds = captured.length / context.sampleRate
      const enough = speech >= this.options.minSpeechMs
      const wasAnnounced = announced
      // A guard-window onset is self-echo for the whole utterance: never report,
      // never transcribe it, and never let it pollute voiceprint enrolment.
      const swallowed = echoBlocked
      reset()
      if (swallowed) return
      // Leave ducked mode before transcription starts; waiting for the ASR
      // result kept the player quiet long after the user stopped speaking.
      if (wasAnnounced) {
        try { this.options.onSpeechEnd?.() } catch (error) { this.options.onError?.(error) }
      }
      if (!enough || captured.length === 0) return
      const samples = resample(captured, context.sampleRate, TARGET_RATE)
      try { this.options.onSegment?.(samples, seconds) } catch (error) { this.options.onError?.(error) }
    }

    processor.onaudioprocess = (event) => {
      if (!this.active) return
      const input = event.inputBuffer.getChannelData(0)
      const copy = new Float32Array(input.length)
      copy.set(input)
      let sum = 0
      for (const sample of copy) sum += sample * sample
      const rms = Math.sqrt(sum / copy.length)
      this.options.onLevel?.(Math.min(1, rms / 0.25))
      if (this.options.onFrame) {
        try { this.options.onFrame(resample(copy, context.sampleRate, TARGET_RATE)) }
        catch (error) { this.options.onError?.(error) }
      }

      // Learn only while the gate is closed: once speaking starts, freezing
      // the floor prevents the talker's own voice from raising the threshold.
      const manualThreshold = this.options.threshold
      if (!speaking && manualThreshold === undefined) noiseFloor.push(rms, chunkMs)
      const playback = playbackNow()
      const thresholds = resolveMicThresholds(noiseFloor.value, manualThreshold, playback)

      /** Mark the first frame and decide once whether this is frame echo. */
      const openUtterance = (): void => {
        speaking = true
        voiceStartedAt = Date.now()
        voicedRun = chunkMs
        const probe = playback.playing
          ? decideSpeechOnset({
            playing: true,
            playbackStartedAt: playback.startedAt,
            onsetAt: voiceStartedAt,
            voicedMs: 0,
          })
          : undefined
        echoBlocked = probe?.selfEcho === true
      }

      if (this.options.continuous) {
        if (!speaking) {
          if (rms < thresholds.onset) return
          openUtterance()
          speech = chunkMs
          silence = 0
          totalMs = chunkMs
          // Capture the complete utterance here as well. The legacy continuous
          // path only forwards frames; the fast path needs the full mixed audio
          // for one normal ASR call and for a possible on-demand separation.
          segment = [copy]
          announce(rms, thresholds.onset)
          return
        }
        segment.push(copy)
        totalMs += chunkMs
        if (rms >= thresholds.hold) {
          speech += chunkMs
          voicedRun += chunkMs
          silence = 0
          tailAnnounced = false
          announce(rms, thresholds.onset)
          fallbackCut()
        } else {
          voicedRun = 0
          silence += chunkMs
          // The endpoint is still silenceMs away; start the legacy continuous
          // separation prewarm now so its result is ready at the endpoint.
          if (!tailAnnounced && silence >= TAIL_HINT_MS) {
            tailAnnounced = true
            try { this.options.onSpeechTail?.() } catch (error) { this.options.onError?.(error) }
          }
        }
        if (totalMs >= this.options.maxSegmentMs
          || (silence >= this.options.silenceMs && speech >= this.options.minSpeechMs)) {
          finalize()
        }
        return
      }

      if (!speaking) {
        preRoll.push(copy)
        if (preRoll.length > preRollLimit) preRoll.shift()
        if (rms < thresholds.onset) return
        openUtterance()
        segment = [...preRoll, copy]
        speech = chunkMs
        silence = 0
        totalMs = segment.reduce((n, c) => n + c.length, 0) / context.sampleRate * 1000
        return
      }

      segment.push(copy)
      totalMs += chunkMs
      if (rms >= thresholds.hold) {
        speech += chunkMs
        voicedRun += chunkMs
        silence = 0
        // A single click or speaker echo must not open the gate; playback also
        // requires PLAYBACK_MIN_VOICED_MS of *contiguous* voicing.
        announce(rms, thresholds.onset)
        fallbackCut()
      } else {
        voicedRun = 0
        silence += chunkMs
      }
      if (totalMs >= this.options.maxSegmentMs || (silence >= this.options.silenceMs && speech >= this.options.minSpeechMs)) {
        finalize()
      }
    }
  }
}

export interface RecordVoiceOptions {
  /** Recording length; enrollment works best with 5-8 seconds. */
  seconds?: number
  deviceId?: string
  onLevel?: (level: number) => void
  signal?: AbortSignal
}

/**
 * Record one finite voice sample for speaker enrollment.
 *
 * The continuous loop above is optimized for streaming utterances; this one
 * returns a complete 16 kHz buffer so the host can compute one embedding.
 * It never uploads audio itself: the caller sends it to the local host only.
 */
export async function recordVoiceSample(options: RecordVoiceOptions = {}): Promise<Float32Array> {
  if (options.signal?.aborted) throw new Error('录音已取消')
  const seconds = Math.min(15, Math.max(1, options.seconds ?? 6.5))
  const devices = (navigator as Partial<Navigator>).mediaDevices
  if (!devices) throw new Error('当前页面不是安全上下文，浏览器不提供麦克风 API；请使用 HTTPS 或 localhost。')
  const stream = await devices.getUserMedia({
    audio: {
      echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1,
      ...(options.deviceId ? { deviceId: { exact: options.deviceId } } : {}),
    },
    video: false,
  })
  let context: AudioContext
  try {
    const Ctor = window.AudioContext
    // Enrollment also runs beside playback; do not force a narrowband device.
    context = new Ctor()
    await context.resume()
  } catch (error) {
    stream.getTracks().forEach((track) => { track.stop() })
    throw error
  }
  const source = context.createMediaStreamSource(stream)
  const processor = context.createScriptProcessor(BUFFER_SIZE, 1, 1)
  const sink = context.createGain()
  sink.gain.value = 0
  const chunks: Float32Array[] = []
  let peak = 0
  let done = false
  let timer: ReturnType<typeof setTimeout> | undefined
  return await new Promise<Float32Array>((resolve, reject) => {
    const cleanup = async (error?: unknown): Promise<void> => {
      if (done) return
      done = true
      if (timer !== undefined) clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      processor.onaudioprocess = null
      try {
        processor.disconnect()
        source.disconnect()
        sink.disconnect()
      } catch {
        // A partially constructed graph can already be detached.
      }
      stream.getTracks().forEach((track) => { track.stop() })
      const captured = flatten(chunks)
      const samples = resample(captured, context.sampleRate, TARGET_RATE)
      if (context.state !== 'closed') await context.close().catch(() => undefined)
      if (error) { reject(error); return }
      if (peak < 0.008) { reject(new Error('没有听到声音，请靠近麦克风再试')); return }
      if (samples.length / TARGET_RATE < 1) { reject(new Error('录音太短，请说满两秒再试')); return }
      resolve(samples)
    }
    const onAbort = (): void => { void cleanup(new Error('录音已取消')) }
    timer = setTimeout(() => { void cleanup() }, seconds * 1000)
    options.signal?.addEventListener('abort', onAbort)
    processor.onaudioprocess = (event) => {
      if (done) return
      const input = event.inputBuffer.getChannelData(0)
      const copy = new Float32Array(input.length)
      copy.set(input)
      chunks.push(copy)
      let sum = 0
      for (const sample of copy) sum += sample * sample
      const rms = Math.sqrt(sum / copy.length)
      if (rms > peak) peak = rms
      options.onLevel?.(Math.min(1, rms / 0.25))
    }
    source.connect(processor)
    processor.connect(sink)
    sink.connect(context.destination)
  })
}
