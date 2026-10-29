/** Pure owner/guest barge-in policy and sentence-boundary queue planning. */

export type BargeInAction = 'none' | 'queue' | 'interrupt'
export type BargeInLane = 'owner' | 'guest'
export type BargeInGuestMode = 'queue' | 'steer' | 'ignore'

export interface BargeInRequest {
  lane: BargeInLane
  /** True while a TTS frame is audible. */
  playing: boolean
  /** Captured utterances already waiting in the scheduler. */
  queued?: number
  /** Explicit guest policy; omitted means the safe default, queue. */
  guestMode?: BargeInGuestMode
}

export interface BargeInDecision {
  action: BargeInAction
  /** Let the sentence being spoken reach its endpoint before silence. */
  finishSentence: boolean
  /** Keep unread old-answer blocks instead of discarding them. */
  keepRemainder: boolean
  /** Lower numbers reach the scheduler earlier. */
  priority?: number
  reason: string
}

/**
 * Echo/selffloor guard constants. These are deliberately exported so the
 * browser audio path and its tests agree on the same numbers.
 */
export const PLAYBACK_ECHO_GUARD_MS = 300
/** While the assistant is audible, a blip is never enough to report speech. */
export const PLAYBACK_MIN_VOICED_MS = 400
/**
 * Last-resort cut after continuous speech while the host has not reacted.
 * This is NOT the normal barge-in path: the page reports the onset and the
 * host/model decides first. This timer only stops microphone/speaker feedback
 * when nobody responds for a full second.
 */
export const PLAYBACK_FALLBACK_CUT_MS = 1_000

export interface SpeechOnsetRequest {
  /** True while an assistant audio frame is audible. */
  playing: boolean
  /** Start of the current TTS frame, whose echo can mask an onset. */
  playbackStartedAt?: number
  /** First voiced frame of this utterance. */
  onsetAt: number
  /** Contiguous voiced time, not cumulative speech across pauses. */
  voicedMs: number
  /** Current microphone RMS and the resolved gate, when available. */
  rms?: number
  threshold?: number
}

export interface SpeechOnsetDecision {
  action: 'ignore' | 'report'
  reason: string
  /** Time from the current frame start to the first voiced frame. */
  sincePlaybackMs?: number
  /** A guard-window onset is treated as self-echo for its whole utterance. */
  selfEcho: boolean
}

/**
 * Decide whether a microphone onset is real enough to report to the host.
 *
 * The page never cuts audio here. A short burst near a frame start is echo and
 * is discarded; only speech that begins after the guard and stays voiced for
 * the playback-specific minimum is surfaced as speech:start. An unknown output
 * level degrades to the conservative default (400 ms continuous), never a
 * single-frame trigger.
 */
export function decideSpeechOnset(input: SpeechOnsetRequest): SpeechOnsetDecision {
  if (!input.playing) {
    return { action: 'report', reason: 'idle', selfEcho: false }
  }
  const since = typeof input.playbackStartedAt === 'number'
    && Number.isFinite(input.playbackStartedAt)
    ? input.onsetAt - input.playbackStartedAt
    : undefined
  if (since !== undefined && since >= 0 && since < PLAYBACK_ECHO_GUARD_MS) {
    return {
      action: 'ignore',
      reason: 'playback-echo-guard',
      sincePlaybackMs: since,
      selfEcho: true,
    }
  }
  if (!(input.voicedMs >= PLAYBACK_MIN_VOICED_MS)) {
    return {
      action: 'ignore',
      reason: 'playback-min-sustained',
      ...(since === undefined ? {} : { sincePlaybackMs: since }),
      selfEcho: false,
    }
  }
  if (typeof input.rms === 'number' && typeof input.threshold === 'number'
    && (!Number.isFinite(input.rms) || input.rms < input.threshold)) {
    return {
      action: 'ignore',
      reason: 'playback-echo-threshold',
      ...(since === undefined ? {} : { sincePlaybackMs: since }),
      selfEcho: false,
    }
  }
  return {
    action: 'report',
    reason: 'playback-sustained-onset',
    ...(since === undefined ? {} : { sincePlaybackMs: since }),
    selfEcho: false,
  }
}

