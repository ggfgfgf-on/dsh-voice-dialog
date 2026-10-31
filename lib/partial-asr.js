const PARTIAL_WINDOW_MS = 1e4;
const PARTIAL_MIN_SPEECH_MS = 300;
const IMMEDIATE_PARTIAL_MS = 400;
function clampPartialMs(value) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? Math.min(2e3, Math.max(0, Math.round(number))) : 0;
}
function partialIntervalFor(waitMs, storedMs = 0) {
  const wait = Number(waitMs);
  if (!Number.isFinite(wait) || wait > 0) return 0;
  const stored = Number(storedMs);
  return Number.isFinite(stored) && stored > 0 ? stored : IMMEDIATE_PARTIAL_MS;
}
function shouldFirePartial(input) {
  if (!input.enabled) return false;
  if (!(input.intervalMs > 0)) return false;
  if (input.inFlight) return false;
  if (input.finalizing) return false;
  if (!(input.speechMs >= (input.minSpeechMs ?? PARTIAL_MIN_SPEECH_MS))) return false;
  if (!(input.sinceLastMs >= input.intervalMs)) return false;
  return true;
}
function dedupePartial(previous, next) {
  const clean = String(next ?? "").replace(/\s+/gu, " ").trim();
  if (clean.length === 0) return null;
  const last = String(previous ?? "").trim();
  if (clean === last) return null;
  if (clean.length <= last.length) return null;
  return clean;
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
export {
  IMMEDIATE_PARTIAL_MS,
  PARTIAL_MIN_SPEECH_MS,
  PARTIAL_WINDOW_MS,
  clampPartialMs,
  dedupePartial,
  partialIntervalFor,
  shouldFirePartial,
  trimPartialWindow
};
