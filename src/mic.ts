/** Adapted from the built-in DSH voice-input audio capture (MIT). See NOTICE. */
/** Continuous microphone capture with RMS endpoint detection; outputs 16 kHz mono samples. */

export interface MicOptions {
  /** Leading audio retained before speech starts. */
  preRollMs?: number
  /** Trailing silence that closes one utterance. */
  silenceMs?: number
  /** Ignore bursts shorter than this. */
  minSpeechMs?: number
  /** Hard cap so one utterance cannot grow without bound. */
  maxSegmentMs?: number
  /** RMS opening threshold. */
  threshold?: number
  /** Preferred input device; empty uses the browser default. */
  deviceId?: string
  onLevel?: (level: number) => void
  onSpeechStart?: () => void
  /** Fired once the utterance closes, so playback can leave ducked mode. */
  onSpeechEnd?: () => void
  onSegment?: (samples: Float32Array, seconds: number) => void
  onError?: (error: unknown) => void
}

const TARGET_RATE = 16_000
const BUFFER_SIZE = 1024

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
  private readonly options: Required<Pick<MicOptions, 'preRollMs' | 'silenceMs' | 'minSpeechMs' | 'maxSegmentMs' | 'threshold' | 'deviceId'>> & MicOptions

  constructor(options: MicOptions = {}) {
    this.options = {
      preRollMs: options.preRollMs ?? 320,
      silenceMs: options.silenceMs ?? 1400,
      minSpeechMs: options.minSpeechMs ?? 260,
      maxSegmentMs: options.maxSegmentMs ?? 25_000,
      threshold: options.threshold ?? 0.022,
      deviceId: options.deviceId ?? '',
      ...options,
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
    try { this.context = new Ctor({ sampleRate: TARGET_RATE }) }
    catch { this.context = new Ctor() }
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

    const reset = (): void => {
      preRoll = []
      segment = []
      speaking = false
      silence = 0
      speech = 0
      totalMs = 0
      announced = false
    }

    const finalize = (): void => {
      const captured = flatten(segment)
      const seconds = captured.length / context.sampleRate
      const enough = speech >= this.options.minSpeechMs
      const wasAnnounced = announced
      reset()
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

      if (!speaking) {
        preRoll.push(copy)
        if (preRoll.length > preRollLimit) preRoll.shift()
        if (rms < this.options.threshold) return
        speaking = true
        segment = [...preRoll, copy]
        speech = chunkMs
        silence = 0
        totalMs = segment.reduce((n, c) => n + c.length, 0) / context.sampleRate * 1000
        return
      }

      segment.push(copy)
      totalMs += chunkMs
      if (rms >= this.options.threshold) {
        speech += chunkMs
        silence = 0
        // A single click or speaker echo must not duck playback. Require a
        // short sustained utterance before treating it as a barge-in.
        if (!announced && speech >= this.options.minSpeechMs) {
          announced = true
          try { this.options.onSpeechStart?.() } catch (error) { this.options.onError?.(error) }
        }
      } else {
        silence += chunkMs
      }
      if (totalMs >= this.options.maxSegmentMs || (silence >= this.options.silenceMs && speech >= this.options.minSpeechMs)) {
        finalize()
      }
    }
  }
}