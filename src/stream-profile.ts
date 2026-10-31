/**
 * Reading the declared speech profile from the reply pipeline.
 *
 * tapStream() runs above apply(), so the declaration it needs is a local of the
 * plugin instance and cannot be captured at module scope. The pipeline is
 * therefore given a READER, and every read goes through it: a declaration may
 * change between two replies, and the next reply must see the new value.
 *
 * Keeping the shape decision here (not inline in the pipeline) makes the rule
 * testable without standing up the whole mouth.
 */
import type { SpeechProfile } from './speech-profile.js'

/** How soon the first block may speak, and when an unpunctuated opener is released. */
export interface FirstBlockShape {
  /** Fewest characters the first block may speak on; 8 is the historical value. */
  chars: number
  /** Release the opener this long after the first token even without punctuation. */
  deadlineMs: number
}

/**
 * Read the first-block shape through the caller's reader. Always one fresh
 * read per call: a cached snapshot would freeze an earlier declaration.
 */
export function firstBlockShape(read: () => SpeechProfile): FirstBlockShape {
  const profile = read()
  return {
    chars: typeof profile.firstBlockChars === 'number' ? profile.firstBlockChars : 8,
    deadlineMs: profile.firstBlockDeadlineMs ?? 0,
  }
}

/** In-sentence breath for one long block; 0 keeps a block in one request. */
export function innerPauseFor(read: () => SpeechProfile): number {
  return read().innerPauseMs ?? 0
}

/** The optional acknowledgement the model wrote, and when to say it. */
export function declaredAck(read: () => SpeechProfile): { text: string; afterMs: number } {
  const profile = read()
  return {
    text: String(profile.backchannel ?? ''),
    afterMs: typeof profile.backchannelAfterMs === 'number' ? profile.backchannelAfterMs : 0,
  }
}

/** True when a reply should pick the listener's half sentence up first. */
export function warmOpenDeclared(read: () => SpeechProfile): boolean {
  return read().warmOpen === true
}