export interface FallbackCutRequest {
  /** Still audible right now, i.e. the host has not stopped the mouth. */
  playing: boolean
  /** The onset was already surfaced to the host. */
  reported: boolean
  /** The host explicitly answered with a stop/hold/control action. */
  hostResponded?: boolean
  /** One contiguous voiced run, not cumulative speech. */
  voicedMs: number
  /** A fallback cut has already fired for this utterance. */
  alreadyCut?: boolean
  fallbackMs?: number
}

/**
 * Last-resort safety valve. It only fires for a reported, unanswered, still
 * audible utterance after a full second of continuous voicing, and only once.
 */
export function shouldFallbackCut(input: FallbackCutRequest): boolean {
  const limit = typeof input.fallbackMs === 'number' && Number.isFinite(input.fallbackMs)
    ? Math.max(PLAYBACK_MIN_VOICED_MS, input.fallbackMs)
    : PLAYBACK_FALLBACK_CUT_MS
  return input.playing === true
    && input.reported === true
    && input.hostResponded !== true
    && input.alreadyCut !== true
    && input.voicedMs >= limit
}

/**
 * Decide what a newly recognized speaker does to audio already being played.
 *
 * Owner speech during playback is a real barge-in, but it never hard-cuts a
 * sentence: the player finishes the current sentence and retains the rest.
 * Guests default to queueing and may only interrupt when an explicit guest
 * policy says so.
 */
export function decideBargeIn(input: BargeInRequest): BargeInDecision {
  const playing = input.playing === true
  if (input.lane === 'guest') {
    if (input.guestMode === 'ignore') {
      return {
        action: 'none', finishSentence: false, keepRemainder: false,
        reason: 'guest-ignore',
      }
    }
    if (input.guestMode === 'steer' && playing) {
      return {
        action: 'interrupt', finishSentence: true, keepRemainder: true, priority: -1,
        reason: 'guest-steer-policy',
      }
    }
    return {
      action: playing ? 'queue' : 'none',
      finishSentence: false,
      keepRemainder: false,
      reason: 'guest-default-queue',
    }
  }
  if (!playing) {
    return {
      action: 'none', finishSentence: false, keepRemainder: false,
      reason: 'owner-idle',
    }
  }
  // Perception first: an owner onset is reported by the microphone so the host
  // and model can decide hold/stop/continue. The page itself never cuts audio.
  return {
    action: 'queue',
    finishSentence: false,
    keepRemainder: true,
    reason: 'owner-playback-report-only',
  }
}

export interface SentenceFrameLike {
  /** Blocks cut from the same assistant sentence share this id. */
  sentenceId?: number
  /** Groups every block of one assistant reply. */
  replyId?: string
}

/** Same-sentence only when both sides carry the same numeric sentence id. */
export function isSameSentence(left: SentenceFrameLike, right: SentenceFrameLike): boolean {
  return typeof left.sentenceId === 'number'
    && Number.isFinite(left.sentenceId)
    && left.sentenceId === right.sentenceId
}

export interface SentenceBoundaryPlan<T extends SentenceFrameLike> {
  /** Queued blocks from the current sentence that must still be spoken. */
  finish: T[]
  /** Blocks after the sentence boundary, preserved in arrival order. */
  remainder: T[]
  /** Whether playback should stop once current + finish have drained. */
  stopAfterCurrent: boolean
}

/**
 * Split queued blocks at the end of the currently playing sentence. A frame
 * without a sentence id is treated as a complete one-block sentence, which is
 * the conservative interpretation: never continue into an unrelated block.
 */
export function splitAtSentenceBoundary<T extends SentenceFrameLike>(
  current: T | undefined,
  queued: readonly T[],
): SentenceBoundaryPlan<T> {
  if (!current) {
    return { finish: [], remainder: [...queued], stopAfterCurrent: false }
  }
  let boundary = 0
  while (boundary < queued.length && isSameSentence(current, queued[boundary]!)) boundary += 1
  return {
    finish: queued.slice(0, boundary),
    remainder: queued.slice(boundary),
    stopAfterCurrent: true,
  }
}

/**
 * Actual playback order after a barge-in: the owner's new answer first, then
 * the preserved tail of the old answer. Dropping is only possible when the
 * caller explicitly chooses it; the default keeps every old block.
 */
export function orderBargeInFrames<T>(
  newReplyFrames: readonly T[],
  oldRemainder: readonly T[],
  keepRemainder = true,
): T[] {
  return keepRemainder ? [...newReplyFrames, ...oldRemainder] : [...newReplyFrames]
}
