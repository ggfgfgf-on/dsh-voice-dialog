/** Owner-onset yield policy: how long a held sentence waits for a decision. */

/**
 * Speech this long counts as someone taking the floor. A cough, a click or a
 * single syllable ducks the volume but never stops the sentence.
 */
export const YIELD_CONFIRM_MS = 300
/** A real interruption waits this long for the routing decision after speech. */
export const YIELD_RESUME_AFTER_SPEECH_MS = 1600
/** Anything shorter than this is a cough or a backchannel, not a takeover. */
export const YIELD_SHORT_UTTERANCE_MS = 400
/** A blip resumes after this short silence instead of a full decision wait. */
export const YIELD_SHORT_RESUME_MS = 320

/**
 * Silence the held sentence must keep after the speaker stops. Long utterances
 * wait for the router (the answer is coming); blips do not hold the floor.
 */
export function resumeDelayForUtterance(speechMs: number): number {
  if (typeof speechMs !== 'number' || !Number.isFinite(speechMs) || speechMs < 0) {
    return YIELD_RESUME_AFTER_SPEECH_MS
  }
  return speechMs < YIELD_SHORT_UTTERANCE_MS ? YIELD_SHORT_RESUME_MS : YIELD_RESUME_AFTER_SPEECH_MS
}
