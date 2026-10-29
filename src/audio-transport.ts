/**
 * Binary audio transport for the local voice pipeline.
 *
 * The old path shipped every segment as base64 WAV inside JSON, which costs two
 * full copies of the audio on the client (WAV encode, then base64) and two more
 * on the host (JSON parse, then base64/WAV decode). This container carries raw
 * PCM16 little-endian frames instead: one pass to Int16 on the client, one pass
 * back to Float32 on the host, no base64.
 *
 * Layout (all little endian):
 *   container: "VDP1" | u8 version | u8 flags | u16 reserved | u32 sampleRate | u32 totalSamples
 *   frame:     u16 byteLength | byteLength bytes of PCM16
 */

export const AUDIO_CONTAINER_MAGIC = 'VDP1'
export const AUDIO_TRANSPORT_VERSION = 1
export const AUDIO_CONTAINER_HEADER_BYTES = 16
/** 300 ms at 16 kHz keeps every frame inside a u16 length field. */
export const AUDIO_FRAME_SAMPLES = 4800
export const AUDIO_SAMPLE_RATE = 16_000

export interface DecodedAudioFrames {
  samples: Float32Array
  sampleRate: number
  /** Frames dropped because their length field was impossible. */
  droppedFrames: number
  /** True when the container ended in the middle of a frame. */
  truncated: boolean
}

function clampSample(value: number): number {
  if (!(value === value)) return 0
  if (value > 1) return 1
  if (value < -1) return -1
  return value
}

/** Encode Float32 samples into the binary container. */
export function encodeAudioFrames(
  samples: Float32Array,
  options: { sampleRate?: number; frameSamples?: number } = {},
): Uint8Array {
  const sampleRate = options.sampleRate ?? AUDIO_SAMPLE_RATE
  const frameSamples = Math.max(1, Math.min(32_000, options.frameSamples ?? AUDIO_FRAME_SAMPLES))
  const frameCount = Math.max(1, Math.ceil(samples.length / frameSamples))
  let bytes = AUDIO_CONTAINER_HEADER_BYTES
  const frames: Array<[number, number]> = []
  for (let index = 0; index < frameCount; index++) {
    const start = index * frameSamples
    const count = Math.min(frameSamples, Math.max(0, samples.length - start))
    frames.push([start, count])
    bytes += 2 + count * 2
  }
  const out = new Uint8Array(bytes)
  const view = new DataView(out.buffer)
  for (let i = 0; i < 4; i++) out[i] = AUDIO_CONTAINER_MAGIC.charCodeAt(i)
  out[4] = AUDIO_TRANSPORT_VERSION
  out[5] = 0
  view.setUint16(6, 0, true)
  view.setUint32(8, sampleRate, true)
  view.setUint32(12, samples.length, true)
  let offset = AUDIO_CONTAINER_HEADER_BYTES
  for (const [start, count] of frames) {
    view.setUint16(offset, count * 2, true)
    offset += 2
    for (let i = 0; i < count; i++) {
      const value = clampSample(samples[start + i]!)
      view.setInt16(offset, Math.round(value * (value < 0 ? 32768 : 32767)), true)
      offset += 2
    }
  }
  return out
}

/** Decode the binary container; impossible frames are dropped, never thrown. */
export function decodeAudioFrames(bytes: Uint8Array): DecodedAudioFrames {
  if (bytes.length < AUDIO_CONTAINER_HEADER_BYTES) throw new Error('音频数据过短')
  for (let i = 0; i < 4; i++) {
    if (bytes[i] !== AUDIO_CONTAINER_MAGIC.charCodeAt(i)) throw new Error('音频容器标识不匹配')
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const version = bytes[4]!
  if (version !== AUDIO_TRANSPORT_VERSION) throw new Error('不支持的音频容器版本 ' + version)
  const sampleRate = view.getUint32(8, true)
  const totalSamples = view.getUint32(12, true)
  if (sampleRate < 8_000 || sampleRate > 48_000) throw new Error('采样率异常 ' + sampleRate)
  const samples = new Float32Array(Math.min(totalSamples, 16_000 * 120))
  let written = 0
  let offset = AUDIO_CONTAINER_HEADER_BYTES
  let droppedFrames = 0
  let truncated = false
  while (offset < bytes.length) {
    if (offset + 2 > bytes.length) { truncated = true; break }
    const byteLength = view.getUint16(offset, true)
    offset += 2
    if (byteLength === 0 || byteLength % 2 !== 0 || offset + byteLength > bytes.length) {
      // A frame with an impossible length cannot be trusted; skip it and stop,
      // because there is no reliable way to find the next frame boundary.
      droppedFrames += 1
      truncated = true
      break
    }
    const count = byteLength / 2
    if (written + count > samples.length) {
      droppedFrames += 1
      truncated = true
      break
    }
    for (let i = 0; i < count; i++) samples[written + i] = view.getInt16(offset + i * 2, true) / 32768
    written += count
    offset += byteLength
  }
  return { samples: samples.subarray(0, written), sampleRate, droppedFrames, truncated }
}

export interface BinaryTransportState {
  /** Set after a failed attempt; every later call goes straight to the JSON path. */
  broken: boolean
}

type FetchLike = (input: string, init: Record<string, unknown>) => Promise<{
  ok: boolean
  status?: number
  json(): Promise<unknown>
}>

/**
 * Upload one segment over the binary route. Returns null when the route is not
 * available, so the caller can fall back to the JSON path; the failure is
 * remembered so a host without the route costs exactly one wasted request.
 */
export async function postAudioFrames(
  fetchImpl: FetchLike,
  url: string,
  samples: Float32Array,
  headers: Record<string, string>,
  state: BinaryTransportState,
): Promise<unknown | null> {
  if (state.broken) return null
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream', ...headers },
      body: encodeAudioFrames(samples),
    })
    if (response && response.ok) return await response.json()
    state.broken = true
    return null
  } catch {
    state.broken = true
    return null
  }
}

/** Round-trip helper used by tests and the benchmark. */
export function audioFramesToFloat32(bytes: Uint8Array): Float32Array {
  return decodeAudioFrames(bytes).samples
}
