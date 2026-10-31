const DEFAULT_SPEECH_PROFILE = {
  interruption: "sentence",
  mergeMaxChars: 40,
  mergeRunMaxChars: 160,
  mergeRunMaxItems: 6,
  betweenBlocksMs: 0,
  micSilenceMs: 900,
  separationSilenceMs: 1600,
  rhythm: "natural",
  innerPauseMs: 0,
  backchannel: "none",
  backchannelAfterMs: 900,
  warmOpen: false,
  firstBlockChars: 8,
  firstBlockDeadlineMs: 0
};
const INTERRUPTION_MODES = ["sentence", "immediate", "never"];
const NUMERIC_RANGES = [
  ["mergeMaxChars", 8, 400],
  ["mergeRunMaxChars", 8, 1200],
  ["mergeRunMaxItems", 1, 32],
  ["betweenBlocksMs", 0, 2e3],
  ["micSilenceMs", 400, 4e3],
  ["separationSilenceMs", 400, 4e3],
  ["innerPauseMs", 0, 400],
  ["backchannelAfterMs", 200, 3e3],
  ["firstBlockChars", 4, 12],
  ["firstBlockDeadlineMs", 0, 2e3]
];
const RHYTHM_MODES = ["natural", "off"];
const BACKCHANNEL_WORDS = ["none", "\u55EF", "\u5728", "\u597D"];
function clampInteger(value, low, high) {
  const number = typeof value === "number" ? value : Number.NaN;
  if (!Number.isFinite(number)) return void 0;
  return Math.min(high, Math.max(low, Math.round(number)));
}
function normalizeSpeechProfile(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const record = input;
  const profile = {};
  const mode = record.interruption;
  if (typeof mode === "string" && INTERRUPTION_MODES.includes(mode)) {
    profile.interruption = mode;
  }
  const rhythm = record.rhythm;
  if (typeof rhythm === "string" && RHYTHM_MODES.includes(rhythm)) {
    profile.rhythm = rhythm;
  }
  const backchannel = record.backchannel;
  if (typeof backchannel === "string" && BACKCHANNEL_WORDS.includes(backchannel)) {
    profile.backchannel = backchannel;
  }
  if (typeof record.warmOpen === "boolean") profile.warmOpen = record.warmOpen;
  for (const [key, low, high] of NUMERIC_RANGES) {
    const value = clampInteger(record[key], low, high);
    if (value !== void 0) profile[key] = value;
  }
  return profile;
}
function resolveSpeechProfile(declared, fallback) {
  const resolved = { ...DEFAULT_SPEECH_PROFILE };
  for (const source of [fallback, declared]) {
    if (!source) continue;
    for (const [key, value] of Object.entries(source)) {
      if (value !== void 0) resolved[key] = value;
    }
  }
  return resolved;
}
export {
  DEFAULT_SPEECH_PROFILE,
  normalizeSpeechProfile,
  resolveSpeechProfile
};
