const YIELD_RESUME_AFTER_SPEECH_MS = 1600;
const YIELD_SHORT_UTTERANCE_MS = 400;
const YIELD_SHORT_RESUME_MS = 320;
function resumeDelayForUtterance(speechMs) {
  if (typeof speechMs !== "number" || !Number.isFinite(speechMs) || speechMs < 0) {
    return YIELD_RESUME_AFTER_SPEECH_MS;
  }
  return speechMs < YIELD_SHORT_UTTERANCE_MS ? YIELD_SHORT_RESUME_MS : YIELD_RESUME_AFTER_SPEECH_MS;
}
export {
  YIELD_RESUME_AFTER_SPEECH_MS,
  YIELD_SHORT_RESUME_MS,
  YIELD_SHORT_UTTERANCE_MS,
  resumeDelayForUtterance
};
