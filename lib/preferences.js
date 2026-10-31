const STORAGE_KEY = "dsh-voice-dialog.preferences";
const SPEAKER_THRESHOLD_MIN = 0.35;
const SPEAKER_THRESHOLD_MAX = 1;
const SPEAKER_THRESHOLD_DEFAULT = 0.5;
const PARTIAL_ASR_MIN_MS = 0;
const PARTIAL_ASR_MAX_MS = 2e3;
function clampPartialAsr(value, fallback) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? Math.min(PARTIAL_ASR_MAX_MS, Math.max(PARTIAL_ASR_MIN_MS, Math.round(number))) : fallback;
}
const DEFAULT_PREFERENCES = {
  autoRead: true,
  volume: 0.9,
  duckLevel: 0.85,
  speechBoost: 1.8,
  deviceId: "",
  pauseMs: 900,
  micThreshold: 0,
  speakerPrefix: true,
  speakerGate: false,
  speakerThreshold: SPEAKER_THRESHOLD_DEFAULT,
  ownerMargin: 0.12,
  ownerMode: "queue",
  guestMode: "queue",
  parallelAsr: true,
  partialAsrMs: 400,
  separateSpeakers: true,
  separationFastPath: true,
  organizerEnabled: true,
  chunkMaxChars: 0
};
const DEFAULTS = {
  autoRead: true,
  volume: 0.9,
  duckLevel: 0.85,
  speechBoost: 1.8,
  deviceId: "",
  pauseMs: 900,
  micThreshold: 0,
  speakerPrefix: true,
  speakerGate: false,
  speakerThreshold: SPEAKER_THRESHOLD_DEFAULT,
  ownerMargin: 0.12,
  ownerMode: "queue",
  guestMode: "queue",
  parallelAsr: true,
  partialAsrMs: 400,
  separateSpeakers: true,
  separationFastPath: true,
  organizerEnabled: true,
  chunkMaxChars: 0
};
function clampPause(value, fallback) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? Math.min(4e3, Math.max(0, Math.round(number))) : fallback;
}
function clampThreshold(value, fallback) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? Math.min(SPEAKER_THRESHOLD_MAX, Math.max(SPEAKER_THRESHOLD_MIN, Math.round(number * 100) / 100)) : fallback;
}
function clampMargin(value, fallback) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? Math.min(0.3, Math.max(0.04, Math.round(number * 100) / 100)) : fallback;
}
function clampBoost(value, fallback) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? Math.min(2.5, Math.max(1, Math.round(number * 10) / 10)) : fallback;
}
function clampChunkMax(value, fallback) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? Math.min(400, Math.max(0, Math.round(number))) : fallback;
}
function clampMicThreshold(value, fallback) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? Math.min(0.08, Math.max(0, Math.round(number * 1e3) / 1e3)) : fallback;
}
function parseGuestMode(value, fallback) {
  return value === "queue" || value === "steer" || value === "ignore" ? value : fallback;
}
function parseOwnerMode(value, fallback) {
  return value === "queue" || value === "steer" ? value : fallback;
}
const listeners = /* @__PURE__ */ new Set();
function clamp(value, fallback) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? Math.min(1, Math.max(0, number)) : fallback;
}
function parse(raw) {
  if (!raw) return { ...DEFAULTS };
  try {
    const value = JSON.parse(raw);
    return {
      autoRead: typeof value.autoRead === "boolean" ? value.autoRead : DEFAULTS.autoRead,
      volume: clamp(value.volume, DEFAULTS.volume),
      // Speaking barely lowers the reading now: an old 0.3 value made every answer
      // sound distant, and with the microphone always on it ducked constantly.
      duckLevel: Math.max(0.8, clamp(value.duckLevel, DEFAULTS.duckLevel)),
      speechBoost: clampBoost(value.speechBoost, DEFAULTS.speechBoost),
      deviceId: typeof value.deviceId === "string" ? value.deviceId : DEFAULTS.deviceId,
      pauseMs: clampPause(value.pauseMs, DEFAULTS.pauseMs),
      // 0.022 was the old hard-coded default, not a deliberate choice: migrate
      // it to the adaptive gate so existing profiles get the new behaviour.
      micThreshold: clampMicThreshold(value.micThreshold, 0) === 0.022 ? 0 : clampMicThreshold(value.micThreshold, DEFAULTS.micThreshold),
      speakerPrefix: typeof value.speakerPrefix === "boolean" ? value.speakerPrefix : DEFAULTS.speakerPrefix,
      speakerGate: typeof value.speakerGate === "boolean" ? value.speakerGate : DEFAULTS.speakerGate,
      speakerThreshold: clampThreshold(value.speakerThreshold, DEFAULTS.speakerThreshold),
      ownerMargin: clampMargin(value.ownerMargin, DEFAULTS.ownerMargin),
      ownerMode: parseOwnerMode(value.ownerMode, DEFAULTS.ownerMode),
      guestMode: parseGuestMode(value.guestMode, DEFAULTS.guestMode),
      parallelAsr: typeof value.parallelAsr === "boolean" ? value.parallelAsr : DEFAULTS.parallelAsr,
      // 0 used to mean "off". A stored 0 is an old profile, not a request for
      // silence: partial recognition is part of the recording layer now.
      partialAsrMs: clampPartialAsr(value.partialAsrMs, DEFAULTS.partialAsrMs) === 0 ? DEFAULTS.partialAsrMs : clampPartialAsr(value.partialAsrMs, DEFAULTS.partialAsrMs),
      separateSpeakers: typeof value.separateSpeakers === "boolean" ? value.separateSpeakers : DEFAULTS.separateSpeakers,
      separationFastPath: typeof value.separationFastPath === "boolean" ? value.separationFastPath : DEFAULTS.separationFastPath,
      organizerEnabled: typeof value.organizerEnabled === "boolean" ? value.organizerEnabled : DEFAULTS.organizerEnabled,
      chunkMaxChars: clampChunkMax(value.chunkMaxChars, DEFAULTS.chunkMaxChars)
    };
  } catch {
    return { ...DEFAULTS };
  }
}
let current;
function getPreferences() {
  if (current === void 0) {
    try {
      current = parse(localStorage.getItem(STORAGE_KEY));
    } catch {
      current = { ...DEFAULTS };
    }
  }
  return current;
}
function setPreferences(patch) {
  const next = { ...getPreferences(), ...patch };
  next.volume = clamp(next.volume, DEFAULTS.volume);
  next.duckLevel = Math.max(0.8, clamp(next.duckLevel, DEFAULTS.duckLevel));
  next.speechBoost = clampBoost(next.speechBoost, DEFAULTS.speechBoost);
  next.pauseMs = clampPause(next.pauseMs, DEFAULTS.pauseMs);
  next.micThreshold = clampMicThreshold(next.micThreshold, DEFAULTS.micThreshold);
  next.speakerThreshold = clampThreshold(next.speakerThreshold, DEFAULTS.speakerThreshold);
  next.ownerMargin = clampMargin(next.ownerMargin, DEFAULTS.ownerMargin);
  next.ownerMode = parseOwnerMode(next.ownerMode, DEFAULTS.ownerMode);
  next.guestMode = parseGuestMode(next.guestMode, DEFAULTS.guestMode);
  next.parallelAsr = typeof next.parallelAsr === "boolean" ? next.parallelAsr : DEFAULTS.parallelAsr;
  next.partialAsrMs = clampPartialAsr(next.partialAsrMs, DEFAULTS.partialAsrMs);
  next.separateSpeakers = typeof next.separateSpeakers === "boolean" ? next.separateSpeakers : DEFAULTS.separateSpeakers;
  next.separationFastPath = typeof next.separationFastPath === "boolean" ? next.separationFastPath : DEFAULTS.separationFastPath;
  next.organizerEnabled = typeof next.organizerEnabled === "boolean" ? next.organizerEnabled : DEFAULTS.organizerEnabled;
  next.chunkMaxChars = clampChunkMax(next.chunkMaxChars, DEFAULTS.chunkMaxChars);
  current = next;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
  }
  for (const listener of listeners) listener(next);
  return next;
}
function subscribePreferences(listener) {
  listeners.add(listener);
  listener(getPreferences());
  return () => {
    listeners.delete(listener);
  };
}
export {
  DEFAULT_PREFERENCES,
  PARTIAL_ASR_MAX_MS,
  PARTIAL_ASR_MIN_MS,
  SPEAKER_THRESHOLD_DEFAULT,
  SPEAKER_THRESHOLD_MAX,
  SPEAKER_THRESHOLD_MIN,
  clampPartialAsr,
  clampPause,
  getPreferences,
  setPreferences,
  subscribePreferences
};
