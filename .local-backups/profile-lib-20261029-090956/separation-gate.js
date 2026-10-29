const FRAME_MS = 100;
const MIN_ACTIVE_MS = 700;
const TARGET_WINDOW_MS = 1600;
const MIN_WINDOW_SAMPLES = 5600;
const DEFAULT_SINGLE_THRESHOLD = 0.62;
const DEFAULT_SUSPECT_THRESHOLD = 0.48;
const DEFAULT_OWNER_FLOOR = 0.5;
function frameRms(samples, start, length) {
  let sum = 0;
  const end = Math.min(samples.length, start + length);
  for (let i = start; i < end; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / Math.max(1, end - start));
}
function selectSpeechWindows(samples, sampleRate = 16e3) {
  const rate = Math.max(1e3, Math.floor(sampleRate));
  const frame = Math.max(160, Math.round(rate * FRAME_MS / 1e3));
  if (samples.length < frame * 2) {
    return { windows: [], activeSamples: 0, reason: "too-short" };
  }
  const levels = [];
  for (let at = 0; at + frame <= samples.length; at += frame) levels.push(frameRms(samples, at, frame));
  const sorted = [...levels].sort((a, b) => a - b);
  const noise = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.2))] ?? 0;
  const threshold = Math.max(6e-3, noise * 2.2);
  let first = -1;
  let last = -1;
  for (let index = 0; index < levels.length; index++) {
    if (levels[index] < threshold) continue;
    if (index + 1 < levels.length && levels[index + 1] < threshold) continue;
    if (first < 0) first = index;
    last = index + 1;
  }
  if (first < 0 || last <= first) return { windows: [], activeSamples: 0, reason: "no-speech" };
  const activeStart = first * frame;
  const activeEnd = Math.min(samples.length, last * frame);
  const activeSamples = activeEnd - activeStart;
  if (activeSamples < Math.round(rate * MIN_ACTIVE_MS / 1e3)) {
    return { windows: [], activeSamples, reason: "too-short" };
  }
  const windowSamples = Math.min(
    Math.round(rate * TARGET_WINDOW_MS / 1e3),
    Math.floor(activeSamples * 0.42)
  );
  if (windowSamples < MIN_WINDOW_SAMPLES) {
    return { windows: [], activeSamples, reason: "too-short" };
  }
  return {
    windows: [
      { samples: samples.slice(activeStart, activeStart + windowSamples), startSample: activeStart, endSample: activeStart + windowSamples },
      { samples: samples.slice(activeEnd - windowSamples, activeEnd), startSample: activeEnd - windowSamples, endSample: activeEnd }
    ],
    activeSamples,
    reason: "ok"
  };
}
function decideSpeakerGate(input) {
  const singleThreshold = input.singleThreshold ?? DEFAULT_SINGLE_THRESHOLD;
  const suspectThreshold = input.suspectThreshold ?? DEFAULT_SUSPECT_THRESHOLD;
  const ownerFloor = input.ownerFloor ?? DEFAULT_OWNER_FLOOR;
  const similarities = input.selfSimilarities.filter((value) => Number.isFinite(value));
  if (similarities.length === 0) {
    return { suspected: true, singleSpeaker: false, confident: false, reason: "insufficient-audio", threshold: singleThreshold };
  }
  const minSimilarity = Math.min(...similarities);
  const ownerSimilarity = typeof input.ownerSimilarity === "number" && Number.isFinite(input.ownerSimilarity) ? input.ownerSimilarity : void 0;
  const common = {
    minSimilarity: Math.round(minSimilarity * 1e3) / 1e3,
    ...ownerSimilarity === void 0 ? {} : { ownerSimilarity: Math.round(ownerSimilarity * 1e3) / 1e3 },
    threshold: singleThreshold
  };
  if (minSimilarity < suspectThreshold) {
    return { ...common, suspected: true, singleSpeaker: false, confident: true, reason: "voice-changed" };
  }
  if (ownerSimilarity !== void 0 && ownerSimilarity < ownerFloor) {
    return { ...common, suspected: true, singleSpeaker: false, confident: true, reason: "owner-mismatch" };
  }
  if (minSimilarity >= singleThreshold) {
    return { ...common, suspected: false, singleSpeaker: true, confident: true, reason: "same-voice" };
  }
  return { ...common, suspected: false, singleSpeaker: false, confident: false, reason: "uncertain" };
}
export {
  decideSpeakerGate,
  selectSpeechWindows
};
