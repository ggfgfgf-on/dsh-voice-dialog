const PLAYBACK_ECHO_GUARD_MS = 300;
const PLAYBACK_MIN_VOICED_MS = 400;
const PLAYBACK_FALLBACK_CUT_MS = 1e3;
function decideSpeechOnset(input) {
  if (!input.playing) {
    return { action: "report", reason: "idle", selfEcho: false };
  }
  const since = typeof input.playbackStartedAt === "number" && Number.isFinite(input.playbackStartedAt) ? input.onsetAt - input.playbackStartedAt : void 0;
  if (since !== void 0 && since >= 0 && since < PLAYBACK_ECHO_GUARD_MS) {
    return {
      action: "ignore",
      reason: "playback-echo-guard",
      sincePlaybackMs: since,
      selfEcho: true
    };
  }
  if (!(input.voicedMs >= PLAYBACK_MIN_VOICED_MS)) {
    return {
      action: "ignore",
      reason: "playback-min-sustained",
      ...since === void 0 ? {} : { sincePlaybackMs: since },
      selfEcho: false
    };
  }
  if (typeof input.rms === "number" && typeof input.threshold === "number" && (!Number.isFinite(input.rms) || input.rms < input.threshold)) {
    return {
      action: "ignore",
      reason: "playback-echo-threshold",
      ...since === void 0 ? {} : { sincePlaybackMs: since },
      selfEcho: false
    };
  }
  return {
    action: "report",
    reason: "playback-sustained-onset",
    ...since === void 0 ? {} : { sincePlaybackMs: since },
    selfEcho: false
  };
}
function shouldFallbackCut(input) {
  const limit = typeof input.fallbackMs === "number" && Number.isFinite(input.fallbackMs) ? Math.max(PLAYBACK_MIN_VOICED_MS, input.fallbackMs) : PLAYBACK_FALLBACK_CUT_MS;
  return input.playing === true && input.reported === true && input.hostResponded !== true && input.alreadyCut !== true && input.voicedMs >= limit;
}
function decideBargeIn(input) {
  const playing = input.playing === true;
  if (input.lane === "guest") {
    if (input.guestMode === "ignore") {
      return {
        action: "none",
        finishSentence: false,
        keepRemainder: false,
        reason: "guest-ignore"
      };
    }
    if (input.guestMode === "steer" && playing) {
      return {
        action: "interrupt",
        finishSentence: true,
        keepRemainder: true,
        priority: -1,
        reason: "guest-steer-policy"
      };
    }
    return {
      action: playing ? "queue" : "none",
      finishSentence: false,
      keepRemainder: false,
      reason: "guest-default-queue"
    };
  }
  if (!playing) {
    return {
      action: "none",
      finishSentence: false,
      keepRemainder: false,
      reason: "owner-idle"
    };
  }
  return {
    action: "queue",
    finishSentence: false,
    keepRemainder: true,
    reason: "owner-playback-report-only"
  };
}
function isSameSentence(left, right) {
  return typeof left.sentenceId === "number" && Number.isFinite(left.sentenceId) && left.sentenceId === right.sentenceId;
}
function splitAtSentenceBoundary(current, queued) {
  if (!current) {
    return { finish: [], remainder: [...queued], stopAfterCurrent: false };
  }
  let boundary = 0;
  while (boundary < queued.length && isSameSentence(current, queued[boundary])) boundary += 1;
  return {
    finish: queued.slice(0, boundary),
    remainder: queued.slice(boundary),
    stopAfterCurrent: true
  };
}
function orderBargeInFrames(newReplyFrames, oldRemainder, keepRemainder = true) {
  return keepRemainder ? [...newReplyFrames, ...oldRemainder] : [...newReplyFrames];
}
export {
  PLAYBACK_ECHO_GUARD_MS,
  PLAYBACK_FALLBACK_CUT_MS,
  PLAYBACK_MIN_VOICED_MS,
  decideBargeIn,
  decideSpeechOnset,
  isSameSentence,
  orderBargeInFrames,
  shouldFallbackCut,
  splitAtSentenceBoundary
};
