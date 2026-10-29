const AUDIO_CONTAINER_MAGIC = "VDP1";
const AUDIO_TRANSPORT_VERSION = 1;
const AUDIO_CONTAINER_HEADER_BYTES = 16;
const AUDIO_FRAME_SAMPLES = 4800;
const AUDIO_SAMPLE_RATE = 16e3;
function clampSample(value) {
  if (!(value === value)) return 0;
  if (value > 1) return 1;
  if (value < -1) return -1;
  return value;
}
function encodeAudioFrames(samples, options = {}) {
  const sampleRate = options.sampleRate ?? AUDIO_SAMPLE_RATE;
  const frameSamples = Math.max(1, Math.min(32e3, options.frameSamples ?? AUDIO_FRAME_SAMPLES));
  const frameCount = Math.max(1, Math.ceil(samples.length / frameSamples));
  let bytes = AUDIO_CONTAINER_HEADER_BYTES;
  const frames = [];
  for (let index = 0; index < frameCount; index++) {
    const start = index * frameSamples;
    const count = Math.min(frameSamples, Math.max(0, samples.length - start));
    frames.push([start, count]);
    bytes += 2 + count * 2;
  }
  const out = new Uint8Array(bytes);
  const view = new DataView(out.buffer);
  for (let i = 0; i < 4; i++) out[i] = AUDIO_CONTAINER_MAGIC.charCodeAt(i);
  out[4] = AUDIO_TRANSPORT_VERSION;
  out[5] = 0;
  view.setUint16(6, 0, true);
  view.setUint32(8, sampleRate, true);
  view.setUint32(12, samples.length, true);
  let offset = AUDIO_CONTAINER_HEADER_BYTES;
  for (const [start, count] of frames) {
    view.setUint16(offset, count * 2, true);
    offset += 2;
    for (let i = 0; i < count; i++) {
      const value = clampSample(samples[start + i]);
      view.setInt16(offset, Math.round(value * (value < 0 ? 32768 : 32767)), true);
      offset += 2;
    }
  }
  return out;
}
function decodeAudioFrames(bytes) {
  if (bytes.length < AUDIO_CONTAINER_HEADER_BYTES) throw new Error("\u97F3\u9891\u6570\u636E\u8FC7\u77ED");
  for (let i = 0; i < 4; i++) {
    if (bytes[i] !== AUDIO_CONTAINER_MAGIC.charCodeAt(i)) throw new Error("\u97F3\u9891\u5BB9\u5668\u6807\u8BC6\u4E0D\u5339\u914D");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = bytes[4];
  if (version !== AUDIO_TRANSPORT_VERSION) throw new Error("\u4E0D\u652F\u6301\u7684\u97F3\u9891\u5BB9\u5668\u7248\u672C " + version);
  const sampleRate = view.getUint32(8, true);
  const totalSamples = view.getUint32(12, true);
  if (sampleRate < 8e3 || sampleRate > 48e3) throw new Error("\u91C7\u6837\u7387\u5F02\u5E38 " + sampleRate);
  const samples = new Float32Array(Math.min(totalSamples, 16e3 * 120));
  let written = 0;
  let offset = AUDIO_CONTAINER_HEADER_BYTES;
  let droppedFrames = 0;
  let truncated = false;
  while (offset < bytes.length) {
    if (offset + 2 > bytes.length) {
      truncated = true;
      break;
    }
    const byteLength = view.getUint16(offset, true);
    offset += 2;
    if (byteLength === 0 || byteLength % 2 !== 0 || offset + byteLength > bytes.length) {
      droppedFrames += 1;
      truncated = true;
      break;
    }
    const count = byteLength / 2;
    if (written + count > samples.length) {
      droppedFrames += 1;
      truncated = true;
      break;
    }
    for (let i = 0; i < count; i++) samples[written + i] = view.getInt16(offset + i * 2, true) / 32768;
    written += count;
    offset += byteLength;
  }
  return { samples: samples.subarray(0, written), sampleRate, droppedFrames, truncated };
}
async function postAudioFrames(fetchImpl, url, samples, headers, state) {
  if (state.broken) return null;
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/octet-stream", ...headers },
      body: encodeAudioFrames(samples)
    });
    if (response && response.ok) return await response.json();
    state.broken = true;
    return null;
  } catch {
    state.broken = true;
    return null;
  }
}
function audioFramesToFloat32(bytes) {
  return decodeAudioFrames(bytes).samples;
}
export {
  AUDIO_CONTAINER_HEADER_BYTES,
  AUDIO_CONTAINER_MAGIC,
  AUDIO_FRAME_SAMPLES,
  AUDIO_SAMPLE_RATE,
  AUDIO_TRANSPORT_VERSION,
  audioFramesToFloat32,
  decodeAudioFrames,
  encodeAudioFrames,
  postAudioFrames
};
