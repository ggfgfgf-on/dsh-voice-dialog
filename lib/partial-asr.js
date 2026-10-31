const PARTIAL_WINDOW_MS = 1e4;
const PARTIAL_MIN_SPEECH_MS = 300;
const PARTIAL_ASR_DEFAULT_MS = 400;
const PARTIAL_FEED_MAX_WAIT_MS = 400;
function clampPartialMs(value) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? Math.min(2e3, Math.max(0, Math.round(number))) : 0;
}
function partialIntervalFor(storedMs = PARTIAL_ASR_DEFAULT_MS) {
  const stored = Number(storedMs);
  if (!Number.isFinite(stored)) return 0;
  return clampPartialMs(stored);
}
function partialFeedEnabled(waitMs) {
  const wait = Number(waitMs);
  return Number.isFinite(wait) && wait >= 0 && wait <= PARTIAL_FEED_MAX_WAIT_MS;
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
  PARTIAL_ASR_DEFAULT_MS,
  PARTIAL_FEED_MAX_WAIT_MS,
  PARTIAL_MIN_SPEECH_MS,
  PARTIAL_WINDOW_MS,
  clampPartialMs,
  dedupePartial,
  partialFeedEnabled,
  partialIntervalFor,
  shouldFirePartial,
  trimPartialWindow
};
