function encodeWave(samples) {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const text = (at, value) => {
    for (let i = 0; i < value.length; i++) bytes[at + i] = value.charCodeAt(i);
  };
  text(0, "RIFF");
  view.setUint32(4, bytes.length - 8, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16e3, true);
  view.setUint32(28, 32e3, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const value = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true);
  }
  return bytes;
}
function audioBase64(bytes) {
  let text = "";
  for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(text);
}
function decodeWaveBase64(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  if (bytes.length < 12 || String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) !== "RIFF" || String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]) !== "WAVE") {
    throw new Error("\u4E0D\u662F\u6709\u6548\u7684 WAV \u6570\u636E");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let format = 0;
  let channels = 0;
  let bits = 0;
  let dataOffset = 0;
  let dataLength = 0;
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const id = String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (body + size > bytes.length) break;
    if (id === "fmt ") {
      format = view.getUint16(body, true);
      channels = view.getUint16(body + 2, true);
      bits = view.getUint16(body + 14, true);
    } else if (id === "data") {
      dataOffset = body;
      dataLength = size;
      break;
    }
    offset = body + size + size % 2;
  }
  if (format !== 1 || channels !== 1 || bits !== 16 || dataLength === 0) {
    throw new Error("\u53EA\u652F\u6301 16 kHz \u5355\u58F0\u9053 16 \u4F4D WAV");
  }
  const samples = new Float32Array(Math.floor(dataLength / 2));
  for (let i = 0; i < samples.length; i++) {
    samples[i] = view.getInt16(dataOffset + i * 2, true) / 32768;
  }
  return samples;
}
export {
  audioBase64,
  decodeWaveBase64,
  encodeWave
};
